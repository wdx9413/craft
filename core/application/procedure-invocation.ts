import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { payload, stableDigest } from "../digest.ts";
import { object, text, uniqueList } from "../validation.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey } from "../scope-policy.ts";
import { assertProcedureTestIsolation, selectedProcedure } from "../../capability/craft-experience/procedure-release.ts";
import { ProcedurePlanner } from "../../capability/craft-experience/procedure-composition.ts";
import { ProcedureDefinitionStore, type ProcedureDefinitionRef } from "../../capability/craft-experience/procedure-definition.ts";
import { DurableActionLoopKernel } from "../durable-action-loop.ts";
import { AcceptanceGateKernel } from "../runtime-completion.ts";

import { lowerInvocationPlan, type Item, type Node } from "./procedure-work-items.ts";
import { graphInitial, GraphInvocationProgress } from "./procedure-graph-progress.ts";
function refs(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(object(value, "artifact refs")).map(([key, val]) => [key, text(val, "artifact ref")]));
}
function integer(value: unknown, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) throw new Error(`${name} must be an integer in 1..${maximum}`);
  return Number(value);
}

/** Binds Procedure calls to the existing Work Loop, without a second executor. */
export class ProcedureInvocationKernel {
  readonly store: CraftStore;
  readonly durable: DurableActionLoopKernel;
  readonly gates: AcceptanceGateKernel;
  constructor(store: CraftStore, durable: DurableActionLoopKernel, gates: AcceptanceGateKernel) { this.store = store; this.durable = durable; this.gates = gates; }

  bind(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const id = text(args.invocation_id, "invocation_id");
      const request = { ...args }; delete request.expected_version;
      const requestDigest = stableDigest(request);
      const existing = this.store.find("procedure_invocation", id);
      if (existing) {
        this.access(existing, args);
        if (existing.request_digest !== requestDigest) throw new Error("Invocation idempotency conflict");
        return { ...this.get(args), idempotent: true };
      }
      const work = this.store.get("verified_work_loop", text(args.work_loop_id, "work_loop_id"));
      const contract = this.store.get("task_control_contract", String(work.contract_id));
      const task = this.store.get("task", String(work.task_id));
      if (task.status !== "active" || work.lifecycle !== "active" || contract.task_id !== task.id || contract.version !== work.contract_version) throw new Error("Invocation requires an active same-Task Work Loop and current contract");
      const effects = uniqueList(args.allowed_effects, "allowed_effects");
      if (!effects.length || effects.some(effect => !["read_only", "local_write"].includes(effect) || !(contract.allowed_effects as string[]).includes(effect))) throw new Error("Invocation effects exceed Task contract or supported local effects");
      if (args.release_channel === "test" && effects.includes("local_write")) assertProcedureTestIsolation(this.store, args, work.workspace_id);
      const maxDispatches = integer(args.max_dispatches, "max_dispatches", 500);
      const ttl = integer(args.ttl_ms, "ttl_ms", 86_400_000);
      const compiled = new ProcedurePlanner(this.store).plan(args, { deferPreconditions: true });
      const plan = compiled.plan as JsonObject;
      const rootInputs = refs(args.input_refs);
      const artifacts = Object.fromEntries(Object.entries(rootInputs).map(([name, ref]) => [`root:input:${name}`, ref]));
      const graph = plan.graph as JsonObject | undefined;
      const graphPrepared = graph ? graphInitial(plan, rootInputs) : null;
      const prepared = graphPrepared ?? lowerInvocationPlan(plan, Object.fromEntries(Object.keys(rootInputs).map(key => [key, `root:input:${key}`])));
      const { nodes, items } = prepared;
      if (items.length > maxDispatches) throw new Error("Dispatch budget is smaller than the selected route");
      const snapshot = this.store.get("state_snapshot", String(work.latest_snapshot_id));
      const loop = this.durable.create({ action_loop_id: `procedure:${id}`, work_loop_id: work.id, work_items: items, max_parallel: graph || nodes.some(node => (node.parallel_groups as unknown[]).length > 0) ? 8 : 1 }).loop as JsonObject;
      if (graph) {
        const marker = this.store.get("durable_work_item", `${loop.id}:root/$exit`);
        this.store.save("durable_work_item", String(marker.id), { ...payload(marker), status: "dormant" });
      }
      const invocation = this.store.create("procedure_invocation", id, { ...(graph ? { graph: plan.graph, graph_state: graphPrepared!.graph_state, subscenario_id: (graph.scenario as JsonObject).id, scenario_id: (graph.control as JsonObject).scenario_id, scenario_digest: stableDigest(graph.scenario) } : {}), request_digest: requestDigest, work_loop_id: work.id, task_id: work.task_id, task_run_id: work.task_run_id,
        release_channel: args.release_channel ?? "current", test_workspace_id: args.test_workspace_id ?? null, baseline_workspace_id: args.baseline_workspace_id ?? null, contract_id: contract.id, contract_version: contract.version, workspace_id: work.workspace_id, scope: args.scope, action_loop_id: loop.id,
        procedure_id: plan.procedure_id, procedure_version: plan.procedure_version, definition_digest: plan.definition_digest, entry_id: plan.entry_id, exit_id: args.exit_id,
        plan_digest: compiled.plan_digest, input_digest: stableDigest(rootInputs), initial_snapshot_digest: snapshot.snapshot_digest,
        host_id: text(args.host_id, "host_id"), model_fingerprint: text(args.model_fingerprint, "model_fingerprint"), budget_fingerprint: text(args.budget_fingerprint, "budget_fingerprint"),
        allowed_effects: effects, max_dispatches: maxDispatches, expires_at: new Date(Date.now() + ttl).toISOString(), nodes, items, artifacts, entered: {}, lifecycle: "active", dispatch_count: 0 });
      return { invocation, idempotent: false, host_execution_authority: false };
    });
  }

  dispatch(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const run = this.load(args); this.current(run, args);
      this.cas(run, args);
      const state = this.durable.resume({ action_loop_id: run.action_loop_id, snapshot_id: text(args.snapshot_id, "snapshot_id") });
      if (state.next_action !== "propose_action") return { invocation: run, ...state, host_execution_authority: false };
      if (Number(run.dispatch_count) >= Number(run.max_dispatches)) throw new Error("Invocation dispatch budget exhausted");
      const item = (run.items as Item[]).find(item => item.id === text(args.item_key, "item_key"));
      if (!item || !(state.ready_items as JsonObject[]).some(ready => ready.item_key === item.id)) throw new Error("Invocation item is not ready");
      const artifacts = refs(run.artifacts), entered = { ...object(run.entered, "entered") };
      const snapshot = this.store.get("state_snapshot", String(args.snapshot_id));
      const evidenceByPath = object(args.precondition_evidence ?? {}, "precondition_evidence");
      for (const path of item.entry_paths) if (!Object.hasOwn(entered, path)) {
        const node = (run.nodes as Node[]).find(node => node.path === path)!;
        const inputs = this.resolve(node.input_keys, artifacts);
        const supplied = refs(evidenceByPath[path] ?? {});
        const evidence = node.precondition_evidence.map(condition => {
          const proof = this.store.get("evidence", text(supplied[String(condition.condition_ref)], "precondition Evidence"));
          const meta = object(proof.metadata, "Evidence metadata");
          if (proof.confidence !== "confirmed" || meta.scope !== run.scope || meta.invocation_id !== run.id || meta.call_path !== path || meta.task_id !== run.task_id
            || meta.condition_ref !== condition.condition_ref || meta.input_digest !== stableDigest(inputs) || meta.snapshot_digest !== snapshot.snapshot_digest
            || meta.workspace_state_revision !== snapshot.workspace_state_revision || !Number.isFinite(Date.parse(String(meta.expires_at))) || Date.parse(String(meta.expires_at)) <= Date.now()) throw new Error("Precondition Evidence is stale or belongs to another invocation/input/state");
          return { id: proof.id, version: proof.version };
        });
        entered[path] = { input_digest: stableDigest(inputs), snapshot_id: snapshot.id, evidence_refs: evidence, entered_at: new Date().toISOString() };
      }
      const inputs = this.resolve(item.input_keys, artifacts);
      const binding = { invocation_id: run.id, item_key: item.id, task_id: run.task_id, work_loop_id: run.work_loop_id, plan_digest: run.plan_digest,
        acceptance_digest: item.acceptance_digest, acceptance_ref: item.acceptance_ref, input_refs: inputs, input_digest: stableDigest(inputs), snapshot_id: snapshot.id,
        snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: snapshot.workspace_state_revision, effect: item.effect, host_id: run.host_id };
      const dispatchDigest = stableDigest(binding);
      const action = this.durable.propose({ action_loop_id: run.action_loop_id, item_key: item.id, kind: "verify", effect: "read_only", action_digest: dispatchDigest,
        action_id: `${run.id}:${item.id}${Number((run.attempts as JsonObject | undefined)?.[item.id] ?? 0) ? `:retry:${String((run.attempts as JsonObject)[item.id])}` : ""}` }).action as JsonObject;
      this.durable.dispatch({ action_id: action.id, dispatch_ref: dispatchDigest });
      const dispatch = this.store.create("procedure_invocation_dispatch", String(action.id), { ...binding, dispatch_digest: dispatchDigest, action_id: action.id });
      const saved = this.store.save("procedure_invocation", String(run.id), { ...payload(run), entered, dispatch_count: Number(run.dispatch_count) + 1 });
      return { invocation: saved, dispatch, work_item: item, host_execution_authority: false };
    });
  }

  report(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const run = this.load(args), dispatch = this.store.get("procedure_invocation_dispatch", text(args.dispatch_id, "dispatch_id"));
      if (dispatch.invocation_id !== run.id) throw new Error("Dispatch belongs to another invocation");
      const receiptId = String(dispatch.id), requestDigest = stableDigest({ ...args, expected_version: null });
      const existing = this.store.find("procedure_invocation_receipt", receiptId);
      if (existing) {
        if (existing.request_digest !== requestDigest) throw new Error("Receipt idempotency conflict");
        return { ...this.get(args), receipt: existing, idempotent: true };
      }
      const recovering = ["blocked", "inconclusive"].includes(String(run.lifecycle)) || run.lifecycle === "failed" && (run.recovery_action === "retry" || !!run.graph);
      this.current(recovering ? { ...run, lifecycle: "active" } : run, args); this.cas(run, args);
      if ((this.durable.get({ action_loop_id: run.action_loop_id }).loop as JsonObject).lifecycle !== "active") throw new Error("Durable loop requires replan before accepting progress");
      const session = this.store.get("host_session", text(args.host_session_id, "host_session_id"));
      if (session.status !== "terminal" || session.task_id !== run.task_id || session.host_id !== run.host_id || session.capability_fingerprint !== dispatch.dispatch_digest
        || session.model_fingerprint !== run.model_fingerprint || session.budget_fingerprint !== run.budget_fingerprint) throw new Error("Terminal Host Session does not match dispatch");
      const terminal = this.store.list("host_session_event", 100_000, event => event.session_id === session.id && event.sequence === session.next_sequence)[0];
      if (!terminal || !["session.completed", "session.failed", "session.cancelled"].includes(String(terminal.kind))) throw new Error("Missing terminal Host event");
      const observation = this.store.get("outcome_observation", text(args.observation_id, "observation_id"));
      const snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
      if (snapshot.workspace_id !== run.workspace_id || observation.state_snapshot_ref !== snapshot.id || observation.trace_id !== session.trace_id || observation.host_id !== run.host_id
        || !observation.observer_id || observation.observer_id === session.host_id || observation.observer_kind !== "program"
        || observation.environment_fingerprint !== session.environment_fingerprint || !["passed", "failed", "blocked", "inconclusive"].includes(String(observation.verdict))) throw new Error("Independent observation does not match Host and snapshot");
      const item = (run.items as Item[]).find(item => item.id === dispatch.item_key)!;
      const outputs = refs(args.output_refs);
      const passed = terminal.kind === "session.completed" && observation.verdict === "passed";
      const verdict = terminal.kind === "session.cancelled" ? "cancelled" : observation.verdict === "passed" ? (passed ? "passed" : "failed") : String(observation.verdict);
      const required = item.kind === "exit" ? Object.keys(item.input_keys) : Object.keys(item.output_keys);
      if (passed && stableDigest(Object.keys(outputs).sort()) !== stableDigest(required.sort())) throw new Error("Output refs must match selected step or exit");
      if (passed && item.kind === "exit" && stableDigest(outputs) !== stableDigest(dispatch.input_refs)) throw new Error("Exit cannot replace unverified outputs");
      const evidenceIds = uniqueList(args.acceptance_evidence_ids, "acceptance_evidence_ids");
      if (!evidenceIds.length) throw new Error("Acceptance Evidence is required");
      let metrics: JsonObject | null = null;
      for (const id of evidenceIds) {
        const evidence = this.store.get("evidence", id), meta = object(evidence.metadata, "acceptance metadata");
        if (evidence.source_type !== "program" || evidence.confidence !== "confirmed" || !(observation.evidence_ids as string[]).includes(id)
          || meta.dispatch_digest !== dispatch.dispatch_digest || meta.acceptance_digest !== item.acceptance_digest || meta.output_digest !== stableDigest(outputs)
          || meta.state_after_digest !== snapshot.snapshot_digest || meta.status !== observation.verdict) throw new Error("Acceptance Evidence does not match exact dispatch/output/state");
        if (meta.metrics !== undefined) {
          const measured = object(meta.metrics, "measured metrics");
          if (["cost_units", "latency_ms", "retry_count"].some(key => typeof measured[key] !== "number" || !Number.isFinite(measured[key]) || Number(measured[key]) < 0)
            || !Number.isSafeInteger(measured.retry_count)) throw new Error("Metrics must be finite non-negative measurements");
          const normalized = { cost_units: measured.cost_units, latency_ms: measured.latency_ms, retry_count: measured.retry_count };
          if (metrics && stableDigest(metrics) !== stableDigest(normalized)) throw new Error("Conflicting receipt metrics");
          metrics = normalized;
        }
      }
      const artifactIds = [...new Set([`dispatch:${dispatch.id}`, ...Object.values(outputs)])];
      const gate = this.gates.prepare({ gate_id: `procedure:${dispatch.id}`, task_id: run.task_id, work_id: dispatch.id, acceptance_ref: item.acceptance_ref,
        required_artifact_ids: artifactIds, required_evidence_ids: evidenceIds }).gate as JsonObject;
      const assessed = this.gates.assess({ gate_id: gate.id, verdict: passed ? "passed" : verdict === "failed" ? "failed" : "blocked", artifact_ids: artifactIds, evidence_ids: evidenceIds, assessor: observation.observer_id }).gate as JsonObject;
      const node = (run.nodes as Node[]).find(node => node.path === item.node_path)!;
      this.durable.report({ action_id: dispatch.action_id, recoverable: verdict === "blocked" || verdict === "inconclusive" || (verdict === "failed" && (node.failure_disposition === "retry" || !!run.graph)), outcome: passed ? "succeeded" : "blocked", snapshot_id: snapshot.id,
        receipt_ref: { kind: "host_session_event", id: terminal.id, version: terminal.version }, acceptance_ref: { kind: "acceptance_gate", id: assessed.id, version: assessed.version } });
      const receipt = this.store.create("procedure_invocation_receipt", receiptId, { invocation_id: run.id, item_key: item.id, request_digest: requestDigest, dispatch_digest: dispatch.dispatch_digest,
        status: verdict, host_session_id: session.id, host_session_version: session.version, observation_id: observation.id, observation_version: observation.version,
        acceptance_gate_id: assessed.id, output_refs: outputs, snapshot_id: snapshot.id, metrics, verification_provenance: "host_attested", promotion_eligible: false });
      if (!passed) {
        const blockedItem = this.store.get("durable_work_item", `${run.action_loop_id}:${item.id}`);
        this.store.save("durable_work_item", String(blockedItem.id), { ...payload(blockedItem), blocked_receipt_id: receipt.id });
      }
      const artifacts = refs(run.artifacts);
      if (passed) for (const [name, key] of Object.entries(item.output_keys)) {
        if (item.kind === "exit") artifacts[name] = outputs[key]!;
        else artifacts[key] = outputs[name]!;
      }
      if (!passed || item.kind === "exit") this.store.save("procedure_invocation_outcome", `${run.id}:${item.node_path}`, {
        invocation_id: run.id, receipt_id: receipt.id, call_path: item.node_path, scope: run.scope, procedure_id: node.procedure_id, procedure_version: node.procedure_version,
        definition_digest: node.definition_digest, entry_id: node.entry_id, exit_id: (node.exit as JsonObject).id, input_digest: (run.entered as Record<string, JsonObject>)[item.node_path]!.input_digest,
        status: verdict, failure_stage: passed ? null : item.id, host_id: run.host_id, model_fingerprint: run.model_fingerprint, budget_fingerprint: run.budget_fingerprint,
        elapsed_ms: Date.now() - Date.parse(String((run.entered as Record<string, JsonObject>)[item.node_path]!.entered_at)),
        metrics: this.metrics(run, item.node_path), verification_provenance: "host_attested", promotion_eligible: false, evidence_ids: evidenceIds });
      const lifecycle = !passed ? verdict : recovering ? run.lifecycle : item.id === "root/$exit" ? "completed" : "active";
      const saved = this.store.save("procedure_invocation", String(run.id), { ...payload(run), artifacts, lifecycle, last_receipt_id: passed && recovering ? run.last_receipt_id : receipt.id, recovery_action: passed ? (recovering ? run.recovery_action : null) : verdict === "cancelled" ? "none" : run.graph ? "graph_transition" : verdict === "failed" ? node.failure_disposition : "await_resolution" });
      return { invocation: saved, receipt, idempotent: false };
    });
  }

  resume(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      let run = this.load(args);
      this.cas(run, args);
      if (["blocked", "inconclusive", "failed"].includes(String(run.lifecycle))) {
        // Validate the same policy/version/expiry before reopening any item.
        this.current({ ...run, lifecycle: "active" }, args);
        if (args.recovery_evidence_id === undefined) return { invocation: run, recovery_action: run.recovery_action, host_execution_authority: false };
        if (run.graph) throw new Error("Graph recovery requires a declared transition; retry budgets cannot be reset by resume");
        const receipt = this.store.get("procedure_invocation_receipt", String(run.last_receipt_id));
        const item = (run.items as Item[]).find(item => item.id === receipt.item_key)!;
        const node = (run.nodes as Node[]).find(node => node.path === item.node_path)!;
        if (run.lifecycle === "failed" && node.failure_disposition !== "retry") throw new Error("Failure disposition requires handoff or replan");
        const attempts = { ...object(run.attempts ?? {}, "attempts") };
        if (Number(attempts[item.id] ?? 0) >= 3 || Number(run.dispatch_count) >= Number(run.max_dispatches)) throw new Error("Invocation retry budget exhausted");
        const proof = this.store.get("evidence", text(args.recovery_evidence_id, "recovery_evidence_id"));
        const meta = object(proof.metadata, "recovery metadata"), snapshot = this.store.get("state_snapshot", text(args.snapshot_id, "snapshot_id"));
        if (proof.source_type !== "program" || proof.confidence !== "confirmed" || meta.invocation_id !== run.id || meta.receipt_id !== receipt.id
          || meta.snapshot_digest !== snapshot.snapshot_digest || meta.workspace_state_revision !== snapshot.workspace_state_revision || meta.safe_to_retry !== true
          || !Number.isFinite(Date.parse(String(meta.expires_at))) || Date.parse(String(meta.expires_at)) <= Date.now()) throw new Error("Recovery Evidence does not prove current target state and safe retry");
        const state = this.durable.resume({ action_loop_id: run.action_loop_id, snapshot_id: snapshot.id });
        if (state.next_action === "replan") return { ...state, invocation: run, recovery_action: "replan", host_execution_authority: false };
        const blocked = this.store.get("durable_work_item", `${run.action_loop_id}:${item.id}`);
        this.store.save("durable_work_item", String(blocked.id), { ...payload(blocked), status: "pending", recovery_evidence_id: proof.id });
        attempts[item.id] = Number(attempts[item.id] ?? 0) + 1;
        const entered = { ...object(run.entered, "entered") };
        for (const path of item.entry_paths) delete entered[path];
        const remaining = (this.durable.get({ action_loop_id: run.action_loop_id }).work_items as JsonObject[]).find(item => item.status === "blocked");
        if (remaining) {
          const nextReceipt = this.store.get("procedure_invocation_receipt", text(remaining.blocked_receipt_id, "blocked_receipt_id"));
          const nextItem = (run.items as Item[]).find(item => item.id === nextReceipt.item_key)!;
          const nextNode = (run.nodes as Node[]).find(node => node.path === nextItem.node_path)!;
          const recovery = nextReceipt.status === "failed" ? nextNode.failure_disposition : "await_resolution";
          run = this.store.save("procedure_invocation", String(run.id), { ...payload(run), attempts, entered, lifecycle: nextReceipt.status, last_receipt_id: nextReceipt.id, recovery_action: recovery });
          return { invocation: run, recovery_action: recovery, host_execution_authority: false };
        }
        run = this.store.save("procedure_invocation", String(run.id), { ...payload(run), lifecycle: "active", attempts, entered, recovery_action: null });
      } else this.current(run, args);
      const state = this.durable.resume({ action_loop_id: run.action_loop_id, snapshot_id: text(args.snapshot_id, "snapshot_id") });
      // A dispatched action is never replayed, even if the caller lost its response.
      return { ...state, invocation: run, recovery_action: state.next_action === "await_receipt" ? "reconcile_dispatch" : state.next_action, host_execution_authority: false };
    });
  }

  transition(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const run = this.load(args);
      return new GraphInvocationProgress(this.store).transition(run, args, () => {
        this.current({ ...run, lifecycle: ["failed", "blocked", "inconclusive"].includes(String(run.lifecycle)) ? "active" : run.lifecycle }, args);
        this.cas(run, args);
      });
    });
  }

  get(args: JsonObject): JsonObject {
    const invocation = this.load(args);
    return { invocation, ...this.durable.get({ action_loop_id: invocation.action_loop_id }),
      dispatches: this.store.list("procedure_invocation_dispatch", 500, item => item.invocation_id === invocation.id),
      receipts: this.store.list("procedure_invocation_receipt", 500, item => item.invocation_id === invocation.id),
      graph_transitions: this.store.list("procedure_graph_transition", 500, item => item.invocation_id === invocation.id),
      outcomes: this.store.list("procedure_invocation_outcome", 200, item => item.invocation_id === invocation.id) };
  }

  evaluate(args: JsonObject): JsonObject {
    const baselineIds = uniqueList(args.baseline_ids, "baseline_ids"), candidateIds = uniqueList(args.candidate_ids, "candidate_ids");
    if (baselineIds.length < 3 || baselineIds.length > 100 || baselineIds.length !== candidateIds.length || new Set([...baselineIds, ...candidateIds]).size !== baselineIds.length * 2) throw new Error("Evaluation requires 3..100 independent paired trials");
    const pairs = baselineIds.map((id, index) => {
      const baseline = this.load({ ...args, invocation_id: id }), candidate = this.load({ ...args, invocation_id: candidateIds[index] });
      const key = (run: JsonObject) => [run.scope, run.scenario_id ?? null, run.subscenario_id ?? null, run.entry_id, run.exit_id, run.input_digest, run.initial_snapshot_digest, run.host_id, run.model_fingerprint, run.budget_fingerprint];
      if (stableDigest(key(baseline)) !== stableDigest(key(candidate))) throw new Error("Paired trial context differs");
      const outcome = (run: JsonObject) => {
        if (!["completed", "failed", "cancelled", "blocked", "inconclusive"].includes(String(run.lifecycle))) throw new Error("Evaluation requires terminal invocations");
        const receipts = this.store.list("procedure_invocation_receipt", 500, item => item.invocation_id === run.id);
        return { invocation_id: run.id, definition_digest: run.definition_digest, status: run.lifecycle, passed: run.lifecycle === "completed", receipts: receipts.length,
          elapsed_ms: Date.parse(String(run.updated_at)) - Date.parse(String(run.created_at)), metrics: this.metrics(run, "root"), verification_provenance: "host_attested" };
      };
      return { baseline: outcome(baseline), candidate: outcome(candidate) };
    });
    return { pairs, baseline_pass_rate: pairs.filter(pair => pair.baseline.passed).length / pairs.length,
      candidate_pass_rate: pairs.filter(pair => pair.candidate.passed).length / pairs.length,
      metrics_available: pairs.every(pair => pair.baseline.metrics !== null && pair.candidate.metrics !== null), promotion_eligible: false };
  }

  private metrics(run: JsonObject, path: string): JsonObject | null {
    const receipts = this.store.list("procedure_invocation_receipt", 500, receipt => receipt.invocation_id === run.id && String(receipt.item_key).startsWith(`${path}/`));
    if (!receipts.length || receipts.some(receipt => receipt.metrics === null)) return null;
    return Object.fromEntries(["cost_units", "latency_ms", "retry_count"].map(key => [key, receipts.reduce((sum, receipt) => sum + Number((receipt.metrics as JsonObject)[key]), 0)]));
  }

  private load(args: JsonObject): JsonObject { const run = this.store.get("procedure_invocation", text(args.invocation_id, "invocation_id")); this.access(run, args); return run; }
  private access(run: JsonObject, args: JsonObject): void {
    if (args.scope !== run.scope) throw new Error("Invocation scope denied");
    for (const node of run.nodes as Node[]) {
      const procedure = this.store.get("experience_procedure", String(node.procedure_id));
      if (!scopeAllows(scopeEnvelope(procedure.scope_envelope, scopeFromKey(String(run.scope))), scopeAccess(args))) throw new Error("Invocation audience denied");
    }
  }
  private current(run: JsonObject, args: JsonObject): void {
    if (run.lifecycle !== "active" || Date.parse(String(run.expires_at)) <= Date.now()) throw new Error("Invocation is terminal or expired");
    const work = this.store.get("verified_work_loop", String(run.work_loop_id));
    const task = this.store.get("task", String(run.task_id));
    const contract = this.store.get("task_control_contract", String(run.contract_id));
    if (task.status !== "active" || work.lifecycle !== "active" || contract.version !== run.contract_version) throw new Error("Task/Work Loop/Policy changed; replan required");
    if (contract.budget_account) {
      const budget = this.store.get("budget_account", String((contract.budget_account as JsonObject).id));
      const limits = object(budget.limits, "budget limits"), used = object(budget.used, "budget used"), reserved = object(budget.reserved, "budget reserved");
      if (budget.status !== "active" || budget.owner_id !== run.task_id || Object.keys(limits).some(key => Number(limits[key]) <= Number(used[key] ?? 0) + Number(reserved[key] ?? 0))) throw new Error("Task budget exhausted or unavailable");
    }
    if (run.release_channel === "test" && (run.allowed_effects as string[]).includes("local_write")) assertProcedureTestIsolation(this.store, run, work.workspace_id);
    for (const node of run.nodes as Node[]) {
      const procedure = selectedProcedure(this.store, String(node.procedure_id), run.release_channel);
      if (!procedure || run.release_channel !== "test" && (procedure.routeable !== true || procedure.lifecycle !== "routeable") || procedure.version !== node.procedure_version || procedure.definition_digest !== node.definition_digest) throw new Error("Procedure revoked or version drifted; replan required");
      new ProcedureDefinitionStore(this.store.paths).read(procedure.definition_ref as ProcedureDefinitionRef);
    }
    this.access(run, args);
  }
  private cas(run: JsonObject, args: JsonObject): void { if (integer(args.expected_version, "expected_version", Number.MAX_SAFE_INTEGER) !== run.version) throw new Error("Invocation version conflict"); }
  private resolve(keys: Record<string, string>, artifacts: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(keys).map(([name, key]) => { if (!Object.hasOwn(artifacts, key)) throw new Error("Required artifact has not been accepted"); return [name, artifacts[key]!]; }));
  }
}
