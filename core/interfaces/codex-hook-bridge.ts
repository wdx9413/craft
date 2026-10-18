import { ComponentTraceKernel } from "../component-trace.ts";
import { randomUUID as hookRequestId } from "node:crypto";
import { assertContextReadCurrent } from "../context-access-guard.ts";
/**
 * Bounded Codex lifecycle integration for Craft Context and its standalone products.
 *
 * This module deliberately does not read transcripts, execute Host actions, or
 * mutate a Workflow. It turns the small, documented Hook event envelope into
 * scoped Context, bounded Memory capture, and content-free Experience signals.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { projectIdentityFromRoot } from "../scope-identity.ts";
import type { CraftService } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { payload, stableDigest } from "../digest.ts";
import { projectExperienceDirectory } from "../project-experience-directory.ts";
import { deleteExperienceTaskGoal, readExperienceTaskGoal, storeExperienceTaskGoal } from "../experience-task-goals.ts";
import { CRAFT_RELEASE_VERSION } from "../version.ts";

type ComponentHookMember = "knowledge" | "memory" | "experience";
export type CodexHookMember = "context" | ComponentHookMember;
const CONTEXT_MEMBERS: readonly ComponentHookMember[] = ["knowledge", "memory", "experience"];
type HookEvent = "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PostToolUse" | "Stop";
type HookInput = JsonObject & {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  turn_id?: string;
  scenario_key?: string;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
};

const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
const VERIFY = /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?|pytest|(?:python3?\s+-m\s+pytest)|(?:mvn|gradle|gradlew|\.\/gradlew)\s+(?:test|verify)|go\s+test|cargo\s+test|node\s+--test)(?:\s|$)/u;
const EDIT = /(?:^|[;&|\s])(?:apply_patch|git\s+apply|sed\s+-i|perl\s+-pi)\b/iu;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nestedText(value: unknown, names: readonly string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as JsonObject;
  for (const name of names) {
    const raw = object[name];
    const found = text(typeof raw === "number" ? String(raw) : raw);
    if (found) return found;
  }
  return null;
}

function hookHost(input: HookInput): "codex" | "claude" {
  return /claude/iu.test(text(input.source) ?? "") ? "claude" : "codex";
}

export function codexProjectScope(cwd: unknown): { kind: "project"; id: string } | null {
  const value = text(cwd);
  if (!value) return null;
  // Keep the old absolute path as a local alias in the journal only. Context
  // uses a Git-derived identity so another checkout of the same repository can
  // resolve the same scoped records without scanning every project.
  return projectIdentityFromRoot(resolve(value)).canonical_scope as { kind: "project"; id: string };
}

/** Explicit capture syntax remains supported alongside automatic stable-fact classification. */
export function explicitMemoryStatement(prompt: unknown): string | null {
  const source = text(prompt);
  if (!source) return null;
  const match = /^(?:\/remember|记住)\s*[:：]\s*(.+)$/iu.exec(source);
  if (!match?.[1] || SECRET.test(match[1])) return null;
  const statement = match[1].trim();
  return statement.length <= 1_000 ? statement : null;
}

/** Capture only classified stable project conventions or personal preferences; ordinary task text stays ephemeral. */
export function automaticMemoryFact(prompt: unknown): string | null {
  const source = text(prompt);
  if (!source || source.length > 1_000 || /(?:无需|不用|不要|别)(?:记录|记住|保存)|(?:do not|don't)\s+(?:remember|save|store)/iu.test(source) || SECRET.test(source)) return null;
  const match = /^(?:(?:本项目|这个项目|该项目)(?:的)?(?:约定|规范|默认规则)(?:是)?\s*[:：,，]?\s*|(?:本项目|这个项目|该项目)(?:目前)?(?:默认)?(?:使用|采用|基于)\s*[:：,，]?\s*|(?:以后|今后)(?:在本项目中)?(?:请)?(?:默认)?(?:使用|采用|遵循|保持|优先|避免|不要|总是)\s*[:：,，]?\s*|(?:我们约定|项目要求|编码规范是)\s*[:：,，]?\s*|(?:我偏好|我更喜欢|我的默认偏好是|我长期使用|我习惯)\s*[:：,，]?\s*|(?:this project uses|our project uses|by default,? use|from now on,? use|our convention is|I prefer|I usually use)\s*[:：,，]?\s*)(.+)$/iu.exec(source);
  const fact = match?.[1]?.trim();
  return fact && fact.length <= 700 ? fact : null;
}

/** Keep only a short, redacted task goal for project Experience classification. */
export function sanitizedExperienceTaskGoal(value: unknown): string | null {
  const source = text(value);
  if (!source || source.length > 8_000 || SECRET.test(source)) return null;
  const goal = source.split(/\r?\n/u, 1)[0]!
    .replace(/```[\s\S]*?```/gu, " ").replace(/`[^`]*`/gu, " ")
    .replace(/\[[^\]]{1,200}\]\(https?:\/\/[^)]+\)/gu, " ").replace(/https?:\/\/\S+/giu, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, " ")
    .replace(/(?:\/[\w.-]+){2,}|[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gu, " ")
    .replace(/\b[a-f0-9]{32,}\b/giu, " ").replace(/\s+/gu, " ").replace(/^\s*[#>*-]+\s*/u, "").trim().slice(0, 320).trim();
  return goal.length >= 8 ? goal : null;
}

function experienceTaskGoalArgs(service: CraftService, input: HookInput) {
  const root = text(input.cwd), sessionId = text(input.session_id), turnId = text(input.turn_id), scope = codexProjectScope(root);
  if (!root || !sessionId || !turnId || !scope) return null;
  return { experience_dir: projectExperienceDirectory(service.store, scope.id, root, true), scope: scope.id, session_id: sessionId, turn_id: turnId };
}

type Signal = { readonly id: string; readonly tool: string; readonly kind: "edit" | "verification" | "other"; readonly outcome: "passed" | "failed" | "unknown"; readonly digest: string; readonly verifier: string | null; readonly scenario_key?: string; readonly coarse_scenario_key?: string; readonly observed_path?: string };

const SENSITIVE_PATH = /(?:secret|token|credential|password|private|\.env)/iu;
function observedProjectPath(value: unknown, projectRoot: unknown): string | null {
  if (typeof value !== "string" || typeof projectRoot !== "string" || !value.trim() || value.length > 512 || value.includes("\\") || value.includes("\0")) return null;
  try {
    const root = realpathSync(projectRoot), absolute = resolve(root, value.trim()), target = realpathSync(absolute);
    const path = relative(root, target), parts = path.split(sep);
    if (!path || path.startsWith(`..${sep}`) || path === ".." || resolve(target) !== absolute || parts.some(part => !part || part.startsWith(".") || SENSITIVE_PATH.test(part))
      || path.length > 256 || lstatSync(absolute).isSymbolicLink() || !lstatSync(target).isFile()) return null;
    return path.split(sep).join("/");
  } catch { return null; }
}

type ProjectScenario = { scenario_key: string; coarse_scenario_key?: string };

/** A verifier can resolve a project-owned fine scene, but cannot define semantic task identity by itself. */
function projectScenarioKey(input: HookInput, signal: Signal, service: CraftService): ProjectScenario | null {
  if (signal.kind !== "verification" || signal.outcome === "unknown") return null;
  const root = text(input.cwd);
  if (!root) return null;
  // This helper is called only for a sanitized verification Signal; the same
  // command extraction above therefore always produced its verifier command.
  const command = nestedText(input.tool_input ?? input.toolInput ?? input.input, ["command", "cmd", "script"])!;
  try {
    const scope = codexProjectScope(root)!;
    const directory = projectExperienceDirectory(service.store, scope.id, root);
    const path = join(directory, "experience-scenarios.json");
    for (const entry of [join(root, ".craft_data"), directory, path]) {
      const info = lstatSync(entry);
      if (info.isSymbolicLink() || (entry === path && !info.isFile())) return null;
      if (entry === path && info.size > 16_384) return null;
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const catalog = parsed as JsonObject;
    if (catalog.schema !== "craft.experience-scenario-catalog.v1" || !Array.isArray(catalog.scenarios) || catalog.scenarios.length > 64) return null;
    const scenarios = new Map<string, { tier: "coarse" | "fine"; parent: string | null; commands: string[]; verification_digests: string[]; lifecycle?: unknown }>();
    for (const raw of catalog.scenarios) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const entry = raw as JsonObject;
      if (typeof entry.scenario_key !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(entry.scenario_key)
        || !Array.isArray(entry.verification_commands) || entry.verification_commands.length > 32
        || entry.verification_commands.some(value => typeof value !== "string" || value.length > 500)
        || entry.verification_digests !== undefined && (!Array.isArray(entry.verification_digests) || entry.verification_digests.length > 32
          || entry.verification_digests.some(value => typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)))
        || entry.lifecycle !== undefined && !["candidate", "active", "conflicted"].includes(String(entry.lifecycle))) return null;
      const tier = entry.tier === undefined ? "fine" : entry.tier;
      const parent = entry.parent_scenario_key === undefined ? null : entry.parent_scenario_key;
      if ((tier !== "coarse" && tier !== "fine") || (parent !== null && (typeof parent !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(parent)))
        || (tier === "coarse" && (parent !== null || entry.verification_commands.length > 0 || entry.evaluation !== undefined))
        || (tier === "fine" && parent === entry.scenario_key) || scenarios.has(entry.scenario_key)) return null;
      scenarios.set(entry.scenario_key, { tier, parent, commands: entry.verification_commands as string[],
        verification_digests: (entry.verification_digests as string[] | undefined) ?? [], lifecycle: entry.lifecycle });
    }
    for (const scenario of scenarios.values()) {
      if (scenario.tier === "fine" && scenario.parent !== null && scenarios.get(scenario.parent)?.tier !== "coarse") return null;
    }
      const matches = [...scenarios].filter(([, scenario]) => scenario.tier === "fine" && scenario.lifecycle !== "candidate" && scenario.lifecycle !== "conflicted"
        && (scenario.commands.some(value => value.trim() === command.trim())
          || Array.isArray(scenario.verification_digests) && (scenario.verification_digests as unknown[]).includes(digest(command))));
    if (matches.length > 1) return null;
    const match = matches[0];
    return match ? { scenario_key: match[0], ...(match[1].parent ? { coarse_scenario_key: match[1].parent } : {}) } : null;
  } catch (error) {
    // A missing catalog is a cold start; the Host model may classify from task context at finalization.
    // A verifier digest is evidence, not a semantic scenario identity.
    return null;
  }
}

export class HookSignalSanitizer {
  signal(input: HookInput): Signal | null {
    const tool = text(input.tool_name) ?? text(input.toolName) ?? nestedText(input.tool, ["name"]) ?? "unknown";
    const toolInput = (input.tool_input ?? input.toolInput ?? input.input) as unknown;
    const command = nestedText(toolInput, ["command", "cmd", "script"]);
    const rawOutcome = nestedText(input.tool_response ?? input.toolResponse ?? input.output, ["exit_code", "exitCode", "status"]);
    const outcome = rawOutcome === "0" || rawOutcome === "success" || rawOutcome === "passed" ? "passed"
      : rawOutcome && (/^[1-9]\d*$/u.test(rawOutcome) || rawOutcome === "failed" || rawOutcome === "error") ? "failed" : "unknown";
    const kind = /^(?:apply_patch|Edit|Write)$/iu.test(tool) || Boolean(command && EDIT.test(command)) ? "edit"
      : Boolean(command && VERIFY.test(command.trim()) && !/[;&|`$\n]/u.test(command)) ? "verification" : "other";
    if (kind === "other") return null;
    const path = kind === "edit" ? observedProjectPath(nestedText(toolInput, ["file_path", "filePath", "path", "filename"]), input.cwd) : null;
    const stable = { tool, kind, outcome, command_digest: command ? digest(command) : null, path, tool_use_id: text(input.tool_use_id) ?? text(input.toolUseId) ?? randomUUID() };
    return { id: `codex_hook_signal_${digest(stable).slice(-20)}`, tool, kind, outcome, digest: digest(stable), verifier: command ? digest(command) : null, ...(path ? { observed_path: path } : {}) };
  }
}

/** Append-only, content-free session facts shared by PostToolUse and Stop. */
export class HookTurnJournal {
  readonly service: CraftService;
  constructor(service: CraftService) { this.service = service; }

  record(input: HookInput, signal: Signal): JsonObject | null {
    const scope = codexProjectScope(input.cwd); const turn = this.turn(input);
    if (!scope || !turn) return null;
    return this.service.store.transaction(() => {
      const existing = this.find(input);
      const journalId = existing ? String(existing.id) : this.journalId(scope, turn, input);
      if (existing?.closed_at) return null;
      const priorSignals = Array.isArray(existing?.signals) ? existing.signals as JsonObject[] : [];
      if (priorSignals.some((item) => item.id === signal.id)) return existing!;
      const signals = [...priorSignals, signal];
      const lastEdit = signals.findLastIndex((item) => item.kind === "edit");
      const checks = new Map<string, string>();
      for (const item of signals.slice(lastEdit + 1)) if (item.kind === "verification") checks.set(String(item.verifier), String(item.outcome));
      const outcomes = [...checks.values()];
      const verifications = signals.slice(lastEdit + 1).filter(item => item.kind === "verification");
      const scenarioKey = verifications.length > 0 && verifications.every(item => item.outcome !== "unknown" && typeof item.scenario_key === "string")
        && new Set(verifications.map(item => String(item.scenario_key))).size === 1 ? String(verifications[0]!.scenario_key) : null;
      const coarseScenarioKey = scenarioKey && verifications.every(item => (item.coarse_scenario_key ?? null) === (verifications[0]!.coarse_scenario_key ?? null))
        ? text(verifications[0]!.coarse_scenario_key) : null;
      const next = { scope, session_id: text(input.session_id) ?? "unknown", turn_id: turn, signals,
        has_edit: signals.some((item) => item.kind === "edit"),
        verification_outcome: !outcomes.length || outcomes.includes("unknown") ? null : outcomes.includes("failed") ? "failed" : "passed",
        edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest,
        verification_receipts: [...checks].map(([verifier, outcome]) => ({ verifier, outcome, edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest })),
        scenario_key: lastEdit >= 0 ? scenarioKey : null,
        coarse_scenario_key: lastEdit >= 0 ? coarseScenarioKey : null,
        content_stored: false, updated_at: new Date().toISOString() } satisfies JsonObject;
      return existing ? this.service.store.save("codex_hook_turn", journalId, { ...payload(existing), ...next })
        : this.service.store.create("codex_hook_turn", journalId, next);
    });
  }

  bindContextReceipt(input: HookInput, receipt: JsonObject): void {
    const scope = codexProjectScope(input.cwd); const turn = this.turn(input);
    if (!scope || !turn) return;
    const existing = this.find(input);
    const id = existing ? String(existing.id) : this.journalId(scope, turn, input);
    const prior = existing ?? this.service.store.find("codex_hook_turn", id);
    this.service.store.save("codex_hook_turn", id, { ...(prior ?? { scope, session_id: text(input.session_id) ?? "unknown", turn_id: turn, signals: [], has_edit: false, verification_outcome: null, content_stored: false }), context_receipt_id: receipt.id, content_free: true });
  }

  find(input: HookInput): JsonObject | null {
    const scope = codexProjectScope(input.cwd); const turn = this.turn(input);
    if (!scope || !turn) return null;
    const current = this.service.store.find("codex_hook_turn", this.journalId(scope, turn, input));
    if (current) return current;
    const legacy = this.service.store.find("codex_hook_turn", `codex_hook_turn_${digest({ scope, turn }).slice(-20)}`);
    return legacy && (legacy.session_id ?? "unknown") === (text(input.session_id) ?? "unknown") ? legacy : null;
  }

  close(input: HookInput): void {
    const scope = codexProjectScope(input.cwd), turn = this.turn(input);
    if (!scope || !turn) return;
    const existing = this.find(input);
    const journalId = existing ? String(existing.id) : this.journalId(scope, turn, input);
    if (existing?.closed_at) return;
    const next = { ...(existing ? payload(existing) : { scope, session_id: text(input.session_id) ?? "unknown", turn_id: turn,
      signals: [], has_edit: false, verification_outcome: null, content_stored: false }), closed_at: new Date().toISOString() };
    if (existing) this.service.store.save("codex_hook_turn", journalId, next);
    else this.service.store.create("codex_hook_turn", journalId, next);
  }

  private journalId(scope: { kind: "project"; id: string }, turn: string, input: HookInput): string {
    return `codex_hook_turn_${digest({ scope, session_id: text(input.session_id) ?? "unknown", turn }).slice(-20)}`;
  }

  private turn(input: HookInput): string | null {
    return text(input.turn_id);
  }
}

/** Converts a verified local coding turn into only a proposal request. */
export class HookLearningCoordinator {
  readonly service: CraftService;
  readonly journal: HookTurnJournal;
  constructor(service: CraftService, journal = new HookTurnJournal(service)) { this.service = service; this.journal = journal; }

  private finalizedTurn(input: HookInput, journal: JsonObject): JsonObject | null {
    const turnId = String(journal.turn_id), receiptId = String(journal.context_receipt_id), host = hookHost(input);
    const evidenceIds = new Set(this.service.store.list("evidence", 10_000, evidence => {
      const metadata = evidence.metadata as JsonObject | undefined;
      return metadata?.provenance === "host_completion_signal" && metadata.host === host
        && metadata.turn_id === turnId && metadata.context_receipt_id === receiptId;
    }).map(evidence => String(evidence.id)));
    if (!evidenceIds.size) return null;
    const scope = journal.scope as JsonObject;
    const scopeKey = scope.kind === "project" ? `project:${String(scope.id).replace(/^project:/u, "")}` : `${scope.kind}:${scope.id}`;
    return this.service.store.list("workflow_evolution_observation", 10_000, observation => {
      const source = observation.source as JsonObject | undefined;
      return source?.scope === scopeKey && Array.isArray(observation.evidence_ids)
        && (observation.evidence_ids as unknown[]).some(id => evidenceIds.has(String(id)));
    })[0] ?? null;
  }

  finalize(input: HookInput): JsonObject | null {
    const journal = this.journal.find(input);
    if (!journal || journal.has_edit !== true || !["passed", "failed"].includes(String(journal.verification_outcome))) return null;
    if (typeof journal.context_receipt_id !== "string") return null;
    const projectRoot = text(input.cwd);
    if (projectRoot) {
      const resolved = this.service.scopeIdentityResolveProject({ project_root: projectRoot }).identity as JsonObject;
      const receipt = this.service.store.find("context_resolution_receipt", String(journal.context_receipt_id));
      const receiptScope = receipt?.scope as JsonObject | undefined;
      if (receiptScope?.kind === "project" && resolved.canonical_scope
        && stableDigest(resolved.canonical_scope) !== stableDigest(receiptScope)) throw new Error("Hook project root does not match the Context receipt scope");
    }
    const prior = this.finalizedTurn(input, journal);
    if (prior) {
      if (prior.outcome !== journal.verification_outcome) throw new Error("Host turn already has a different terminal Experience outcome");
      return { status: "observed", observation: prior, request: null, idempotent: true, next_action: "terminal_turn_already_recorded" };
    }
    const suppliedScenario = text(input.scenario_key);
    if (suppliedScenario && !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(suppliedScenario)) throw new Error("scenario_key must be a bounded stable identifier");
    if (suppliedScenario && journal.scenario_key && journal.scenario_key !== suppliedScenario) throw new Error("scenario_key conflicts with the turn's recorded scenario");
    if (suppliedScenario && !journal.scenario_key) {
      const signals = Array.isArray(journal.signals) ? journal.signals as JsonObject[] : [];
      const lastEdit = signals.findLastIndex(item => item.kind === "edit");
      const alignedSignals = signals.map((signal, index) => index > lastEdit && signal.kind === "verification"
        ? { ...signal, scenario_key: suppliedScenario } : signal);
      this.service.store.save("codex_hook_turn", String(journal.id), { ...payload(journal), scenario_key: suppliedScenario, signals: alignedSignals });
    }
    const scenario = suppliedScenario ?? text(journal.scenario_key);
    const taskGoalArgs = scenario ? null : experienceTaskGoalArgs(this.service, input);
    const taskGoal = taskGoalArgs ? readExperienceTaskGoal(taskGoalArgs) : null;
    const signals = Array.isArray(journal.signals) ? journal.signals as JsonObject[] : [];
    const lastVerifier = [...signals].reverse().find(signal => signal.kind === "verification" && typeof signal.verifier === "string");
    const observedPaths = [...new Set(signals.filter(signal => signal.kind === "edit" && typeof signal.observed_path === "string")
      .map(signal => String(signal.observed_path)))].slice(0, 16);
    const finalized = this.service.learningCycleFinalize({ host: hookHost(input), task_id: String(journal.id), turn_id: String(journal.turn_id), context_receipt_id: journal.context_receipt_id,
      verified: true, project_root: projectRoot, verification_outcome: journal.verification_outcome, verification_ref: stableDigest(journal.verification_receipts), ...(scenario ? { scenario_key: scenario } : {}),
      ...(taskGoal ? { scenario_context: { task_goal: taskGoal,
        effect_summary: `项目代码已修改并完成终态验证，结果为 ${String(journal.verification_outcome)}。`, sanitized: true, content_stored: false } } : {}),
      observed_paths: observedPaths,
      ...(typeof journal.coarse_scenario_key === "string" ? { coarse_scenario_key: journal.coarse_scenario_key } : {}),
      ...(typeof lastVerifier?.verifier === "string" ? { scenario_verifier_digest: lastVerifier.verifier } : {}) });
    return finalized;
  }
}

export class CodexHookBridge {
  readonly service: CraftService;
  readonly signals: HookSignalSanitizer;
  readonly journal: HookTurnJournal;
  readonly learning: HookLearningCoordinator;
  constructor(service: CraftService) {
    this.service = service; this.signals = new HookSignalSanitizer(); this.journal = new HookTurnJournal(service); this.learning = new HookLearningCoordinator(service, this.journal);
  }

  async handle(member: CodexHookMember, input: HookInput): Promise<JsonObject> {
    const captured = await new ComponentTraceKernel(this.service.trace, "hook").capture({ requestId: hookRequestId(), component: "craft-hook",
      operation: "handle", input: { member, envelope: input }, handler: () => this.dispatch(member, input) });
    if (!captured.ok) {
      this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member, error_type: captured.error instanceof Error ? captured.error.name : "unknown" });
      return {};
    }
    return captured.result ?? {};
  }

  private async dispatch(member: CodexHookMember, input: HookInput): Promise<JsonObject> {
      const event = text(input.hook_event_name) as HookEvent | null;
      input = this.correlateTurn(input, event);
      if (member === "context") {
        if (event === "SessionStart" || event === "SessionEnd") {
          for (const component of CONTEXT_MEMBERS) this.lifecycle(component, event, input, component === "memory");
          return {};
        }
        if (event === "UserPromptSubmit") return await this.prompt(member, input);
        if (event === "PostToolUse") return this.tool(input);
        if (event === "Stop") {
          for (const component of CONTEXT_MEMBERS) this.stop(component, input);
        }
        return {};
      }
      if (event === "SessionStart" || event === "SessionEnd") return this.lifecycle(member, event, input);
      if (event === "UserPromptSubmit") return await this.prompt(member, input);
      if (event === "PostToolUse" && member === "experience") return this.tool(input);
      if (event === "Stop") return this.stop(member, input);
      return {};
  }

  private correlateTurn(input: HookInput, event: HookEvent | null): HookInput {
    const scope = codexProjectScope(input.cwd), sessionId = text(input.session_id);
    if (!scope || !sessionId) return input;
    const sessionKey = `context_hook_session_${stableDigest({ scope, session_id: sessionId }).slice(-24)}`;
    return this.service.store.transaction(() => {
      const prior = this.service.store.find("context_hook_session", sessionKey);
      let pending = Array.isArray(prior?.pending_turn_ids) ? prior.pending_turn_ids as string[] : [];
      let ambiguous = prior?.ambiguous === true;
      let turnId = text(input.turn_id);
      if (event === "UserPromptSubmit" && (text(input.prompt) || text(input.user_prompt))) {
        const sequence = Number(prior?.sequence ?? 0) + 1;
        turnId ??= `hook_turn_${sessionKey.slice(-24)}_${sequence}`;
        if (!pending.includes(turnId)) pending = [...pending, turnId];
        ambiguous ||= pending.length > 1;
        this.service.store.save("context_hook_session", sessionKey, { scope, session_id: sessionId, sequence, last_turn_id: turnId, pending_turn_ids: pending, ambiguous, content_free: true });
      } else if (event === "PostToolUse" || event === "Stop") {
        // Overlapping turns stay ambiguous until all are closed; a delayed event
        // must never be attributed to whichever turn happens to remain.
        if (!turnId && !ambiguous && pending.length === 1) turnId = pending[0]!;
        if (event === "Stop" && turnId && pending.includes(turnId)) {
          pending = pending.filter(id => id !== turnId);
          this.service.store.save("context_hook_session", sessionKey, { ...payload(prior!), pending_turn_ids: pending, ambiguous: pending.length > 0 && ambiguous });
        }
      } else if ((event === "SessionStart" || event === "SessionEnd") && prior) {
        this.service.store.save("context_hook_session", sessionKey, { ...payload(prior), pending_turn_ids: [], ambiguous: false });
      }
      return turnId ? { ...input, turn_id: turnId } : input;
    });
  }

  private async prompt(member: CodexHookMember, input: HookInput): Promise<JsonObject> {
    const scope = codexProjectScope(input.cwd); const prompt = text(input.prompt) ?? text(input.user_prompt);
    if (!scope || !prompt) return {};
    const members = member === "context" ? CONTEXT_MEMBERS : [member];
    // Persist the current checkout only as an alias. The receipt still names the
    // canonical Git identity, so it is portable and does not leak the path.
    if (typeof input.cwd === "string") this.service.scopeIdentityResolveProject({ project_root: input.cwd });
    if (members.includes("experience")) {
      const taskGoal = sanitizedExperienceTaskGoal(prompt);
      if (taskGoal) {
        try {
          const args = experienceTaskGoalArgs(this.service, input);
          if (args) storeExperienceTaskGoal({ ...args, task_goal: taskGoal });
        }
        catch { this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "experience", event: "UserPromptSubmit", error_type: "storage_unavailable" }); }
      }
    }
    let memoryWritten = false; let captureSummary: JsonObject | null = null;
    if (members.includes("memory")) {
      const explicitStatement = explicitMemoryStatement(prompt);
      const statement = explicitStatement ?? automaticMemoryFact(prompt);
      const sessionId = text(input.session_id);
      if (statement && sessionId) {
        try {
          const capture = explicitStatement ? this.service.memoryCaptureUserStatement.bind(this.service) : this.service.memoryCaptureObservedFact.bind(this.service);
          const captured = capture({ content: statement, kind: "preference", session_id: sessionId,
            scope_kind: "session", scope_id: sessionId, project_scope_id: scope.id, project_root: input.cwd, sensitivity: "internal" });
          memoryWritten = captured.auto_committed === true;
          captureSummary = { candidate_id: (captured.candidate as JsonObject | null)?.id ?? null, next_action: captured.next_action,
            topic_suggestions: captured.topic_suggestions ?? [], memory_file: captured.memory_file ?? null,
            promotions: Array.isArray(captured.promotions) ? (captured.promotions as JsonObject[]).map(item => ({ tier: item.tier, auto_committed: item.auto_committed === true, memory_file: item.memory_file ?? null })) : [],
            capture_mode: explicitStatement ? "explicit" : "automatic_stable_fact", memory_written: memoryWritten };
        } catch (error) {
          this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "memory", event: "UserPromptSubmit", error_type: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    const sessionId = text(input.session_id);
    const resolved = await this.service.contextWorkingSets.resolve({ query: prompt, session_id: sessionId ?? undefined, session_scope_id: sessionId ?? undefined, turn_id: text(input.turn_id) ?? undefined, scope_kind: scope.kind, scope_id: scope.id,
      members: [...members], max_items: 6, max_chars: 3_000 });
    const items = resolved.items as JsonObject[];
    const contributions = resolved.contributions as JsonObject[];
    const selected = [...items.map((item) => ({ type: "memory", id: item.memory_id, version: item.memory_version, content: item.content })),
      ...contributions.flatMap((contribution) => Array.isArray(contribution.items) ? contribution.items : [])];
    const receipt = resolved.receipt as JsonObject | null;
    if (receipt) this.journal.bindContextReceipt(input, receipt);
    return this.service.store.transaction(() => {
      assertContextReadCurrent(this.service.store, receipt);
      for (const component of members) this.service.activationProofRecord({ host: hookHost(input), component, event: "UserPromptSubmit", session_id: text(input.session_id) ?? "unknown",
        turn_id: text(input.turn_id), context_receipt_id: receipt?.id ?? undefined, memory_written: component === "memory" && memoryWritten, observation_written: false,
        plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
      if (!selected.length && !captureSummary) return {};
      if (selected.length) this.service.contextWorkingSets.recordEmission({ query: prompt, session_id: text(input.session_id) ?? undefined, turn_id: text(input.turn_id) ?? undefined, scope_kind: scope.kind, scope_id: scope.id }, resolved);
      return { additionalContext: JSON.stringify({ source: `craft-${member}`, scope, receipt_id: receipt?.id ?? null, session_id: text(input.session_id), turn_id: text(input.turn_id), memory_capture: captureSummary, selected }) };
    });
  }

  private tool(input: HookInput): JsonObject {
    const captured = this.signals.signal(input); if (!captured) return {};
    const root = text(input.cwd);
    if (root) this.service.scopeIdentityResolveProject({ project_root: root });
    const scenario = projectScenarioKey(input, captured, this.service);
    this.journal.record(input, scenario ? { ...captured, scenario_key: scenario.scenario_key,
      ...(scenario.coarse_scenario_key ? { coarse_scenario_key: scenario.coarse_scenario_key } : {}) } : captured);
    return {};
  }

  private stop(member: ComponentHookMember, input: HookInput): JsonObject {
    const finalized = member === "experience" ? this.service.store.transaction(() => {
      const result = this.learning.finalize(input);
      const goalArgs = experienceTaskGoalArgs(this.service, input);
      if (goalArgs) deleteExperienceTaskGoal(goalArgs);
      this.journal.close(input);
      return result;
    }) : null;
    this.service.activationProofRecord({ host: hookHost(input), component: member, event: "Stop", session_id: text(input.session_id) ?? "unknown",
      turn_id: text(input.turn_id), memory_written: false, observation_written: finalized !== null,
      plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
    this.lifecycle(member, "Stop", input);
    return {};
  }

  /**
   * Session and turn boundaries are audit signals, not component usage.  In
   * particular, readiness here is intentionally marked as readiness-only so a
   * lifecycle hook can never masquerade as a Knowledge/Memory retrieval.
   */
  private lifecycle(member: ComponentHookMember, event: HookEvent, input: HookInput, scheduleMaintenance = true): JsonObject {
    const readiness = this.service.componentReadinessGet({ component: member });
    const scope = codexProjectScope(input.cwd);
    this.service.store.appendEvent("codex-hook", "codex_hook.lifecycle", {
      member,
      event,
      scope,
      session_id: text(input.session_id) ?? "unknown",
      turn_id: text(input.turn_id),
      source: text(input.source),
      reason: text(input.reason),
      stop_hook_active: input.stop_hook_active === true,
      readiness_state: readiness.state,
      usage: { kind: "readiness_only", component_used: false, context_resolved: false },
    });
    this.service.activationProofRecord({ host: hookHost(input), component: member, event, session_id: text(input.session_id) ?? "unknown",
      turn_id: text(input.turn_id), memory_written: false, observation_written: false,
      plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
    if (event === "SessionEnd" && member === "memory" && text(input.session_id)) {
      try { this.service.memorySessionArchive({ session_id: text(input.session_id) }); }
      catch (error) { this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member, event, error_type: error instanceof Error ? error.name : "unknown" }); }
    }
    if (event === "SessionEnd" && scheduleMaintenance) this.service.memoryMaintenanceSchedule({ stage: "light", lease_id: `codex-${member}-${text(input.session_id) ?? "unknown"}` });
    return {};
  }
}
