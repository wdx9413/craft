import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHookBridge } from "../core/codex-hook-bridge.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";

const candidate = (...eventRefs: string[]) => ({
  title: { text: "Recover a failed project check", provenance: "user_stated", source_refs: [] },
  applies_when: { text: "Observed Host Trace fields: event_kind=host.tool.completed; operation_id=codex_tool_bash; status=failed; sequence=1.",
    provenance: "host_observed", source_refs: eventRefs.slice(0, 1) },
  exclude_when: { text: "The failure belongs to an unrelated project", provenance: "user_stated", source_refs: [] },
  steps: [{ text: "Inspect the reported check category before changing files", provenance: "inferred", source_refs: [] }],
  pitfalls: [{ symptom: "A retry repeats the same failing check", cause: "The underlying change was not applied",
    provenance: "inferred", source_refs: [] }],
  done_criteria: { text: "The relevant project check reaches a passing result", provenance: "inferred", source_refs: [] },
  failure_handling: { text: "Stop and report the unresolved check category", provenance: "inferred", source_refs: [] },
  focus: ["failure recovery"],
  exclude_topics: ["unrelated projects"],
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-trace-distill-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = await CraftService.open(store);
  const hook = new CodexHookBridge(service, undefined, true);
  const mcp = new McpServer(service, "component-experience-daily");
  const call = async (name: string, args: JsonObject = {}) => {
    const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return response?.result as JsonObject;
  };
  const turn = async (session = "session-current", turnId = "turn-current") => {
    const output = await hook.handle("context", { cwd: projectRoot, session_id: session, turn_id: turnId,
      hook_event_name: "UserPromptSubmit", prompt: "Summarize the observed recovery method" });
    return JSON.parse(String(output.additionalContext)) as { project_binding: string; scope: JsonObject };
  };
  const trace = (input: { id: string; session: string; turn: string; task: string; eventId: string; operation?: string;
    category?: string; toolName?: string; action?: string; summary?: string; includeScope?: boolean }) => {
    service.traceStart({ trace_id: input.id, task_id: input.task, host: "codex",
      ...(input.includeScope === false ? {} : { project_scope: { kind: "project", id: projectScope } }),
      session_id: input.session, turn_id: input.turn });
    service.traceAppend({ trace_id: input.id, event_id: input.eventId, event_kind: "host.tool.completed", actor: "host",
      source: "codex", trust: "observed", operation_id: input.operation ?? "codex_tool_bash", status: "failed",
      action_contract: { kind: "host_tool_operation", tool_category: input.category ?? "script", action: input.action ?? "execute",
        ...(input.toolName ? { tool_name: input.toolName } : {}) },
      data: input.summary ? { untrusted_text: input.summary } : {}, summary: input.summary ?? "Codex script operation observed" });
  };
  const terminalTrace = (traceId: string, eventId: string, taskId: string, sessionId: string, turnId: string,
    outcome: "passed" | "failed", observationId: string, evidenceId: string) => {
    service.evidenceRecord({ evidence_id: evidenceId, source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host terminal verification fixture.", metadata: { provenance: "host_completion_signal", verification_outcome: outcome,
        project_scope_id: projectScope, source_session_id: sessionId, task_id: taskId, turn_id: turnId, content_stored: false } });
    service.workflowEvolutionObserve({ observation_id: observationId, scenario_key: "coding:trace-distillation",
      source_kind: "host:codex", source_id: taskId, source_session_id: sessionId, source_digest: `digest-${observationId}`,
      scope: projectScope, outcome, evidence_ids: [evidenceId], sanitized: true, content_stored: false });
    service.traceAppend({ trace_id: traceId, event_id: `terminal-event-${traceId}`, event_kind: "task.terminal_verification",
      actor: "experience", source: "experience", trust: "verified", operation_id: "codex_task_terminal_verification",
      status: outcome, output_refs: [observationId], data: {}, summary: "Accepted task terminal verification" });
    service.traceFinalize({ trace_id: traceId, status: outcome === "passed" ? "completed" : "failed",
      summary: "Task terminal verification finalized", evidence_ids: [observationId] });
  };
  let projectScope = "";
  return {
    root, projectRoot, store, service, hook, mcp, call, turn, trace, terminalTrace,
    setScope(value: string) { projectScope = value; },
    async close() { await store.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("the public Experience tool resolves only the current project Trace and returns the existing durable evaluation work item", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-current", session: "session-current", turn: "turn-current", task: "task-current", eventId: "event-current" });

    const sourcesResponse = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(sourcesResponse.isError, false);
    const sources = (sourcesResponse.structuredContent as JsonObject).sources as JsonObject[];
    assert.equal((sourcesResponse.structuredContent as JsonObject).status, "sources_ready");
    assert.equal(sources.length, 1);
    assert.equal(sources[0]!.host, "codex");
    assert.equal(sources[0]!.project_scope_id, binding.scope.id);
    assert.equal(sources[0]!.task_id, "task-current");
    assert.equal(sources[0]!.session_id, "session-current");
    assert.equal(sources[0]!.turn_id, "turn-current");
    assert.equal((sources[0]!.trace_ref as JsonObject).id, "trace-current");
    const eventRef = ((sources[0]!.event_refs as JsonObject[])[0]!).id;

    const capturedResponse = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, candidate: candidate(String(eventRef)),
    });
    assert.equal(capturedResponse.isError, false, JSON.stringify(capturedResponse));
    const result = capturedResponse.structuredContent as JsonObject;
    assert.equal(result.status, "captured");
    assert.equal(result.current_stage, "evaluation_contract");
    const candidateRef = result.candidate_ref as JsonObject;
    assert.equal(candidateRef.kind, "experience_procedure");
    assert.equal(candidateRef.version, 1);
    assert.match(String(candidateRef.digest), /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(Object.keys(candidateRef).sort(), ["digest", "id", "kind", "version"]);
    const procedure = f.store.get("experience_procedure", String(candidateRef.id));
    assert.equal(procedure.scope, binding.scope.id);
    assert.equal(procedure.routeable, false);
    const workItem = result.learning_work_item_ref as JsonObject;
    assert.equal(workItem.kind, "experience_learning_work_item");
    assert.equal(workItem.version, 1);
    assert.equal(workItem.status, undefined);
    const storedWorkItem = f.store.get("experience_learning_work_item", String(workItem.id));
    assert.deepEqual(candidateRef, storedWorkItem.candidate_ref);
    assert.equal(result.learning_work_item_stage, "evaluation_contract");
    assert.equal(result.learning_work_item_status, "blocked");
    assert.equal(result.blocked_reason, "evaluation_contract_unavailable");
    assert.equal(f.store.count("experience_learning_work_item"), 1);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
  } finally { await f.close(); }
});

test("ambiguous current traces require explicit selection and do not create a Candidate or work item", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-one", session: "session-current", turn: "turn-current", task: "task-one", eventId: "event-one" });
    f.trace({ id: "trace-two", session: "session-current", turn: "turn-current", task: "task-two", eventId: "event-two" });

    const response = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    const result = response.structuredContent as JsonObject;
    assert.equal(response.isError, false);
    assert.equal(result.status, "source_selection_required");
    assert.equal((result.sources as JsonObject[]).length, 2);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
  } finally { await f.close(); }
});

test("explicit selection preserves all chosen current Trace references", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-one", session: "session-current", turn: "turn-current", task: "task-one", eventId: "event-one" });
    f.trace({ id: "trace-two", session: "session-current", turn: "turn-current", task: "task-two", eventId: "event-two" });
    const ready = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    const sourceRefs = ((ready.structuredContent as JsonObject).sources as JsonObject[]).flatMap(source => source.event_refs as JsonObject[]);

    const response = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding,
      trace_ids: ["trace-two", "trace-one"],
      candidate: candidate(String(sourceRefs[0]!.id), String(sourceRefs[1]!.id)),
    });
    const result = response.structuredContent as JsonObject;
    assert.equal(response.isError, false);
    assert.equal(result.status, "captured");
    const procedure = f.store.get("experience_procedure", String((result.candidate_ref as JsonObject).id));
    const sources = procedure.source_refs as JsonObject[];
    assert.deepEqual(sources.map(source => (source.trace_ref as JsonObject).id), ["trace-two", "trace-one"]);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
  } finally { await f.close(); }
});

test("distillation fails closed without a project binding or current Trace source", async () => {
  const f = await fixture();
  try {
    const unbound = await f.call("craft_experience_trace_distill");
    assert.equal(unbound.isError, true);
    assert.equal(f.store.count("experience_procedure"), 0);

    const binding = await f.turn();
    const empty = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(empty.isError, false);
    assert.equal((empty.structuredContent as JsonObject).status, "source_unavailable");
    assert.equal((empty.structuredContent as JsonObject).reason_code, "current_trace_not_found");
    assert.deepEqual((empty.structuredContent as JsonObject).sources, []);

    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-unsupported", session: "session-current", turn: "turn-current", task: "task-unsupported",
      eventId: "event-unsupported", operation: "unrecognized_host_operation" });
    const unsupported = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal((unsupported.structuredContent as JsonObject).status, "source_unavailable");
    assert.equal((unsupported.structuredContent as JsonObject).reason_code, "no_supported_host_events");
    assert.deepEqual((unsupported.structuredContent as JsonObject).sources, []);
    assert.equal(f.store.count("experience_procedure"), 0);
  } finally { await f.close(); }
});

test("Trace distillation excludes host events with mismatched identity, action, or result fields", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-filtered-events", session: "session-current", turn: "turn-current",
      task: "task-filtered-events", eventId: "event-supported" });
    const rejectedEvents = [
      { event_id: "event-wrong-actor", actor: "agent", source: "codex", trust: "observed", action_contract: { kind: "host_tool_operation", tool_category: "script" }, status: "failed" },
      { event_id: "event-wrong-source", actor: "host", source: "other", trust: "observed", action_contract: { kind: "host_tool_operation", tool_category: "script" }, status: "failed" },
      { event_id: "event-wrong-trust", actor: "host", source: "codex", trust: "verified", action_contract: { kind: "host_tool_operation", tool_category: "script" }, status: "failed" },
      { event_id: "event-wrong-action", actor: "host", source: "codex", trust: "observed", action_contract: { kind: "other", tool_category: "script" }, status: "failed" },
      { event_id: "event-wrong-status", actor: "host", source: "codex", trust: "observed", action_contract: { kind: "host_tool_operation", tool_category: "script" }, status: "cancelled" },
      { event_id: "event-missing-action", actor: "host", source: "codex", trust: "observed", status: "failed" },
    ];
    for (const event of rejectedEvents) f.service.traceAppend({ trace_id: "trace-filtered-events", event_kind: "host.tool.completed",
      operation_id: "codex_tool_bash", data: {}, summary: "Rejected fixture event", ...event });

    const response = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(response.isError, false);
    const source = ((response.structuredContent as JsonObject).sources as JsonObject[])[0]!;
    assert.deepEqual((source.event_refs as JsonObject[]).map(event => event.id), ["event-supported"]);
    assert.equal(f.store.count("experience_procedure"), 0);
  } finally { await f.close(); }
});

test("historical Trace selection is rejected and raw event content is not returned", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-current", session: "session-current", turn: "turn-current", task: "task-current", eventId: "event-current",
      summary: "sensitive-marker-alpha command-output-marker prompt-marker" });
    f.trace({ id: "trace-old", session: "session-old", turn: "turn-old", task: "task-old", eventId: "event-old" });

    const current = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(current.isError, false);
    const encoded = JSON.stringify(current.structuredContent);
    assert.doesNotMatch(encoded, /sensitive-marker-alpha|command-output-marker|prompt-marker/u);
    const currentSource = ((current.structuredContent as JsonObject).sources as JsonObject[])[0]!;
    const eventRef = String((currentSource.event_refs as JsonObject[])[0]!.id);
    const saved = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, candidate: candidate(eventRef),
    });
    assert.equal(saved.isError, false);
    const procedureId = String(((saved.structuredContent as JsonObject).candidate_ref as JsonObject).id);
    const projection = f.service.experienceProcedureGet({ procedure_id: procedureId });
    assert.doesNotMatch(JSON.stringify(projection), /sensitive-marker-alpha|command-output-marker|prompt-marker/u);

    const historical = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-old"],
    });
    assert.equal(historical.isError, true);
    assert.match(JSON.stringify(historical), /not from the current task/u);
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
  } finally { await f.close(); }
});

test("DataSec rejects sensitive Candidate text before saving Candidate or Learning Work Item", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-current", session: "session-current", turn: "turn-current", task: "task-current", eventId: "event-current" });
    const sources = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    const eventRef = String((((sources.structuredContent as JsonObject).sources as JsonObject[])[0]!.event_refs as JsonObject[])[0]!.id);
    const unsafe = candidate(eventRef);
    unsafe.steps[0]!.text = ["api", "_key=", "test", "-value"].join("");

    const response = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding, candidate: unsafe });
    assert.equal(response.isError, true);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
  } finally { await f.close(); }
});

test("repeated public submissions return the same Candidate and durable Learning Work Item", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-current", session: "session-current", turn: "turn-current", task: "task-current", eventId: "event-current" });
    const sources = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    const eventRef = String((((sources.structuredContent as JsonObject).sources as JsonObject[])[0]!.event_refs as JsonObject[])[0]!.id);
    const args = {
      project_binding: binding.project_binding,
      request_id: "same-distillation-request",
      candidate: candidate(eventRef),
    };
    const first = await f.call("craft_experience_trace_distill", args);
    const retry = await f.call("craft_experience_trace_distill", args);
    const firstResult = first.structuredContent as JsonObject;
    const retryResult = retry.structuredContent as JsonObject;
    assert.equal(first.isError, false);
    assert.equal(retry.isError, false);
    assert.deepEqual(retryResult.candidate_ref, firstResult.candidate_ref);
    assert.deepEqual(retryResult.learning_work_item_ref, firstResult.learning_work_item_ref);
    assert.equal(retryResult.idempotent, true);
    assert.equal(retryResult.learning_work_item_status, "blocked");
    assert.equal(retryResult.blocked_reason, "evaluation_contract_unavailable");
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
  } finally { await f.close(); }
});

test("owner failures and malformed owner responses return a content-free blocked result without committing a Candidate", async () => {
  for (const failure of ["throws", "missing_work_item", "mismatched_candidate", "incomplete_work_item",
    "invalid_blocked_reason"] as const) {
    const f = await fixture();
    try {
      const binding = await f.turn();
      f.setScope(String(binding.scope.id));
      f.trace({ id: `trace-owner-${failure}`, session: "session-current", turn: "turn-current",
        task: `task-owner-${failure}`, eventId: `event-owner-${failure}` });
      const sources = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
      const eventRef = String((((sources.structuredContent as JsonObject).sources as JsonObject[])[0]!
        .event_refs as JsonObject[])[0]!.id);
      const owner = f.service.experienceProcedures as unknown as {
        traceDistillationCapture(input: JsonObject): JsonObject;
      };
      const original = owner.traceDistillationCapture.bind(owner);
      let ownerCalls = 0;
      // ProcedureStore is wrapped in observedKernel, which memoizes method
      // wrappers on first read. Replace the service's owner seam so the public
      // request reaches this fault injector instead of mutating a cached proxy.
      Object.defineProperty(f.service, "experienceProcedures", {
        configurable: true,
        writable: true,
        value: {
          traceDistillationCapture(input: JsonObject): JsonObject {
            ownerCalls++;
            const saved = original(input);
            if (failure === "throws") throw new Error("sensitive-owner-error-marker");
            if (failure === "missing_work_item") return { ...saved, learning_work_item: undefined };
            if (failure === "mismatched_candidate") return {
              ...saved, learning_work_item: { ...(saved.learning_work_item as JsonObject), scope: "project:other" },
            };
            if (failure === "incomplete_work_item") return {
              ...saved, learning_work_item: { ...(saved.learning_work_item as JsonObject), status: 1 },
            };
            return {
              ...saved, learning_work_item: { ...(saved.learning_work_item as JsonObject), blocked_reason: 1 },
            };
          },
        },
      });

      const response = await f.call("craft_experience_trace_distill", {
        project_binding: binding.project_binding, candidate: candidate(eventRef),
      });
      assert.equal(response.isError, false);
      const result = response.structuredContent as JsonObject;
      assert.equal(ownerCalls, 1, "the public distillation entry must call the injected Experience owner");
      assert.equal(result.status, "blocked");
      assert.equal(result.reason_code, "learning_work_item_unavailable");
      assert.equal(result.blocked_reason, "learning_work_item_unavailable");
      assert.equal(result.candidate_ref, undefined);
      assert.equal(result.learning_work_item_ref, undefined);
      assert.doesNotMatch(JSON.stringify(response), /sensitive-owner-error-marker|Recover a failed project check/u);
      assert.equal(f.store.count("experience_procedure"), 0);
      assert.equal(f.store.count("experience_learning_work_item"), 0);
    } finally { await f.close(); }
  }
});

test("distillation accepts valid owner references using legacy version and digest fallbacks", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-owner-fallbacks", session: "session-current", turn: "turn-current",
      task: "task-owner-fallbacks", eventId: "event-owner-fallbacks" });
    const sources = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    const eventRef = String((((sources.structuredContent as JsonObject).sources as JsonObject[])[0]!
      .event_refs as JsonObject[])[0]!.id);
    const owner = f.service.experienceProcedures as unknown as {
      traceDistillationCapture(input: JsonObject): JsonObject;
    };
    const original = owner.traceDistillationCapture.bind(owner);
    Object.defineProperty(f.service, "experienceProcedures", {
      configurable: true,
      writable: true,
      value: {
        traceDistillationCapture(input: JsonObject): JsonObject {
          const saved = original(input);
          const procedure = saved.procedure as JsonObject;
          const candidateRef = { kind: "experience_procedure", id: String(procedure.id),
            version: Number(procedure.version), digest: String(procedure.identity_digest) };
          return {
            ...saved,
            procedure: { ...procedure, candidate_version: undefined, definition_digest: undefined, content_digest: undefined },
            learning_work_item: { ...(saved.learning_work_item as JsonObject), candidate_ref: candidateRef },
          };
        },
      },
    });

    const response = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, candidate: candidate(eventRef),
    });
    assert.equal(response.isError, false);
    assert.equal((response.structuredContent as JsonObject).status, "captured");
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
  } finally { await f.close(); }
});

test("Trace source references distinguish a successful tool call from accepted terminal verification", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-passed", session: "session-current", turn: "turn-current", task: "task-passed",
      eventId: "event-passed" });
    f.terminalTrace("trace-passed", "terminal-event-passed", "task-passed", "session-current", "turn-current",
      "passed", "observation-passed", "evidence-passed");
    f.trace({ id: "trace-failed", session: "session-current", turn: "turn-current", task: "task-failed",
      eventId: "event-failed" });
    f.terminalTrace("trace-failed", "terminal-event-failed", "task-failed", "session-current", "turn-current",
      "failed", "observation-failed", "evidence-failed");

    const response = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-passed", "trace-failed"],
    });
    const result = response.structuredContent as JsonObject;
    assert.equal(response.isError, false);
    const [passed, failed] = result.sources as JsonObject[];
    assert.equal(passed!.terminal_outcome, "verified_passed");
    assert.equal(failed!.terminal_outcome, "verified_failed");
    assert.deepEqual((passed!.observation_refs as JsonObject[]).map(ref => ref.id), ["observation-passed"]);
    assert.deepEqual((failed!.evidence_refs as JsonObject[]).map(ref => ref.id), ["evidence-failed"]);
    const passedEvents = passed!.event_refs as JsonObject[];
    assert.equal(passedEvents.find(event => event.event_kind === "host.tool.completed")!.status, "failed");
    assert.equal(passedEvents.find(event => event.event_kind === "task.terminal_verification")!.status, "passed");
  } finally { await f.close(); }
});

test("Trace terminal verification without an Observation reference cannot be presented as verified", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-no-observation", session: "session-current", turn: "turn-current",
      task: "task-no-observation", eventId: "event-no-observation" });
    f.service.traceAppend({ trace_id: "trace-no-observation", event_id: "terminal-no-observation",
      event_kind: "task.terminal_verification", actor: "experience", source: "experience", trust: "verified",
      operation_id: "codex_task_terminal_verification", status: "passed", data: {}, summary: "Terminal without observation" });

    const response = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-no-observation"],
    });
    assert.equal(response.isError, true);
    assert.match(JSON.stringify(response), /no Observation reference/u);
    assert.equal(f.store.count("experience_procedure"), 0);
  } finally { await f.close(); }
});

test("unavailable terminal evidence stays unverified and mismatched Observation evidence is rejected", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-unavailable", session: "session-current", turn: "turn-current",
      task: "task-unavailable", eventId: "event-unavailable" });
    f.service.traceAppend({ trace_id: "trace-unavailable", event_id: "unavailable-terminal",
      event_kind: "task.terminal_verification.unavailable", actor: "host", source: "codex", trust: "observed",
      operation_id: "codex_task_terminal_verification", status: "unknown", data: {}, summary: "Terminal evidence unavailable" });
    const unavailable = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-unavailable"],
    });
    const unavailableSource = ((unavailable.structuredContent as JsonObject).sources as JsonObject[])[0]!;
    assert.equal(unavailable.isError, false);
    assert.equal(unavailableSource.terminal_outcome, "unverified");
    assert.deepEqual(unavailableSource.observation_refs, []);
    assert.deepEqual(unavailableSource.evidence_refs, []);

    f.trace({ id: "trace-mismatched-observation", session: "session-current", turn: "turn-current",
      task: "task-mismatched-observation", eventId: "event-mismatched-observation" });
    const evidenceId = "evidence-mismatched-observation";
    f.service.evidenceRecord({ evidence_id: evidenceId, source_type: "host_completion_signal", confidence: "bounded",
      claim: "Host terminal verification fixture.", metadata: { provenance: "host_completion_signal", verification_outcome: "passed",
        project_scope_id: String(binding.scope.id), source_session_id: "session-current", task_id: "other-task",
        turn_id: "turn-current", content_stored: false } });
    f.service.workflowEvolutionObserve({ observation_id: "observation-mismatched", scenario_key: "coding:trace-distillation",
      source_kind: "host:codex", source_id: "other-task", source_session_id: "session-current", source_digest: "mismatched-observation-digest",
      scope: String(binding.scope.id), outcome: "passed", evidence_ids: [evidenceId], sanitized: true, content_stored: false });
    f.service.traceAppend({ trace_id: "trace-mismatched-observation", event_id: "terminal-mismatched-observation",
      event_kind: "task.terminal_verification", actor: "experience", source: "experience", trust: "verified",
      operation_id: "codex_task_terminal_verification", status: "passed", output_refs: ["observation-mismatched"],
      data: {}, summary: "Accepted task terminal verification" });
    assert.ok(f.store.find("workflow_evolution_observation", "observation-mismatched"));
    assert.deepEqual((f.service.traceGet({ trace_id: "trace-mismatched-observation" }).events as JsonObject[])
      .find(event => event.event_kind === "task.terminal_verification")?.output_refs, ["observation-mismatched"]);

    const mismatched = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-mismatched-observation"],
    });
    assert.equal(mismatched.isError, true);
    assert.match(JSON.stringify(mismatched), /does not match its Experience Observation/u);
  } finally { await f.close(); }
});

test("project file edits are supported and explicit Trace references enforce identity and count limits", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-file-edit", session: "session-current", turn: "turn-current", task: "task-file-edit",
      eventId: "event-file-edit", operation: "codex_tool_edit", category: "file_edit" });
    const fileEdit = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(fileEdit.isError, false);
    assert.equal((fileEdit.structuredContent as JsonObject).status, "sources_ready");

    const duplicateIds = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-file-edit", "trace-file-edit"],
    });
    assert.equal(duplicateIds.isError, true);
    const emptyIds = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: [],
    });
    assert.equal(emptyIds.isError, true);
    const invalidId = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace id with spaces"],
    });
    assert.equal(invalidId.isError, true);
    const missing = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-missing"],
    });
    assert.equal(missing.isError, true);

    f.trace({ id: "trace-no-project", session: "session-current", turn: "turn-current", task: "task-no-project",
      eventId: "event-no-project", includeScope: false });
    const unscoped = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-no-project"],
    });
    assert.equal(unscoped.isError, true);
    assert.match(JSON.stringify(unscoped), /authorized Host and project scope/u);

    const service = f.service as unknown as { experienceTraceDistill(args: JsonObject): JsonObject; capabilityOwned: boolean };
    const currentArgs = { host: "codex", session_id: "session-current", turn_id: "turn-current",
      scope: binding.scope, project_root: f.projectRoot };
    assert.throws(() => service.experienceTraceDistill({ ...currentArgs, session_id: "bad session id" }), /session_id is invalid/u);
    assert.throws(() => service.experienceTraceDistill({ ...currentArgs, host: "unknown" }), /Codex Hook traces only/u);
    assert.throws(() => service.experienceTraceDistill({ host: "codex", session_id: "s", turn_id: "t" }), /active Host project binding/u);
    assert.throws(() => service.experienceTraceDistill({ ...currentArgs, project_root: undefined }), /active Host project binding/u);
    assert.throws(() => service.experienceTraceDistill({ ...currentArgs, scope: { kind: "project", id: "project:other" } }),
      /does not match the active Host binding/u);

    const previousCapabilityOwned = service.capabilityOwned;
    service.capabilityOwned = true;
    try {
      assert.throws(() => service.experienceTraceDistill(currentArgs), /Trace owner is unavailable/u);
    } finally {
      service.capabilityOwned = previousCapabilityOwned;
    }

    const originalList = f.store.list.bind(f.store) as (...args: unknown[]) => unknown[];
    (f.store as unknown as { list: (...args: unknown[]) => unknown[] }).list = (...args) => {
      if (args[0] === "trace") return Array.from({ length: 10_001 }, (_, index) => ({
        id: `trace-over-limit-${index}`, host: "codex", session_id: "session-current", turn_id: "turn-current",
        status: "running", project_scope: binding.scope,
      }));
      return originalList(...args);
    };
    assert.throws(() => service.experienceTraceDistill(currentArgs), /Current Trace lookup exceeds/u);
    (f.store as unknown as { list: (...args: unknown[]) => unknown[] }).list = originalList;
  } finally { await f.close(); }
});

test("MCP Trace distillation keeps only the validated tool name, category, sequence, and event reference", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-mcp", session: "session-current", turn: "turn-current", task: "task-mcp",
      eventId: "event-mcp", operation: "codex_tool_mcp", category: "api_mcp", action: "invoke",
      toolName: "mcp__browser__navigate", summary: "sensitive-mcp-argument-and-result-marker" });

    const response = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(response.isError, false);
    const source = ((response.structuredContent as JsonObject).sources as JsonObject[])[0]!;
    const event = (source.event_refs as JsonObject[])[0]!;
    assert.equal((response.structuredContent as JsonObject).status, "sources_ready");
    assert.equal(event.operation_id, "codex_tool_mcp");
    assert.equal(event.tool_category, "api_mcp");
    assert.equal(event.tool_name, "mcp__browser__navigate");
    assert.equal(event.sequence, 1);
    assert.equal(event.id, "event-mcp");
    assert.equal(event.data, undefined);
    assert.equal(event.action_contract, undefined);
    assert.doesNotMatch(JSON.stringify(response.structuredContent), /sensitive-mcp-argument-and-result-marker/u);
  } finally { await f.close(); }
});

test("MCP Trace distillation rejects mismatched operations and malformed tool names", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-mcp-operation-mismatch", session: "session-current", turn: "turn-current",
      task: "task-mcp-operation-mismatch", eventId: "event-mcp-operation-mismatch", operation: "codex_tool_bash",
      category: "api_mcp", action: "invoke", toolName: "mcp__browser__navigate" });
    f.trace({ id: "trace-mcp-invalid-name", session: "session-current", turn: "turn-current",
      task: "task-mcp-invalid-name", eventId: "event-mcp-invalid-name", operation: "codex_tool_mcp",
      category: "api_mcp", action: "invoke", toolName: "mcp__bad name__navigate" });

    const response = await f.call("craft_experience_trace_distill", { project_binding: binding.project_binding });
    assert.equal(response.isError, false);
    assert.equal((response.structuredContent as JsonObject).status, "source_unavailable");
    assert.equal((response.structuredContent as JsonObject).reason_code, "no_supported_host_events");
    assert.deepEqual((response.structuredContent as JsonObject).sources, []);
    assert.equal(f.store.count("experience_procedure"), 0);
    assert.equal(f.store.count("experience_learning_work_item"), 0);
  } finally { await f.close(); }
});

test("malformed terminal references and incomplete verified observations never become Evidence refs", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-invalid-output-ref", session: "session-current", turn: "turn-current",
      task: "task-invalid-output-ref", eventId: "event-invalid-output-ref" });
    f.service.traceAppend({ trace_id: "trace-invalid-output-ref", event_id: "terminal-invalid-output-ref",
      event_kind: "task.terminal_verification", actor: "experience", source: "experience", trust: "verified",
      operation_id: "codex_task_terminal_verification", status: "passed", output_refs: ["not a reference"],
      data: {}, summary: "Terminal with invalid reference" });
    f.service.traceFinalize({ trace_id: "trace-invalid-output-ref", status: "completed",
      summary: "Terminal with invalid reference finalized", evidence_ids: ["not a reference"] });
    const invalidRef = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-invalid-output-ref"],
    });
    assert.equal(invalidRef.isError, true);
    assert.match(JSON.stringify(invalidRef), /no Observation reference/u);

    f.trace({ id: "trace-no-evidence", session: "session-current", turn: "turn-current",
      task: "task-no-evidence", eventId: "event-no-evidence" });
    f.store.create("workflow_evolution_observation", "observation-no-evidence", {
      lifecycle: "accepted", outcome: "passed",
      source: { kind: "host:codex", id: "task-no-evidence", session_id: "session-current", scope: binding.scope.id },
      evidence_ids: null,
    });
    f.service.traceAppend({ trace_id: "trace-no-evidence", event_id: "terminal-no-evidence",
      event_kind: "task.terminal_verification", actor: "experience", source: "experience", trust: "verified",
      operation_id: "codex_task_terminal_verification", status: "passed", output_refs: ["observation-no-evidence"],
      data: {}, summary: "Terminal with empty Evidence" });
    const missingEvidence = await f.call("craft_experience_trace_distill", {
      project_binding: binding.project_binding, trace_ids: ["trace-no-evidence"],
    });
    assert.equal(missingEvidence.isError, true);
    assert.match(JSON.stringify(missingEvidence), /no Evidence references/u);
  } finally { await f.close(); }
});

test("Trace event and terminal reference limits fail with content-free reasons", async () => {
  const f = await fixture();
  try {
    const binding = await f.turn();
    f.setScope(String(binding.scope.id));
    f.trace({ id: "trace-event-over-limit", session: "session-current", turn: "turn-current",
      task: "task-event-over-limit", eventId: "event-event-over-limit" });
    const originalList = f.store.list.bind(f.store) as (...args: unknown[]) => unknown[];
    (f.store as unknown as { list: (...args: unknown[]) => unknown[] }).list = (...args) => {
      if (args[0] === "trace_event" && args[1] === 10_001) {
        return Array.from({ length: 10_001 }, (_, index) => ({ sequence: index + 1 }));
      }
      return originalList(...args);
    };
    const service = f.service as unknown as { experienceTraceDistill(args: JsonObject): JsonObject };
    const args = { host: "codex", session_id: "session-current", turn_id: "turn-current",
      scope: binding.scope, project_root: f.projectRoot, trace_ids: ["trace-event-over-limit"] };
    assert.throws(() => service.experienceTraceDistill(args), /Trace source exceeds/u);
    (f.store as unknown as { list: (...args: unknown[]) => unknown[] }).list = originalList;

    f.trace({ id: "trace-malformed-output", session: "session-current", turn: "turn-current",
      task: "task-malformed-output", eventId: "event-malformed-output" });
    f.service.traceAppend({ trace_id: "trace-malformed-output", event_id: "terminal-malformed-output",
      event_kind: "task.terminal_verification", actor: "experience", source: "experience", trust: "verified",
      operation_id: "codex_task_terminal_verification", status: "passed", output_refs: ["observation-ref"],
      data: {}, summary: "Terminal reference fixture" });
    f.service.traceFinalize({ trace_id: "trace-malformed-output", status: "completed",
      summary: "Malformed terminal reference fixture finalized", evidence_ids: ["invalid reference"] });
    (f.store as unknown as { list: (...args: unknown[]) => unknown[] }).list = (...args) => {
      const rows = originalList(...args);
      if (args[0] === "trace_event") return rows.map(row => {
        const item = row as JsonObject;
        return item.trace_id === "trace-malformed-output" && item.event_kind === "task.terminal_verification"
          ? { ...item, output_refs: null } : row;
      });
      return rows;
    };
    assert.throws(() => service.experienceTraceDistill({ ...args, trace_ids: ["trace-malformed-output"] }),
      /no Observation reference/u);
  } finally { await f.close(); }
});
