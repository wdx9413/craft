import { assertContextReadCurrent } from "../context-access-guard.ts";
/**
 * Bounded Codex lifecycle integration for Craft Context and its standalone products.
 *
 * This module deliberately does not read transcripts, execute Host actions, or
 * mutate a Workflow. It turns the small, documented Hook event envelope into
 * scoped Context, explicit Memory capture, and content-free Experience signals.
 */
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { projectIdentityFromRoot } from "../scope-identity.ts";
import type { CraftService } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { payload, stableDigest } from "../digest.ts";
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

/** Only an explicit command is allowed to retain a user authored statement. */
export function explicitMemoryStatement(prompt: unknown): string | null {
  const source = text(prompt);
  if (!source) return null;
  const match = /^(?:\/remember|记住)\s*[:：]\s*(.+)$/iu.exec(source);
  if (!match?.[1] || SECRET.test(match[1])) return null;
  const statement = match[1].trim();
  return statement.length <= 1_000 ? statement : null;
}

type Signal = { readonly id: string; readonly tool: string; readonly kind: "edit" | "verification" | "other"; readonly outcome: "passed" | "failed" | "unknown"; readonly digest: string; readonly verifier: string | null };

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
    const stable = { tool, kind, outcome, command_digest: command ? digest(command) : null, tool_use_id: text(input.tool_use_id) ?? text(input.toolUseId) ?? randomUUID() };
    return { id: `codex_hook_signal_${digest(stable).slice(-20)}`, tool, kind, outcome, digest: digest(stable), verifier: command ? digest(command) : null };
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
    const lastEdit = signals.findLastIndex((item) => item.kind === "edit");
    const checks = new Map<string, string>();
    for (const item of signals.slice(lastEdit + 1)) if (item.kind === "verification") checks.set(String(item.verifier), String(item.outcome));
    const outcomes = [...checks.values()];
    const next = { scope, session_id: text(input.session_id) ?? "unknown", turn_id: turn, signals,
      has_edit: signals.some((item) => item.kind === "edit"),
      verification_outcome: !outcomes.length || outcomes.includes("unknown") ? null : outcomes.includes("failed") ? "failed" : "passed",
      edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest,
      verification_receipts: [...checks].map(([verifier, outcome]) => ({ verifier, outcome, edit_revision: lastEdit < 0 ? null : signals[lastEdit]!.digest })),
      content_stored: false, updated_at: new Date().toISOString() } satisfies JsonObject;
    return existing ? this.service.store.save("codex_hook_turn", journalId, { ...payload(existing), ...next })
      : this.service.store.create("codex_hook_turn", journalId, next);
  }

  find(input: HookInput): JsonObject | null {
    const scope = codexProjectScope(input.cwd); const turn = this.turn(input);
    return !scope || !turn ? null : this.service.store.find("codex_hook_turn", `codex_hook_turn_${digest({ scope, turn }).slice(-20)}`);
  }

  private turn(input: HookInput): string | null { return text(input.turn_id); }
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
      source_type: "codex_hook", confidence: "bounded",
      claim: `Codex local verification ${outcome}.`, locator: `codex-hook:${sourceDigest}`, metadata: { provenance: "host_hook_observation", independently_verified: false, edit_revision: journal.edit_revision, verification_receipts: journal.verification_receipts, content_stored: false, signal_count: (journal.signals as unknown[]).length } });
    const scenarioSignature = {
      schema: "craft.scenario-signature.v1",
      project: journal.scope,
      target_class: "local_workspace_change",
      effect_class: "workspace_write",
      verifier: "local_verification",
      failure_signature: outcome === "failed" ? stableDigest((journal.verification_receipts as JsonObject[]).map(({ verifier, outcome }) => ({ verifier, outcome }))) : null,
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
    } catch (error) {
      // Hook failures are deliberately fail-open. The trace contains only the class of error.
      this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member, event: String(input.hook_event_name), error_type: error instanceof Error ? error.name : "unknown" });
      return {};
    }
  }

  private async prompt(member: CodexHookMember, input: HookInput): Promise<JsonObject> {
    const scope = codexProjectScope(input.cwd); const prompt = text(input.prompt) ?? text(input.user_prompt);
    if (!scope || !prompt) return {};
    const members = member === "context" ? CONTEXT_MEMBERS : [member];
    // Native Hosts need not supply turn_id. Mint a local turn for this prompt and
    // return it to the Host; never reuse a prompt digest across different turns.
    const sessionId = text(input.session_id);
    if (sessionId && !text(input.turn_id)) {
      const sessionKey = `context_hook_session_${stableDigest({ scope, session_id: sessionId }).slice(-24)}`;
      const turnId = this.service.store.transaction(() => {
        const prior = this.service.store.find("context_hook_session", sessionKey), sequence = Number(prior?.sequence ?? 0) + 1;
        const generated = `hook_turn_${sessionKey.slice(-24)}_${sequence}`;
        this.service.store.save("context_hook_session", sessionKey, { scope, session_id: sessionId, sequence, last_turn_id: generated, content_free: true }); return generated;
      });
      input = { ...input, session_id: sessionId, turn_id: turnId };
    }
    // Persist the current checkout only as an alias. The receipt still names the
    // canonical Git identity, so it is portable and does not leak the path.
    if (typeof input.cwd === "string") this.service.scopeIdentityResolveProject({ project_root: input.cwd });
    let memoryWritten = false; let captureSummary: JsonObject | null = null;
    if (members.includes("memory")) {
      const statement = explicitMemoryStatement(prompt);
      if (statement) {
        try {
          const captured = this.service.memoryCaptureUserStatement({ content: statement, kind: /prefer|default|默认|以后|总是|不要|优先/iu.test(statement) ? "preference" : "episodic", scope_kind: scope.kind, scope_id: scope.id,
            explicit_consent: true, auto_accept: true, sensitivity: "internal" });
          memoryWritten = captured.auto_committed === true;
          captureSummary = { candidate_id: (captured.candidate as JsonObject | null)?.id ?? null, next_action: captured.next_action, topic_suggestions: captured.topic_suggestions ?? [], memory_written: memoryWritten };
        } catch (error) {
          this.service.store.appendEvent("codex-hook", "codex_hook.failed", { member: "memory", event: "UserPromptSubmit", error_type: error instanceof Error ? error.name : "unknown" });
        }
      }
    }
    const resolved = await this.service.contextWorkingSets.resolve({ query: prompt, session_id: text(input.session_id) ?? undefined, turn_id: text(input.turn_id) ?? undefined, scope_kind: scope.kind, scope_id: scope.id,
      members: [...members], max_items: 6, max_chars: 3_000 });
    const items = resolved.items as JsonObject[];
    const contributions = resolved.contributions as JsonObject[];
    const selected = [...items.map((item) => ({ type: "memory", id: item.memory_id, version: item.memory_version, content: item.content })),
      ...contributions.flatMap((contribution) => Array.isArray(contribution.items) ? contribution.items : [])];
    const receipt = resolved.receipt as JsonObject | null;
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
    const signal = this.signals.signal(input); if (!signal) return {};
    this.journal.record(input, signal);
    return {};
  }

  private stop(member: ComponentHookMember, input: HookInput): JsonObject {
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
    if (event === "SessionEnd" && scheduleMaintenance) this.service.memoryMaintenanceSchedule({ stage: "light", lease_id: `codex-${member}-${text(input.session_id) ?? "unknown"}` });
    return {};
  }
}
