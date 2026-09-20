import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { canonicalJson, stableDigest, payload } from "./digest.ts";

const KIT_ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const SURFACES = new Set(["skill", "mcp", "cli", "plugin"]);
const PHASES = new Set(["intent.enrich", "clarify.propose", "plan.propose", "activation.resolve", "preflight.check", "execute.adapter", "observe.snapshot", "accept.evaluate", "instrument.emit", "learn.propose"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]/iu;


function strings(value: unknown, name: string, allowed?: Set<string>): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length || (allowed && result.some((item) => !allowed.has(item)))) {
    throw new Error(`${name} must contain supported unique values`);
  }
  return [...result].sort();
}
function optionalStrings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}

function assertNoSecret(value: unknown, name: string): void {
  if (typeof value === "string" && SECRET.test(value)) throw new Error(`${name} must not contain credentials or secrets`);
  if (Array.isArray(value)) value.forEach((item) => assertNoSecret(item, name));
  if (value && typeof value === "object") Object.values(value as JsonObject).forEach((item) => assertNoSecret(item, name));
}

type Manifest = JsonObject & { id: string; manifest_version: string; depends_on: JsonObject[]; hooks: string[] };

/**
 * The installable capability boundary. This module validates and projects Kits,
 * but never loads third-party code or gives an installed Kit execution power.
 */
export class CapabilityKitRuntime {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  install(args: JsonObject): JsonObject {
    const manifest = this.manifest(object(args.manifest, "manifest"));
    const existing = this.store.find("capability_kit", manifest.id);
    if (existing && existing.manifest_version === manifest.manifest_version) {
      if (existing.manifest_digest !== stableDigest(manifest)) throw new Error("Capability Kit version digest conflicts with installed Kit");
      return { kit: existing, idempotent: true };
    }
    this.dependencies(manifest.depends_on);
    const origin = text(args.origin ?? (args.builtin === true ? "builtin" : "local"), "origin");
    assertNoSecret(origin, "origin");
    const kit = this.store.save("capability_kit", manifest.id, {
      manifest, manifest_version: manifest.manifest_version, manifest_digest: stableDigest(manifest), status: "installed",
      origin, built_in: args.builtin === true,
    });
    this.store.appendEvent(`capability-kit:${kit.id}`, "kit.installed", { kit_id: kit.id, version: kit.version, manifest_digest: kit.manifest_digest });
    return { kit, idempotent: false };
  }

  installBuiltins(): JsonObject {
    const kits = [
      this.install({ builtin: true, manifest: builtin("builtin.serena-project-knowledge", "Serena project knowledge", ["project_knowledge"], ["read_only"], ["discover", "resolve"], ["activation.resolve", "instrument.emit"]) }).kit,
      this.install({ builtin: true, manifest: builtin("builtin.local-workspace", "Local file and code workspace", ["state_workspace", "file_delivery"], ["read_only", "local_write"], ["observe", "accept"], ["preflight.check", "observe.snapshot", "accept.evaluate", "instrument.emit"]) }).kit,
    ];
    return { kits };
  }

  get(args: JsonObject): JsonObject { return { kit: this.store.get("capability_kit", text(args.kit_id, "kit_id"), args.version === undefined ? undefined : Number(args.version)) }; }
  list(args: JsonObject): JsonObject {
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer between 1 and 100");
    return { kits: this.store.list("capability_kit", limit) };
  }

  activate(args: JsonObject): JsonObject {
    const kit = this.store.get("capability_kit", text(args.kit_id, "kit_id"));
    const taskId = text(args.task_id, "task_id");
    const reason = this.activationBlockReason(kit, taskId);
    const activationId = String(args.activation_id ?? `kit_activation_${kit.id}_${taskId}`);
    const identity = { kit_id: kit.id, kit_version: kit.version, task_id: taskId, manifest_digest: kit.manifest_digest, activation_profile_id: args.activation_profile_id ?? null };
    const existing = this.store.find("capability_kit_activation", activationId);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Capability Kit activation idempotency conflict");
      return { activation: existing, idempotent: true };
    }
    const activation = this.store.create("capability_kit_activation", activationId, { ...identity, identity_digest: stableDigest(identity), status: reason ? "blocked" : "active", reason });
    this.store.appendEvent(`capability-kit:${kit.id}`, "kit.activation", { activation_id: activation.id, task_id: taskId, status: activation.status });
    return { activation, idempotent: false };
  }

  contributionRecord(args: JsonObject): JsonObject {
    const kit = this.store.get("capability_kit", text(args.kit_id, "kit_id"));
    const activation = this.store.get("capability_kit_activation", text(args.activation_id, "activation_id"));
    if (activation.kit_id !== kit.id || activation.kit_version !== kit.version || activation.status !== "active" || kit.status !== "installed") throw new Error("Capability Kit is not active for this contribution");
    const phase = text(args.phase, "phase"); const manifest = object(kit.manifest, "kit.manifest");
    if (!(manifest.hooks as string[]).includes(phase)) throw new Error("Capability Kit phase is not declared");
    const proposal = object(args.proposal, "proposal"); assertNoSecret(proposal, "proposal");
    const evidenceIds = optionalStrings(args.evidence_ids, "evidence_ids");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const contributionId = String(args.contribution_id ?? `kit_contribution_${randomUUID().replaceAll("-", "")}`);
    const contribution = this.store.create("capability_kit_contribution", contributionId, {
      kit_id: kit.id, kit_version: kit.version, activation_id: activation.id, activation_version: activation.version,
      phase, proposal_digest: stableDigest(proposal), proposal_keys: Object.keys(proposal).sort(), evidence_ids: evidenceIds, raw_content_stored: false,
    });
    this.store.appendEvent(`capability-kit:${kit.id}`, "kit.contribution", { contribution_id: contribution.id, phase, proposal_digest: contribution.proposal_digest });
    return { contribution };
  }

  setState(args: JsonObject): JsonObject {
    const kit = this.store.get("capability_kit", text(args.kit_id, "kit_id"));
    const state = text(args.state, "state"); if (!new Set(["disabled", "revoked"]).has(state)) throw new Error("Capability Kit state is unsupported");
    const reason = text(args.reason, "reason"); assertNoSecret(reason, "reason");
    if (kit.status === state) return { kit, invalidations: [], idempotent: true };
    const updated = this.store.save("capability_kit", String(kit.id), { ...payload(kit), status: state, state_actor: text(args.actor, "actor"), state_reason_digest: stableDigest(reason) });
    const affected = this.affectedKitIds(String(kit.id));
    const invalidations = this.store.list("capability_kit_activation", 100_000, (item) => affected.has(String(item.kit_id)) && item.status === "active")
      .map((activation) => this.store.save("capability_kit_activation", String(activation.id), { ...payload(activation), status: "needs_replan", reason: `kit_${state}` }));
    this.store.appendEvent(`capability-kit:${kit.id}`, `kit.${state}`, { kit_id: kit.id, invalidated_activation_ids: invalidations.map((item) => item.id) });
    return { kit: updated, invalidations, idempotent: false };
  }

  conformance(args: JsonObject): JsonObject {
    const kit = this.store.get("capability_kit", text(args.kit_id, "kit_id"));
    const findings = this.conformanceFindings(kit);
    const reportId = String(args.report_id ?? `kit_conformance_${kit.id}_${kit.version}`);
    const identity = { kit_id: kit.id, kit_version: kit.version, manifest_digest: kit.manifest_digest, findings };
    const existing = this.store.find("capability_kit_conformance", reportId);
    if (existing) { if (existing.identity_digest !== stableDigest(identity)) throw new Error("Capability Kit conformance idempotency conflict"); return { report: existing, idempotent: true }; }
    const report = this.store.create("capability_kit_conformance", reportId, { ...identity, identity_digest: stableDigest(identity), verdict: findings.length ? "failed" : "passed", mechanism_only: true, raw_content_stored: false });
    return { report, idempotent: false };
  }

  distribution(args: JsonObject): JsonObject {
    const kit = this.store.get("capability_kit", text(args.kit_id, "kit_id"));
    const manifest = object(kit.manifest, "kit.manifest");
    const descriptors: Record<string, JsonObject> = {
      skill: { kind: "instruction", activation: "craft_capability_kit_activate" },
      mcp: { kind: "descriptor", resource: "capability_kit", dynamic: true },
      cli: { kind: "descriptor", command: "craft kit describe" },
      plugin: { kind: "descriptor", requires_core_mcp: true },
    };
    const surfaces = [...(manifest.surfaces as string[])].sort();
    return { distribution: {
      kit_id: kit.id,
      kit_version: kit.version,
      manifest_version: kit.manifest_version,
      manifest_digest: kit.manifest_digest,
      surfaces,
      descriptors: Object.fromEntries(surfaces.map((surface) => [surface, descriptors[surface]])),
      execution_authority: false,
    } };
  }

  private manifest(input: JsonObject): Manifest {
    assertNoSecret(input, "manifest"); const id = text(input.id, "manifest.id"); if (!KIT_ID.test(id)) throw new Error("manifest.id is unsupported");
    const manifestVersion = text(input.version, "manifest.version"); if (!SEMVER.test(manifestVersion)) throw new Error("manifest.version must be semantic version");
    const compatibility = text(input.compatibility, "manifest.compatibility"); if (!/^\^\d+\.\d+\.\d+$/u.test(compatibility)) throw new Error("manifest.compatibility must be a caret semantic version");
    const dependsOn = input.depends_on === undefined ? [] : this.dependencyDeclarations(input.depends_on);
    return { id, manifest_version: manifestVersion, name: text(input.name, "manifest.name"), description: text(input.description, "manifest.description"), compatibility,
      depends_on: dependsOn, provides: strings(input.provides, "manifest.provides"), effects: strings(input.effects, "manifest.effects", EFFECTS), data_scopes: strings(input.data_scopes, "manifest.data_scopes"),
      entrypoints: strings(input.entrypoints, "manifest.entrypoints"), hooks: strings(input.hooks, "manifest.hooks", PHASES), surfaces: strings(input.surfaces, "manifest.surfaces", SURFACES),
      healthcheck: text(input.healthcheck, "manifest.healthcheck"), eval_suite: text(input.eval_suite, "manifest.eval_suite") };
  }

  private dependencyDeclarations(value: unknown): JsonObject[] {
    if (!Array.isArray(value)) throw new Error("manifest.depends_on must be an array");
    const result = value.map((item) => { const dependency = object(item, "manifest.depends_on item"); const kitId = text(dependency.kit_id, "manifest.depends_on.kit_id"); const manifestVersion = text(dependency.manifest_version, "manifest.depends_on.manifest_version"); if (!KIT_ID.test(kitId) || !SEMVER.test(manifestVersion)) throw new Error("manifest dependency is invalid"); return { kit_id: kitId, manifest_version: manifestVersion }; });
    if (new Set(result.map((item) => item.kit_id)).size !== result.length) throw new Error("manifest.depends_on must not repeat a Kit");
    return result.sort((left, right) => String(left.kit_id).localeCompare(String(right.kit_id)));
  }

  private dependencies(dependencies: JsonObject[]): void {
    for (const dependency of dependencies) { const kit = this.store.find("capability_kit", String(dependency.kit_id)); if (!kit || kit.status !== "installed" || kit.manifest_version !== dependency.manifest_version) throw new Error("Capability Kit dependency is unavailable or drifted"); }
  }
  private activationBlockReason(kit: JsonObject, taskId: string): string | null {
    if (!this.store.find("task", taskId)) return "Task does not exist";
    if (kit.status !== "installed") return "Capability Kit is not installed";
    try { this.dependencies(object(kit.manifest, "kit.manifest").depends_on as JsonObject[]); } catch { return "Capability Kit dependency drifted"; }
    const report = this.store.find("capability_kit_conformance", `kit_conformance_${kit.id}_${kit.version}`);
    return report?.verdict === "passed" && report.manifest_digest === kit.manifest_digest ? null : "Capability Kit has no passing Conformance report";
  }
  private conformanceFindings(kit: JsonObject): string[] {
    const findings: string[] = []; if (kit.status !== "installed") findings.push("kit_not_installed");
    try { this.dependencies(object(kit.manifest, "kit.manifest").depends_on as JsonObject[]); } catch { findings.push("dependency_drift"); }
    const manifest = object(kit.manifest, "kit.manifest"); if ((manifest.hooks as string[]).some((phase) => !PHASES.has(phase))) findings.push("unsupported_hook");
    if ((manifest.effects as string[]).includes("destructive") && !(manifest.hooks as string[]).includes("preflight.check")) findings.push("destructive_without_preflight");
    return findings;
  }
  private affectedKitIds(root: string): Set<string> {
    const affected = new Set([root]); let changed = true;
    while (changed) { changed = false; for (const kit of this.store.list("capability_kit", 100_000)) {
      const dependencies = object(kit.manifest, "kit.manifest").depends_on as JsonObject[];
      if (!affected.has(String(kit.id)) && dependencies.some((dependency) => affected.has(String(dependency.kit_id)))) { affected.add(String(kit.id)); changed = true; }
    } }
    return affected;
  }
}

function builtin(id: string, name: string, provides: string[], effects: string[], entrypoints: string[], hooks: string[]): JsonObject {
  return { id, version: "1.0.0", name, description: `${name} is a built-in declarative Capability Kit.`, compatibility: "^0.12.34", provides, effects, data_scopes: ["project_root"], entrypoints, hooks, surfaces: ["skill", "mcp", "cli", "plugin"], healthcheck: "builtin-declared", eval_suite: "capability-platform-fixtures" };
}
