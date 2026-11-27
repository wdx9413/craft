import { hookVerificationGap } from "../hook-verification-gap.ts";
import { carryVerifiedCodexCommandCompletion, NATIVE_ASYNC_COMPLETION } from "./codex-hook-command-result.ts";
import { ComponentTraceKernel } from "../component-trace.ts";
import { operationErrorCode } from 'craft-common-log/operation';
import { randomUUID as hookRequestId } from "node:crypto";
import { assertContextReadCurrent } from "../context-access-guard.ts";
import { contextAssetMatches, contextAssetRef } from 'craft-common-base/context-assets';
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
import { retrievalExcerpt } from 'craft-common-base/retrieval-excerpt';
import { payload, stableDigest } from "../digest.ts";
import { projectExperienceDirectory } from "../project-experience-directory.ts";
import { deleteExperienceTaskGoal, readExperienceTaskGoal } from "../experience-task-goals.ts";
import { sessionStorageScopeId } from "craft-common-store-local/paths";
import { SupervisorClient } from "./supervisor.ts";
import { sanitizeCodexTaskGoal } from "../codex-task-prose.ts";
import { validateConcept, mapLegacyKind } from 'craft-common-ontology/validation';
import { evaluateEvolutionValue } from "../evolution-value-gate.ts";
import { extractUserStatedOperatingSteps } from '@craft/capability-context';
import { CRAFT_RELEASE_VERSION } from "../version.ts";
import { HookSignalSanitizer, nestedText, type HookSignal } from "./codex-hook-signal-sanitizer.ts";
import { codexHookLearningStageDiagnostic } from "./codex-hook-learning-diagnostic.ts";
import { queueHookMaintenance } from "./memory-archive-worker.ts";
import { evolutionHostTurnSource, expireEvolutionProjectBinding, mintEvolutionProjectBinding } from "../evolution-project-binding.ts";
import { extractDurableStatements } from "../domains/durable-statements.ts";
import { CodexHostTraceCapture } from "./codex-host-trace-capture.ts";
import { CodexExperienceProcedureUsageCapture } from "./codex-experience-procedure-usage.ts";
export { extractDurableStatements } from "../domains/durable-statements.ts";
export { HookSignalSanitizer } from "./codex-hook-signal-sanitizer.ts";

const HOOK_SESSION_CLAIM = Symbol("hook-session-claim");
function hookClaim(input: HookInput): string | undefined {
  const value = (input as Record<PropertyKey, unknown>)[HOOK_SESSION_CLAIM];
  return typeof value === "string" ? value : undefined;
}

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

/** Caller-provided Host hint used for routing; it is not authenticated Host identity. */
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

function evolutionDomainFor(textValue: string): "coding" | "office" | "travel" | "creation" | "research" {
  if (/(?:会议|文档|表格|ppt|模板|审批)/iu.test(textValue)) return "office";
  if (/(?:预算|行程|航班|酒店|签证)/iu.test(textValue)) return "travel";
  if (/(?:prompt|风格|图片|视频|幻灯片|封面|素材)/iu.test(textValue)) return "creation";
  if (/(?:论文|假设|实验|文献|反例|复现)/iu.test(textValue)) return "research";
  return "coding";
}

/**
 * Extract durable statements (rules/facts/preferences) from a user prompt.
 * Conservative by design: only explicit conventions, rules, preferences or
 * facts are captured so ordinary task chatter is never persisted.
 */
function experienceTaskGoalArgs(service: CraftService, input: HookInput, scope: HookProjectScope | null) {
  const root = text(input.cwd), sessionId = text(input.session_id), turnId = text(input.turn_id);
  if (!root || !sessionId || !turnId || !scope) return null;
  return { experience_dir: projectExperienceDirectory(service.store, scope.id, root, true), scope: scope.id, session_host: hookHost(input), session_host_verified: false, session_id: sessionId, turn_id: turnId };
}

function taskGoalMemoryKey(args: { scope: string; session_host: string; session_id: string; turn_id: string }): string {
  return `goal:${stableDigest({ scope: args.scope, session_host: args.session_host, session_id: args.session_id, turn_id: args.turn_id }).slice(-32)}`;
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

/** Session facts live only in the shared Supervisor and are updated atomically. */
export class HookTurnJournal {
  readonly service: CraftService;
  constructor(service: CraftService) { this.service = ownedMemberService(service, "runtime"); }
  private key(input: HookInput, scope: HookProjectScope, turn: string): string {
    return `hook:turn:${stableDigest({ scope, turn }).slice(-32)}`;
  }
  private session(input: HookInput): string { return sessionStorageScopeId(hookHost(input), text(input.session_id) ?? "unknown"); }
  async update(input: HookInput, key: string, change: (prior: JsonObject | null) => JsonObject | null): Promise<JsonObject | null> {
    const client = new SupervisorClient(this.service.store.paths), session_key = this.session(input);
    for (let attempt = 0; attempt < 32; attempt++) {
      const result = await client.contextGet({ session_key, key, ...(hookClaim(input) ? { claim_token: hookClaim(input) } : {}) });
      if (result.ended === true) throw new Error("SESSION_ARCHIVED: session Hook is unavailable");
      const prior = result.status === "available" ? result.value as JsonObject : null;
      const next = change(prior);
      if (!next) return prior;
      const expected_digest = prior ? createHash("sha256").update(JSON.stringify(prior)).digest("hex") : null;
      const written = await client.contextPut({ session_key, key, value: next, expected_digest, ttl_ms: 86_400_000, ...(hookClaim(input) ? { claim_token: hookClaim(input) } : {}) });
      if (written.status === "stored") return next;
    }
    throw new Error("Hook session changed repeatedly; retry the event");
  }
  async record(input: HookInput, signal: Signal, projectScope?: HookProjectScope | null): Promise<JsonObject | null> {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope, turn = text(input.turn_id);
    if (!scope || !turn) return null;
    const legacy = await this.find(input, undefined, scope);
    return this.update(input, this.key(input, scope, turn), current => {
      const prior = current ?? legacy;
      if (prior?.closed_at && !((input as Record<PropertyKey, unknown>)[NATIVE_ASYNC_COMPLETION] === true && !prior.verification_outcome)) return null;
      const signals = Array.isArray(prior?.signals) ? prior.signals as JsonObject[] : [];
      if (signals.some(item => item.id === signal.id)) return null;
      return this.summarize(input, scope, turn, { ...prior, signals: [...signals, signal] });
    });
  }
  async bindContextReceipt(input: HookInput, receipt: JsonObject, projectScope?: HookProjectScope | null): Promise<void> {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope, turn = text(input.turn_id);
    if (!scope || !turn) return;
    const legacy = await this.find(input, undefined, scope);
    await this.update(input, this.key(input, scope, turn), current => {
      const prior = current ?? legacy;
      return prior?.closed_at ? null : this.summarize(input, scope, turn, { ...prior, context_receipt_id: receipt.id });
    });
  }
  async find(input: HookInput, _includePendingSignals?: boolean, projectScope?: HookProjectScope | null): Promise<JsonObject | null> {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope, turn = text(input.turn_id);
    if (!scope || !turn) return null;
    const result = await new SupervisorClient(this.service.store.paths).contextGet({ session_key: this.session(input), key: this.key(input, scope, turn), ...(hookClaim(input) ? { claim_token: hookClaim(input) } : {}) });
    if (result.status === "available") return result.value as JsonObject;
    if (result.ended === true) return null;
    const session_id = text(input.session_id) ?? "unknown";
    const ids = [
      `codex_hook_turn_${digest({ scope, session_host: hookHost(input), session_id, turn }).slice(-20)}`,
      `codex_hook_turn_${digest({ scope, session_id, turn }).slice(-20)}`,
      `codex_hook_turn_${digest({ scope, turn }).slice(-20)}`,
    ];
    let prior: JsonObject | null = null;
    for (const id of ids) {
      const candidate = this.service.store.find("codex_hook_turn", id) ?? this.service.store.traceShards.find("codex_hook_turn", id, undefined, id);
      if (candidate && candidate.session_host === hookHost(input) && (candidate.session_id ?? "unknown") === session_id) { prior = candidate; break; }
    }
    const records = this.service.store.traceShards.hookSignalsForTurn(scope.kind, scope.id, session_id, turn, 10_000, hookHost(input));
    const signals = new Map<string, JsonObject>();
    for (const signal of Array.isArray(prior?.signals) ? prior.signals as JsonObject[] : []) if (typeof signal.id === "string") signals.set(signal.id, signal);
    for (const record of records) {
      const signal = record.signal;
      if (signal && typeof signal === "object" && !Array.isArray(signal) && typeof (signal as JsonObject).id === "string") signals.set(String((signal as JsonObject).id), signal as JsonObject);
    }
    if (!prior && !signals.size) return null;
    const summarized = this.summarize(input, scope, turn, { ...prior, signals: [...signals.values()] });
    return prior ? { ...summarized, id: prior.id, trace_id: prior.trace_id ?? prior.id } : summarized;
  }
  async close(input: HookInput, projectScope?: HookProjectScope | null): Promise<JsonObject | null> {
    const scope = projectScope === undefined ? codexProjectScope(input.cwd) : projectScope, turn = text(input.turn_id);
    if (!scope || !turn) return null;
    const legacy = await this.find(input, undefined, scope);
    return this.update(input, this.key(input, scope, turn), current => {
      const prior = current ?? legacy;
      if (prior?.closed_at && current) return null;
      const next = this.summarize(input, scope, turn, prior ?? {});
      const scenario = text(input.scenario_key);
      if (scenario && /^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(scenario) && !next.scenario_key) {
        const signals = next.signals as JsonObject[], lastEdit = signals.findLastIndex(item => item.kind === "edit");
        next.signals = signals.map((signal, index) => index > lastEdit && signal.kind === "verification" ? { ...signal, scenario_key: scenario } : signal);
        next.scenario_key = scenario;
      }
      return { ...next, closed_at: prior?.closed_at ?? new Date().toISOString() };
    });
  }
  private summarize(input: HookInput, scope: HookProjectScope, turn: string, prior: JsonObject): JsonObject {
    const signals = Array.isArray(prior.signals) ? prior.signals as JsonObject[] : [];
    const lastEdit = signals.findLastIndex(item => item.kind === "edit"), checks = new Map<string, string>();
    for (const item of signals.slice(lastEdit + 1)) if (item.kind === "verification" || item.kind === "verification_gap") checks.set(String(item.verifier), String(item.outcome));
    const outcomes = [...checks.values()], verifications = signals.slice(lastEdit + 1).filter(item => item.kind === "verification");
    const scenarioKey = verifications.length && verifications.every(item => item.outcome !== "unknown" && typeof item.scenario_key === "string") && new Set(verifications.map(item => item.scenario_key)).size === 1 ? String(verifications[0]!.scenario_key) : null;
    const coarse = scenarioKey && verifications.every(item => (item.coarse_scenario_key ?? null) === (verifications[0]!.coarse_scenario_key ?? null)) ? text(verifications[0]!.coarse_scenario_key) : null;
    const id = `codex_hook_turn_${digest({ scope, session_host: hookHost(input), session_id: text(input.session_id) ?? "unknown", turn }).slice(-20)}`;
    return { ...prior, id, trace_id: id, scope, session_host: hookHost(input), session_host_verified: false, session_id: text(input.session_id) ?? "unknown", turn_id: turn, signals,
      has_edit: Array.isArray(prior.signals) ? signals.some(item => item.kind === "edit") : prior.has_edit === true,
      verification_outcome: Array.isArray(prior.signals) ? (!outcomes.length || outcomes.includes("unknown") ? null : outcomes.includes("failed") ? "failed" : "passed") : prior.verification_outcome ?? null,
      edit_revision: Array.isArray(prior.signals) ? (lastEdit < 0 ? null : signals[lastEdit]!.digest) : prior.edit_revision ?? null,
      verification_receipts: Array.isArray(prior.signals) ? [...checks].map(([verifier, outcome]) => ({ verifier, outcome, edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest })) : prior.verification_receipts ?? [],
      scenario_key: lastEdit >= 0 ? scenarioKey : null, coarse_scenario_key: lastEdit >= 0 ? coarse : null, content_stored: false };
  }
}

/** Converts a verified local coding turn into only a proposal request. */
export class HookLearningCoordinator {
  readonly service: CraftService;
  readonly journal: HookTurnJournal;
  constructor(service: CraftService, journal = new HookTurnJournal(service)) { this.service = service; this.journal = journal; }

  private finalizedTurn(input: HookInput, journal: JsonObject): JsonObject | null {
    const turnId = String(journal.turn_id), receiptId = String(journal.context_receipt_id), host = hookHost(input);
    const evidenceIds = new Set(ownedMemberService(this.service, "experience").store.list("evidence", 10_000, evidence => {
      const metadata = evidence.metadata as JsonObject | undefined;
      return metadata?.provenance === "host_completion_signal" && metadata.host === host
        && metadata.turn_id === turnId && metadata.context_receipt_id === receiptId;
    }).map(evidence => String(evidence.id)));
    if (!evidenceIds.size) return null;
    const scope = journal.scope as JsonObject;
    const scopeKey = scope.kind === "project" ? `project:${String(scope.id).replace(/^project:/u, "")}` : `${scope.kind}:${scope.id}`;
    return ownedMemberService(this.service, "experience").store.list("workflow_evolution_observation", 10_000, observation => {
      const source = observation.source as JsonObject | undefined;
      return source?.scope === scopeKey && Array.isArray(observation.evidence_ids)
        && (observation.evidence_ids as unknown[]).some(id => evidenceIds.has(String(id)));
    })[0] ?? null;
  }

  finalize(input: HookInput, projectScope?: HookProjectScope | null, capturedTaskGoal?: string | null, journal?: JsonObject | null): JsonObject | null {
    const resolvedProjectScope = projectScope === undefined && typeof input.cwd === "string"
      ? (this.service.scopeIdentityResolveProject({ project_root: input.cwd }).identity as JsonObject).canonical_scope as HookProjectScope
      : projectScope;
    if (!journal || !["passed", "failed"].includes(String(journal.verification_outcome))) return null;
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

    }
    const suppliedScenario = text(input.scenario_key);
    if (suppliedScenario && !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(suppliedScenario)) throw new Error("scenario_key must be a bounded stable identifier");
    if (suppliedScenario && journal.scenario_key && journal.scenario_key !== suppliedScenario) throw new Error("scenario_key conflicts with the turn's recorded scenario");
    if (suppliedScenario && !journal.scenario_key) {
      const signals = journal.signals as JsonObject[];
      const lastEdit = signals.findLastIndex(item => item.kind === "edit");
      const alignedSignals = signals.map((signal, index) => index > lastEdit && signal.kind === "verification"
        ? { ...signal, scenario_key: suppliedScenario } : signal);
      journal.scenario_key = suppliedScenario;
      journal.signals = alignedSignals;
    }
    const scenario = suppliedScenario ?? text(journal.scenario_key);
    const legacyGoalArgs = capturedTaskGoal === undefined && !scenario ? experienceTaskGoalArgs(this.service, input, resolvedProjectScope as HookProjectScope) : null;
    const taskGoal = scenario ? null : capturedTaskGoal === undefined ? (legacyGoalArgs ? readExperienceTaskGoal(legacyGoalArgs) : null) : capturedTaskGoal;
    const signals = journal.signals as JsonObject[];
    const lastVerifier = [...signals].reverse().find(signal => signal.kind === "verification" && typeof signal.verifier === "string");
    const observedPaths = [...new Set(signals.filter(signal => signal.kind === "edit" && typeof signal.observed_path === "string")
      .map(signal => String(signal.observed_path)))].slice(0, 16);
    const finalized = prior ? { status: "observed", observation: prior,
      evidence: ownedMemberService(this.service, "experience").store.find("evidence", String((prior.evidence_ids as string[] | undefined)?.[0])),
      request: null, idempotent: true, next_action: "terminal_turn_already_recorded" }
      : this.service.learningCycleFinalize({ host: hookHost(input), host_identity_verified: false, task_id: String(journal.id), turn_id: String(journal.turn_id), context_receipt_id: journal.context_receipt_id,
      ...(typeof input.session_id === "string" ? { session_id: input.session_id } : {}),
      verified: true, project_root: projectRoot, verification_outcome: journal.verification_outcome, verification_ref: stableDigest(journal.verification_receipts), ...(scenario ? { scenario_key: scenario } : {}),
      ...(taskGoal ? { scenario_context: { task_goal: taskGoal,
        effect_summary: `任务已完成终态验证，结果为 ${String(journal.verification_outcome)}。`, sanitized: true, content_stored: false } } : {}),
      observed_paths: observedPaths,
      ...(typeof journal.coarse_scenario_key === "string" ? { coarse_scenario_key: journal.coarse_scenario_key } : {}),
      ...(typeof lastVerifier?.verifier === "string" ? { scenario_verifier_digest: lastVerifier.verifier } : {}) });
    const finalizedObject = finalized as JsonObject;
    const observation = finalizedObject.observation as JsonObject | null;
    if (journal.verification_outcome === "passed" && observation && typeof observation.id === "string") {
      try {
        const goalText = taskGoal || scenario || observedPaths.join(" ") || "verified project workflow";
        const scope = journal.scope as JsonObject;
        const evidence = finalizedObject.evidence as JsonObject | undefined;
        const source = observation.source as JsonObject | undefined;
        if (resolvedProjectScope && lastVerifier && typeof input.session_id === "string" && source?.session_id === input.session_id
          && source.scope === resolvedProjectScope.id && typeof evidence?.id === "string"
          && !this.service.store.find("program_memory_verified_observation", observation.id)) {
          this.service.store.create("program_memory_verified_observation", observation.id, { scope: resolvedProjectScope, evidence_id: evidence.id,
            source_digest: source.digest, source_session_id: source.session_id, task_id: source.id,
            turn_id: journal.turn_id, context_receipt_id: journal.context_receipt_id, content_stored: false });
        }
        if (typeof observation.scenario_key !== "string" || !observation.scenario_key) throw new Error("Verified observation has no scene identity");
        this.service.selfEvolution.captureProgramMemory({
          scenario_key: observation.scenario_key,
          domain: evolutionDomainFor(goalText),
          statement: `Verified workflow: ${goalText}`.slice(0, 280),
          steps: observedPaths,
          evidence_ids: [String(observation.id)],
          scope: { kind: String(scope.kind), id: String(scope.id) },
        });
      } catch { this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "experience", event: "Stop", error_type: "program_memory_capture_failed" }); }
    }
    return prior ? { ...finalized, idempotent: true, next_action: "terminal_turn_already_recorded" } : finalized;
  }
}

function ownedMemberService(service: CraftService, member: string): CraftService {
  if (!service.capabilityOwned || service.storageOwner === member) return service;
  const target = service.ownerServices.get(member);
  if (!target) throw new Error(`${member} owner is unavailable`);
  return target;
}

function memoryOwnerForProject(service: CraftService, scope: HookProjectScope, projectRoot: string | undefined): CraftService {
  if (!projectRoot?.trim()) throw new Error("Memory project root is unavailable");
  const memoryOwner = ownedMemberService(service, "memory");
  const resolved = memoryOwner.scopeIdentityResolveProject({ project_root: projectRoot }).identity as JsonObject | undefined;
  const canonical = resolved?.canonical_scope as JsonObject | undefined;
  if (canonical?.kind !== "project" || canonical.id !== scope.id) throw new Error("Memory project identity does not match Context");
  return memoryOwner;
}

export class CodexHookBridge {
  readonly service: CraftService;
  readonly signals: HookSignalSanitizer;
  readonly traceCapture: CodexHostTraceCapture;
  readonly procedureUsageCapture: CodexExperienceProcedureUsageCapture;
  readonly journal: HookTurnJournal;
  readonly learning: HookLearningCoordinator;
  readonly launchArchiveWorker?: () => void;
  private readonly issueEvolutionBinding: boolean;
  private readonly launchSessionCleanup?: (sessionKey: string, ownerId: string) => void;
  constructor(service: CraftService, launchArchiveWorker?: () => void, issueEvolutionBinding = process.env.CRAFT_HOOK_MODE === "1", launchSessionCleanup?: (sessionKey: string, ownerId: string) => void) {
    this.service = service; this.signals = new HookSignalSanitizer(); this.traceCapture = new CodexHostTraceCapture(service); this.procedureUsageCapture = new CodexExperienceProcedureUsageCapture(service); this.journal = new HookTurnJournal(service); this.learning = new HookLearningCoordinator(service, this.journal);
    this.launchArchiveWorker = launchArchiveWorker;
    this.launchSessionCleanup = launchSessionCleanup;
    this.issueEvolutionBinding = issueEvolutionBinding;
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
        // Existing legacy maintenance may still need a worker, but an identity
        // failure must never create a new session archive record.
        if (event === "SessionEnd" && (member === "context" || member === "memory") && this.launchArchiveWorker) {
          try { this.launchArchiveWorker(); } catch { /* Preserve the original identity failure. */ }
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
      if (event !== "SessionStart" && event !== "SessionEnd") {
        try { input = await this.correlateTurn(input, event, projectScope); }
        catch { return { systemMessage: "Craft Context 内存服务不可用，本次处理尚未完成，可在服务恢复后重试。" }; }
      }
      if ((event === "SessionStart" || event === "SessionEnd") && text(input.session_id)) {
        const sessionId = text(input.session_id)!;
        const scope = projectScope ? { scope_kind: projectScope.kind, scope_id: projectScope.id, project_id: projectScope.id }
          : { scope_kind: "global", scope_id: "global" };
        if (this.service.modRuntimeHasTrustedEvent("craft.session.lifecycle@1", scope)) {
          const status = event === "SessionStart" ? "started" : "ended";
          const deliveryId = `mod_session_${stableDigest({ host: hookHost(input), session_id: sessionId, status, scope }).slice(-32)}`;
          try {
            await this.service.modRuntimeDispatch({ event: "craft.session.lifecycle@1", host: hookHost(input), ...scope, delivery_id: deliveryId,
              input: { session_id: sessionId, status, scope_kind: scope.scope_kind, scope_id: scope.scope_id } });
          } catch {
            this.service.store.appendEvent("codex-hook", "codex_hook.mod_lifecycle_failed", { event, host: hookHost(input), error_type: "mod_runtime_failure" });
          }
        }
      }
      if (member === "context") {
        if (event === "SessionStart") {
          const sessionId = text(input.session_id);
          if (!sessionId) return {};
          try {
            const client = new SupervisorClient(this.service.store.paths), session_key = sessionStorageScopeId(hookHost(input), sessionId);
            await client.contextStart({ session_key });
            return {};
          } catch {
            return { systemMessage: "Craft Context 内存服务不可用，会话临时数据暂不可使用。" };
          }
        }
        if (event === "SessionEnd") {
          const sessionId = text(input.session_id);
          let contextPurgeUnavailable = false;
          if (sessionId) {
            const sessionKey = sessionStorageScopeId(hookHost(input), sessionId);
            let ownerId: string | undefined;
            for (const name of ["supervisor.json", "supervisor.lock.json"]) {
              try {
                const state = JSON.parse(readFileSync(join(this.service.store.paths.runtimeDir, name), "utf8")) as JsonObject;
                if (typeof state.owner_id === "string" && state.owner_id) { ownerId = state.owner_id; break; }
              } catch { /* Try the other existing Supervisor ownership record. */ }
            }
            try {
              await new SupervisorClient(this.service.store.paths, ownerId).contextEnd({ session_key: sessionKey });
            } catch {
              contextPurgeUnavailable = true;
              if (ownerId) this.launchSessionCleanup?.(sessionKey, ownerId);
            }
          }
          if (this.issueEvolutionBinding && sessionId) expireEvolutionProjectBinding(this.service.store, hookHost(input), sessionId);
          // Only Memory has lifecycle work here: archive temporary facts and
          // schedule maintenance. Readiness-only records for the other members
          // added repeated SQLite writes without representing capability use.
          this.lifecycle("memory", event, input);
          return contextPurgeUnavailable ? { systemMessage: "Craft Context 内存服务不可用，会话临时数据将在服务停止或过期时释放。" } : {};
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

  private async correlateTurn(input: HookInput, event: HookEvent | null, scope: HookProjectScope | null): Promise<HookInput> {
    const sessionId = text(input.session_id);
    if (!scope || !sessionId) return input;
    const sessionKey = `hook:session:${stableDigest({ scope }).slice(-24)}`;
    const suppliedTurnId = text(input.turn_id) ?? (hookHost(input) === "claude" ? text(input.prompt_id) : null);
    let turnId = suppliedTurnId;
    await this.journal.update(input, sessionKey, prior => {
      turnId = suppliedTurnId;
      let pending = Array.isArray(prior?.pending_turn_ids) ? prior.pending_turn_ids as string[] : [];
      let ambiguous = prior?.ambiguous === true;
      if (event === "UserPromptSubmit" && (text(input.prompt) || text(input.user_prompt))) {
        const sequence = Number(prior?.sequence ?? 0) + 1;
        turnId ??= `hook_turn_${sessionKey.slice(-24)}_${sequence}`;
        if (!pending.includes(turnId)) pending = [...pending, turnId];
        return { sequence, pending_turn_ids: pending, ambiguous: ambiguous || pending.length > 1 };
      }
      if (!turnId && !ambiguous && pending.length === 1) turnId = pending[0]!;
      return null;
    });
    if (!turnId) return input;
    const correlated = { ...input, turn_id: turnId };
    carryVerifiedCodexCommandCompletion(input, correlated);
    return correlated;
  }

  private async completeCorrelatedTurn(input: HookInput, scope: HookProjectScope | null): Promise<void> {
    const turn = text(input.turn_id);
    if (!scope || !text(input.session_id) || !turn) return;
    const key = `hook:session:${stableDigest({ scope }).slice(-24)}`;
    await this.journal.update(input, key, prior => {
      const pending = Array.isArray(prior?.pending_turn_ids) ? prior.pending_turn_ids as string[] : [];
      if (!pending.includes(turn)) return null;
      const remaining = pending.filter(id => id !== turn);
      return { ...prior, pending_turn_ids: remaining, ambiguous: remaining.length > 0 && prior?.ambiguous === true };
    });
  }

  /**
   * Write side of conversation self-evolution: turn durable user statements into
   * governed ledger records. Every write goes through the capability's own
   * validation and stays best-effort so a malformed statement can never block
   * the user's prompt. Facts/preferences become scoped Memory candidates; rules
   * additionally become reviewable Knowledge claims.
   */
  private accumulateDurableStatements(prompt: string, input: HookInput, scope: HookProjectScope,
    members: readonly string[]): { written: boolean; count: number } {
    const autoStatements = extractDurableStatements(prompt);
    if (!autoStatements.length) return { written: false, count: 0 };
    const sessionId = text(input.session_id);
    const sessionHost = hookHost(input);
    let written = false;
    let count = 0;
    const shouldWriteMemory = members.includes("memory");
    const shouldWriteKnowledge = members.includes("knowledge") || members.includes("context") || members.includes("memory");
    if (shouldWriteMemory && sessionId) {
      try {
        const memoryOwner = memoryOwnerForProject(this.service, scope, input.cwd);
        this.service.store.bindSessionStorageHost(sessionId, sessionHost);
        for (const item of autoStatements) {
          const decision = evaluateEvolutionValue({ statement: item.statement, source_kind: "user-statement", explicit: true,
            scope: { scope_kind: "project", scope_id: scope.id, project_scope_id: scope.id } });
          if (decision.action !== "store_as_fact" && decision.action !== "store_as_preference") continue;
          const legacyKind = item.kind === "preference" ? "preference" : item.kind === "rule" ? "procedural" : "working";
          validateConcept(mapLegacyKind("memory", legacyKind), item.statement);
          const captured = memoryOwner.memoryCaptureObservedFact({ content: item.statement, kind: legacyKind,
            session_id: sessionId, session_host: sessionHost,
            project_scope_id: scope.id, project_root: input.cwd, sensitivity: "internal",
            ...(text(input.turn_id) ? { turn_id: text(input.turn_id) } : {}), ...(text(input.task_id) ? { task_id: text(input.task_id) } : {}),
            ...(item.kind === "rule" ? { tags: ["auto_extracted_rule"] } : {}) });
          written = written || captured.auto_committed === true;
          count += 1;
        }
      } catch (error) {
        this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "memory", event: "UserPromptSubmit", error_type: error instanceof Error ? error.name : "unknown" });
      }
    }
    if (shouldWriteKnowledge) {
      try {
        for (const item of autoStatements.filter((entry) => entry.kind === "rule")) {
          const decision = evaluateEvolutionValue({ statement: item.statement, source_kind: "user-statement", explicit: true,
            scope: { scope_kind: "project", scope_id: scope.id } });
          if (decision.action !== "store_as_fact") continue;
          // A claim requires at least one Evidence record. The evidence only
          // attests "the user stated this rule", never that the rule is true.
          const evidenceId = `codex_hook_rule_${stableDigest({ statement: item.statement, session_id: sessionId ?? "" }).slice(-24)}`;
          const knowledgeOwner = ownedMemberService(this.service, "knowledge");
          knowledgeOwner.knowledgeMemoryInstallBuiltins();
          if (knowledgeOwner !== this.service && typeof input.cwd === "string") {
            const registered = knowledgeOwner.scopeIdentityResolveProject({ project_root: input.cwd });
            if (((registered.identity as JsonObject).canonical_scope as JsonObject).id !== scope.id) throw new Error("Knowledge project binding mismatch");
          }
          const evidence = knowledgeOwner.evidenceRecord({ evidence_id: evidenceId, source_type: "codex-hook",
            claim: "user-stated-convention", confidence: "unverified",
            locator: sessionId ?? "codex-hook" });
          const turnId = text(input.turn_id);
          if (!sessionId || !turnId) continue;
          knowledgeOwner.knowledgeCaptureLiveHookCandidate({ kind: "rule", content: item.statement, scope: scope.id,
            project_root: input.cwd, evidence_ids: [evidenceId],
            source_lineage: [{ origin: "live_hook", session_id: sessionId, turn_id: turnId,
              ...(text(input.task_id) ? { task_id: text(input.task_id) } : {}), project_scope_id: scope.id,
              source_ref: { kind: "codex_hook_turn", id: turnId, digest: stableDigest({ session_id: sessionId, turn_id: turnId, statement_digest: stableDigest(item.statement) }) },
              evidence_refs: [{ kind: "evidence", id: evidence.id, version: Number(evidence.version) }] }],
            tags: ["auto_extracted_rule"], proposed_by: sessionId });
          count += 1;
        }
      } catch (error) {
        this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "knowledge", event: "UserPromptSubmit", error_type: error instanceof Error ? error.name : "unknown" });
      }
    }
    return { written, count };
  }

  private async prompt(member: CodexHookMember, input: HookInput, scope: HookProjectScope | null): Promise<JsonObject> {
    const prompt = text(input.prompt) ?? text(input.user_prompt);
    if (!scope || !prompt) return {};
    const sessionId = text(input.session_id);
    const turnId = text(input.turn_id);
    const taskId = text(input.task_id);
    const runtimeScope = { scope_kind: scope.kind, scope_id: scope.id, project_id: scope.id,
      ...(taskId ? { task_id: taskId } : {}) };
    const deliveryId = (event: string) => turnId ? `mod_hook_${stableDigest({ event, scope, session_id: sessionId, turn_id: turnId }).slice(-32)}` : undefined;
    if (this.service.modRuntimeHasTrustedEvent("craft.input.receive@1", runtimeScope)) {
      try {
        await this.service.modRuntimeDispatch({ event: "craft.input.receive@1", host: hookHost(input), ...runtimeScope,
          ...(deliveryId("craft.input.receive@1") ? { delivery_id: deliveryId("craft.input.receive@1") } : {}),
          input: { text: prompt, ...(sessionId ? { session_id: sessionId } : {}), ...(taskId ? { task_id: taskId } : {}) } });
      } catch { /* Input receipt observers cannot block prompt submission. */ }
    }
    let effectivePrompt = prompt;
    if (this.service.modRuntimeHasTrustedEvent("craft.input.submit@1", runtimeScope)) {
      const inputResult = await this.service.modRuntimeDispatch({ event: "craft.input.submit@1", host: hookHost(input),
        ...(deliveryId("craft.input.submit@1") ? { delivery_id: deliveryId("craft.input.submit@1") } : {}), ...runtimeScope,
        input: { text: prompt, ...(sessionId ? { session_id: sessionId } : {}), ...(text(input.task_id) ? { task_id: text(input.task_id)! } : {}) } });
      if (inputResult.status === "rejected" || inputResult.status === "failed") return {};
      const submitted = inputResult.result as JsonObject;
      effectivePrompt = typeof submitted.text === "string" ? submitted.text : prompt;
    }
    let effectiveQuery = effectivePrompt;
    let modContextAdditions: string[] = [];
    if (this.service.modRuntimeHasTrustedEvent("craft.context.assemble@1", runtimeScope)) {
      const contextResult = await this.service.modRuntimeDispatch({ event: "craft.context.assemble@1", host: hookHost(input),
        ...(deliveryId("craft.context.assemble@1") ? { delivery_id: deliveryId("craft.context.assemble@1") } : {}), ...runtimeScope,
        input: { query: effectivePrompt, scope_kind: scope.kind, scope_id: scope.id,
          ...(sessionId ? { session_id: sessionId } : {}), ...(text(input.task_id) ? { task_id: text(input.task_id)! } : {}) } });
      if (contextResult.status === "rejected" || contextResult.status === "failed") return {};
      const assembled = contextResult.result as JsonObject;
      effectiveQuery = typeof assembled.query === "string" ? assembled.query : effectivePrompt;
      if (assembled.context_additions !== undefined) {
        if (!Array.isArray(assembled.context_additions) || assembled.context_additions.length > 5
          || assembled.context_additions.some((item) => typeof item !== "string" || !item.trim() || item.length > 2_000 || SECRET.test(item))) {
          throw new Error("Mod Context additions must be at most five non-empty, secret-free strings of at most 2000 characters");
        }
        modContextAdditions = [...assembled.context_additions] as string[];
      }
    }
    const members = member === "context" ? CONTEXT_MEMBERS : [member];
    // Persist the current checkout only as an alias. The receipt still names the
    // canonical Git identity, so it is portable and does not leak the path.
    if (members.includes("experience")) {
      const taskGoal = sanitizedExperienceTaskGoal(prompt);
      if (taskGoal) {
        try {
          const args = experienceTaskGoalArgs(this.service, input, scope);
          if (args) await new SupervisorClient(this.service.store.paths).contextPut({
            session_key: sessionStorageScopeId(args.session_host, args.session_id), key: taskGoalMemoryKey(args),
            value: { task_goal: taskGoal }, ttl_ms: 86_400_000,
          });
        }
        catch { this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "experience", event: "UserPromptSubmit", error_type: "storage_unavailable" }); }
      }
    }
    let memoryWritten = false; let captureSummary: JsonObject | null = null;
    // Automatically accumulate durable statements from the user's prompt into
    // the governed Knowledge/Memory ledgers. This is the write side that was
    // missing: the Hook previously only projected context and captured a very
    // narrow set of preferences.
    const autoAccumulation = this.accumulateDurableStatements(prompt, input, scope, members);
    memoryWritten = memoryWritten || autoAccumulation.written;
    // Project-bound operating steps become diagnostic Program Memory.
    // Keep the original Runbook behavior for existing embedded callers.
    try {
      const statement = extractUserStatedOperatingSteps(prompt)[0];
      if (members.includes("experience") && sessionId && turnId && statement) {
        const sourceRefs = [evolutionHostTurnSource({ host: hookHost(input), session_id: sessionId, turn_id: turnId, scope })];
        this.service.evolutionDomainCapture({ statement, scope, source_refs: sourceRefs });
        if (!this.issueEvolutionBinding) this.service.evolutionRunbookCapture({ statement, session_id: sessionId, turn_id: turnId, source_refs: sourceRefs });
      }
    } catch { /* A malformed or already-captured Runbook must not block the prompt. */ }
    if (members.includes("memory")) {
      const explicitStatement = explicitMemoryStatement(prompt);
      // `/remember:` statements keep the richer capture summary. Automatic
      // facts and conventions are handled by accumulateDurableStatements to
      // avoid duplicate ledger writes.
      const statement = explicitStatement;
      const sessionId = text(input.session_id);
      if (statement && sessionId) {
        try {
          const memoryOwner = memoryOwnerForProject(this.service, scope, input.cwd);
          this.service.store.bindSessionStorageHost(sessionId, hookHost(input));
          const captured = memoryOwner.memoryCaptureUserStatement({ content: statement, kind: "preference", session_id: sessionId, session_host: hookHost(input), session_host_verified: false,
            scope_kind: "project", scope_id: scope.id, project_scope_id: scope.id, project_root: input.cwd, sensitivity: "internal" });
          memoryWritten = captured.auto_committed === true;
          captureSummary = { candidate_id: (captured.candidate as JsonObject | null)?.id ?? null, next_action: captured.next_action,
            ...(statement.length <= 32 ? { captured_fact: statement } : {}),
            topic_suggestions: Array.isArray(captured.topic_suggestions) ? captured.topic_suggestions.slice(0, 2) : [],
            promotions: Array.isArray(captured.promotions) ? (captured.promotions as JsonObject[]).map(item => ({ tier: item.tier, auto_committed: item.auto_committed === true })) : [],
            capture_mode: "explicit", memory_written: memoryWritten };
        } catch (error) {
          this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "memory", event: "UserPromptSubmit", error_type: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    const resolved = await this.service.contextWorkingSets.resolve({ query: effectiveQuery, session_id: sessionId ?? undefined, session_scope_id: sessionId ?? undefined, session_host: hookHost(input), session_host_verified: false, turn_id: turnId ?? undefined, scope_kind: scope.kind, scope_id: scope.id,
      members: [...members], include_global: true,
      ...(member === "context" && this.issueEvolutionBinding ? { program_memory_scope_id: scope.id } : {}) });
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
    if (receipt) await this.journal.bindContextReceipt(input, receipt, scope);
    let presentedProcedureRefs: JsonObject[] = [];
    const response = this.service.store.transaction(() => {
      assertContextReadCurrent(this.service.store, receipt, this.service.contextResolution.ownerStores);
      const projectBinding = member === "context" && this.issueEvolutionBinding && sessionId && turnId && input.cwd
        ? mintEvolutionProjectBinding(this.service.store, { host: hookHost(input), session_id: sessionId, turn_id: turnId, project_root: input.cwd, scope,
          ...(typeof receipt?.id === "string" ? { context_receipt_id: receipt.id } : {}) })
        : undefined;
      let available: HookEmissionCandidate[] = candidateRefs ?? candidates.map(candidate => ({ candidate, ref: null }));
      available = available.map(entry => ({ ...entry, candidate: { ...entry.candidate, output: { ...entry.candidate.output } } }));
      const response = (selected: JsonObject[]) => JSON.stringify({ source: `craft-${member}`, scope, receipt_id: receipt?.id ?? null,
        ...(projectBinding ? { project_binding: projectBinding } : {}),
        ...(captureSummary ? { memory_capture: captureSummary } : {}),
        ...(modContextAdditions.length ? { mod_context_additions: modContextAdditions } : {}), selected });
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
          available[longest]!.candidate.output = compactHookItem(output, effectiveQuery, Math.max(32, Math.floor(content.length / 2)));
        } else available = available.slice(0, -1);
        selected = available.map(entry => entry.candidate.output);
        additionalContext = response(selected);
      }
      if (estimateTokens(additionalContext) > HOOK_ADDITIONAL_CONTEXT_BUDGET[member] && captureSummary && Array.isArray(captureSummary.topic_suggestions)
        && captureSummary.topic_suggestions.every(item => item !== null && typeof item === "object" && !Array.isArray(item))) {
        captureSummary.topic_suggestions = (captureSummary.topic_suggestions as JsonObject[]).map(item => ({ topic: item.topic, memory_id: item.memory_id }));
        additionalContext = response(selected);
      }
      if (estimateTokens(additionalContext) > HOOK_ADDITIONAL_CONTEXT_BUDGET[member]) return {};
      if (resolvedRefs && available.length > 0) {
        const novelRefs = this.service.contextWorkingSets.claimEmission({ query: effectiveQuery, session_id: sessionId ?? undefined,
          turn_id: text(input.turn_id) ?? undefined, scope_kind: scope.kind, scope_id: scope.id }, { asset_refs: available.map(entry => entry.ref!), receipt });
        available = available.filter(entry => novelRefs.some(ref => contextAssetMatches(ref, entry.ref!)));
        selected = available.map(entry => entry.candidate.output);
        additionalContext = response(selected);
      }
      for (const component of members) this.service.activationProofRecord({ host: hookHost(input), component, event: "UserPromptSubmit", session_id: text(input.session_id) ?? "unknown",
        turn_id: text(input.turn_id), context_receipt_id: receipt?.id ?? undefined, memory_written: component === "memory" && memoryWritten, observation_written: false,
        plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
      if (!selected.length && !captureSummary && !modContextAdditions.length && !projectBinding) return {};
      if (receipt && input.session_host === "codex") {
        presentedProcedureRefs = available
          .filter(entry => entry.candidate.member === "experience" && entry.ref?.member === "experience")
          .map(entry => entry.ref!);
      }
      return { additionalContext };
    });
    if (receipt && typeof receipt.id === "string" && input.session_host === "codex" && presentedProcedureRefs.length) {
      const trace = this.traceCapture.ensureTurnTrace(input, scope);
      if (trace.status === "captured") {
        for (const procedureRef of presentedProcedureRefs) {
          this.procedureUsageCapture.record({
            host: "codex",
            trace_id: trace.trace_id,
            session_id: text(input.session_id),
            turn_id: text(input.turn_id),
            project_scope: scope,
            context_receipt_id: receipt.id,
            procedure_ref: procedureRef,
            usage_state: "presented",
          });
        }
      }
    }
    return response;
  }

  private async tool(input: HookInput, projectScope: HookProjectScope | null): Promise<JsonObject> {
    const traceCapture = input.session_host === "codex" ? this.traceCapture.captureTool(input, projectScope) : null;
    const rawSignal = this.signals.signal(input) ?? this.signals.gap(input);
    if (!rawSignal) return traceCapture ? { trace_capture: traceCapture } : {};
    const captured = { ...rawSignal, id: `codex_hook_signal_${stableDigest({ host: hookHost(input), scope: projectScope, session_id: text(input.session_id), turn_id: text(input.turn_id), signal_id: rawSignal.id }).slice(-20)}` };
    const scenario = projectScope ? projectScenarioKey(input, captured, this.service, projectScope) : null;
    await this.journal.record(input, scenario ? { ...captured, scenario_key: scenario.scenario_key,
      ...(scenario.coarse_scenario_key ? { coarse_scenario_key: scenario.coarse_scenario_key } : {}) } : captured, projectScope);
    return traceCapture ? { trace_capture: traceCapture } : {};
  }

  /** Persist a bounded resume snapshot before the Host compacts. Best-effort. */
  private async preCompact(input: HookInput, projectScope: HookProjectScope | null): Promise<JsonObject> {
    const sessionId = text(input.session_id);
    if (!sessionId) return {};
    try {
      await this.service.contextExtensionsCheckpointResume({ session_id: sessionId, session_host: hookHost(input), session_host_verified: false,
        ...(projectScope ? { scope: `${projectScope.kind}:${projectScope.id}` } : {}),
        files_touched: input.files_touched, tasks: input.tasks, errors: input.errors,
        decisions: input.decisions, open_questions: input.open_questions });
    } catch { return { systemMessage: "Craft Context 内存服务不可用，本次压缩恢复快照未保存。" }; }
    return {};
  }

  private async stop(member: ComponentHookMember, input: HookInput, projectScope: HookProjectScope | null): Promise<JsonObject> {
    const client = new SupervisorClient(this.service.store.paths);
    const sessionKey = sessionStorageScopeId(hookHost(input), text(input.session_id) ?? "unknown");
    let claim: string | undefined;
    if (member === "experience") {
      try {
        const result = await client.contextClaim({ session_key: sessionKey });
        if (typeof result.token !== "string") throw new Error("Context claim unavailable");
        claim = result.token;
        input = { ...input, [HOOK_SESSION_CLAIM]: claim };
      } catch { return { systemMessage: "Craft Context 会话已结束或内存服务不可用，经验观察尚未完成。" }; }
    }
    try {
    const journal = await this.journal.close(input, projectScope);
    const goalArgs = member === "experience" ? experienceTaskGoalArgs(this.service, input, projectScope) : null;
    let taskGoal: string | null = null;
    let goalUnavailable = false;
    if (goalArgs) {
      try {
        const result = await new SupervisorClient(this.service.store.paths).contextGet({
          session_key: sessionStorageScopeId(goalArgs.session_host, goalArgs.session_id), key: taskGoalMemoryKey(goalArgs), claim_token: claim,
        });
        if (result.ended === true || result.status !== "available" && result.status !== "unavailable") goalUnavailable = true;
        else if (result.status === "available" && typeof (result.value as JsonObject).task_goal === "string") taskGoal = String((result.value as JsonObject).task_goal);
        else taskGoal = readExperienceTaskGoal(goalArgs);
      } catch {
        goalUnavailable = true;
      }
    }
    if (goalUnavailable) return { systemMessage: "Craft Context 内存服务不可用，经验观察尚未完成，可在服务恢复后重试。" };
    let terminalCapture: JsonObject | null = null;
    const finalized = member === "experience" ? this.service.store.transaction(() => {
      const result = this.learning.finalize(input, projectScope, taskGoal, journal);
      if (input.session_host === "codex") terminalCapture = this.traceCapture.recordTerminalVerification(input, projectScope, result);
      this.recordObservedContextUse(input, journal);
      return result;
    }) : null;
    if (goalArgs && finalized?.observation) {
      try {
        await new SupervisorClient(this.service.store.paths).contextPurge({
          session_key: sessionStorageScopeId(goalArgs.session_host, goalArgs.session_id), key: taskGoalMemoryKey(goalArgs), claim_token: claim,
        });
        deleteExperienceTaskGoal(goalArgs);
      } catch { /* A later cleanup may retire the retained legacy goal. */ }
    }
    if (member !== "experience") this.recordObservedContextUse(input, journal);
    await this.completeCorrelatedTurn(input, projectScope);
    this.service.activationProofRecord({ host: hookHost(input), component: member, event: "Stop", session_id: text(input.session_id) ?? "unknown",
      turn_id: text(input.turn_id), memory_written: false, observation_written: finalized !== null,
      plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
    if (member === "experience") this.recordLearningStageDiagnostic(input, journal, finalized);
    this.lifecycle(member, "Stop", input);
    const guidance = [
      this.verificationGapGuidance(input, journal),
      this.runbookCaptureGuidance(input, journal, finalized) ?? this.unverifiedLearningGuidance(input, journal, projectScope),
    ].filter(Boolean).join("\n");
    const automaticCandidate = member === "experience" && input.session_host === "codex"
      ? this.traceCapture.captureAutomaticRecoveryCandidate(input, projectScope, terminalCapture) : null;
    if (automaticCandidate && typeof automaticCandidate.status === "string") {
      try { this.service.store.appendEvent("codex-hook", "codex_hook.trace_distillation_ticket", {
        status: automaticCandidate.status,
        ...(typeof automaticCandidate.ticket_id === "string" ? { ticket_id: automaticCandidate.ticket_id } : {}),
        ...(typeof automaticCandidate.reason_code === "string" ? { reason_code: automaticCandidate.reason_code } : {}),
        content_free: true,
      }); } catch { /* Ticket diagnostics must never change Hook completion. */ }
    }
    if (automaticCandidate?.status === "retryable" && typeof automaticCandidate.ticket_id === "string" && input.stop_hook_active !== true) {
      return { decision: "block", reason: `Craft Experience recovery ticket ${automaticCandidate.ticket_id} was not completed by its prior continuation and is preserved as retryable. Continue once using the active project_binding and call craft_experience_trace_distill with ticket_id and decision=retry; submit a sanitized candidate or decision=skip. Source Trace and project scope are pinned.`,
        trace_capture: terminalCapture, automatic_candidate: automaticCandidate };
    }
    if (automaticCandidate?.status === "candidate_request" && automaticCandidate.idempotent !== true
      && typeof automaticCandidate.ticket_id === "string") {
      return { decision: "block", reason: `Craft Experience has one verified recovery ticket (${automaticCandidate.ticket_id}) bound to the preceding Codex task Trace. Continue once in this same project. Read the exact source with craft_experience_trace_distill using this ticket_id and the active project_binding, then either submit a sanitized candidate using only cited Trace fields (mark any inferred steps as inferred and unverified) or close the ticket with decision=skip. Do not claim an exact retry relation or invent observed steps.`,
        trace_capture: terminalCapture, automatic_candidate: automaticCandidate };
    }
    return { ...(guidance ? { systemMessage: guidance } : {}), ...(terminalCapture ? { trace_capture: terminalCapture } : {}),
      ...(automaticCandidate ? { automatic_candidate: automaticCandidate } : {}) };
    } finally {
      if (claim) await client.contextRelease({ session_key: sessionKey, token: claim }).catch(() => undefined);
    }
  }

  private unverifiedLearningGuidance(input: HookInput, journal: JsonObject | null, scope: HookProjectScope | null): string | null {
    if (input.stop_hook_active === true || !scope || !journal || journal.verification_outcome === "passed"
      || typeof journal.context_receipt_id !== "string" || typeof journal.turn_id !== "string" || !text(input.session_id)) return null;
    return `Craft Experience：请判断本次任务是否产生可复用操作、脚本或排障经验。若有，以 decision=capture_unverified 调用 craft_experience_runbook_capture，scope=${scope.id}、host=${hookHost(input)}、session_id=${text(input.session_id)}、turn_id=${journal.turn_id}、context_receipt_id=${journal.context_receipt_id}，并传入本轮 Context 返回的 project_binding，填写适用条件、方法和待验证事项；若无，以 decision=no_new_learning_unverified 和 reason=no_reusable_learning 调用。来源为调用方声明，候选待验证且不可执行，不要复制会话原文或凭据。`;
  }

  /** Offer a non-blocking Experience capture choice after a verified task. */
  private runbookCaptureGuidance(input: HookInput, journal: JsonObject | null, finalized: JsonObject | null): string | null {
    if (input.stop_hook_active === true || !journal || journal.verification_outcome !== "passed") return null;
    const observation = finalized?.observation as JsonObject | undefined;
    if (!observation || typeof observation.id !== "string" || typeof journal.context_receipt_id !== "string"
      || typeof journal.turn_id !== "string" || !text(input.session_id)) return null;
    try {
      const prior = this.service.store.list("experience_runbook_decision", 1, item => item.observation_id === observation.id);
      const candidate = this.service.store.list("experience_procedure", 1, item => item.runbook_candidate === true && item.observation_id === observation.id);
      if (prior.length || candidate.length) return null;
    } catch { return null; }
    return `Craft Experience：本轮任务已有通过验证的结果。若发现可复用的操作、脚本或坑点，请用 craft_experience_runbook_capture 基于 observation_id=${observation.id} 提交一份脱敏 Runbook 候选；若没有可复用经验，用 decision=no_new_learning 和 reason=no_reusable_learning 明确略过。两种选择均传入本轮 Context 返回的 project_binding，以及 host=${hookHost(input)}、session_id=${text(input.session_id)}、turn_id=${journal.turn_id}、context_receipt_id=${journal.context_receipt_id}。只写适用条件、正确做法、验证和失败处置；不要复制提示词、对话、原始日志、密钥或客户数据。该提示不影响本轮结果。`;
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
        reason: hookVerificationGap(journal).reason, content_stored: false });
    } catch { /* The hint must never block Stop. */ }
    const reason = hookVerificationGap(journal).reason;
    if (reason === "pending_background") return "Craft Hook：后台验证尚无终态，本轮暂未生成已验证的 Experience 观察；收到原生完成回执后会按原任务对账。";
    if (reason === "unsupported_native_envelope") return "Craft Hook：工具已调用，但原生回执格式不受支持或缺少可关联终态；本轮未生成已验证的 Experience 观察。";
    return "Craft Hook 未识别到验证回执；本轮未生成已验证的 Experience 观察。这不影响之前保存的知识和记忆。若本轮已运行测试，请确认测试命令及退出码被 Hook 接收；否则运行相关测试后再结束。";
  }

  /** Record content-free progress across verification, observation, candidate and promotion stages. */
  private recordLearningStageDiagnostic(input: HookInput, journal: JsonObject | null, finalized: JsonObject | null): void {
    try {
      const observation = finalized?.observation as JsonObject | undefined;
      const observationId = typeof observation?.id === "string" ? observation.id : null;
      const candidates = observationId ? this.service.store.list("program_memory_candidate", 100, candidate =>
        Array.isArray(candidate.evidence_ids) && (candidate.evidence_ids as unknown[]).includes(observationId)) : [];
      this.service.store.appendEvent("codex-hook", "codex_hook.learning_stage_diagnostic", {
        member: "experience", session_id: text(input.session_id) ?? "unknown", turn_id: text(input.turn_id), content_free: true,
        ...codexHookLearningStageDiagnostic(journal, finalized, candidates), verification_gap: hookVerificationGap(journal),
      });
    } catch { /* Diagnostics must never block Stop. */ }
  }

  /** Record that exact Context assets were shown and the turn's observed outcome, without calling them helpful. */
  private recordObservedContextUse(input: HookInput, journal: JsonObject | null): void {
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
      if (event === "SessionEnd" && scheduleMaintenance && text(input.session_id)) {
        const leaseId = `hook-${member}-${stableDigest({ host: hookHost(input), member, session_id: text(input.session_id) }).slice(-32)}`;
        const memory = this.service.capabilityOwned ? this.service.ownerServices.get("memory") : this.service;
        if (memory) {
          if (this.launchArchiveWorker) queueHookMaintenance(memory.store, leaseId);
          else memory.memoryMaintenanceSchedule({ stage: "light", lease_id: leaseId });
        }
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
