import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { productSurfaceOf } from "../src/interfaces/mcp/product-launch.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-procedure-graph-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}
async function dispose(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

test("standalone Memory reads and writes only its named scope", async () => {
  const f = await fixture();
  try {
    f.service.knowledgeMemoryInstallBuiltins();
    const memory = new McpServer(f.service, productSurfaceOf("memory"));
    const saved = await memory.handlers.craft_memory_ledger_remember({ memory_id: "coffee", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "user", scope_id: "didi", content: "Prefer unsweetened coffee.", topic: "preference:drink:sugar" });
    assert.equal(((saved.memory as JsonObject).status), "active");
    assert.equal(((await memory.handlers.craft_memory_ledger_get({ memory_id: "coffee" })).memory as JsonObject).content, "Prefer unsweetened coffee.");
    assert.deepEqual(((await memory.handlers.craft_memory_ledger_list({ scope_kind: "user", scope_id: "didi" })).memories as JsonObject[]).map((item) => item.id), ["coffee"]);
    await memory.handlers.craft_memory_ledger_remember({ memory_id: "coffee-replacement", source_id: "builtin.evidence-wiki", kind: "preference", scope_kind: "user", scope_id: "didi", content: "Prefer sugar-free coffee.", topic: "preference:drink:sugar" });
    await memory.handlers.craft_memory_ledger_transition({ memory_id: "coffee", status: "superseded", replacement_id: "coffee-replacement", reason: "Newer preference is more specific." });
    assert.deepEqual(((await memory.handlers.craft_memory_ledger_list({ scope_kind: "user", scope_id: "didi", limit: 1, include_history: false })).memories as JsonObject[]).map((item) => item.id), ["coffee-replacement"]);
    assert.deepEqual(((await memory.handlers.craft_memory_ledger_list({ scope_kind: "user", scope_id: "didi", limit: 2, include_history: true })).memories as JsonObject[]).map((item) => item.id).sort(), ["coffee", "coffee-replacement"]);
    assert.deepEqual(((await memory.handlers.craft_memory_ledger_list({ scope_kind: "project", scope_id: "other" })).memories as JsonObject[]), []);
    assert.throws(() => memory.handlers.craft_memory_ledger_list({ scope_kind: "user" }), /scope_id/u);
    assert.throws(() => memory.handlers.craft_memory_ledger_list({ scope_kind: "user", scope_id: "didi", include_history: "yes" }), /boolean/u);
    assert.throws(() => memory.handlers.craft_memory_ledger_list({ scope_kind: "user", scope_id: "didi", limit: 0 }), /between 1 and 100/u);
    assert.throws(() => memory.handlers.craft_memory_ledger_list({ scope_kind: "user", scope_id: "didi", limit: 1.5 }), /integer/u);
  } finally { await dispose(f); }
});

test("standalone Knowledge registers a source, writes a candidate, and only reviewed evidence enters governed search", async () => {
  const f = await fixture();
  try {
    const knowledge = new McpServer(f.service, productSurfaceOf("knowledge"));
    await knowledge.handlers.craft_knowledge_bootstrap_install({});
    f.store.create("evidence", "knowledge-evidence", { confidence: "bounded", summary: "fixture source observation" });
    const candidate = await knowledge.handlers.craft_knowledge_claim_save({ claim_id: "source-rule", source_id: "builtin.evidence-wiki", kind: "rule", scope: "project:craft", content: "Use the focused regression command before a broad suite.", evidence_ids: ["knowledge-evidence"], tags: ["testing"] }) as JsonObject;
    assert.equal(((candidate.claim as JsonObject).status), "candidate");
    await knowledge.handlers.craft_knowledge_claim_review({ claim_id: "source-rule", status: "reviewed", reviewer: "fixture-review", reason: "Evidence and active source agree." });
    const result = await knowledge.handlers.craft_knowledge_search({ query: "focused regression", scope: "project:craft" }) as JsonObject;
    assert((result.hits as JsonObject[]).some((hit) => hit.claim_id === "source-rule" && hit.status === "reviewed"));
  } finally { await dispose(f); }
});

test("Experience turns independent observations into a draft Graph Procedure without creating a second executor", async () => {
  const f = await fixture();
  try {
    const experience = new McpServer(f.service, productSurfaceOf("experience"));
    f.store.create("evidence", "evidence", { confidence: "bounded", summary: "sanitized fixture evidence" });
    const first = await experience.handlers.craft_workflow_evolution_observe({ observation_id: "first", scenario_key: "coding.retry", source_kind: "outcome", source_id: "one", source_digest: "sha256:one", outcome: "failed", evidence_ids: ["evidence"], sanitized: true }) as JsonObject;
    const second = await experience.handlers.craft_workflow_evolution_observe({ observation_id: "second", scenario_key: "coding.retry", source_kind: "outcome", source_id: "two", source_digest: "sha256:two", outcome: "passed", evidence_ids: ["evidence"], sanitized: true }) as JsonObject;
    const request = (await experience.handlers.craft_workflow_evolution_propose({ request_id: "graph-request", scenario_key: "coding.retry", observation_ids: [(first.observation as JsonObject).id, (second.observation as JsonObject).id], hypothesis: "Bound retries and stop for an explicit approval.", design_axes: ["orchestration"], procedure_kind: "graph", output_contract_ref: "acceptance:tests-pass" })).request as JsonObject;
    assert.throws(() => f.service.workflowEvolutionPropose({ request_id: "graph-request", scenario_key: "coding.retry", observation_ids: [(first.observation as JsonObject).id, (second.observation as JsonObject).id], hypothesis: "Bound retries and stop for an explicit approval.", design_axes: ["orchestration"], procedure_kind: "workflow", output_contract_ref: "acceptance:tests-pass" }), /idempotency/u);
    assert.throws(() => f.service.workflowEvolution.submit({ request_id: request.id, workflow_id: "invalid-graph", name: "Invalid graph", description: "No nodes.", inputs: [], nodes: [] }), /graph nodes/u);
    const graph = await experience.handlers.craft_workflow_evolution_proposal_submit({ proposal_id: "graph-proposal", request_id: request.id, workflow_id: "coding-retry-graph", name: "Bounded coding retry", description: "A candidate graph with a decision-point human gate.", inputs: ["task_contract"],
      nodes: [
        { id: "inspect", type: "action", side_effect: "read_only" },
        { id: "verify", type: "condition", depends_on: ["inspect"], side_effect: "read_only" },
        { id: "retry", type: "retry", depends_on: ["verify"], side_effect: "read_only", max_attempts: 2 },
        { id: "approval", type: "human_gate", depends_on: ["verify"], side_effect: "read_only" },
      ],
      edges: [
        { id: "inspect-success", from: "inspect", to: "verify", kind: "success" },
        { id: "verify-failed", from: "verify", to: "retry", kind: "failure" },
        { id: "retry-loop", from: "retry", to: "inspect", kind: "retry", max_attempts: 2, on_exhausted: "needs_replan" },
        { id: "verify-review", from: "verify", to: "approval", kind: "condition", predicate_ref: "acceptance:uncertain" },
        { id: "approval-resume", from: "approval", to: "inspect", kind: "human_resume", approval_ref: "approval:operator" },
      ], outputs: { acceptance: "passed" }, checkpoint_policy: { mode: "step" } }) as JsonObject;
    const workflow = graph.workflow as JsonObject;
    assert.equal(workflow.lifecycle, "draft");
    assert.equal(workflow.automation_authority, false);
    assert.equal((workflow.derived_from as JsonObject).workflow_evolution_proposal_id, "graph-proposal");
    assert.equal(((workflow.graph as JsonObject).edges as JsonObject[]).length, 5);
    assert.equal(((await experience.handlers.craft_workflow_dag_get({ workflow_id: workflow.id })).workflow as JsonObject).id, workflow.id);
    assert.match(String(graph.next_action), /shadow and held-out/u);
    assert.throws(() => f.service.workflowDagValidate({ nodes: [{ id: "a", type: "action" }, { id: "b", type: "action" }], edges: [{ id: "a-b", from: "a", to: "b", kind: "success" }, { id: "b-a", from: "b", to: "a", kind: "failure" }] }), /unbounded cycle/u);
  } finally { await dispose(f); }
});

test("Experience keeps a graph proposal deterministic when optional graph fields are omitted", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "evidence", { confidence: "confirmed", summary: "sanitized fixture evidence" });
    f.service.workflowEvolutionObserve({ observation_id: "default-one", scenario_key: "coding.default-graph", source_kind: "outcome", source_id: "one", source_digest: "sha256:one", outcome: "failed", evidence_ids: ["evidence"], sanitized: true });
    f.service.workflowEvolutionObserve({ observation_id: "default-two", scenario_key: "coding.default-graph", source_kind: "outcome", source_id: "two", source_digest: "sha256:two", outcome: "passed", evidence_ids: ["evidence"], sanitized: true });
    const request = f.service.workflowEvolutionPropose({ request_id: "default-graph-request", scenario_key: "coding.default-graph", hypothesis: "Retry only after a failed terminal assertion.", design_axes: ["orchestration"], procedure_kind: "graph", output_contract_ref: "acceptance:tests-pass" }).request as JsonObject;
    assert.throws(() => f.service.workflowEvolutionPropose({ scenario_key: "coding.default-graph", hypothesis: "Reject an unsupported procedure type.", design_axes: ["orchestration"], procedure_kind: "tree", output_contract_ref: "acceptance:tests-pass" }), /procedure_kind is unsupported/u);
    const proposal = f.service.workflowEvolution.submit({ request_id: request.id, workflow_id: "default-graph", name: "Default graph", description: "Graph defaults remain explicit in the persisted draft.", inputs: [], nodes: [{ id: "inspect", type: "action" }] }).proposal as JsonObject;
    assert.deepEqual((proposal.graph as JsonObject).edges, []);
    assert.deepEqual((proposal.graph as JsonObject).outputs, {});
    assert.deepEqual((proposal.graph as JsonObject).checkpoint_policy, { mode: "step" });
    f.store.create("workflow_evolution_request", "legacy-workflow-request", { lifecycle: "awaiting_model", scenario_key: "coding.default-graph" });
    const legacyProposal = f.service.workflowEvolution.submit({ request_id: "legacy-workflow-request", workflow_id: "legacy-workflow", name: "Legacy workflow", description: "Old requests retain the linear default.", inputs: [], steps: [{ type: "assertion" }] }).proposal as JsonObject;
    assert.equal(legacyProposal.procedure_kind, "workflow");
    f.store.create("workflow_evolution_request", "bad-procedure-kind", { lifecycle: "awaiting_model", procedure_kind: "tree", scenario_key: "coding.default-graph" });
    assert.throws(() => f.service.workflowEvolution.submit({ request_id: "bad-procedure-kind", workflow_id: "bad-kind", name: "Bad kind", description: "Must not be accepted.", inputs: [], steps: [{ type: "assertion" }] }), /procedure_kind is unsupported/u);
  } finally { await dispose(f); }
});
