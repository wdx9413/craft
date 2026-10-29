import { ComponentTraceKernel } from "../component-trace.ts";
import { operationErrorCode } from "../../common/craft-common-log/src/operation.ts";
import { randomUUID as hookRequestId } from "node:crypto";
import { assertContextReadCurrent } from "../context-access-guard.ts";
import { contextAssetMatches, contextAssetRef } from "../../common/craft-common-base/src/context-assets.ts";
/**
 * Bounded Codex lifecycle integration for Craft Context and its standalone products.
 *
 * This module deliberately does not read transcripts, execute Host actions, or
 * mutate a Workflow. It turns the small, documented Hook event envelope into
 * scoped Context, bounded Memory capture, and content-free Experience signals.
 */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { projectIdentityFromRoot } from "../scope-identity.ts";
import type { CraftService } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { estimateTokens } from "../token-budget.ts";
import { retrievalExcerpt } from "../../common/craft-common-base/src/retrieval-excerpt.ts";
import { payload, stableDigest } from "../digest.ts";
import { projectExperienceDirectory } from "../project-experience-directory.ts";
import { deleteExperienceTaskGoal, readExperienceTaskGoal, storeExperienceTaskGoal } from "../experience-task-goals.ts";
import { sanitizeCodexTaskGoal } from "../codex-task-prose.ts";
import { CRAFT_RELEASE_VERSION } from "../version.ts";
import { HookSignalSanitizer, nestedText, type HookSignal } from "./codex-hook-signal-sanitizer.ts";
import { queueHookMaintenance } from "./memory-archive-worker.ts";
export { HookSignalSanitizer } from "./codex-hook-signal-sanitizer.ts";

type ComponentHookMember = "knowledge" | "memory" | "experience";
export type CodexHookMember = "context" | ComponentHookMember;
const HOOK_ADDITIONAL_CONTEXT_BUDGET: Record<CodexHookMember, number> = { context: 400, knowledge: 150, memory: 150, experience: 150 };
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
interface HookCandidate { member: string; item: JsonObject; output: JsonObject }
interface HookEmissionCandidate { candidate: HookCandidate; ref: JsonObject | null }

function compactHookItem(item: JsonObject, query: string, maxChars: number): JsonObject {
  const content = String(item.content);
  const prior = item.content_excerpt && typeof item.content_excerpt === "object" ? item.content_excerpt as JsonObject : {};
  // A previous projection with unknown source offsets cannot safely be treated
  // as a complete source. Keep its reference but never compact its body again:
  // doing so would attach a new excerpt range to text whose origin is unknown.
  if (item.content_excerpt && !Number.isSafeInteger(prior.source_start)) {
    return { ...item, content: "", content_excerpt: {
      ...prior, source_start: null, source_end: null,
      source_chars: Number.isSafeInteger(prior.source_chars) ? prior.source_chars : content.length,
      reason: "requires_expansion",
    } };
  }
  const excerpt = retrievalExcerpt(content, query, maxChars);
  const sourceStart = Number.isSafeInteger(prior.source_start) ? Number(prior.source_start) : 0;
  return { ...item, content: excerpt.text, content_excerpt: {
    source_start: excerpt.source_start === null ? null : sourceStart + excerpt.source_start,
    source_end: excerpt.source_end === null ? null : sourceStart + excerpt.source_end,
    source_chars: Number.isSafeInteger(prior.source_chars) ? Number(prior.source_chars) : excerpt.source_chars,
    reason: excerpt.reason,
    ...(excerpt.matched_terms ? { matched_terms: excerpt.matched_terms } : {}),
  } };
}

function knowledgeHookProjection(item: JsonObject): JsonObject {
  return Object.fromEntries(["claim_id", "claim_version", "content", "content_excerpt", "content_digest", "source_id", "evidence_ids"]
    .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}

function experienceHookProjection(item: JsonObject): JsonObject {
  return Object.fromEntries(["procedure_id", "procedure_version", "procedure_kind", "trigger", "content_digest", "definition_digest", "routeable", "host_next_step"]
    .filter(key => item[key] !== undefined).map(key => [key, item[key]]));
}
const CONTEXT_MEMBERS: readonly ComponentHookMember[] = ["knowledge", "memory", "experience"];
type HookEvent = "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PostToolUse" | "Stop" | "PreCompact";
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

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function hookHost(input: HookInput): "codex" | "claude" {
  if (input.session_host === "codex" || input.session_host === "claude") return input.session_host;
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
  // Classification must not strip the subject, negation, priority or conditions
  // from a stable fact: those words determine what a promoted Memory means.
  return match && source.length <= 700 ? source : null;
}

/** Keep only a short, redacted task goal for project Experience classification. */
export function sanitizedExperienceTaskGoal(value: unknown): string | null {
  return sanitizeCodexTaskGoal(value);
}

function experienceTaskGoalArgs(service: CraftService, input: HookInput, scope: HookProjectScope | null) {
  const root = text(input.cwd), sessionId = text(input.session_id), turnId = text(input.turn_id);
  if (!root || !sessionId || !turnId || !scope) return null;
  return { experience_dir: projectExperienceDirectory(service.store, scope.id, root, true), scope: scope.id, session_host: hookHost(input), session_id: sessionId, turn_id: turnId };
}

type Signal = HookSignal;
type HookProjectScope = { kind: "project"; id: string };

type ProjectScenario = { scenario_key: string; coarse_scenario_key?: string };

/** A verifier can resolve a project-owned fine scene, but cannot define semantic task identity by itself. */
function projectScenarioKey(input: HookInput, signal: Signal, service: CraftService, projectScope: HookProjectScope): ProjectScenario | null {
  if (signal.kind !== "verification" || signal.outcome === "unknown") return null;
  const root = text(input.cwd) as string;
  // This helper is called only for a sanitized verification Signal; the same
  // command extraction above therefore always produced its verifier command.
  const command = nestedText(input.tool_input ?? input.toolInput ?? input.input, ["command", "cmd", "script"])!;
  try {
    const scope = projectScope;
    const directory = projectExperienceDirectory(service.store, scope.id, root);
    const path = join(directory, "experience-scenarios.json");
    for (const entry of [directory, path]) {
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

/** Append-only, content-free session facts shared by PostToolUse and Stop. */
export class HookTurnJournal {
  readonly service: CraftService;
  constructor(service: CraftService) { this.service = service; }

  record(input: HookInput, signal: Signal, projectScope?: HookProjectScope | null): JsonObject | null {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope; const turn = this.turn(input);
    if (!scope || !turn) return null;
    const journalId = this.journalId(scope, turn, input);
    const matched = this.find(input, false, scope);
    const legacyRow = this.service.store.database.prepare("SELECT 1 FROM records WHERE kind='codex_hook_turn' AND id=? LIMIT 1")
      .get(typeof matched?.id === "string" ? matched.id : journalId) !== undefined;
    if (process.env.CRAFT_HOOK_MODE === "1" && !legacyRow) {
      const prior = this.find(input, false, scope);
      if (prior?.closed_at) return prior;
      const signalId = signal.id;
      return this.service.store.traceTransaction(signalId, () => {
        const existing = this.service.store.traceShards.find("codex_hook_signal", signalId, undefined, signalId);
        return existing ?? this.service.store.create("codex_hook_signal", signalId, { scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown",
          turn_id: turn, trace_id: signalId, signal: signal as unknown as JsonObject,
          observed_at_ms: performance.timeOrigin + performance.now(), content_stored: false });
      });
    }
    const write = () => {
      const existing = this.find(input, undefined, scope);
      const currentId = existing ? String(existing.id) : journalId;
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
      const next = { scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown", turn_id: turn, trace_id: currentId, signals,
        has_edit: signals.some((item) => item.kind === "edit"),
        verification_outcome: !outcomes.length || outcomes.includes("unknown") ? null : outcomes.includes("failed") ? "failed" : "passed",
        edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest,
        verification_receipts: [...checks].map(([verifier, outcome]) => ({ verifier, outcome, edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest })),
        scenario_key: lastEdit >= 0 ? scenarioKey : null,
        coarse_scenario_key: lastEdit >= 0 ? coarseScenarioKey : null,
        content_stored: false, updated_at: new Date().toISOString() } satisfies JsonObject;
      return existing ? this.service.store.save("codex_hook_turn", currentId, { ...payload(existing), ...next })
        : this.service.store.create("codex_hook_turn", currentId, next);
    };
    return legacyRow ? this.service.store.transaction(write) : this.service.store.traceTransaction(journalId, write);
  }

  bindContextReceipt(input: HookInput, receipt: JsonObject, projectScope?: HookProjectScope | null): void {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope; const turn = this.turn(input);
    if (!scope || !turn) return;
    const existing = this.find(input, false, scope);
    const id = existing ? String(existing.id) : this.journalId(scope, turn, input);
    const prior = existing ?? this.findById(id);
    this.service.store.save("codex_hook_turn", id, { ...(prior ?? { scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown", turn_id: turn, signals: [], has_edit: false, verification_outcome: null, content_stored: false }), trace_id: String(prior?.trace_id ?? id), context_receipt_id: receipt.id, content_free: true });
  }

  find(input: HookInput, includePendingSignals = process.env.CRAFT_HOOK_MODE === "1", projectScope?: HookProjectScope | null): JsonObject | null {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope; const turn = this.turn(input);
    if (!scope || !turn) return null;
    const journalId = this.journalId(scope, turn, input);
    const current = this.findById(journalId);
    const legacy = current ? null : this.findById(`codex_hook_turn_${digest({ scope, session_id: text(input.session_id) ?? "unknown", turn }).slice(-20)}`)
      ?? this.findById(`codex_hook_turn_${digest({ scope, turn }).slice(-20)}`);
    const journal = current ?? (legacy && legacy.session_host === hookHost(input) && (legacy.session_id ?? "unknown") === (text(input.session_id) ?? "unknown") ? legacy : null);
    const pending = includePendingSignals ? this.service.store.traceShards.hookSignalsForTurn(
      scope.kind, scope.id, text(input.session_id) ?? "unknown", turn, 10_000, hookHost(input)) : [];
    if (journal && pending.length === 0) return { ...payload(journal), id: String(journal.id),
      signals: Array.isArray(journal.signals) ? journal.signals as JsonObject[] : [] };
    const merged = new Map<string, JsonObject>();
    for (const item of Array.isArray(journal?.signals) ? journal.signals as JsonObject[] : []) if (typeof item.id === "string") merged.set(item.id, item);
    for (const record of pending) if (record.signal && typeof record.signal === "object" && !Array.isArray(record.signal)) {
      const signal = record.signal as JsonObject;
      if (typeof signal.id === "string") merged.set(signal.id, signal);
    }
    if (!journal && !merged.size) return null;
    const signals = [...merged.values()];
    const lastEdit = signals.findLastIndex(item => item.kind === "edit");
    const checks = new Map<string, string>();
    for (const item of signals.slice(lastEdit + 1)) if (item.kind === "verification") checks.set(String(item.verifier), String(item.outcome));
    const outcomes = [...checks.values()];
    const verifications = signals.slice(lastEdit + 1).filter(item => item.kind === "verification");
    const scenarioKey = verifications.length > 0 && verifications.every(item => item.outcome !== "unknown" && typeof item.scenario_key === "string")
      && new Set(verifications.map(item => String(item.scenario_key))).size === 1 ? String(verifications[0]!.scenario_key) : null;
    const coarseScenarioKey = scenarioKey && verifications.every(item => (item.coarse_scenario_key ?? null) === (verifications[0]!.coarse_scenario_key ?? null))
      ? text(verifications[0]!.coarse_scenario_key) : null;
    return { ...(journal ? payload(journal) : { scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown", turn_id: turn, trace_id: journalId }),
      id: String(journal?.id ?? journalId), signals, has_edit: signals.some(item => item.kind === "edit"),
      verification_outcome: !outcomes.length || outcomes.includes("unknown") ? null : outcomes.includes("failed") ? "failed" : "passed",
      edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest,
      verification_receipts: [...checks].map(([verifier, outcome]) => ({ verifier, outcome, edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest })),
      scenario_key: lastEdit >= 0 ? scenarioKey : null, coarse_scenario_key: lastEdit >= 0 ? coarseScenarioKey : null };
  }

  private findById(id: string): JsonObject | null {
    const legacy = this.service.store.database.prepare("SELECT 1 FROM records WHERE kind='codex_hook_turn' AND id=? LIMIT 1")
      .get(id) !== undefined;
    return legacy ? this.service.store.find("codex_hook_turn", id)
      : this.service.store.traceShards.find("codex_hook_turn", id, undefined, id);
  }

  close(input: HookInput, projectScope?: HookProjectScope | null): void {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope, turn = this.turn(input);
    if (!scope || !turn) return;
    const existing = this.find(input, undefined, scope);
    const journalId = existing ? String(existing.id) : this.journalId(scope, turn, input);
    if (existing?.closed_at) return;
    const next = { ...(existing ? payload(existing) : { scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown", turn_id: turn,
      signals: [], has_edit: false, verification_outcome: null, content_stored: false }), trace_id: String(existing?.trace_id ?? journalId), closed_at: new Date().toISOString() };
    if (existing) this.service.store.save("codex_hook_turn", journalId, next);
    else this.service.store.create("codex_hook_turn", journalId, next);
  }

  private journalId(scope: { kind: "project"; id: string }, turn: string, input: HookInput): string {
    return `codex_hook_turn_${digest({ scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown", turn }).slice(-20)}`;
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

  finalize(input: HookInput, projectScope?: HookProjectScope | null): JsonObject | null {
    const resolvedProjectScope = projectScope === undefined && typeof input.cwd === "string"
      ? (this.service.scopeIdentityResolveProject({ project_root: input.cwd }).identity as JsonObject).canonical_scope as HookProjectScope
      : projectScope;
    const journal = this.journal.find(input, undefined, resolvedProjectScope);
    if (!journal || journal.has_edit !== true || !["passed", "failed"].includes(String(journal.verification_outcome))) return null;
    if (typeof journal.context_receipt_id !== "string") return null;
    const projectRoot = text(input.cwd);
    if (projectRoot && resolvedProjectScope) {
      const receipt = this.service.store.find("context_resolution_receipt", String(journal.context_receipt_id));
      const receiptScope = receipt?.scope as JsonObject | undefined;
      if (receiptScope?.kind === "project" && stableDigest(resolvedProjectScope) !== stableDigest(receiptScope)) throw new Error("Hook project root does not match the Context receipt scope");
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
      const signals = journal.signals as JsonObject[];
      const lastEdit = signals.findLastIndex(item => item.kind === "edit");
      const alignedSignals = signals.map((signal, index) => index > lastEdit && signal.kind === "verification"
        ? { ...signal, scenario_key: suppliedScenario } : signal);
      this.service.store.save("codex_hook_turn", String(journal.id), { ...payload(journal), trace_id: String(journal.trace_id ?? journal.id), scenario_key: suppliedScenario, signals: alignedSignals });
    }
    const scenario = suppliedScenario ?? text(journal.scenario_key);
    const taskGoalArgs = scenario ? null : experienceTaskGoalArgs(this.service, input, resolvedProjectScope as HookProjectScope);
    const taskGoal = taskGoalArgs ? readExperienceTaskGoal(taskGoalArgs) : null;
    const signals = journal.signals as JsonObject[];
    const lastVerifier = [...signals].reverse().find(signal => signal.kind === "verification" && typeof signal.verifier === "string");
    const observedPaths = [...new Set(signals.filter(signal => signal.kind === "edit" && typeof signal.observed_path === "string")
      .map(signal => String(signal.observed_path)))].slice(0, 16);
    const finalized = this.service.learningCycleFinalize({ host: hookHost(input), task_id: String(journal.id), turn_id: String(journal.turn_id), context_receipt_id: journal.context_receipt_id,
      ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
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
  readonly launchArchiveWorker?: () => void;
  constructor(service: CraftService, launchArchiveWorker?: () => void) {
    this.service = service; this.signals = new HookSignalSanitizer(); this.journal = new HookTurnJournal(service); this.learning = new HookLearningCoordinator(service, this.journal);
    this.launchArchiveWorker = launchArchiveWorker;
  }

  async handle(member: CodexHookMember, input: HookInput): Promise<JsonObject> {
    const rawEvent = text(input.hook_event_name);
    const event = rawEvent && ["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "Stop", "PreCompact"].includes(rawEvent) ? rawEvent : "unknown";
    // Resolve and bind the Git project identity once per Hook request. The old
    // path repeated synchronous `git config` calls in turn correlation,
    // retrieval, scenario classification, and journal persistence.
    const resolveProjectScope = () => typeof input.cwd === "string"
      ? process.env.CRAFT_HOOK_MODE === "1" && event === "PostToolUse"
        // High-volume signal writes only need the deterministic canonical ID.
        // Registering the same local alias on every edit/verification adds a
        // database read and can open a writer transaction on the Hook path.
        ? codexProjectScope(input.cwd)
        : (this.service.scopeIdentityResolveProject({ project_root: input.cwd }).identity as JsonObject).canonical_scope as HookProjectScope
      : null;
    const dispatchScope = () => {
      try { return resolveProjectScope(); }
      catch (error) {
        // Session cleanup is Host-scoped and does not require a project root.
        // Preserve the original identity failure; never route project work to
        // a guessed scope. A queued archive still validates its own evidence.
        const sessionId = text(input.session_id);
        if (event === "SessionEnd" && (member === "context" || member === "memory") && sessionId && this.launchArchiveWorker) {
          try {
            this.service.store.bindSessionStorageHost(sessionId, hookHost(input));
            this.service.memoryGovernance.ledger.files.queueSessionArchive(sessionId, hookHost(input));
          } catch { /* The original failure remains the diagnostic result. */ }
          finally { try { this.launchArchiveWorker(); } catch { /* Preserve the original identity failure. */ } }
        }
        throw error;
      }
    };
    // PostToolUse fires for every tool. In the short-lived Host adapter the
    // content-free hook-runtime ledger is the call receipt; avoid creating and
    // finalizing a separate SQLite Trace for each signal. This removes four
    // extra writer transactions from the highest-volume Hook event.
    if (process.env.CRAFT_HOOK_MODE === "1" && event === "PostToolUse") return await this.dispatch(member, input, dispatchScope());
    const captured = await new ComponentTraceKernel(this.service.trace, "hook").capture({ requestId: hookRequestId(), component: "craft-hook",
      operation: `handle.${member}.${event}`, input: { member, hook_event: event }, handler: () => this.dispatch(member, input, dispatchScope()) });
    if (!captured.ok) {
      // The original error is recorded in the Trace shard and the Hook runtime
      // journal. Retrying a central write here only waits on the same lock again.
      if (process.env.CRAFT_HOOK_MODE === "1" && operationErrorCode(captured.error) === "STORAGE_BUSY") throw captured.error;
      this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member, error_type: captured.error instanceof Error ? captured.error.name : "unknown" });
      return {};
    }
    return captured.result ?? {};
  }

  private async dispatch(member: CodexHookMember, input: HookInput, projectScope: HookProjectScope | null): Promise<JsonObject> {
      const event = text(input.hook_event_name) as HookEvent | null;
      input = this.correlateTurn(input, event, projectScope);
      if (member === "context") {
        if (event === "SessionStart") return {};
        if (event === "SessionEnd") {
          // Only Memory has lifecycle work here: archive temporary facts and
          // schedule maintenance. Readiness-only records for the other members
          // added repeated SQLite writes without representing capability use.
          this.lifecycle("memory", event, input);
          return {};
        }
        if (event === "UserPromptSubmit") return await this.prompt(member, input, projectScope);
        if (event === "PostToolUse") return this.tool(input, projectScope);
        if (event === "PreCompact") return this.preCompact(input, projectScope);
        if (event === "Stop") {
          // Experience owns task finalization. It also records the one Context
          // usage receipt, so invoking the other two no-op stop handlers only
          // duplicates feedback, activation proofs, and lifecycle writes.
          return this.stop("experience", input, projectScope);
        }
        return {};
      }
      if (event === "SessionStart" || event === "SessionEnd") return this.lifecycle(member, event, input);
      if (event === "UserPromptSubmit") return await this.prompt(member, input, projectScope);
      if (event === "PostToolUse" && member === "experience") return this.tool(input, projectScope);
      if (event === "Stop") return this.stop(member, input, projectScope);
      return {};
  }

  private correlateTurn(input: HookInput, event: HookEvent | null, scope: HookProjectScope | null): HookInput {
    const sessionId = text(input.session_id);
    if (!scope || !sessionId) return input;
    const sessionKey = `context_hook_session_${stableDigest({ scope, session_host: hookHost(input), session_id: sessionId }).slice(-24)}`;
    // PostToolUse only reads the pending turn. Opening an IMMEDIATE transaction
    // here made every edit/verification Hook compete for SQLite's single writer
    // before HookTurnJournal.record opened its own write transaction.
    if (event === "PostToolUse") {
      const prior = this.service.store.find("context_hook_session", sessionKey);
      const pending = Array.isArray(prior?.pending_turn_ids) ? prior.pending_turn_ids as string[] : [];
      const turnId = text(input.turn_id) ?? (prior?.ambiguous !== true && pending.length === 1 ? pending[0] : undefined);
      return turnId ? { ...input, turn_id: turnId } : input;
    }
    return this.service.store.traceTransaction(sessionKey, () => {
      const prior = this.service.store.find("context_hook_session", sessionKey);
      let pending = Array.isArray(prior?.pending_turn_ids) ? prior.pending_turn_ids as string[] : [];
      let ambiguous = prior?.ambiguous === true;
      let turnId = text(input.turn_id);
      if (event === "UserPromptSubmit" && (text(input.prompt) || text(input.user_prompt))) {
        const sequence = Number(prior?.sequence ?? 0) + 1;
        turnId ??= `hook_turn_${sessionKey.slice(-24)}_${sequence}`;
        if (!pending.includes(turnId)) pending = [...pending, turnId];
        ambiguous ||= pending.length > 1;
        this.service.store.save("context_hook_session", sessionKey, { trace_id: sessionKey, scope, session_host: hookHost(input), session_id: sessionId, sequence, last_turn_id: turnId, pending_turn_ids: pending, ambiguous, content_free: true });
      } else if (event === "Stop") {
        // Overlapping turns stay ambiguous until all are closed; a delayed event
        // must never be attributed to whichever turn happens to remain.
        if (!turnId && !ambiguous && pending.length === 1) turnId = pending[0]!;
        if (event === "Stop" && turnId && pending.includes(turnId)) {
          pending = pending.filter(id => id !== turnId);
          this.service.store.save("context_hook_session", sessionKey, { ...payload(prior!), trace_id: sessionKey, pending_turn_ids: pending, ambiguous: pending.length > 0 && ambiguous });
        }
      } else if ((event === "SessionStart" || event === "SessionEnd") && prior) {
        this.service.store.save("context_hook_session", sessionKey, { ...payload(prior), trace_id: sessionKey, pending_turn_ids: [], ambiguous: false });
      }
      return turnId ? { ...input, turn_id: turnId } : input;
    });
  }

  private async prompt(member: CodexHookMember, input: HookInput, scope: HookProjectScope | null): Promise<JsonObject> {
    const prompt = text(input.prompt) ?? text(input.user_prompt);
    if (!scope || !prompt) return {};
    const members = member === "context" ? CONTEXT_MEMBERS : [member];
    // Persist the current checkout only as an alias. The receipt still names the
    // canonical Git identity, so it is portable and does not leak the path.
    if (members.includes("experience")) {
      const taskGoal = sanitizedExperienceTaskGoal(prompt);
      if (taskGoal) {
        try {
          const args = experienceTaskGoalArgs(this.service, input, scope);
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
          this.service.store.bindSessionStorageHost(sessionId, hookHost(input));
          const capture = explicitStatement ? this.service.memoryCaptureUserStatement.bind(this.service) : this.service.memoryCaptureObservedFact.bind(this.service);
          const captured = capture({ content: statement, kind: "preference", session_id: sessionId, session_host: hookHost(input),
            scope_kind: "session", scope_id: sessionId, project_scope_id: scope.id, project_root: input.cwd, sensitivity: "internal" });
          memoryWritten = captured.auto_committed === true;
          captureSummary = { candidate_id: (captured.candidate as JsonObject | null)?.id ?? null, next_action: captured.next_action,
            ...(statement.length <= 32 ? { captured_fact: statement } : {}),
            topic_suggestions: Array.isArray(captured.topic_suggestions) ? captured.topic_suggestions.slice(0, 2) : [],
            promotions: Array.isArray(captured.promotions) ? (captured.promotions as JsonObject[]).map(item => ({ tier: item.tier, auto_committed: item.auto_committed === true })) : [],
            capture_mode: explicitStatement ? "explicit" : "automatic_stable_fact", memory_written: memoryWritten };
        } catch (error) {
          this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "memory", event: "UserPromptSubmit", error_type: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    const sessionId = text(input.session_id);
    const resolved = await this.service.contextWorkingSets.resolve({ query: prompt, session_id: sessionId ?? undefined, session_scope_id: sessionId ?? undefined, session_host: hookHost(input), turn_id: text(input.turn_id) ?? undefined, scope_kind: scope.kind, scope_id: scope.id,
      members: [...members], include_global: true });
    const items = resolved.items as JsonObject[];
    const contributions = resolved.contributions as JsonObject[];
    const candidates: HookCandidate[] = [
      ...items.map(item => ({ member: "memory", item, output: { type: "memory", id: item.memory_id, version: item.memory_version, content: item.content,
        ...(item.content_digest ? { content_digest: item.content_digest } : {}), ...(item.content_excerpt ? { content_excerpt: item.content_excerpt } : {}) } })),
      ...contributions.flatMap(contribution => {
        if (!Array.isArray(contribution.items)) return [];
        if (contribution.member === "knowledge") return (contribution.items as JsonObject[]).map(item => ({ member: "knowledge", item, output: knowledgeHookProjection(item) }));
        if (contribution.member === "experience") return (contribution.items as JsonObject[]).map(item => ({ member: "experience", item, output: experienceHookProjection(item) }));
        return [];
      }),
    ];
    const resolvedRefs = Array.isArray(resolved.asset_refs) ? resolved.asset_refs as JsonObject[] : null;
    const candidateRefs: HookEmissionCandidate[] | null = resolvedRefs
      ? candidates.map(candidate => ({ candidate, ref: contextAssetRef(candidate.member, candidate.item, scope) }))
        .filter(entry => resolvedRefs.some(ref => contextAssetMatches(ref, entry.ref)))
      : null;
    const receipt = resolved.receipt as JsonObject | null;
    if (receipt) this.journal.bindContextReceipt(input, receipt, scope);
    return this.service.store.transaction(() => {
      assertContextReadCurrent(this.service.store, receipt);
      let available: HookEmissionCandidate[] = candidateRefs ?? candidates.map(candidate => ({ candidate, ref: null }));
      available = available.map(entry => ({ ...entry, candidate: { ...entry.candidate, output: { ...entry.candidate.output } } }));
      const response = (selected: JsonObject[]) => JSON.stringify({ source: `craft-${member}`, scope, receipt_id: receipt?.id ?? null,
        ...(captureSummary ? { memory_capture: captureSummary } : {}), selected });
      let selected = available.map(entry => entry.candidate.output);
      let additionalContext = response(selected);
      while (selected.length > 0 && estimateTokens(additionalContext) > HOOK_ADDITIONAL_CONTEXT_BUDGET[member]) {
        const longest = available.reduce((best, entry, index) => {
          const currentLength = typeof entry.candidate.output.content === "string" ? entry.candidate.output.content.length : 0;
          const bestContent = best < 0 ? null : available[best]!.candidate.output.content;
          const bestLength = typeof bestContent === "string" ? bestContent.length : 0;
          return currentLength > 32 && (best < 0 || currentLength > bestLength) ? index : best;
        }, -1);
        if (longest >= 0) {
          const output = available[longest]!.candidate.output;
          const content = String(output.content);
          available[longest]!.candidate.output = compactHookItem(output, prompt, Math.max(32, Math.floor(content.length / 2)));
        } else available = available.slice(0, -1);
        selected = available.map(entry => entry.candidate.output);
        additionalContext = response(selected);
      }
      if (estimateTokens(additionalContext) > HOOK_ADDITIONAL_CONTEXT_BUDGET[member]) return {};
      if (resolvedRefs && available.length > 0) {
        const novelRefs = this.service.contextWorkingSets.claimEmission({ query: prompt, session_id: sessionId ?? undefined,
          turn_id: text(input.turn_id) ?? undefined, scope_kind: scope.kind, scope_id: scope.id }, { asset_refs: available.map(entry => entry.ref!), receipt });
        available = available.filter(entry => novelRefs.some(ref => contextAssetMatches(ref, entry.ref!)));
        selected = available.map(entry => entry.candidate.output);
        additionalContext = response(selected);
      }
      for (const component of members) this.service.activationProofRecord({ host: hookHost(input), component, event: "UserPromptSubmit", session_id: text(input.session_id) ?? "unknown",
        turn_id: text(input.turn_id), context_receipt_id: receipt?.id ?? undefined, memory_written: component === "memory" && memoryWritten, observation_written: false,
        plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
      if (!selected.length && !captureSummary) return {};
      return { additionalContext };
    });
  }

  private tool(input: HookInput, projectScope: HookProjectScope | null): JsonObject {
    const rawSignal = this.signals.signal(input); if (!rawSignal) return {};
    const captured = { ...rawSignal, id: `codex_hook_signal_${stableDigest({ host: hookHost(input), scope: projectScope, session_id: text(input.session_id), turn_id: text(input.turn_id), signal_id: rawSignal.id }).slice(-20)}` };
    const scenario = projectScope ? projectScenarioKey(input, captured, this.service, projectScope) : null;
    this.journal.record(input, scenario ? { ...captured, scenario_key: scenario.scenario_key,
      ...(scenario.coarse_scenario_key ? { coarse_scenario_key: scenario.coarse_scenario_key } : {}) } : captured, projectScope);
    return {};
  }

  /** Persist a bounded resume snapshot before the Host compacts. Best-effort. */
  private preCompact(input: HookInput, projectScope: HookProjectScope | null): JsonObject {
    const sessionId = text(input.session_id);
    if (!sessionId) return {};
    try {
      this.service.contextExtensionsCheckpointResume({ session_id: sessionId, session_host: hookHost(input),
        ...(projectScope ? { scope: `${projectScope.kind}:${projectScope.id}` } : {}),
        files_touched: input.files_touched, tasks: input.tasks, errors: input.errors,
        decisions: input.decisions, open_questions: input.open_questions });
    } catch { /* Compaction must never be blocked by a resume-snapshot failure. */ }
    return {};
  }

  private stop(member: ComponentHookMember, input: HookInput, projectScope: HookProjectScope | null): JsonObject {
    const journal = this.journal.find(input, undefined, projectScope);
    const finalized = member === "experience" ? this.service.store.transaction(() => {
      const result = this.learning.finalize(input, projectScope);
      const goalArgs = experienceTaskGoalArgs(this.service, input, projectScope);
      if (goalArgs) deleteExperienceTaskGoal(goalArgs);
      this.recordObservedContextUse(input, projectScope);
      this.journal.close(input, projectScope);
      return result;
    }) : null;
    if (member !== "experience") this.recordObservedContextUse(input, projectScope);
    this.service.activationProofRecord({ host: hookHost(input), component: member, event: "Stop", session_id: text(input.session_id) ?? "unknown",
      turn_id: text(input.turn_id), memory_written: false, observation_written: finalized !== null,
      plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
    this.lifecycle(member, "Stop", input);
    const guidance = this.verificationGapGuidance(input, journal);
    return guidance ? { systemMessage: guidance } : {};
  }

  /**
   * A turn that edited files but never produced a verification signal cannot be
   * recorded as passed or failed. Surface a bounded, content-free hint instead
   * of silently leaving `verification_outcome` null. `stop_hook_active` prevents
   * a Host that re-enters Stop from looping on the same hint.
   */
  private verificationGapGuidance(input: HookInput, journal: JsonObject | null): string | null {
    if (!journal || journal.has_edit !== true || journal.verification_outcome !== null || input.stop_hook_active === true) return null;
    try {
      this.service.store.appendEvent("codex-hook", "codex_hook.unverified_edit", { member: "experience",
        session_id: input.session_id, turn_id: journal.turn_id,
        reason: "edit_without_verification", content_stored: false });
    } catch { /* The hint must never block Stop. */ }
    return "Craft：本轮修改了文件，但最后一次编辑后没有可识别的验证结果。请运行相关测试后再结束，以便记录为已验证；否则该回合只会作为未验证观察。";
  }

  /** Record that exact Context assets were shown and the turn's observed outcome, without calling them helpful. */
  private recordObservedContextUse(input: HookInput, projectScope?: HookProjectScope | null): void {
    const journal = this.journal.find(input, undefined, projectScope);
    if (!journal || typeof journal.context_receipt_id !== "string" || typeof journal.turn_id !== "string") return;
    const turnOutcome = journal.verification_outcome === "passed" || journal.verification_outcome === "failed"
      ? String(journal.verification_outcome) : "unverified";
    try {
      this.service.contextResolutionFeedback({ receipt_id: journal.context_receipt_id, outcome: "unrated", usage_stage: "shown",
        turn_outcome: turnOutcome, feedback_id: `context_hook_observed_${stableDigest({ receipt_id: journal.context_receipt_id, turn_id: journal.turn_id }).slice(-24)}` });
    } catch (error) {
      this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "context", event: "Stop",
        error_type: error instanceof Error ? error.name : "Error" });
    }
  }

  /**
   * Session and turn boundaries are audit signals, not component usage.  In
   * particular, readiness here is intentionally marked as readiness-only so a
   * lifecycle hook can never masquerade as a Knowledge/Memory retrieval.
   */
  private lifecycle(member: ComponentHookMember, event: HookEvent, input: HookInput, scheduleMaintenance = true): JsonObject {
    // A lifecycle signal does not require a full readiness scan. In particular,
    // counting every Memory candidate here makes SessionEnd scale with the
    // entire data set and can exceed the Host Hook deadline.
    const scope = codexProjectScope(input.cwd);
    try {
      if (event === "SessionEnd" && member === "memory" && text(input.session_id)) {
        try {
          this.service.store.bindSessionStorageHost(text(input.session_id)!, hookHost(input));
          if (this.launchArchiveWorker) {
            this.service.memoryGovernance.ledger.files.queueSessionArchive(text(input.session_id)!, hookHost(input));
          } else this.service.memorySessionArchive({ session_id: text(input.session_id), session_host: hookHost(input) });
        }
        catch (error) { this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member, event, error_type: error instanceof Error ? error.name : "unknown" }); }
      }
      if (event === "SessionEnd" && scheduleMaintenance && text(input.session_id)) {
        const leaseId = `hook-${member}-${stableDigest({ host: hookHost(input), member, session_id: text(input.session_id) }).slice(-32)}`;
        if (this.launchArchiveWorker) queueHookMaintenance(this.service.store, leaseId);
        else this.service.memoryMaintenanceSchedule({ stage: "light", lease_id: leaseId });
      }
      this.service.store.appendEvent("codex-hook", "codex_hook.lifecycle", {
        member,
        event,
        scope,
        session_id: text(input.session_id) ?? "unknown",
        turn_id: text(input.turn_id),
        source: text(input.source),
        reason: text(input.reason),
        stop_hook_active: input.stop_hook_active === true,
        readiness_state: "not_evaluated",
        usage: { kind: "readiness_only", component_used: false, context_resolved: false },
      });
      this.service.activationProofRecord({ host: hookHost(input), component: member, event, session_id: text(input.session_id) ?? "unknown",
        turn_id: text(input.turn_id), memory_written: false, observation_written: false,
        plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
    } finally {
      // Failed telemetry or maintenance enqueue must not strand a queued archive.
      if (event === "SessionEnd" && this.launchArchiveWorker) this.launchArchiveWorker();
    }
    return {};
  }
}
