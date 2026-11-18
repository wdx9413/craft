import { createHash, randomUUID } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, realpathSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { executeModHook } from "./mod-runtime-sandbox.ts";
import { modEventCatalog, modEventContract } from "./mod-event-contracts.ts";

const MOD_ID = /^[a-z][a-z0-9_.-]{0,63}$/u;
const EVENT_ID = /^[a-z][a-z0-9_.-]{0,95}@\d+$/u;
const ACTION_ID = /^[a-z][a-z0-9_.-]{0,95}$/u;
const CAPABILITIES = new Set(["event.observe", "event.patch", "event.reject", "event.takeover", "approval.strategy"]);
const MAX_PACKAGE_FILES = 200;
const MAX_PACKAGE_BYTES = 2 * 1024 * 1024;
const UI_INSERTION_POINTS = new Set(["composer_toolbar", "task_context", "project_sidebar", "task_header"]);
const UI_COMPONENTS = new Set(["text", "button", "status"]);
const MOD_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const MOD_RUNTIME_VERSION = "craft-mod-runtime@2";
const MOD_REGRESSION_SUITE = "craft.mod-runtime.system-regression.v2";
const MODULE_REGRESSION_SAMPLE_SET = "craft.mod-runtime.module-contract.v1";
const MODULE_REGRESSION_INPUTS = 3;

const DEFAULT_HOOK_TIMEOUT_MS = 1_000;
const MAX_HOOK_TIMEOUT_MS = 30_000;

type HookOutcome = { kind: "continue" } | { kind: "patch"; patch: JsonObject } | { kind: "reject"; reason: string }
  | { kind: "takeover"; result: JsonObject } | { kind: "approval"; decision: string };

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function digest(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function packageDigest(packageRoot: string): string {
  const root = realpathSync(packageRoot);
  const files: Array<{ path: string; bytes: Buffer }> = [];
  let totalBytes = 0;
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = resolve(directory, entry.name);
      const relativePath = relative(root, fullPath);
      if (entry.isSymbolicLink() || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("Mod packages cannot contain symlinks or escape their root");
      if (entry.isDirectory()) { visit(fullPath); continue; }
      if (!entry.isFile()) throw new Error("Mod packages may contain only regular files");
      if (![".mjs", ".json", ".md"].includes(fullPath.slice(fullPath.lastIndexOf(".")))) throw new Error("Mod packages may contain only reviewable .mjs, .json, and .md files");
      if (files.length >= MAX_PACKAGE_FILES) throw new Error(`Mod package exceeds ${MAX_PACKAGE_FILES} files`);
      const bytes = readFileSync(fullPath);
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_PACKAGE_BYTES) throw new Error(`Mod package exceeds ${MAX_PACKAGE_BYTES} bytes`);
      files.push({ path: relativePath.split(sep).join("/"), bytes });
    }
  };
  visit(root);
  if (!files.length) throw new Error("Mod package must contain files");
  const hash = createHash("sha256");
  for (const file of files) hash.update(file.path).update("\0").update(file.bytes).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

function sanitizePackageCopy(sourceRoot: string, destinationRoot: string, expectedDigest: string): { digest: string; files: number } {
  if (packageDigest(sourceRoot) !== expectedDigest) throw new Error("source package changed before the isolated project copy");
  const sourceFiles = readdirSync(sourceRoot, { recursive: true, withFileTypes: true });
  let fileCount = 0;
  for (const entry of sourceFiles) {
    if (!entry.isFile()) continue;
    fileCount += 1;
    const filePath = resolve(sourceRoot, String(entry.parentPath ?? sourceRoot), entry.name);
    const content = readFileSync(filePath, "utf8");
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)
      || /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu.test(content)) {
      throw new Error("project copy refused because the Mod package contains a credential-like value");
    }
  }
  mkdirSync(resolve(destinationRoot, ".."), { recursive: true, mode: 0o700 });
  cpSync(sourceRoot, destinationRoot, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  const copiedDigest = packageDigest(destinationRoot);
  if (copiedDigest !== expectedDigest) throw new Error("isolated project copy digest did not match the reviewed package");
  const copiedEntries = readdirSync(destinationRoot, { recursive: true, withFileTypes: true });
  for (const entry of copiedEntries) {
    const filePath = resolve(destinationRoot, String(entry.parentPath ?? destinationRoot), entry.name);
    chmodSync(filePath, entry.isDirectory() ? 0o700 : 0o600);
  }
  chmodSync(destinationRoot, 0o700);
  return { digest: copiedDigest, files: fileCount };
}

function normalizeManifest(value: unknown): JsonObject {
  const manifest = object(value, "manifest");
  const id = text(manifest.id, "manifest.id");
  if (!MOD_ID.test(id)) throw new Error("Mod id is invalid");
  const name = text(manifest.name, "manifest.name");
  const version = text(manifest.version, "manifest.version");
  const entry = text(manifest.entry, "manifest.entry");
  if (isAbsolute(entry) || entry.split(/[\\/]+/u).includes("..") || !entry.endsWith(".mjs")) throw new Error("Mod entry must be a relative .mjs file inside the package");
  const scopeKind = manifest.scope_kind === undefined ? "global" : text(manifest.scope_kind, "manifest.scope_kind");
  if (!["global", "project", "task"].includes(scopeKind)) throw new Error("Mod scope_kind must be global, project or task");
  const scopeId = scopeKind === "global" ? "global" : text(manifest.scope_id, "manifest.scope_id");
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length > 32) throw new Error("Mod capabilities must be an array of at most 32 entries");
  const capabilities = manifest.capabilities.map((item) => text(item, "capability"));
  if (capabilities.some((capability) => !CAPABILITIES.has(capability))) throw new Error("Mod requests an unsupported capability");
  if (new Set(capabilities).size !== capabilities.length) throw new Error("Mod capabilities must be unique");
  const sideEffects = manifest.side_effects === undefined ? [] : manifest.side_effects;
  if (!Array.isArray(sideEffects) || sideEffects.length > 32 || sideEffects.some((effect) => typeof effect !== "string" || !effect.trim())) {
    throw new Error("Mod side_effects must be an array of at most 32 non-empty descriptions");
  }
  if (!Array.isArray(manifest.hooks) || manifest.hooks.length < 1 || manifest.hooks.length > 64) throw new Error("Mod hooks must be an array of 1 to 64 entries");
  const hooks = manifest.hooks.map((raw, index) => {
    const hook = object(raw, `manifest.hooks[${index}]`);
    const event = text(hook.event, `manifest.hooks[${index}].event`);
    if (!EVENT_ID.test(event)) throw new Error("Hook event must include an event version");
    const contract = modEventContract(event);
    if (!contract) throw new Error(`Unsupported Mod event: ${event}`);
    const capability = text(hook.capability, `manifest.hooks[${index}].capability`);
    if (!CAPABILITIES.has(capability) || !capabilities.includes(capability) || !contract.capabilities.includes(capability)) throw new Error("Hook capability must be declared by the Mod and supported by the event");
    if (capability === "approval.strategy" && event !== "craft.approval.decide@1") throw new Error("approval.strategy is only valid for craft.approval.decide@1");
    if (event === "craft.approval.decide@1" && capability !== "approval.strategy") throw new Error("approval decision Hooks require approval.strategy");
    const timeout = hook.timeout_ms === undefined ? DEFAULT_HOOK_TIMEOUT_MS : Number(hook.timeout_ms);
    if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > MAX_HOOK_TIMEOUT_MS) throw new Error("Hook timeout_ms must be an integer from 10 to 30000");
    return { event, capability, order: Number.isSafeInteger(hook.order) ? Number(hook.order) : index, timeout_ms: timeout };
  });
  if (new Set(hooks.map((hook) => hook.event)).size !== hooks.length) throw new Error("Mod may register only one Hook per event in this release");
  const rawContributions = manifest.ui_contributions === undefined ? [] : manifest.ui_contributions;
  if (!Array.isArray(rawContributions) || rawContributions.length > 20) throw new Error("ui_contributions must be an array of at most 20 entries");
  const uiContributions = rawContributions.map((raw, index) => {
    const contribution = object(raw, `manifest.ui_contributions[${index}]`);
    const contributionId = text(contribution.id, `manifest.ui_contributions[${index}].id`);
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(contributionId)) throw new Error("UI contribution id is invalid");
    const insertionPoint = text(contribution.insertion_point, "ui_contribution.insertion_point");
    if (!UI_INSERTION_POINTS.has(insertionPoint)) throw new Error("UI contribution insertion point is protected or unsupported");
    const version = Number(contribution.version ?? 1);
    const updateBudget = Number(contribution.update_budget_ms ?? 50);
    if (version !== 1 || !Number.isSafeInteger(updateBudget) || updateBudget < 1 || updateBudget > 200) throw new Error("UI contribution version or update budget is unsupported");
    if (!Array.isArray(contribution.hosts) || contribution.hosts.length < 1 || contribution.hosts.some((host) => typeof host !== "string" || !(modEventCatalog(String(host)).events as unknown[]).length)) throw new Error("UI contribution hosts must be supported Hosts");
    if (!Array.isArray(contribution.platforms) || contribution.platforms.length < 1
      || contribution.platforms.some((platform) => typeof platform !== "string" || !MOD_PLATFORMS.has(platform))) {
      throw new Error("UI contribution platforms must explicitly list supported Node platforms");
    }
    if (!Array.isArray(contribution.layout) || contribution.layout.length > 20) throw new Error("UI contribution layout must be a bounded array");
    const layout = contribution.layout.map((item, itemIndex) => {
      const component = object(item, `ui_contribution.layout[${itemIndex}]`);
      const type = text(component.type, "ui_component.type");
      const componentId = text(component.id, "ui_component.id");
      const label = text(component.label, "ui_component.label");
      if (!UI_COMPONENTS.has(type) || componentId.length > 64 || label.length > 120) throw new Error("UI contribution component is unsupported");
      if (type === "button") {
        if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(text(component.action_id, "ui_component.action_id"))) throw new Error("UI button action_id is invalid");
      } else if (component.action_id !== undefined) throw new Error("Only UI buttons may declare action_id");
      return { type, id: componentId, label, ...(type === "button" ? { action_id: String(component.action_id) } : {}) };
    });
    return { id: contributionId, version, insertion_point: insertionPoint, update_budget_ms: updateBudget,
      hosts: [...new Set((contribution.hosts as string[]).map(String))], platforms: [...new Set((contribution.platforms as string[]).map(String))], layout };
  });
  if (new Set(uiContributions.map((item) => item.id)).size !== uiContributions.length) throw new Error("UI contribution ids must be unique");
  return { id, name, version, entry, scope_kind: scopeKind, scope_id: scopeId, capabilities, hooks, ui_contributions: uiContributions, side_effects: sideEffects.map((effect) => String(effect).trim()) };
}

function permissionDigest(manifest: JsonObject): string {
  return digest(JSON.stringify({ scope_kind: manifest.scope_kind, scope_id: manifest.scope_id,
    capabilities: manifest.capabilities, hooks: manifest.hooks, ui_contributions: manifest.ui_contributions, side_effects: manifest.side_effects }));
}

function regressionSuiteDigest(manifest: JsonObject): string {
  const hooks = Array.isArray(manifest.hooks) ? manifest.hooks as JsonObject[] : [];
  return digest(JSON.stringify({ runtime_version: MOD_RUNTIME_VERSION, suite: MOD_REGRESSION_SUITE,
    module_sample_set: MODULE_REGRESSION_SAMPLE_SET, module_samples_per_hook: MODULE_REGRESSION_INPUTS, cases: [
    "system.no_approval_strategy", "system.user_trust_gate", "system.exact_code_and_permissions_bound",
    ...hooks.map((hook) => `hook:${String(hook.event)}`),
  ] }));
}

function sameScope(left: JsonObject, right: JsonObject): boolean {
  if (String(left.scope_kind ?? "global") === "global") return true;
  const kind = String(left.scope_kind ?? "global");
  const id = String(left.scope_id ?? "global");
  if (kind === "task") return id === String(right.task_id ?? (right.scope_kind === "task" ? right.scope_id : ""));
  if (kind === "project") return id === String(right.project_id ?? (right.scope_kind === "project" ? right.scope_id : ""));
  return false;
}

function hookOrder(mod: JsonObject, event: string): number {
  const hooks = Array.isArray((mod.manifest as JsonObject).hooks) ? (mod.manifest as JsonObject).hooks as JsonObject[] : [];
  const hook = hooks.find((item) => item.event === event);
  return Number.isSafeInteger(hook?.order) ? Number(hook?.order) : 0;
}

export class ModRuntime {
  readonly store: CraftStore;

  constructor(store: CraftStore) { this.store = store; }

  list(): JsonObject {
    const mods = this.store.list("runtime_mod", 1_000).map((mod) => ({ id: mod.id, name: mod.name,
      version: mod.version, origin: mod.origin, scope_kind: mod.scope_kind, scope_id: mod.scope_id,
      trust_status: mod.trust_status, enabled: mod.enabled === true, code_digest: mod.code_digest,
      permission_digest: mod.permission_digest, trusted_by: mod.trusted_by ?? null,
      trusted_at: mod.trusted_at ?? null, updated_at: mod.updated_at }));
    return { mods };
  }

  eventCatalog(args: JsonObject = {}): JsonObject {
    return modEventCatalog(args.host === undefined ? undefined : text(args.host, "host"),
      args.platform === undefined ? undefined : text(args.platform, "platform"));
  }

  hasTrustedEvent(event: string, scope: JsonObject): boolean {
    return this.store.list("runtime_mod", 1_000, (mod) => mod.enabled === true && mod.trust_status === "trusted"
      && this.#inScope(mod, scope) && Array.isArray((mod.manifest as JsonObject).hooks)
      && ((mod.manifest as JsonObject).hooks as JsonObject[]).some((hook) => hook.event === event)).length > 0;
  }

  workbenchContributions(workspaceId: string, context: string, platform: string = process.platform): JsonObject[] {
    return this.store.list("runtime_mod", 1_000, (mod) => mod.enabled === true && mod.trust_status === "trusted"
      && this.#inScope(mod, { scope_kind: "project", scope_id: workspaceId, project_id: workspaceId }))
      .flatMap((mod) => {
        const manifest = mod.manifest as JsonObject;
        const entries = Array.isArray(manifest.ui_contributions) ? manifest.ui_contributions as JsonObject[] : [];
        return entries.filter((entry) => Array.isArray(entry.hosts) && (entry.hosts as string[]).includes("workbench")
          && Array.isArray(entry.platforms) && (entry.platforms as string[]).includes(platform)
          && ((context === "task" && ["composer_toolbar", "task_context", "task_header"].includes(String(entry.insertion_point)))
            || (context === "project" && entry.insertion_point === "project_sidebar")))
          .map((entry) => ({ mod_id: mod.id, mod_name: mod.name, mod_version: mod.version,
            contribution: entry, context, supported: true, protected_surfaces: ["approval_review", "mod_trust_review"] }));
      });
  }

  unavailableWorkbenchContributions(workspaceId: string, platform: string = process.platform): JsonObject[] {
    return this.store.list("runtime_mod", 1_000, (mod) => mod.enabled === true && mod.trust_status === "trusted"
      && this.#inScope(mod, { scope_kind: "project", scope_id: workspaceId, project_id: workspaceId }))
      .flatMap((mod) => {
        const manifest = mod.manifest as JsonObject;
        const entries = Array.isArray(manifest.ui_contributions) ? manifest.ui_contributions as JsonObject[] : [];
        return entries.flatMap((entry) => {
          if (!Array.isArray(entry.hosts) || !(entry.hosts as string[]).includes("workbench")) {
            return [{ mod_id: mod.id, mod_name: mod.name, mod_version: mod.version,
              contribution: entry, supported: false, reason: "workbench_ui_host_unsupported" }];
          }
          if (!Array.isArray(entry.platforms) || !(entry.platforms as string[]).includes(platform)) {
            return [{ mod_id: mod.id, mod_name: mod.name, mod_version: mod.version,
              contribution: entry, supported: false, reason: "workbench_ui_platform_unsupported" }];
          }
          return [];
        });
      });
  }

  stage(args: JsonObject): JsonObject {
    const manifest = normalizeManifest(args.manifest);
    const packageRoot = realpathSync(text(args.package_root, "package_root"));
    const entryPath = resolve(packageRoot, String(manifest.entry));
    const entryRelative = relative(packageRoot, entryPath);
    if (!entryRelative || entryRelative.startsWith(`..${sep}`) || isAbsolute(entryRelative) || !statSync(entryPath).isFile()) {
      throw new Error("Mod entry must resolve to a regular file inside the package");
    }
    const codeDigest = packageDigest(packageRoot);
    const permissionsDigest = permissionDigest(manifest);
    const existing = this.store.find("runtime_mod", String(manifest.id));
    if (existing && existing.code_digest === codeDigest && existing.permission_digest === permissionsDigest) {
      return { mod: existing, idempotent: true };
    }
    if (existing?.origin === "self_evolved") {
      let installedCodeChanged = true, installedPermissionsChanged = true;
      try { installedCodeChanged = packageDigest(String(existing.package_root)) !== existing.code_digest; } catch { /* Missing bytes invalidate the executable version. */ }
      try { installedPermissionsChanged = permissionDigest(object(existing.manifest, "stored manifest")) !== existing.permission_digest; } catch { /* Missing permission identity invalidates the executable version. */ }
      if (installedCodeChanged || installedPermissionsChanged) {
        this.store.save("runtime_mod", String(existing.id), { ...existing, enabled: false, trust_status: "review_required", updated_at: new Date().toISOString() });
        this.#pauseChangedRollout(String(existing.id), "qualification_identity_changed");
      }
      throw new Error("self-evolved Runtime Mod versions are immutable; create a new candidate id for changed code or permissions");
    }
    const now = new Date().toISOString();
    if (existing && existing.trust_status === "trusted" && existing.trusted_code_digest === existing.code_digest
      && existing.trusted_permission_digest === existing.permission_digest) {
      const snapshotId = `runtime_mod_version_${String(existing.id)}_${digest(`${existing.code_digest}:${existing.permission_digest}`).slice(-16)}`;
      if (!this.store.find("runtime_mod_version", snapshotId)) this.store.create("runtime_mod_version", snapshotId, {
        mod_id: existing.id, code_digest: existing.code_digest, permission_digest: existing.permission_digest,
        snapshot: existing, verified: true, created_at: now,
      });
    }
    const mod = this.store.save("runtime_mod", String(manifest.id), {
      id: String(manifest.id), name: String(manifest.name), version: String(manifest.version),
      scope_kind: String(manifest.scope_kind), scope_id: String(manifest.scope_id),
      origin: "human", package_root: packageRoot, manifest, code_digest: codeDigest,
      permission_digest: permissionsDigest, trust_status: "review_required", enabled: false,
      created_at: existing?.created_at ?? now, updated_at: now,
    });
    return { mod, idempotent: false };
  }

  /**
   * Assemble an executable self-evolved candidate only from a completed repair
   * Task Run and an independently eligible Verification Assessment bound to
   * the exact package bytes. Missing evidence is retained as a non-executable
   * draft so the failure can be repaired without inventing provenance.
   */
  async candidateCreate(args: JsonObject): Promise<JsonObject> {
    const candidateId = text(args.candidate_id, "candidate_id");
    const observationId = text(args.observation_id, "observation_id");
    const lineageId = typeof args.lineage_id === "string" && args.lineage_id.trim() ? text(args.lineage_id, "lineage_id") : candidateId;
    if (!MOD_ID.test(candidateId)) throw new Error("candidate_id is invalid");
    const observation = this.store.find("pilot_failure_observation", observationId);
    const repairRunId = typeof args.repair_run_id === "string" ? args.repair_run_id.trim() : "";
    const verificationId = typeof args.verification_id === "string" ? args.verification_id.trim() : "";
    let packageRoot = typeof args.package_root === "string" ? args.package_root.trim() : "";
    let manifest: JsonObject | null = null;
    let codeDigest: string | null = null;
    let permissionDigestValue: string | null = null;
    const blockers: string[] = [];
    if (!MOD_ID.test(lineageId)) blockers.push("candidate_lineage_id_invalid");
    if (this.store.find("runtime_mod", candidateId)) blockers.push("candidate_id_already_exists");
    if (!observation || observation.attributed !== true || observation.failure_class === "unattributed"
      || observation.injection_verified === false || observation.mod_evidence_kind === "legacy_unverified") blockers.push("failure_not_attributed_with_current_evidence");
    if (!repairRunId) blockers.push("repair_run_missing");
    if (!verificationId) blockers.push("verification_assessment_missing");
    if (!packageRoot || !args.manifest) blockers.push("executable_package_missing");
    if (packageRoot && args.manifest) {
      try {
        manifest = normalizeManifest(args.manifest);
        if (manifest.id !== candidateId) throw new Error("candidate_id must equal manifest.id");
        if (manifest.scope_kind !== "task" || manifest.scope_id !== String(observation?.task_id ?? "")) {
          throw new Error("self-evolved candidates must start at the attributed repair task scope");
        }
        if ((manifest.capabilities as string[]).includes("approval.strategy")) throw new Error("self-evolved candidates cannot request approval strategy");
        packageRoot = realpathSync(packageRoot);
        codeDigest = packageDigest(packageRoot);
        permissionDigestValue = permissionDigest(manifest);
      } catch (error) {
        blockers.push(`candidate_package_invalid:${error instanceof Error ? error.message.slice(0, 160) : "unknown"}`);
      }
    }
    let repairRun: JsonObject | null = null;
    if (repairRunId) {
      repairRun = this.store.find("task_run", repairRunId);
      if (!repairRun) blockers.push("repair_run_not_found");
      else {
        const launchIdentity = object(repairRun.launch_identity, "repair Task Run launch_identity");
        const observationTaskId = observation?.task_id === undefined ? null : String(observation.task_id);
        if (!observationTaskId || observationTaskId !== String(launchIdentity.task_id)) blockers.push("repair_run_task_mismatch");
        const launch = this.store.find("work_launch", String(repairRun.launch_id));
        const hostRun = launch?.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
        if (!launch || !hostRun || !["completed", "succeeded"].includes(String(hostRun.status))) blockers.push("repair_run_not_terminal");
      }
    }
    let assessment: JsonObject | null = null;
    let plan: JsonObject | null = null;
    let verificationReceipts: JsonObject[] = [];
    if (verificationId) {
      assessment = this.store.find("verification_assessment", verificationId);
      if (!assessment) blockers.push("verification_assessment_not_found");
      else {
        plan = this.store.find("verification_plan", String(assessment.verification_id));
        if (!plan) blockers.push("verification_plan_missing");
        else {
          if (assessment.verdict !== "eligible" || plan.candidate_change !== true) blockers.push("verification_not_eligible_candidate");
          const boundChangeRef = repairRun && codeDigest
            ? `runtime-mod:${candidateId}:${codeDigest}:${repairRun.id}@${repairRun.version}:${MOD_RUNTIME_VERSION}` : "";
          if (repairRun && String(plan.change_ref) !== boundChangeRef) blockers.push("verification_code_digest_mismatch");
          if (repairRun && String((repairRun.launch_identity as JsonObject | undefined)?.task_id ?? "") !== String(observation?.task_id ?? "")) blockers.push("verification_task_mismatch");
          const checks = this.store.list("verification_check", 100, (item) => item.verification_id === plan!.id);
          verificationReceipts = this.store.list("verification_receipt", 100, (item) => item.verification_id === plan!.id);
          if (!checks.length || checks.some((check) => check.status !== "passed")
            || checks.some((check) => !verificationReceipts.some((receipt) => receipt.check_id === check.id && receipt.status === "passed"))) blockers.push("verification_receipts_incomplete");
          for (const receipt of verificationReceipts) for (const evidenceId of (receipt.evidence_ids as string[] | undefined) ?? []) {
            const evidence = this.store.find("evidence", evidenceId);
            if (!evidence || !["confirmed", "bounded"].includes(String(evidence.confidence))) blockers.push("verification_evidence_missing_or_untrusted");
          }
        }
      }
    }
    const identity = { candidate_id: candidateId, lineage_id: lineageId, observation_id: observationId, repair_run_id: repairRunId || null,
      verification_assessment_id: verificationId || null, code_digest: codeDigest, permission_digest: permissionDigestValue };
    const prior = this.store.find("runtime_mod_candidate", candidateId);
    if (prior) {
      if (JSON.stringify(prior.identity) === JSON.stringify(identity)) {
        return { candidate: prior, mod: this.store.find("runtime_mod", candidateId), idempotent: true };
      }
      const priorIdentity = prior.identity as JsonObject | undefined;
      const canRetryDraft = prior.status === "draft" && priorIdentity?.observation_id === observationId
        && !this.store.find("runtime_mod", candidateId);
      if (!canRetryDraft) throw new Error("self-evolved candidate idempotency conflict");
    }
    const qualifiedForTesting = blockers.length === 0 && !!manifest && !!codeDigest && !!permissionDigestValue && !!packageRoot;
    let mod: JsonObject | null = null;
    let regression: JsonObject | null = null;
    if (qualifiedForTesting) {
      const staged = this.stage({ manifest, package_root: packageRoot, candidate_id: candidateId }).mod as JsonObject;
      const sourceTask = observation?.task_id ? this.store.find("task", String(observation.task_id)) : null;
      const sourceProjectId = sourceTask ? String(sourceTask.workspace_id ?? sourceTask.project_id ?? "") || null : null;
      mod = this.store.save("runtime_mod", candidateId, { ...staged, id: candidateId,
        origin: "self_evolved", enabled: false, trust_status: "review_required",
        lineage_id: lineageId,
        candidate_provenance: { ...identity, task_run_version: repairRun?.version ?? null, source_project_id: sourceProjectId,
          verification_assessment_version: assessment?.version ?? null,
          verification_plan_version: plan?.version ?? null,
          receipt_ids: verificationReceipts.map((receipt) => String(receipt.id)),
          evidence_ids: [...new Set(verificationReceipts.flatMap((receipt) => (receipt.evidence_ids as string[] | undefined) ?? []))] },
        updated_at: new Date().toISOString() });
      regression = await this.candidateRegressionRun(candidateId);
      if ((regression.failed as number) > 0) blockers.push("fixed_regression_failed");
    }
    const regressionRecord = regression?.regression as JsonObject | undefined;
    const candidateRecord = { identity,
      status: blockers.length ? "draft" : "qualified_untrusted", blockers,
      failure_class: observation?.failure_class ?? "unattributed", regression,
      before_after_evaluation: {
        before: { observation_id: observationId, failure_class: observation?.failure_class ?? "unattributed",
          behavior: "without_candidate_mod", result: "input_passthrough" },
        after: { repair_run_id: repairRun?.id ?? null, repair_run_version: repairRun?.version ?? null,
          verification_assessment_id: assessment?.id ?? null, verification_verdict: assessment?.verdict ?? null,
          passed_checks: verificationReceipts.filter((receipt) => receipt.status === "passed").length,
          evidence_ids: [...new Set(verificationReceipts.flatMap((receipt) => (receipt.evidence_ids as string[] | undefined) ?? []))],
          regression_id: regressionRecord?.id ?? null,
          regression_sample_count: Number(regressionRecord?.sample_count ?? 0),
          regression_passed_samples: ((regressionRecord?.cases as JsonObject[] | undefined) ?? [])
            .filter((item) => String(item.id).startsWith("module:")).filter((item) => item.passed === true).length },
        module_contract_quality_score: regressionRecord?.quality_score ?? null,
        module_contract_quality_threshold: regressionRecord?.quality_threshold ?? null,
      },
      regression_id: regressionRecord?.id ?? null, regression_suite: regressionRecord?.suite ?? null,
      regression_digest: regressionRecord?.suite_digest ?? null, regression_verdict: regression?.verdict ?? null,
      regression_sample_count: regressionRecord?.sample_count ?? 0,
      created_at: prior?.created_at ?? new Date().toISOString(), updated_at: new Date().toISOString() };
    const saved = prior
      ? this.store.save("runtime_mod_candidate", candidateId, { ...prior, ...candidateRecord })
      : this.store.create("runtime_mod_candidate", candidateId, candidateRecord);
    return { candidate: saved, mod, regression, idempotent: false };
  }

  /** Immutable model-free system and per-Hook contract regression set. */
  async candidateRegressionRun(modId: string, stage = "candidate"): Promise<JsonObject> {
    const mod = this.#get(text(modId, "mod_id"));
    const rollout = stage === "candidate" ? null : this.store.find("runtime_mod_rollout", String(mod.id));
    if (mod.origin !== "self_evolved") throw new Error("candidate regression applies only to self-evolved Runtime Mods");
    if (stage === "candidate") {
      if (mod.trust_status === "trusted" || mod.enabled === true) throw new Error("candidate regression requires an untrusted, disabled self-evolved Mod");
    } else if (!["task", "project", "global"].includes(stage) || !rollout || !["active", "paused"].includes(String(rollout.status)) || rollout.stage !== stage
      || mod.trust_status !== "trusted" || mod.enabled !== (rollout.status === "active")) throw new Error("stage regression requires the trusted Mod's current rollout stage");
    const manifest = object(mod.manifest, "candidate manifest");
    const hooks = manifest.hooks as JsonObject[];
    const safetyCases: JsonObject[] = [
      { id: "system.no_approval_strategy", passed: !(manifest.capabilities as string[]).includes("approval.strategy") },
      { id: "system.user_trust_gate", passed: stage === "candidate" ? mod.enabled === false && mod.trust_status === "review_required"
        : mod.enabled === (rollout?.status === "active") && mod.trust_status === "trusted" && ["active", "paused"].includes(String(rollout?.status)) },
    ];
    const actualDigest = packageDigest(String(mod.package_root));
    safetyCases.push({ id: "system.exact_code_and_permissions_bound",
      passed: actualDigest === mod.code_digest && permissionDigest(manifest) === mod.permission_digest });
    const moduleCases: JsonObject[] = [];
    for (const hook of hooks) {
      const contract = modEventContract(String(hook.event))!;
      for (let sample = 0; sample < MODULE_REGRESSION_INPUTS; sample += 1) {
        const input: JsonObject = {};
        for (const field of contract.input_fields) {
          input[field] = field === "messages" ? [{ role: "user", content: ["fixture", "Unicode 测试", "second independent vector"][sample] }]
            : field === "arguments" || field === "result" ? { sample: sample + 1 }
              : [`fixture-${sample + 1}`, `unicode-样本-${sample + 1}`, `boundary-${sample + 1}`][sample];
        }
        let passed = false;
        let detail = "Hook did not return an allowed non-blocking result";
        let after: unknown = null;
        try {
          const sandboxResult = await executeModHook(String(mod.package_root), manifest, String(hook.event), input, Number(hook.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS));
          const result = this.#normalizeResult(sandboxResult.value, String(hook.capability));
          if (result.kind === "continue") { passed = true; after = input; }
          else if (result.kind === "patch") {
            const invalidFields = Object.keys(result.patch).filter((key) => !contract.patch_fields.includes(key));
            passed = invalidFields.length === 0;
            after = passed ? { ...input, ...result.patch } : null;
          }
          detail = passed ? "Candidate output passed the immutable event contract" : `Hook outcome ${result.kind} is not auto-qualifiable`;
        } catch (error) { detail = error instanceof Error ? error.message.slice(0, 200) : "Hook regression failed"; }
        moduleCases.push({ id: `module:${MODULE_REGRESSION_SAMPLE_SET}:${String(hook.event)}:${sample + 1}`,
          hook_event: hook.event, sample_set: MODULE_REGRESSION_SAMPLE_SET, sample_index: sample + 1,
          before: input, after, passed, detail });
      }
    }
    const cases = [...safetyCases, ...moduleCases];
    const suite = MOD_REGRESSION_SUITE;
    const suiteDigest = regressionSuiteDigest(manifest);
    const qualityScore = moduleCases.filter((item) => item.passed === true).length / Math.max(1, moduleCases.length);
    const qualityThreshold = 1;
    const hardSafetyPassed = safetyCases.every((item) => item.passed === true);
    const minSamples = MODULE_REGRESSION_INPUTS;
    const verdict = hardSafetyPassed && moduleCases.length >= minSamples && qualityScore >= qualityThreshold
      && moduleCases.every((item) => item.passed === true) ? "passed" : "failed";
    const evaluationId = `mod_regression_${String(mod.id)}_${digest(JSON.stringify({ runtime_version: MOD_RUNTIME_VERSION,
      code: mod.code_digest, permissions: mod.permission_digest, suiteDigest, stage })).slice(-16)}`;
    const evaluation = this.store.find("runtime_mod_regression", evaluationId) ?? this.store.create("runtime_mod_regression", evaluationId,
      { mod_id: mod.id, mod_version: manifest.version, code_digest: mod.code_digest, permission_digest: mod.permission_digest,
        runtime_version: MOD_RUNTIME_VERSION, suite, module_sample_set: MODULE_REGRESSION_SAMPLE_SET, stage, suite_digest: suiteDigest,
        min_samples: minSamples, sample_count: moduleCases.length, safety_case_count: safetyCases.length,
        quality_score: qualityScore, quality_threshold: qualityThreshold,
        hard_safety_passed: hardSafetyPassed, cases, verdict, created_at: new Date().toISOString() });
    const evaluatedVerdict = String(evaluation.verdict);
    const evaluatedCases = Array.isArray(evaluation.cases) ? evaluation.cases as JsonObject[] : [];
    const candidate = this.store.find("runtime_mod_candidate", String(mod.id));
    if (candidate) this.store.save("runtime_mod_candidate", String(mod.id), { ...candidate,
      regression_id: evaluation.id, regression_suite: suite, regression_digest: suiteDigest,
      regression_verdict: evaluatedVerdict, regression_sample_count: evaluation.sample_count,
      status: evaluatedVerdict === "passed" ? "qualified_untrusted" : "draft",
      regression_quality_score: evaluation.quality_score, regression_quality_threshold: evaluation.quality_threshold,
      blockers: evaluatedVerdict === "passed" ? [] : ["fixed_regression_failed"], updated_at: new Date().toISOString() });
    return { regression: evaluation, verdict: evaluatedVerdict, failed: evaluatedCases.filter((item) => item.passed !== true).length };
  }

  review(args: JsonObject): JsonObject {
    const mod = this.#get(text(args.mod_id, "mod_id"));
    const currentCodeDigest = packageDigest(String(mod.package_root));
    const currentPermissionDigest = permissionDigest(object(mod.manifest, "stored manifest"));
    const sourceFiles: JsonObject[] = [];
    const collect = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
        const file = resolve(directory, entry.name);
        if (entry.isDirectory()) { collect(file); continue; }
        const content = readFileSync(file, "utf8");
        sourceFiles.push({ path: relative(String(mod.package_root), file).split(sep).join("/"), content });
      }
    };
    collect(String(mod.package_root));
    if (packageDigest(String(mod.package_root)) !== currentCodeDigest) throw new Error("Mod package changed while it was being reviewed; retry the review");
    const trustInvalidated = mod.trust_status === "trusted"
      && (mod.trusted_code_digest !== currentCodeDigest || mod.trusted_permission_digest !== currentPermissionDigest);
    if (trustInvalidated) this.store.save("runtime_mod", String(mod.id), {
      ...mod, enabled: false, trust_status: "review_required", updated_at: new Date().toISOString(),
    });
    return { mod_id: mod.id, name: mod.name, version: mod.version, origin: mod.origin,
      source_path: String(mod.package_root),
      code_digest: currentCodeDigest, permission_digest: currentPermissionDigest,
      hooks: mod.manifest && (mod.manifest as JsonObject).hooks, capabilities: mod.manifest && (mod.manifest as JsonObject).capabilities,
      scope_kind: mod.scope_kind, scope_id: mod.scope_id,
      source: sourceFiles, side_effects: (mod.manifest as JsonObject).side_effects ?? [],
      ui_contributions: (mod.manifest as JsonObject).ui_contributions ?? [],
      trust_status: trustInvalidated ? "review_required" : mod.trust_status };
  }

  trust(args: JsonObject): JsonObject {
    const mod = this.#get(text(args.mod_id, "mod_id"));
    const review = this.review({ mod_id: mod.id });
    if (text(args.code_digest, "code_digest") !== review.code_digest || text(args.permission_digest, "permission_digest") !== review.permission_digest) {
      throw new Error("Mod changed after review; review the current code and permissions again");
    }
    if (mod.origin === "self_evolved" && (mod.manifest as JsonObject).capabilities && ((mod.manifest as JsonObject).capabilities as string[]).includes("approval.strategy")) {
      throw new Error("self-evolved Mods cannot use approval strategy");
    }
    const now = new Date().toISOString();
    const trusted = this.store.save("runtime_mod", String(mod.id), { ...mod,
      trust_status: "trusted", trusted_code_digest: review.code_digest,
      trusted_permission_digest: review.permission_digest, trusted_by: text(args.actor, "actor"), trusted_at: now,
      enabled: true, updated_at: now });
    return { mod: trusted, status: "trusted" };
  }

  trustAll(args: JsonObject = {}): JsonObject {
    const actor = text(args.actor, "actor");
    const reviews = args.reviews;
    if (!Array.isArray(reviews)) throw new Error("reviews must contain the exact modules and digests the user reviewed");
    const byId = new Map(reviews.map((item) => {
      const review = object(item, "review");
      return [text(review.mod_id, "review.mod_id"), review] as const;
    }));
    if (byId.size !== reviews.length) throw new Error("reviews must not contain duplicate Mod ids");
    const mods = this.store.list("runtime_mod", 1_000, (mod) => mod.trust_status === "review_required" && mod.origin === "human");
    if (mods.length !== byId.size || mods.some((mod) => !byId.has(String(mod.id)))) {
      throw new Error("reviews must exactly match the currently pending human-authored Mod set");
    }
    const trusted = this.store.transaction(() => mods.map((mod) => {
      const review = byId.get(String(mod.id))!;
      return this.trust({ mod_id: String(mod.id), code_digest: review.code_digest,
        permission_digest: review.permission_digest, actor });
    }));
    return { trusted, count: trusted.length };
  }

  approvalPolicySet(args: JsonObject): JsonObject {
    const actions = args.actions;
    if (!Array.isArray(actions) || actions.length > 100 || actions.some((action) => typeof action !== "string" || !ACTION_ID.test(action.trim()))
      || new Set(actions.map((action) => String(action).trim())).size !== actions.length) throw new Error("actions must be an array of at most 100 unique action names");
    const allowed = actions.map((action) => String(action).trim());
    const saved = this.store.save("mod_approval_policy", "global", {
      id: "global", allowed_actions: allowed, decided_by: text(args.actor, "actor"), updated_at: new Date().toISOString(),
    });
    return { policy: saved };
  }

  withdraw(args: JsonObject): JsonObject {
    const mod = this.#get(text(args.mod_id, "mod_id"));
    const scopeKind = text(args.scope_kind ?? mod.scope_kind ?? "global", "scope_kind");
    const scopeId = scopeKind === "global" ? "global" : text(args.scope_id ?? mod.scope_id, "scope_id");
    const rollout = this.store.find("runtime_mod_rollout", String(mod.id));
    if (mod.origin === "self_evolved" && mod.scope_kind === "global" && rollout?.stage === "global" && scopeKind === "project") {
      const allowedProjects = Array.isArray(rollout.allowed_project_ids) ? rollout.allowed_project_ids as string[] : [];
      if (!allowedProjects.includes(scopeId)) throw new Error("project withdrawal requires an active project authorization");
      const actor = text(args.actor, "actor"), reason = text(args.reason, "reason"), now = new Date().toISOString();
      const approvalId = `runtime_mod_project_approval_${String(mod.id)}_${scopeId}`;
      const approval = this.store.get("runtime_mod_project_approval", approvalId);
      this.store.save("runtime_mod_project_approval", approvalId, { ...approval, status: "withdrawn",
        withdrawn_by: actor, withdrawal_reason: reason, withdrawn_at: now, updated_at: now });
      this.store.save("runtime_mod_rollout", String(mod.id), { ...rollout,
        allowed_project_ids: allowedProjects.filter((projectId) => projectId !== scopeId),
        updated_at: now });
      this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.project_withdrawn", {
        actor, reason, scope_kind: scopeKind, scope_id: scopeId, approval_id: approvalId,
      });
      return { mod, status: "disabled", scope_kind: scopeKind, scope_id: scopeId };
    }
    if (scopeKind !== mod.scope_kind || scopeId !== mod.scope_id) throw new Error("withdraw scope must match the Mod's registered scope");
    const saved = this.store.save("runtime_mod", String(mod.id), { ...mod, enabled: false,
      withdrawn_by: text(args.actor, "actor"), withdrawal_reason: text(args.reason, "reason"),
      withdrawn_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (rollout && rollout.status !== "withdrawn") {
      const actor = text(args.actor, "actor"), reason = text(args.reason, "reason"), now = new Date().toISOString();
      this.store.save("runtime_mod_rollout", String(mod.id), { ...rollout, status: "withdrawn",
        withdrawn_by: actor, withdrawal_reason: reason, withdrawal_scope_kind: scopeKind,
        withdrawal_scope_id: scopeId, withdrawn_at: now, updated_at: now });
      this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.withdrawn", { actor, reason, scope_kind: scopeKind, scope_id: scopeId });
    }
    return { mod: saved, status: "disabled" };
  }

  rolloutStart(args: JsonObject): JsonObject {
    const mod = this.#get(text(args.mod_id, "mod_id"));
    if (mod.origin !== "self_evolved") throw new Error("staged rollout applies only to self-evolved Runtime Mods");
    if (mod.enabled !== true || mod.trust_status !== "trusted" || mod.trusted_code_digest !== mod.code_digest
      || mod.trusted_permission_digest !== mod.permission_digest) throw new Error("exact candidate version must be trusted before rollout");
    const candidate = this.store.find("runtime_mod_candidate", String(mod.id));
    const regression = candidate?.regression_id ? this.store.find("runtime_mod_regression", String(candidate.regression_id)) : null;
    if (!candidate || candidate.status !== "qualified_untrusted" || !regression || regression.verdict !== "passed"
      || regression.code_digest !== mod.code_digest || regression.permission_digest !== mod.permission_digest
      || regression.runtime_version !== MOD_RUNTIME_VERSION || regression.suite !== MOD_REGRESSION_SUITE
      || regression.suite_digest !== regressionSuiteDigest(mod.manifest as JsonObject)
      || Number(regression.sample_count) < Number(regression.min_samples)) {
      throw new Error("candidate requires a current passing fixed regression before staged rollout");
    }
    if (mod.scope_kind !== "task" || !mod.scope_id) throw new Error("self-evolved rollout must start at its repair task scope");
    const existing = this.store.find("runtime_mod_rollout", String(mod.id));
    if (existing && existing.status === "active") return { rollout: existing, idempotent: true };
    const lineageId = String(mod.lineage_id ?? mod.id);
    const previousVersion = this.store.list("runtime_mod", 1_000, (item) => item.id !== mod.id && item.origin === "self_evolved"
      && item.lineage_id === lineageId && item.enabled === true && item.trust_status === "trusted"
      && item.trusted_code_digest === item.code_digest && item.trusted_permission_digest === item.permission_digest)
      .sort((left, right) => String(right.trusted_at ?? "").localeCompare(String(left.trusted_at ?? "")))[0];
    if (previousVersion) {
      try {
        if (packageDigest(String(previousVersion.package_root)) === previousVersion.code_digest
          && permissionDigest(object(previousVersion.manifest, "previous lineage manifest")) === previousVersion.permission_digest) {
          const versionId = `runtime_mod_version_${String(mod.id)}_${digest(`${previousVersion.code_digest}:${previousVersion.permission_digest}`).slice(-16)}`;
          if (!this.store.find("runtime_mod_version", versionId)) {
            const priorManifest = object(previousVersion.manifest, "previous lineage manifest");
            this.store.create("runtime_mod_version", versionId, { mod_id: mod.id, source_mod_id: previousVersion.id,
              code_digest: previousVersion.code_digest, permission_digest: previousVersion.permission_digest,
              snapshot: { ...previousVersion, id: mod.id, manifest: { ...priorManifest, id: mod.id } },
              verified: true, created_at: new Date().toISOString() });
          }
        }
      } catch { /* An unavailable historical package is not eligible as a rollback target. */ }
    }
    const actor = text(args.actor, "actor");
    const now = new Date().toISOString();
    const revalidationDays = args.global_revalidation_days === undefined ? 30 : Number(args.global_revalidation_days);
    if (!Number.isSafeInteger(revalidationDays) || revalidationDays < 1 || revalidationDays > 365) throw new Error("global_revalidation_days must be an integer from 1 to 365");
    const sourceProjectId = String((mod.candidate_provenance as JsonObject | undefined)?.source_project_id ?? "") || null;
    const rollout = this.store.save("runtime_mod_rollout", String(mod.id), {
      id: mod.id, mod_id: mod.id, mod_version: (mod.manifest as JsonObject).version, code_digest: mod.code_digest,
      permission_digest: mod.permission_digest, regression_id: regression.id, regression_digest: regression.suite_digest,
      runtime_version: regression.runtime_version, stage: "task", scope_kind: "task", scope_id: mod.scope_id,
      status: "active", observations: [], minimum_samples: { task: 1, project: 3, global: 5 },
      minimum_projects_for_global: 2, quality_failure_threshold: 0.2, source_project_id: sourceProjectId,
      allowed_project_ids: sourceProjectId ? [sourceProjectId] : [], global_revalidation_days: revalidationDays,
      global_revalidated_at: now, promoted_by: actor, started_at: now, updated_at: now,
    });
    this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.started", { actor, stage: "task", scope_id: mod.scope_id, code_digest: mod.code_digest });
    return { rollout, idempotent: false };
  }

  rolloutGet(args: JsonObject): JsonObject {
    const id = text(args.mod_id, "mod_id");
    const rollout = this.store.find("runtime_mod_rollout", id);
    if (!rollout) throw new Error(`No rollout exists for Runtime Mod: ${id}`);
    const observations = Array.isArray(rollout.observations) ? rollout.observations as JsonObject[] : [];
    const taskCount = new Set(observations.map((item) => String(item.task_id))).size;
    const projectCount = new Set(observations.map((item) => String(item.project_id))).size;
    const minimumSamples = Number((rollout.minimum_samples as JsonObject | undefined)?.[String(rollout.stage)] ?? 0);
    const remainingSamples = Math.max(0, minimumSamples - taskCount);
    const remainingProjects = rollout.stage === "global" && rollout.global_gate_passed !== true
      ? Math.max(0, Number(rollout.minimum_projects_for_global ?? 2) - projectCount) : 0;
    const gateState = rollout.status !== "active" ? String(rollout.pause_reason ?? rollout.status)
      : remainingSamples || remainingProjects ? "collecting_samples" : "gate_ready";
    return { rollout: { ...rollout, gate_progress: { state: gateState, task_samples: taskCount,
      required_task_samples: minimumSamples, remaining_task_samples: remainingSamples,
      project_samples: projectCount, remaining_project_samples: remainingProjects,
      quality_failures: observations.filter((item) => ["rejected", "blocked"].includes(String(item.status))).length,
      quality_failure_threshold: Number(rollout.quality_failure_threshold ?? 0.2) } },
      events: this.store.events(`mod-runtime:${id}`, 1_000) };
  }

  async rolloutAuthorizeProject(args: JsonObject): Promise<JsonObject> {
    const modId = text(args.mod_id, "mod_id"), targetProjectId = text(args.target_project_id, "target_project_id");
    const rollout = this.store.get("runtime_mod_rollout", modId);
    const waitingForSourceApproval = rollout.stage === "global" && rollout.status === "paused" && rollout.pause_reason === "source_approval_required";
    const activeGlobalReuse = rollout.stage === "global" && rollout.status === "active" && rollout.global_gate_passed === true;
    if (!waitingForSourceApproval && !activeGlobalReuse) throw new Error("cross-project authorization is available only at the global rollout stage");
    const sourceProjectId = text(rollout.source_project_id, "rollout.source_project_id");
    if (targetProjectId === sourceProjectId) throw new Error("target project must differ from the source project");
    if (!this.store.find("workspace", targetProjectId)) throw new Error("target project must be a registered Workspace");
    const mod = this.#get(modId);
    if (mod.trust_status !== "trusted" || mod.trusted_code_digest !== mod.code_digest || mod.trusted_permission_digest !== mod.permission_digest
      || packageDigest(String(mod.package_root)) !== rollout.code_digest || permissionDigest(object(mod.manifest, "project authorization manifest")) !== rollout.permission_digest) {
      throw new Error("source Mod changed; renewed review and trust are required before cross-project reuse");
    }
    const actor = text(args.actor, "actor"), reason = text(args.reason, "reason"), now = new Date().toISOString();
    const approvalId = `runtime_mod_project_approval_${modId}_${targetProjectId}`;
    const identity = { mod_id: modId, mod_package_version: (mod.manifest as JsonObject).version,
      code_digest: mod.code_digest, permission_digest: mod.permission_digest,
      source_project_id: sourceProjectId, target_project_id: targetProjectId,
      scope: "event_input_only", data_isolation: "no cross-project reads or persistent Mod state",
      reason, approved_by: actor };
    const identityDigest = digest(JSON.stringify(identity));
    const prior = this.store.find("runtime_mod_project_approval", approvalId);
    if (prior && prior.identity_digest !== identityDigest) throw new Error("project approval idempotency conflict; review the current request");
    const copyPath = resolve(this.store.paths.root, "runtime", "mod-project-copies", digest(`${approvalId}:${identityDigest}`).slice(-24));
    let sanitizedCopy: { digest: string; files: number };
    if (prior) {
      const existingCopyPath = text(prior.package_copy_path, "approval.package_copy_path");
      const copyDigest = packageDigest(existingCopyPath);
      if (copyDigest !== mod.code_digest) throw new Error("the isolated project package copy changed; issue a new reviewed Mod version");
      sanitizedCopy = { digest: copyDigest, files: Number(prior.package_copy_files ?? 0) };
    } else sanitizedCopy = sanitizePackageCopy(String(mod.package_root), copyPath, String(mod.code_digest));
    const approval = prior ?? this.store.create("runtime_mod_project_approval", approvalId, { ...identity, identity_digest: identityDigest,
      package_copy_path: copyPath, package_copy_digest: sanitizedCopy.digest, package_copy_files: sanitizedCopy.files,
      source_data_included: false, sanitizer_version: "craft-mod-package-copy@1",
      approved_at: now, runtime_version: MOD_RUNTIME_VERSION });
    const approvedProjects = Array.isArray(rollout.allowed_project_ids) ? rollout.allowed_project_ids as string[] : [sourceProjectId];
    const allowed = [...new Set([...approvedProjects, targetProjectId])];
    const regression = await this.candidateRegressionRun(modId, "global");
    if (regression.verdict !== "passed") {
      this.#rollbackRollout(modId, rollout, "cross_project_regression_failed", String((regression.regression as JsonObject).id), "regression");
      return { status: "rolled_back", approval, regression };
    }
    if (waitingForSourceApproval) this.store.save("runtime_mod", modId, { ...mod, scope_kind: "global", scope_id: "global", enabled: true, updated_at: now });
    const saved = this.store.save("runtime_mod_rollout", modId, { ...rollout, status: "active", pause_reason: null,
      allowed_project_ids: allowed, project_approval_ids: [...new Set([...(rollout.project_approval_ids as string[] ?? []), approval.id])],
      regression_id: (regression.regression as JsonObject).id, regression_digest: (regression.regression as JsonObject).suite_digest,
      runtime_version: MOD_RUNTIME_VERSION, resumed_by: actor, resumed_at: now, updated_at: now });
    this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.project_authorized", { actor, reason,
      source_project_id: sourceProjectId, target_project_id: targetProjectId, approval_id: approval.id,
      code_digest: mod.code_digest, permission_digest: mod.permission_digest });
    return { status: "active", rollout: saved, approval, regression };
  }

  rolloutPause(args: JsonObject): JsonObject {
    const modId = text(args.mod_id, "mod_id");
    const rollout = this.store.get("runtime_mod_rollout", modId);
    if (rollout.status !== "active") throw new Error("only an active Mod rollout can be paused");
    const actor = text(args.actor, "actor"), reason = text(args.reason, "reason"), now = new Date().toISOString();
    const mod = this.#get(modId);
    this.store.save("runtime_mod", modId, { ...mod, enabled: false, updated_at: now });
    const saved = this.store.save("runtime_mod_rollout", modId, { ...rollout, status: "paused", paused_by: actor,
      pause_reason: reason, paused_at: now, updated_at: now });
    this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.paused", { actor, reason, stage: rollout.stage, scope_id: rollout.scope_id });
    return { rollout: saved };
  }

  async rolloutResume(args: JsonObject): Promise<JsonObject> {
    const modId = text(args.mod_id, "mod_id");
    const rollout = this.store.get("runtime_mod_rollout", modId);
    if (rollout.status !== "paused") throw new Error("only a paused Mod rollout can resume");
    if (rollout.pause_reason === "source_approval_required") throw new Error("approve the target project through the source-approval route before resuming global canary");
    const mod = this.#get(modId);
    if (mod.trust_status !== "trusted" || mod.trusted_code_digest !== mod.code_digest || mod.trusted_permission_digest !== mod.permission_digest
      || packageDigest(String(mod.package_root)) !== rollout.code_digest || permissionDigest(object(mod.manifest, "resume manifest")) !== rollout.permission_digest) {
      throw new Error("paused Mod code or permissions changed; renewed review and trust are required");
    }
    const regression = await this.candidateRegressionRun(modId, String(rollout.stage));
    if (regression.verdict !== "passed") {
      this.#rollbackRollout(modId, rollout, "resume_regression_failed", String((regression.regression as JsonObject).id), "regression");
      return { status: "rolled_back", regression };
    }
    const actor = text(args.actor, "actor"), now = new Date().toISOString();
    this.store.save("runtime_mod", modId, { ...mod, enabled: true, updated_at: now });
    const saved = this.store.save("runtime_mod_rollout", modId, { ...rollout, status: "active", resumed_by: actor,
      regression_id: (regression.regression as JsonObject).id, regression_digest: (regression.regression as JsonObject).suite_digest,
      runtime_version: MOD_RUNTIME_VERSION, resumed_at: now, pause_reason: null, updated_at: now });
    this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.resumed", { actor, stage: rollout.stage, scope_id: rollout.scope_id, regression_id: (regression.regression as JsonObject).id });
    return { status: "active", rollout: saved, regression };
  }

  async approvalStrategy(action: string, effect: string, args: JsonObject): Promise<"allow" | "deny" | null> {
    const policy = this.store.find("mod_approval_policy", "global");
    if (!policy || !Array.isArray(policy.allowed_actions) || !policy.allowed_actions.includes(action)) return null;
    const taskId = typeof args.task_id === "string" ? args.task_id : "";
    const task = taskId ? this.store.find("task", taskId) : null;
    const projectId = String(args.project_id ?? args.workspace_id ?? task?.workspace_id ?? task?.project_id ?? "");
    const scope = taskId ? { scope_kind: "task", scope_id: taskId, task_id: taskId, ...(projectId ? { project_id: projectId } : {}) }
      : projectId ? { scope_kind: "project", scope_id: projectId, project_id: projectId } : { scope_kind: "global", scope_id: "global" };
    const decision = await this.dispatch({ event: "craft.approval.decide@1", ...scope,
      input: { action, effect, input_digest: digest(JSON.stringify(args)) } });
    const result = decision.result as JsonObject;
    return result && (result.approval_decision === "allow" || result.approval_decision === "deny")
      ? result.approval_decision : null;
  }

  async dispatch(args: JsonObject): Promise<JsonObject> {
    const eventName = text(args.event, "event");
    if (!EVENT_ID.test(eventName)) throw new Error("event must include an event version");
    const contract = modEventContract(eventName);
    if (!contract) throw new Error(`Unsupported Mod event: ${eventName}`);
    const host = args.host === undefined ? null : text(args.host, "host");
    if (host && !contract.hosts.includes(host)) return { status: "unsupported", reason: "host_not_supported", event: eventName, host, supported_hosts: [...contract.hosts] };
    const platform = args.platform === undefined ? process.platform : text(args.platform, "platform");
    if (!contract.platforms.includes(platform)) return { status: "unsupported", reason: "platform_not_supported", event: eventName, platform, supported_platforms: [...contract.platforms] };
    let current = object(args.input, "input");
    const extraInputFields = Object.keys(current).filter((key) => !contract.input_fields.includes(key));
    if (extraInputFields.length) throw new Error(`Event input has unsupported fields: ${extraInputFields.join(", ")}`);
    const scope = { scope_kind: args.scope_kind ?? "global", scope_id: args.scope_id ?? "global",
      ...(args.task_id === undefined ? {} : { task_id: args.task_id }),
      ...(args.project_id === undefined ? {} : { project_id: args.project_id }) } as JsonObject;
    const deliveryId = args.delivery_id === undefined ? null : text(args.delivery_id, "delivery_id");
    const deliveryDigest = digest(JSON.stringify({ event: eventName, scope, host, platform, input: current }));
    if (deliveryId) {
      const existing = this.store.find("mod_runtime_delivery", deliveryId);
      if (existing) {
        if (existing.identity_digest !== deliveryDigest) throw new Error("Mod event delivery idempotency conflict");
        const priorReceipt = this.store.find("mod_runtime_receipt", String(existing.receipt_id));
        if (!priorReceipt) throw new Error("Mod event delivery receipt is missing");
        return { status: priorReceipt.status, result: priorReceipt.result, receipt: priorReceipt, idempotent: true };
      }
    }
    const approvalPolicy = eventName === "craft.approval.decide@1" ? this.store.find("mod_approval_policy", "global") : null;
    const requestedApprovalAction = typeof current.action === "string" ? current.action : "";
    const approvalActionAllowed = eventName !== "craft.approval.decide@1"
      || (Array.isArray(approvalPolicy?.allowed_actions) && approvalPolicy.allowed_actions.includes(requestedApprovalAction));
    const mods = this.store.list("runtime_mod", 1_000, (mod) => approvalActionAllowed && mod.enabled === true && mod.trust_status === "trusted"
      && this.#inScope(mod, scope) && Array.isArray((mod.manifest as JsonObject).hooks)
      && ((mod.manifest as JsonObject).hooks as JsonObject[]).some((hook) => hook.event === eventName))
      .sort((left, right) => hookOrder(left, eventName) - hookOrder(right, eventName) || String(left.id).localeCompare(String(right.id)));
    const execution: JsonObject[] = [];
    let failure: string | null = null;
    for (const mod of mods) {
      const executionPackageRoot = this.#executionPackageRoot(mod, scope);
      if (!executionPackageRoot) continue;
      const actualCode = packageDigest(executionPackageRoot);
      const actualPermissions = permissionDigest(object(mod.manifest, "stored manifest"));
      if (actualCode !== mod.trusted_code_digest || actualPermissions !== mod.trusted_permission_digest) {
        this.store.save("runtime_mod", String(mod.id), { ...mod, enabled: false, trust_status: "review_required", updated_at: new Date().toISOString() });
        if (mod.origin === "self_evolved") this.#pauseChangedRollout(String(mod.id), "qualification_identity_changed");
        throw new Error("Mod code or permissions changed; review required before execution");
      }
      const hook = ((mod.manifest as JsonObject).hooks as JsonObject[]).find((item) => item.event === eventName);
      if (!hook) continue;
      let sandboxResult;
      let result: HookOutcome;
      try {
        sandboxResult = await executeModHook(executionPackageRoot, object(mod.manifest, "stored manifest"), eventName,
          current, Number(hook.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS));
        result = this.#normalizeResult(sandboxResult.value, String(hook.capability));
      } catch (error) {
        failure = error instanceof Error ? error.message.slice(0, 500) : "Mod Hook failed";
        execution.push({ mod_id: mod.id, version: mod.version, event: eventName, order: hookOrder(mod, eventName), result: "failed", sandbox: "quickjs-wasm" });
        if (mod.origin === "self_evolved") this.store.save("runtime_mod", String(mod.id), { ...mod,
          enabled: false, trust_status: "review_required", safety_disabled_at: new Date().toISOString(),
          safety_disable_reason: "self_evolved_hook_failure", updated_at: new Date().toISOString() });
        break;
      }
      execution.push({ mod_id: mod.id, version: mod.version, event: eventName, order: hookOrder(mod, eventName), result: result.kind,
        sandbox: sandboxResult.sandbox, elapsed_ms: sandboxResult.elapsed_ms });
      if (result.kind === "patch") {
        const invalidFields = Object.keys(result.patch).filter((field) => !contract.patch_fields.includes(field));
        if (invalidFields.length) {
          failure = `Mod patch contains unsupported fields: ${invalidFields.join(", ")}`;
          execution[execution.length - 1] = { ...execution[execution.length - 1]!, result: "failed" };
          break;
        }
        current = { ...current, ...result.patch };
      }
      if (result.kind === "approval") {
        current = { ...current, approval_decision: result.decision };
        break;
      }
      if (result.kind === "reject") break;
      if (result.kind === "takeover") { current = result.result; break; }
    }
    const outcome = failure ? "failed" : execution.some((item) => item.result === "reject") ? "rejected" : "completed";
    const receipt = this.store.create("mod_runtime_receipt", `mod_receipt_${randomUUID().replaceAll("-", "")}`, {
      event: eventName, event_version: Number(eventName.slice(eventName.lastIndexOf("@") + 1)), host, platform, scope, task_id: scope.task_id ?? current.task_id ?? null, delivery_id: deliveryId,
      status: outcome, failure_reason: failure, execution, result: current, created_at: new Date().toISOString(),
    });
    if (deliveryId) this.store.create("mod_runtime_delivery", deliveryId, { id: deliveryId, identity_digest: deliveryDigest, receipt_id: receipt.id, created_at: new Date().toISOString() });
    await this.#observeRollouts(receipt);
    return { status: outcome, failure_reason: failure, result: current, receipt };
  }

  async #observeRollouts(receipt: JsonObject): Promise<void> {
    const modIds = [...new Set((receipt.execution as JsonObject[]).map((item) => String(item.mod_id)))];
    for (const modId of modIds) {
      const rollout = this.store.find("runtime_mod_rollout", modId);
      if (!rollout || rollout.status !== "active") continue;
      const mod = this.store.find("runtime_mod", modId);
      if (!mod || (mod.manifest as JsonObject).version !== rollout.mod_version || mod.code_digest !== rollout.code_digest
        || mod.permission_digest !== rollout.permission_digest || packageDigest(String(mod.package_root)) !== rollout.code_digest
        || permissionDigest(object(mod.manifest, "rollout manifest")) !== rollout.permission_digest
        || rollout.runtime_version !== MOD_RUNTIME_VERSION || rollout.regression_digest !== regressionSuiteDigest(mod.manifest as JsonObject)) {
        if (mod) this.store.save("runtime_mod", modId, { ...mod, enabled: false, trust_status: "review_required", updated_at: new Date().toISOString() });
        this.store.save("runtime_mod_rollout", modId, { ...rollout, status: "paused", pause_reason: "qualification_identity_changed", paused_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.paused", { reason: "qualification_identity_changed", receipt_id: receipt.id });
        continue;
      }
      if (receipt.status !== "completed") {
        this.#rollbackRollout(modId, rollout, receipt.status === "failed" ? "safety_regression" : "quality_regression", String(receipt.id));
        continue;
      }
      if (receipt.event !== "craft.task.lifecycle@1") continue;
      const eventInput = receipt.result as JsonObject | undefined;
      if (!eventInput) continue;
      const taskRunId = String(eventInput.task_run_id ?? "");
      const deliveryId = String(eventInput.delivery_id ?? "");
      const taskRun = taskRunId ? this.store.find("task_run", taskRunId) : null;
      const launch = taskRun?.launch_id ? this.store.find("work_launch", String(taskRun.launch_id)) : null;
      const hostRun = launch?.run_id ? this.store.find("host_run", String(launch.run_id)) : null;
      const delivery = deliveryId ? this.store.find("work_delivery", deliveryId) : null;
      const taskRunState = taskRun ? this.store.find("task_run_state", `task_run_state_${taskRun.id}`) : null;
      const authoritativeTaskId = String((taskRun?.launch_identity as JsonObject | undefined)?.task_id ?? "");
      const task = authoritativeTaskId ? this.store.find("task", authoritativeTaskId) : null;
      const actualProjectId = String(task?.workspace_id ?? task?.project_id ?? "");
      if (!taskRun || !launch || !hostRun || !delivery || !taskRunState || !task || authoritativeTaskId !== String(eventInput.task_id)
        || taskRunState.task_run_version !== taskRun.version || taskRunState.status !== eventInput.status
        || taskRunState.action !== eventInput.action
        || launch.id !== taskRun.launch_id || launch.task_id !== authoritativeTaskId
        || hostRun.id !== launch.run_id || !["completed", "succeeded"].includes(String(hostRun.status))
        || delivery.launch_id !== launch.id || delivery.run_id !== hostRun.id
        || delivery.launch_version !== launch.version || delivery.run_version !== hostRun.version
        || !actualProjectId || actualProjectId !== String((receipt.scope as JsonObject | undefined)?.project_id ?? "")) continue;
      if (!["ready_for_delivery", "accepted", "rejected", "blocked"].includes(String(delivery.status))) continue;
      const taskId = String(receipt.task_id ?? "");
      const projectId = String((receipt.scope as JsonObject | undefined)?.project_id ?? "");
      if (!taskId || !projectId) continue;
      const observations = Array.isArray(rollout.observations) ? rollout.observations as JsonObject[] : [];
      if (observations.some((item) => item.receipt_id === receipt.id)) continue;
      const deliveryStatus = String(delivery.status);
      const nextObservations = [...observations, { receipt_id: receipt.id, delivery_id: delivery.id,
        task_id: taskId, project_id: projectId, status: deliveryStatus }];
      const tasks = new Set(nextObservations.map((item) => String(item.task_id)));
      const projects = new Set(nextObservations.map((item) => String(item.project_id)));
      const sourceProjectId = String(rollout.source_project_id ?? (rollout.stage === "task" ? projectId : "")) || null;
      const qualityFailures = nextObservations.filter((item) => ["rejected", "blocked"].includes(String(item.status))).length;
      const qualityThreshold = Number(rollout.quality_failure_threshold ?? 0.2);
      if (tasks.size >= Number((rollout.minimum_samples as JsonObject | undefined)?.[String(rollout.stage)] ?? 1)
        && qualityFailures / tasks.size > qualityThreshold) {
        this.#rollbackRollout(modId, rollout, "quality_regression", String(delivery.id), "work_delivery");
        continue;
      }
      const stageRegression = await this.candidateRegressionRun(modId, String(rollout.stage));
      if (stageRegression.verdict !== "passed") {
        this.#rollbackRollout(modId, rollout, "stage_regression_failed", String(receipt.id));
        continue;
      }
      let nextStage: string | null = null;
      let nextKind: string | null = null;
      let nextScope = "global";
      if (rollout.stage === "task" && tasks.size >= 1) { nextStage = "project"; nextKind = "project"; nextScope = projectId; }
      else if (rollout.stage === "project" && tasks.size >= 3) { nextStage = "global"; nextKind = "global"; }
      else if (rollout.stage === "global" && tasks.size >= 5 && projects.size >= 2) {
        const history = Array.isArray(rollout.stage_history) ? rollout.stage_history as JsonObject[] : [];
        history.push({ stage: "global", scope_kind: "global", scope_id: "global", observations: nextObservations, passed_at: new Date().toISOString() });
        this.store.save("runtime_mod_rollout", modId, { ...rollout, observations: [], stage_history: history,
          status: "active", global_gate_passed: true, global_revalidated_at: new Date().toISOString(),
          regression_id: (stageRegression.regression as JsonObject).id,
          regression_digest: (stageRegression.regression as JsonObject).suite_digest, runtime_version: MOD_RUNTIME_VERSION,
          stage_passed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.global_gate_passed", { receipt_id: receipt.id, task_samples: tasks.size, project_samples: projects.size });
        continue;
      }
      if (!nextStage) {
        this.store.save("runtime_mod_rollout", modId, { ...rollout, observations: nextObservations, updated_at: new Date().toISOString() });
        continue;
      }
      if (nextStage === "global") {
        const stageHistory = Array.isArray(rollout.stage_history) ? rollout.stage_history as JsonObject[] : [];
        stageHistory.push({ stage: "project", scope_kind: "project", scope_id: rollout.scope_id,
          observations: nextObservations, passed_at: new Date().toISOString() });
        this.store.save("runtime_mod_rollout", modId, { ...rollout, stage: "global", scope_kind: "global", scope_id: "global",
          observations: [], stage_history: stageHistory, status: "paused", pause_reason: "source_approval_required",
          source_project_id: sourceProjectId, allowed_project_ids: sourceProjectId ? [sourceProjectId] : [],
          source_approval_required: true, paused_at: new Date().toISOString(), updated_at: new Date().toISOString() });
        this.store.save("runtime_mod", modId, { ...mod, enabled: false, updated_at: new Date().toISOString() });
        this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.awaiting_source_approval", { stage: "global",
          source_project_id: sourceProjectId, receipt_id: receipt.id });
        continue;
      }
      const modScope = nextKind === "global" ? { scope_kind: "global", scope_id: "global" }
        : { scope_kind: nextKind, scope_id: nextScope };
      this.store.save("runtime_mod", modId, { ...mod, ...modScope, updated_at: new Date().toISOString() });
      const stageHistory = Array.isArray(rollout.stage_history) ? rollout.stage_history as JsonObject[] : [];
      stageHistory.push({ stage: rollout.stage, scope_kind: rollout.scope_kind, scope_id: rollout.scope_id,
        observations: nextObservations, passed_at: new Date().toISOString() });
      this.store.save("runtime_mod_rollout", modId, { ...rollout, observations: [], stage_history: stageHistory,
        stage: nextStage, scope_kind: nextKind, scope_id: nextScope, source_project_id: sourceProjectId,
        regression_id: (stageRegression.regression as JsonObject).id,
        regression_digest: (stageRegression.regression as JsonObject).suite_digest, runtime_version: MOD_RUNTIME_VERSION,
        updated_at: new Date().toISOString() });
      this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.promoted", { from: rollout.stage, to: nextStage,
        scope_id: nextScope, receipt_id: receipt.id, task_samples: tasks.size });
    }
  }

  #rollbackRollout(modId: string, rollout: JsonObject, reason: string, triggerReferenceId: string, triggerKind = "runtime_receipt"): void {
    const versions = this.store.list("runtime_mod_version", 1_000, (item) => item.mod_id === modId && item.verified === true)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    let rollbackTarget: string | null = null;
    for (const item of versions) {
      const snapshot = item.snapshot as JsonObject;
      try {
        if (packageDigest(String(snapshot.package_root)) !== item.code_digest
          || permissionDigest(object(snapshot.manifest, "rollback manifest")) !== item.permission_digest
          || snapshot.trusted_code_digest !== item.code_digest || snapshot.trusted_permission_digest !== item.permission_digest) continue;
        this.store.save("runtime_mod", modId, { ...snapshot, enabled: true, trust_status: "trusted", updated_at: new Date().toISOString() });
        rollbackTarget = String(item.code_digest);
        break;
      } catch { /* An unavailable or changed historical package is not a rollback target. */ }
    }
    if (!rollbackTarget) {
      const mod = this.store.find("runtime_mod", modId);
      if (mod) this.store.save("runtime_mod", modId, { ...mod, enabled: false, updated_at: new Date().toISOString() });
    }
    this.store.save("runtime_mod_rollout", modId, { ...rollout, status: "rolled_back", reason,
      trigger_kind: triggerKind, trigger_reference_id: triggerReferenceId,
      ...(triggerKind === "runtime_receipt" ? { triggering_receipt_id: triggerReferenceId } : {}), rollback_target_digest: rollbackTarget,
      rolled_back_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.rolled_back", { reason, trigger_kind: triggerKind,
      trigger_reference_id: triggerReferenceId, rollback_target_digest: rollbackTarget });
  }

  #get(id: string): JsonObject {
    const mod = this.store.find("runtime_mod", id);
    if (!mod) throw new Error(`Unknown runtime Mod: ${id}`);
    return mod;
  }

  #pauseChangedRollout(modId: string, reason: string): void {
    const rollout = this.store.find("runtime_mod_rollout", modId);
    if (!rollout || rollout.status !== "active") return;
    const now = new Date().toISOString();
    this.store.save("runtime_mod_rollout", modId, { ...rollout, status: "paused", pause_reason: reason,
      paused_at: now, updated_at: now });
    this.store.appendEvent(`mod-runtime:${modId}`, "mod.rollout.paused", { reason, stage: rollout.stage });
  }

  #executionPackageRoot(mod: JsonObject, scope: JsonObject): string | null {
    if (mod.origin !== "self_evolved") return String(mod.package_root);
    const rollout = this.store.find("runtime_mod_rollout", String(mod.id));
    if (rollout?.stage !== "global") return String(mod.package_root);
    const projectId = String(scope.project_id ?? (scope.task_id
      ? this.store.find("task", String(scope.task_id))?.workspace_id ?? this.store.find("task", String(scope.task_id))?.project_id ?? ""
      : ""));
    if (!projectId || projectId === String(rollout.source_project_id ?? "")) return String(mod.package_root);
    const approvalId = `runtime_mod_project_approval_${String(mod.id)}_${projectId}`;
    const approval = this.store.find("runtime_mod_project_approval", approvalId);
    if (!approval || approval.status === "withdrawn" || approval.code_digest !== mod.code_digest || approval.permission_digest !== mod.permission_digest
      || approval.package_copy_digest !== mod.code_digest || approval.source_data_included !== false) return null;
    try {
      const copyPath = text(approval.package_copy_path, "approval.package_copy_path");
      if (packageDigest(copyPath) !== mod.code_digest) {
        this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.project_copy_unavailable", {
          project_id: projectId, approval_id: approval.id, code_digest: mod.code_digest, reason: "copy_digest_changed",
        });
        return null;
      }
      return copyPath;
    } catch {
      this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.project_copy_unavailable", {
        project_id: projectId, approval_id: approval.id, code_digest: mod.code_digest,
      });
      return null;
    }
  }

  #inScope(mod: JsonObject, scope: JsonObject): boolean {
    if (mod.origin !== "self_evolved") return sameScope(mod, scope);
    const rollout = this.store.find("runtime_mod_rollout", String(mod.id));
    if (!rollout || rollout.status !== "active") return false;
    if (rollout.runtime_version !== MOD_RUNTIME_VERSION || rollout.regression_digest !== regressionSuiteDigest(mod.manifest as JsonObject)) {
      const now = new Date().toISOString();
      this.store.save("runtime_mod", String(mod.id), { ...mod, enabled: false, updated_at: now });
      this.store.save("runtime_mod_rollout", String(mod.id), { ...rollout, status: "paused",
        pause_reason: "qualification_runtime_changed", paused_at: now, updated_at: now });
      this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.paused", { reason: "qualification_runtime_changed", stage: rollout.stage });
      return false;
    }
    if (rollout.stage === "global") {
      const projectId = String(scope.project_id ?? (scope.task_id ? this.store.find("task", String(scope.task_id))?.workspace_id ?? "" : ""));
      const allowedProjects = Array.isArray(rollout.allowed_project_ids) ? rollout.allowed_project_ids as string[] : [];
      if (!projectId || !allowedProjects.includes(projectId) || !this.#executionPackageRoot(mod, scope)) return false;
    }
    if (rollout.stage === "global" && rollout.global_gate_passed === true) {
      const intervalDays = Number(rollout.global_revalidation_days ?? 30);
      const revalidatedAt = Date.parse(String(rollout.global_revalidated_at ?? rollout.started_at));
      if (!Number.isFinite(revalidatedAt) || Date.now() - revalidatedAt > intervalDays * 24 * 60 * 60 * 1_000) {
        const now = new Date().toISOString();
        this.store.save("runtime_mod", String(mod.id), { ...mod, enabled: false, updated_at: now });
        this.store.save("runtime_mod_rollout", String(mod.id), { ...rollout, status: "paused",
          pause_reason: "global_revalidation_due", paused_at: now, updated_at: now });
        this.store.appendEvent(`mod-runtime:${mod.id}`, "mod.rollout.paused", { reason: "global_revalidation_due", stage: "global" });
        return false;
      }
    }
    return sameScope(mod, scope);
  }

  #normalizeResult(value: unknown, capability: string): HookOutcome {
    if (value === undefined || value === null || (typeof value === "object" && !Array.isArray(value) && (value as JsonObject).kind === "continue")) return { kind: "continue" };
    const result = object(value, "Hook result");
    const kind = text(result.kind, "Hook result.kind");
    if (kind === "continue") return { kind };
    if (kind === "patch") {
      if (capability !== "event.patch") throw new Error("Hook returned patch without event.patch capability");
      return { kind, patch: object(result.patch, "Hook result.patch") };
    }
    if (kind === "reject") {
      if (capability !== "event.reject") throw new Error("Hook returned reject without event.reject capability");
      return { kind, reason: typeof result.reason === "string" ? result.reason.slice(0, 500) : "rejected by Mod" };
    }
    if (kind === "takeover") {
      if (capability !== "event.takeover") throw new Error("Hook returned takeover without event.takeover capability");
      return { kind, result: object(result.result, "Hook result.result") };
    }
    if (kind === "approval") {
      if (capability !== "approval.strategy") throw new Error("Hook returned approval without approval.strategy capability");
      const decision = text(result.decision, "Hook result.decision");
      if (decision !== "allow" && decision !== "deny") throw new Error("approval decision must be allow or deny");
      return { kind: "approval", decision };
    }
    throw new Error("Unsupported Hook result");
  }
}
