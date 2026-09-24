/**
 * Bounded Codex lifecycle integration for the three standalone Craft products.
 *
 * This module deliberately does not read transcripts, execute Host actions, or
 * mutate a Workflow. It turns the small, documented Hook event envelope into
 * scoped Context, explicit Memory capture, and content-free Experience signals.
 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { projectIdentityFromRoot } from "./scope-identity.ts";
import type { CraftService } from "./service.ts";
import type { JsonObject } from "./infrastructure/store.ts";
import { payload, stableDigest } from "./digest.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";

export type CodexHookMember = "knowledge" | "memory" | "experience";
type HookEvent = "SessionStart" | "SessionEnd" | "UserPromptSubmit" | "PostToolUse" | "Stop";
type HookInput = JsonObject & {
  hook_event_name?: string;
  cwd?: string;
  session_id?: string;
  turn_id?: string;
  source?: string;
  reason?: string;
  stop_hook_active?: boolean;
};

const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
const VERIFY = /(?:^|[;&|\s])(?:pnpm|npm|yarn|bun|pytest|mvn|gradle|go\s+test|cargo\s+test|node\s+--test)\b/iu;
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

/** Only an explicit command is allowed to retain a user authored statement. */
export function explicitMemoryStatement(prompt: unknown): string | null {
  const source = text(prompt);
  if (!source) return null;
  const match = /^(?:\/remember|记住)\s*[:：]\s*(.+)$/iu.exec(source);
  if (!match?.[1] || SECRET.test(match[1])) return null;
  const statement = match[1].trim();
  return statement.length <= 1_000 ? statement : null;
}

type Signal = { readonly id: string; readonly tool: string; readonly kind: "edit" | "verification" | "other"; readonly outcome: "passed" | "failed" | "unknown"; readonly digest: string };

export class HookSignalSanitizer {
  signal(input: HookInput): Signal | null {
    const tool = text(input.tool_name) ?? text(input.toolName) ?? nestedText(input.tool, ["name"]) ?? "unknown";
    const toolInput = (input.tool_input ?? input.toolInput ?? input.input) as unknown;
    const command = nestedText(toolInput, ["command", "cmd", "script"]);
    const rawOutcome = nestedText(input.tool_response ?? input.toolResponse ?? input.output, ["exit_code", "exitCode", "status"]);
    const outcome = rawOutcome === "0" || rawOutcome === "success" || rawOutcome === "passed" ? "passed"
      : rawOutcome && (/^[1-9]\d*$/u.test(rawOutcome) || rawOutcome === "failed" || rawOutcome === "error") ? "failed" : "unknown";
    const kind = /^(?:apply_patch|Edit|Write)$/iu.test(tool) || Boolean(command && EDIT.test(command)) ? "edit"
      : Boolean(command && VERIFY.test(command)) ? "verification" : "other";
    if (kind === "other") return null;
    const stable = { tool, kind, outcome, command_digest: command ? digest(command) : null, tool_use_id: text(input.tool_use_id) ?? text(input.toolUseId) ?? null };
    return { id: `codex_hook_signal_${digest(stable).slice(-20)}`, tool, kind, outcome, digest: digest(stable) };
  }
}

/** Append-only, content-free session facts shared by PostToolUse and Stop. */
export class HookTurnJournal {
  readonly service: CraftService;
  constructor(service: CraftService) { this.service = service; }

  record(input: HookInput, signal: Signal): JsonObject | null {
    const scope = codexProjectScope(input.cwd); const turn = this.turn(input);
    if (!scope || !turn) return null;
    const journalId = `codex_hook_turn_${digest({ scope, turn }).slice(-20)}`;
    const existing = this.service.store.find("codex_hook_turn", journalId);
    const priorSignals = Array.isArray(existing?.signals) ? existing.signals as JsonObject[] : [];
    if (priorSignals.some((item) => item.id === signal.id)) return existing!;
    const signals = [...priorSignals, signal];
    const next = { scope, session_id: text(input.session_id) ?? "unknown", turn_id: turn, signals,
      has_edit: signals.some((item) => item.kind === "edit"),
      verification_outcome: signals.some((item) => item.kind === "verification" && item.outcome === "passed") ? "passed"
        : signals.some((item) => item.kind === "verification" && item.outcome === "failed") ? "failed" : null,
      content_stored: false, updated_at: new Date().toISOString() } satisfies JsonObject;
    return existing ? this.service.store.save("codex_hook_turn", journalId, { ...payload(existing), ...next })
      : this.service.store.create("codex_hook_turn", journalId, next);
  }

  find(input: HookInput): JsonObject | null {
    const scope = codexProjectScope(input.cwd); const turn = this.turn(input);
    return !scope || !turn ? null : this.service.store.find("codex_hook_turn", `codex_hook_turn_${digest({ scope, turn }).slice(-20)}`);
  }

  private turn(input: HookInput): string | null { return text(input.turn_id) ?? text(input.session_id); }
}

/** Converts a verified local coding turn into only a proposal request. */
export class HookLearningCoordinator {
  readonly service: CraftService;
  readonly journal: HookTurnJournal;
  constructor(service: CraftService, journal = new HookTurnJournal(service)) { this.service = service; this.journal = journal; }

  finalize(input: HookInput): JsonObject | null {
    const journal = this.journal.find(input);
    if (!journal || journal.has_edit !== true || !["passed", "failed"].includes(String(journal.verification_outcome))) return null;
    const turn = String(journal.turn_id); const outcome = String(journal.verification_outcome) as "passed" | "failed";
    const identity = { scope: journal.scope, turn, outcome, signals: journal.signals };
    const sourceDigest = stableDigest(identity);
    const evidenceId = `evidence_codex_hook_${sourceDigest.slice(-20)}`;
    const evidence = this.service.store.find("evidence", evidenceId) ?? this.service.evidenceRecord({ evidence_id: evidenceId,
      source_type: "codex_hook", confidence: outcome === "passed" ? "confirmed" : "bounded",
      claim: `Codex local verification ${outcome}.`, locator: `codex-hook:${sourceDigest}`, metadata: { content_stored: false, signal_count: (journal.signals as unknown[]).length } });
    const scenarioSignature = {
      schema: "craft.scenario-signature.v1",
      project: journal.scope,
      target_class: "local_workspace_change",
      effect_class: "workspace_write",
      verifier: "local_verification",
      failure_signature: outcome === "failed" ? stableDigest((journal.signals as JsonObject[]).filter((signal) => signal.kind === "verification").map((signal) => signal.digest)) : null,
      host_revision: "codex-hook-v1",
      capability_revision: `craft-experience@${CRAFT_RELEASE_VERSION}`,
    };
    const scenarioKey = `scenario:${stableDigest(scenarioSignature).slice(-24)}`;
    const observation = this.service.workflowEvolutionObserve({ observation_id: `workflow_evolution_observation_${sourceDigest.slice(-20)}`,
      scenario_key: scenarioKey, source_kind: "codex_hook_turn", source_id: turn, source_digest: sourceDigest, outcome,
      scope: `${String((journal.scope as JsonObject).kind)}:${String((journal.scope as JsonObject).id)}`,
      scenario_signature: scenarioSignature, evidence_ids: [evidence.id], sanitized: true, content_stored: false });
    const observations = this.service.workflowEvolutionObservations({ scenario_key: scenarioKey, limit: 100 }).observations as JsonObject[];
    const distinct = observations.filter((item) => String((item.source as JsonObject).id) !== turn).slice(0, 1);
    if (!distinct.length) return { evidence, observation: observation.observation, request: null, next_action: "await_an_independent_verified_turn" };
    const reference = distinct[0]!;
    const request = this.service.workflowEvolutionPropose({ scenario_key: scenarioKey,
      observation_ids: [String(reference.id), String((observation.observation as JsonObject).id)],
      hypothesis: outcome === "failed" ? "At the failed terminal verification decision point, preserve the failure receipt and require bounded recovery before retry." : "Keep a terminal verification step before declaring a local coding task complete.",
      design_axes: ["orchestration"], procedure_kind: "workflow", output_contract_ref: "acceptance:terminal-verification" });
    return { evidence, observation: observation.observation, request: request.request, next_action: "candidate_request_only_requires_independent_distillation_and_quality_gates" };
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
    try {
      const event = text(input.hook_event_name) as HookEvent | null;
      if (event === "SessionStart" || event === "SessionEnd") return this.lifecycle(member, event, input);
      if (event === "UserPromptSubmit") return await this.prompt(member, input);
      if (event === "PostToolUse" && member === "experience") return this.tool(input);
      if (event === "Stop") return this.stop(member, input);
      return {};
    } catch (error) {
      // Hook failures are deliberately fail-open. The trace contains only the class of error.
      this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member, event: String(input.hook_event_name), error_type: error instanceof Error ? error.name : "unknown" });
      return {};
    }
  }

  private async prompt(member: CodexHookMember, input: HookInput): Promise<JsonObject> {
    const scope = codexProjectScope(input.cwd); const prompt = text(input.prompt) ?? text(input.user_prompt);
    if (!scope || !prompt) return {};
    // Persist the current checkout only as an alias. The receipt still names the
    // canonical Git identity, so it is portable and does not leak the path.
    if (typeof input.cwd === "string") this.service.scopeIdentityResolveProject({ project_root: input.cwd });
    let memoryWritten = false;
    if (member === "memory") {
      const statement = explicitMemoryStatement(prompt);
      if (statement) {
        this.service.memoryCaptureUserStatement({ content: statement, kind: "episodic", scope_kind: scope.kind, scope_id: scope.id,
          explicit_consent: true, auto_accept: true, sensitivity: "internal" });
        memoryWritten = true;
      }
    }
    const resolved = await this.service.contextResolutionResolve({ query: prompt, scope_kind: scope.kind, scope_id: scope.id,
      members: [member], max_items: 6, max_chars: 3_000 });
    const items = resolved.items as JsonObject[];
    const contributions = resolved.contributions as JsonObject[];
    const selected = [...items.map((item) => ({ type: "memory", id: item.memory_id, version: item.memory_version, content: item.content })),
      ...contributions.flatMap((contribution) => Array.isArray(contribution.items) ? contribution.items : [])];
    const receipt = resolved.receipt as JsonObject | null;
    this.service.activationProofRecord({ host: hookHost(input), component: member, event: "UserPromptSubmit", session_id: text(input.session_id) ?? "unknown",
      turn_id: text(input.turn_id), context_receipt_id: receipt?.id ?? undefined, memory_written: memoryWritten, observation_written: false,
      plugin_release: CRAFT_RELEASE_VERSION, hook_trusted: true, mcp_reachable: true });
    if (!selected.length) return {};
    return { additionalContext: JSON.stringify({ source: `craft-${member}`, scope, receipt_id: receipt?.id ?? null, selected }) };
  }

  private tool(input: HookInput): JsonObject {
    const signal = this.signals.signal(input); if (!signal) return {};
    this.journal.record(input, signal);
    return {};
  }

  private stop(member: CodexHookMember, input: HookInput): JsonObject {
    const finalized = member === "experience" ? this.learning.finalize(input) : null;
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
  private lifecycle(member: CodexHookMember, event: HookEvent, input: HookInput): JsonObject {
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
    if (event === "SessionEnd") this.service.memoryMaintenanceSchedule({ stage: "light", lease_id: `codex-${member}-${text(input.session_id) ?? "unknown"}` });
    return {};
  }
}
