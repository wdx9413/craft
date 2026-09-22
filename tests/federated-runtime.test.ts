import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer, surfaceToolNames } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { RuntimeModelProbeKernel } from "../src/runtime-model-probe.ts";
import type { ModelProviderSpec, ModelTransport } from "../src/model-gateway.ts";

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01216-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  const task = service.taskOpen({ title: "Federated", goal: "Research safely" }).task as JsonObject;
  const confirmed = service.evidenceRecord({ evidence_id: "confirmed", source_type: "human", confidence: "confirmed", claim: "reviewed" }) as JsonObject;
  const bounded = service.evidenceRecord({ evidence_id: "bounded", source_type: "program", confidence: "bounded", claim: "limited" }) as JsonObject;
  const provider = service.enterpriseIdentityProviderRegister({ provider_id: "provider", kind: "short_lived_broker", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" }).provider as JsonObject;
  service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security" });
  const card = store.create("a2a_agent_card", "card", { card_digest: "sha256:card", skills: ["research"], endpoint: "https://remote.example.test/a2a" });
  const baseline = store.create("delivery_evaluation_run", "baseline", { status: "eligible_for_signoff" });
  const trust = service.a2aAgentTrustApprove({ trust_id: "trust", card_id: card.id, provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [confirmed.id], approval_ref: "approved" }).trust as JsonObject;
  const session = service.a2aCollaborationSessionCreate({ session_id: "session", task_id: task.id, trust_id: trust.id, evaluation_run_id: baseline.id, justification_evidence_id: confirmed.id, budget: { tokens: 10 }, max_delegations: 5 }).session as JsonObject;
  const artifact = service.artifactRegister({ artifact_id: "artifact", kind: "file", name: "proof", uri: "file:///proof", producer_type: "test", producer_id: "test" }) as JsonObject;
  const run = store.create("task_run", "run", { launch_identity: { task_id: task.id }, environment_digest: "sha256:environment", budget_digest: "sha256:budget" });
  return { root, store, service, task, confirmed, bounded, card, session, artifact, run };
}

function delegation(f: Awaited<ReturnType<typeof fixture>>, id: string, now = "2030-01-01T00:00:00.000Z") {
  return f.service.a2aDelegationPrepare({ delegation_id: id, session_id: f.session.id, objective: "research", artifact_ids: [f.artifact.id], evidence_ids: [f.confirmed.id], ttl_seconds: 60, now }).delegation as JsonObject;
}

function replace(f: Awaited<ReturnType<typeof fixture>>, kind: string, id: unknown, patch: JsonObject): JsonObject {
  const recordId = String(id); const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...record } = f.store.get(kind, recordId);
  return f.store.save(kind, recordId, { ...record, ...patch });
}

test("v0.12.18 grants only healthy, scoped, one-time remote read authority and records bound receipts", async () => {
  const f = await fixture();
  try {
    const item = delegation(f, "delegation");
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "grant", delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /health/);
    assert.throws(() => f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: "sha256:other", status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" }), /Card/);
    const health = f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" }).health as JsonObject;
    assert.equal(f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" }).idempotent, true);
    assert.equal(health.status, "healthy");
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "bad-skill", delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host", capability_ids: ["write"] }), /advertised/);
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "bad-artifact", delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host", artifact_ids: [] }), /widen/);
    const issued = f.service.federatedDelegationGrantIssue({ grant_id: "grant", delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host", capability_ids: ["research"] }); const grant = issued.grant as JsonObject;
    assert.equal((issued.artifact_grants as JsonObject[]).length, 1); assert.equal(f.service.federatedDelegationGrantIssue({ grant_id: "grant", delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host", capability_ids: ["research"] }).idempotent, true);
    assert.throws(() => f.service.federatedDelegationGrantConsume({ grant_id: grant.id, audience: "other", consumer_ref: "adapter", now: "2030-01-01T00:00:01.000Z" }), /audience/);
    const consumed = f.service.federatedDelegationGrantConsume({ grant_id: grant.id, audience: "remote", consumer_ref: "adapter", now: "2030-01-01T00:00:01.000Z" }).grant as JsonObject;
    assert.equal(consumed.status, "consumed"); assert.equal(f.service.federatedDelegationGrantConsume({ grant_id: grant.id, audience: "remote", consumer_ref: "adapter" }).idempotent, true);
    f.service.a2aDelegationDispatch({ delegation_id: item.id, transport_evidence_id: f.confirmed.id, dispatched_by: "adapter", now: "2030-01-01T00:00:02.000Z" });
    const artifactGrantIds = (issued.artifact_grants as JsonObject[]).map((entry) => String(entry.id));
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "bad", grant_id: grant.id, state: "accepted", environment_digest: "wrong", effect: "read_only", result_digest: "sha256:result", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds }), /environment/);
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "bad-artifacts", grant_id: grant.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:result", evidence_ids: [f.confirmed.id], artifact_grant_ids: [] }), /Artifact/);
    assert.equal((f.service.federatedDelegationReceiptRecord({ receipt_id: "accepted", grant_id: grant.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:accepted", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds }).receipt as JsonObject).raw_result_stored, false);
    const complete = f.service.federatedDelegationReceiptRecord({ receipt_id: "complete", grant_id: grant.id, state: "completed", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:complete", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds });
    assert.equal((complete.grant as JsonObject).status, "completed"); assert.equal(f.service.federatedDelegationReceiptRecord({ receipt_id: "complete", grant_id: grant.id, state: "completed", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:complete", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds }).idempotent, true);
    assert.throws(() => f.service.federatedDelegationRevoke({ grant_id: grant.id, reason: "late", evidence_ids: [f.confirmed.id] }), /Terminal/);
    const detail = f.service.federatedDelegationGet({ grant_id: grant.id }); assert.equal((detail.receipts as JsonObject[]).length, 2); assert.equal((detail.artifact_grants as JsonObject[]).length, 1);
    const full = new McpServer(f.service, "full");
    assert.equal((await full.handlers.craft_federated_agent_health_record({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" })).idempotent, true);
    assert.equal((await full.handlers.craft_federated_delegation_grant_issue({ grant_id: grant.id, delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host", capability_ids: ["research"] })).idempotent, true);
    assert.throws(() => full.handlers.craft_federated_delegation_grant_consume({ grant_id: grant.id, audience: "remote", consumer_ref: "adapter" }), /inactive/);
    assert.equal((await full.handlers.craft_federated_remote_receipt_record({ receipt_id: "complete", grant_id: grant.id, state: "completed", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:complete", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds })).idempotent, true);
    assert.throws(() => full.handlers.craft_federated_delegation_revoke({ grant_id: grant.id, reason: "late", evidence_ids: [f.confirmed.id] }), /Terminal/);
    assert.equal((await full.handlers.craft_federated_delegation_reconcile({ grant_id: grant.id })).idempotent, true);
    assert.equal((await full.handlers.craft_federated_delegation_get({ grant_id: grant.id })).grant !== undefined, true);
    assert.equal(VERSION, "0.12.37");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.18 closes unhealthy, revoked, and expired remote delegation paths without assuming success", async () => {
  const f = await fixture();
  try {
    f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" });
    const revocable = delegation(f, "revocable"); const grant = f.service.federatedDelegationGrantIssue({ grant_id: "revocable-grant", delegation_id: revocable.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    assert.throws(() => f.service.federatedDelegationRevoke({ grant_id: grant.id, reason: "bad", evidence_ids: [f.bounded.id] }), /confirmed/);
    const revoked = f.service.federatedDelegationRevoke({ grant_id: grant.id, reason: "operator", evidence_ids: [f.confirmed.id] }); assert.equal((revoked.grant as JsonObject).status, "revoked"); assert.equal(((revoked.artifact_grants as JsonObject[])[0]).status, "revoked"); assert.equal(f.service.federatedDelegationRevoke({ grant_id: grant.id, reason: "operator", evidence_ids: [f.confirmed.id] }).idempotent, true);
    assert.throws(() => f.service.federatedDelegationGrantConsume({ grant_id: grant.id, audience: "remote", consumer_ref: "adapter" }), /inactive/);
    const expiring = delegation(f, "expiring", "2030-01-01T00:00:00.000Z"); const expiringGrant = f.service.federatedDelegationGrantIssue({ grant_id: "expiring-grant", delegation_id: expiring.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    assert.equal(f.service.federatedDelegationReconcile({ grant_id: expiringGrant.id, now: "2030-01-01T00:00:30.000Z" }).incident, null);
    const incident = f.service.federatedDelegationReconcile({ grant_id: expiringGrant.id, now: "2030-01-01T00:02:00.000Z" }); assert.equal((incident.grant as JsonObject).status, "indeterminate"); assert.equal((incident.incident as JsonObject).required_next_action, "adapter_poll_or_human_review"); assert.equal(f.service.federatedDelegationReconcile({ grant_id: expiringGrant.id, now: "2030-01-01T00:03:00.000Z" }).idempotent, true);
    f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "degraded", evidence_ids: [f.confirmed.id], observed_by: "host" });
    const unhealthy = delegation(f, "unhealthy"); assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "unhealthy-grant", delegation_id: unhealthy.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /health/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.18 keeps multi-Agent topology shadowed until paired evidence and makes deployment gaps explicit", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "bad", task_id: f.task.id, roles: ["diagnostic_research"], mode: "candidate" }), /primary/);
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "bad-base", task_id: f.task.id, roles: ["primary", "independent_evaluator"], mode: "baseline" }), /Baseline/);
    const baseline = f.service.harnessTopologyDefine({ topology_id: "single", task_id: f.task.id, roles: ["primary"], mode: "baseline" }).topology as JsonObject;
    const candidate = f.service.harnessTopologyDefine({ topology_id: "evaluated", task_id: f.task.id, roles: ["primary", "independent_evaluator"], mode: "candidate", max_agents: 2 }).topology as JsonObject;
    assert.equal((f.service.harnessTopologySelect({ task_id: f.task.id, baseline_topology_id: baseline.id }).topology as JsonObject).id, baseline.id);
    f.store.create("delivery_evaluation_run", "candidate-eval", { status: "inconclusive" }); assert.throws(() => f.service.harnessTopologyPromote({ topology_id: candidate.id, evaluation_run_id: "candidate-eval", evidence_ids: [f.confirmed.id] }), /eligible/);
    f.store.save("delivery_evaluation_run", "candidate-eval", { status: "eligible_for_signoff" }); assert.throws(() => f.service.harnessTopologyPromote({ topology_id: candidate.id, evaluation_run_id: "candidate-eval", evidence_ids: [f.bounded.id] }), /confirmed/);
    assert.equal((f.service.harnessTopologyPromote({ topology_id: candidate.id, evaluation_run_id: "candidate-eval", evidence_ids: [f.confirmed.id] }).topology as JsonObject).lifecycle, "routing_eligible"); assert.equal(f.service.harnessTopologyPromote({ topology_id: candidate.id, evaluation_run_id: "candidate-eval", evidence_ids: [f.confirmed.id] }).idempotent, true);
    const candidateTwo = f.service.harnessTopologyDefine({ topology_id: "evaluated-two", task_id: f.task.id, roles: ["primary", "diagnostic_research"], mode: "candidate" }).topology as JsonObject;
    f.service.harnessTopologyPromote({ topology_id: candidateTwo.id, evaluation_run_id: "candidate-eval", evidence_ids: [f.confirmed.id] });
    assert.equal((f.service.harnessTopologySelect({ task_id: f.task.id, baseline_topology_id: baseline.id, selection_id: "candidate-selection" }).topology as JsonObject).id, candidate.id);
    assert.throws(() => f.service.harnessTopologySuspend({ topology_id: baseline.id, reason: "no", evidence_ids: [f.confirmed.id] }), /Baseline/);
    f.service.harnessTopologySuspend({ topology_id: candidate.id, reason: "regression", evidence_ids: [f.confirmed.id] }); assert.equal(f.service.harnessTopologySuspend({ topology_id: candidate.id, reason: "regression", evidence_ids: [f.confirmed.id] }).idempotent, true); assert.equal((f.service.harnessTopologyGet({ topology_id: candidate.id }).topology as JsonObject).lifecycle, "suspended");
    const read = f.service.runtimeReadinessAssess({ assessment_id: "read", task_id: f.task.id, host: "codex", platform: "win32", effect: "read_only", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id] }).assessment as JsonObject; assert.equal(read.status, "ready");
    const blocked = f.service.runtimeReadinessAssess({ assessment_id: "write-blocked", task_id: f.task.id, host: "codex", platform: "win32", effect: "local_write", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id], workspace_recovery: false }).assessment as JsonObject; assert.equal(blocked.status, "blocked");
    const conformance = f.service.platformExecutionConformanceRecord({ conformance_id: "conformance", platform: "test", verifier: "test", checks: { network_denied: true, workspace_contained: true, credentials_absent: true, cancel_cleanup: true, resource_limits: true } }).conformance as JsonObject;
    f.service.platformExecutionProfileSave({ profile_id: "profile", platform: "test", isolation: "verified", network: "deny", verified_by: "test", conformance_id: conformance.id }); const preflight = f.service.platformExecutionPreflight({ preflight_id: "preflight", platform: "test", effect: "local_write", profile_id: "profile" }).preflight as JsonObject;
    const write = f.service.runtimeReadinessAssess({ assessment_id: "write", task_id: f.task.id, host: "codex", platform: "test", effect: "local_write", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id], workspace_recovery: true, preflight_id: preflight.id }); assert.equal((write.assessment as JsonObject).status, "ready"); assert.equal((f.service.runtimeReadinessGet({ assessment_id: "write" }).assessment as JsonObject).deployment_claimed, false);
    const externalBlocked = f.service.runtimeReadinessAssess({ assessment_id: "external-blocked", task_id: f.task.id, host: "codex", platform: "test", effect: "external_write", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id] }).assessment as JsonObject; assert.equal(externalBlocked.status, "blocked");
    f.store.create("enterprise_adapter_binding", "external-binding", { lifecycle: "active", allowed_effects: ["external_write", "destructive"] });
    const destructiveBlocked = f.service.runtimeReadinessAssess({ assessment_id: "destructive-blocked", task_id: f.task.id, host: "codex", platform: "test", effect: "destructive", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id], enterprise_binding_id: "external-binding" }).assessment as JsonObject; assert.equal(destructiveBlocked.status, "blocked");
    assert.equal((f.service.runtimeReadinessAssess({ assessment_id: "destructive-ready", task_id: f.task.id, host: "codex", platform: "test", effect: "destructive", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id], enterprise_binding_id: "external-binding", compensation_ref: "human-disposition" }).assessment as JsonObject).status, "ready");
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core"); assert.ok(full.tools.some((tool) => tool.name === "craft_federated_delegation_grant_issue")); assert.ok(full.tools.some((tool) => tool.name === "craft_harness_topology_define")); assert.equal(core.tools.some((tool) => tool.name === "craft_federated_delegation_grant_issue"), false); assert.ok(core.tools.some((tool) => tool.name === "craft_federated_delegation_get")); assert.equal(surfaceToolNames("collaboration").includes("craft_federated_delegation_get"), false);
    const topologyResult = await full.handlers.craft_harness_topology_get({ topology_id: baseline.id }); const readinessResult = await full.handlers.craft_runtime_readiness_get({ assessment_id: "write" });
    assert.equal(topologyResult.topology !== undefined, true); assert.equal(readinessResult.assessment !== undefined, true);
    assert.equal((await full.handlers.craft_harness_topology_define({ topology_id: baseline.id, task_id: f.task.id, roles: ["primary"], mode: "baseline" })).idempotent, true);
    assert.equal((await full.handlers.craft_harness_topology_promote({ topology_id: candidateTwo.id, evaluation_run_id: "candidate-eval", evidence_ids: [f.confirmed.id] })).idempotent, true);
    assert.equal((await full.handlers.craft_harness_topology_select({ task_id: f.task.id, baseline_topology_id: baseline.id, selection_id: "handler-selection" })).idempotent, false);
    assert.equal((await full.handlers.craft_harness_topology_suspend({ topology_id: candidate.id, reason: "regression", evidence_ids: [f.confirmed.id] })).idempotent, true);
    assert.equal((await full.handlers.craft_runtime_readiness_assess({ assessment_id: "read", task_id: f.task.id, host: "codex", platform: "win32", effect: "read_only", environment_digest: "sha256:env", evidence_ids: [f.confirmed.id] })).idempotent, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.18 fails closed at every newly introduced authorization and topology boundary", async () => {
  const f = await fixture();
  try {
    // Topology input, lifecycle, and selection conflict branches.
    assert.throws(() => f.service.harnessTopologyGet({ topology_id: "" }), /must not be empty/);
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "empty", task_id: f.task.id, roles: [], mode: "baseline" }), /at least one/);
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "duplicate", task_id: f.task.id, roles: ["primary", "primary"], mode: "baseline" }), /unique/);
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "mode", task_id: f.task.id, roles: ["primary"], mode: "unknown" }), /mode/);
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "wide", task_id: f.task.id, roles: ["primary", "diagnostic_research", "independent_evaluator", "remote_readonly"], mode: "candidate" }), /two design axes/);
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: "max", task_id: f.task.id, roles: ["primary"], mode: "baseline", max_agents: 0 }), /max_agents/);
    const baseline = f.service.harnessTopologyDefine({ topology_id: "coverage-baseline", task_id: f.task.id, roles: ["primary"], mode: "baseline" }).topology as JsonObject;
    const candidate = f.service.harnessTopologyDefine({ topology_id: "coverage-candidate", task_id: f.task.id, roles: ["primary", "diagnostic_research"], mode: "candidate" }).topology as JsonObject;
    assert.throws(() => f.service.harnessTopologyDefine({ topology_id: candidate.id, task_id: f.task.id, roles: ["primary", "diagnostic_research"], mode: "candidate", max_agents: 3 }), /idempotency/);
    assert.throws(() => f.service.harnessTopologyPromote({ topology_id: baseline.id, evaluation_run_id: "baseline", evidence_ids: [f.confirmed.id] }), /Only candidate/);
    replace(f, "harness_topology", candidate.id, { lifecycle: "suspended" });
    assert.throws(() => f.service.harnessTopologyPromote({ topology_id: candidate.id, evaluation_run_id: "baseline", evidence_ids: [f.confirmed.id] }), /not promotable/);
    assert.throws(() => f.service.harnessTopologySelect({ task_id: f.task.id, baseline_topology_id: candidate.id }), /baseline/);
    const selection = f.service.harnessTopologySelect({ task_id: f.task.id, baseline_topology_id: baseline.id, selection_id: "coverage-selection" });
    assert.equal(f.service.harnessTopologySelect({ task_id: f.task.id, baseline_topology_id: baseline.id, selection_id: "coverage-selection" }).idempotent, true);
    replace(f, "harness_topology", candidate.id, { lifecycle: "routing_eligible" });
    assert.throws(() => f.service.harnessTopologySelect({ task_id: f.task.id, baseline_topology_id: baseline.id, selection_id: (selection.selection as JsonObject).id }), /idempotency/);

    // Readiness validates malformed facts, failed preflight, invalid binding, and idempotency.
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: "", host: "host", platform: "test", effect: "read_only", environment_digest: "sha256:e", evidence_ids: [f.confirmed.id] }), /must not be empty/);
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "read_only", environment_digest: "sha256:e", evidence_ids: [] }), /at least one/);
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "read_only", environment_digest: "sha256:e", evidence_ids: [f.confirmed.id, f.confirmed.id] }), /unique/);
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "unsupported", environment_digest: "sha256:e", evidence_ids: [f.confirmed.id] }), /unsupported/);
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "read_only", environment_digest: "sha256:e", evidence_ids: [f.bounded.id] }), /confirmed/);
    const invalidPreflight = f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "local_write", environment_digest: "sha256:e", evidence_ids: [f.confirmed.id], workspace_recovery: true, preflight_id: "missing" }).assessment as JsonObject;
    assert.deepEqual(invalidPreflight.blockers, ["platform_preflight_invalid"]);
    f.store.create("enterprise_adapter_binding", "inactive-binding", { lifecycle: "inactive", allowed_effects: ["external_write"] });
    const invalidBinding = f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "external_write", environment_digest: "sha256:e", evidence_ids: [f.confirmed.id], enterprise_binding_id: "inactive-binding" }).assessment as JsonObject;
    assert.deepEqual(invalidBinding.blockers, ["enterprise_binding_invalid"]);
    const automatic = f.service.runtimeReadinessAssess({ task_id: f.task.id, host: "host", platform: "test", effect: "read_only", environment_digest: "sha256:auto", evidence_ids: [f.confirmed.id] });
    assert.equal(String((automatic.assessment as JsonObject).id).startsWith("runtime_readiness_"), true);
    assert.throws(() => f.service.runtimeReadinessAssess({ assessment_id: (automatic.assessment as JsonObject).id, task_id: f.task.id, host: "changed", platform: "test", effect: "read_only", environment_digest: "sha256:auto", evidence_ids: [f.confirmed.id] }), /idempotency/);
    assert.throws(() => f.service.runtimeReadinessGet({ assessment_id: "" }), /must not be empty/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.18 records every remote delegation failure as an explicit boundary", async () => {
  const f = await fixture();
  try {
    replace(f, "a2a_collaboration_session", f.session.id, { max_delegations: 50 });
    assert.throws(() => f.service.federatedDelegationGet({ grant_id: "" }), /must not be empty/);
    assert.throws(() => f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "unknown", evidence_ids: [f.confirmed.id], observed_by: "host" }), /unsupported/);
    assert.throws(() => f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [], observed_by: "host" }), /at least/);
    assert.throws(() => f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [f.confirmed.id, f.confirmed.id], observed_by: "host" }), /unique/);
    f.service.federatedAgentHealthRecord({ card_id: f.card.id, card_digest: f.card.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" });
    const trustId = String(f.session.trust_id);
    const badStatus = delegation(f, "bad-status"); replace(f, "a2a_delegation", badStatus.id, { status: "completed" });
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "bad-status", delegation_id: badStatus.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /prepared/);
    const inactiveSession = delegation(f, "inactive-session"); replace(f, "a2a_collaboration_session", f.session.id, { lifecycle: "closed" });
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "inactive-session", delegation_id: inactiveSession.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /session/);
    replace(f, "a2a_collaboration_session", f.session.id, { lifecycle: "active" });
    const staleTrust = delegation(f, "stale-trust"); replace(f, "a2a_agent_trust", trustId, { status: "revoked" });
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "stale-trust", delegation_id: staleTrust.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /trust/);
    replace(f, "a2a_agent_trust", trustId, { status: "active" });
    const missingLaunch = delegation(f, "missing-launch"); f.store.create("task_run", "missing-launch-run", { environment_digest: "sha256:environment", budget_digest: "sha256:budget" });
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "missing-launch", delegation_id: missingLaunch.id, parent_task_run_id: "missing-launch-run", parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /launch identity/);
    const item = delegation(f, "boundary-delegation");
    f.store.create("task_run", "foreign-run", { launch_identity: { task_id: "foreign" }, environment_digest: "sha256:environment", budget_digest: "sha256:budget" });
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: "foreign", delegation_id: item.id, parent_task_run_id: "foreign-run", parent_operation_ref: "parent", audience: "remote", issued_by: "host" }), /another task/);
    const issued = f.service.federatedDelegationGrantIssue({ grant_id: "boundary-grant", delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" });
    const grant = issued.grant as JsonObject; const artifactGrantIds = (issued.artifact_grants as JsonObject[]).map((entry) => String(entry.id));
    assert.throws(() => f.service.federatedDelegationGrantIssue({ grant_id: grant.id, delegation_id: item.id, parent_task_run_id: f.run.id, parent_operation_ref: "changed", audience: "remote", issued_by: "host" }), /idempotency/);
    assert.throws(() => f.service.federatedDelegationReconcile({ grant_id: grant.id, now: "invalid" }), /ISO/);
    f.service.federatedDelegationGrantConsume({ grant_id: grant.id, audience: "remote", consumer_ref: "adapter", now: "2030-01-01T00:00:01.000Z" });
    f.service.a2aDelegationDispatch({ delegation_id: item.id, transport_evidence_id: f.confirmed.id, dispatched_by: "adapter", now: "2030-01-01T00:00:02.000Z" });
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "invalid-state", grant_id: grant.id, state: "unknown", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:x", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds }), /unsupported/);
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "default-artifacts", grant_id: grant.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:x", evidence_ids: [f.confirmed.id] }), /Artifact/);
    f.service.federatedDelegationReceiptRecord({ receipt_id: "idempotent", grant_id: grant.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:x", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds });
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "idempotent", grant_id: grant.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:changed", evidence_ids: [f.confirmed.id], artifact_grant_ids: artifactGrantIds }), /idempotency/);

    const notConsumed = delegation(f, "not-consumed"); const pending = f.service.federatedDelegationGrantIssue({ grant_id: "pending", delegation_id: notConsumed.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    f.service.a2aDelegationDispatch({ delegation_id: notConsumed.id, transport_evidence_id: f.confirmed.id, dispatched_by: "adapter", now: "2030-01-01T00:00:02.000Z" });
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "pending", grant_id: pending.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:pending", evidence_ids: [f.confirmed.id], artifact_grant_ids: ["pending:artifact"] }), /consumed/);
    const notIssued = delegation(f, "not-issued"); const undispatched = f.service.federatedDelegationGrantIssue({ grant_id: "undispatched", delegation_id: notIssued.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    const undispatchedArtifacts = (f.service.federatedDelegationGet({ grant_id: undispatched.id }).artifact_grants as JsonObject[]).map((entry) => String(entry.id));
    f.service.federatedDelegationGrantConsume({ grant_id: undispatched.id, audience: "remote", consumer_ref: "adapter", now: "2030-01-01T00:00:01.000Z" });
    assert.throws(() => f.service.federatedDelegationReceiptRecord({ receipt_id: "undispatched", grant_id: undispatched.id, state: "accepted", environment_digest: f.run.environment_digest, effect: "read_only", result_digest: "sha256:undispatched", evidence_ids: [f.confirmed.id], artifact_grant_ids: undispatchedArtifacts }), /issued A2A/);

    const revocable = delegation(f, "artifact-revoked"); const revocableGrant = f.service.federatedDelegationGrantIssue({ grant_id: "artifact-revoked", delegation_id: revocable.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    replace(f, "federated_artifact_grant", `${revocableGrant.id}:${f.artifact.id}`, { status: "revoked" });
    assert.equal(((f.service.federatedDelegationRevoke({ grant_id: revocableGrant.id, reason: "operator", evidence_ids: [f.confirmed.id] }).artifact_grants as JsonObject[])[0]).status, "revoked");

    const expired = delegation(f, "existing-incident"); const expiredGrant = f.service.federatedDelegationGrantIssue({ grant_id: "existing-incident", delegation_id: expired.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    f.store.create("federated_remote_incident", `federated_remote_incident_${expiredGrant.id}`, { grant_id: expiredGrant.id, state: "indeterminate", required_next_action: "adapter_poll_or_human_review", raw_remote_content_stored: false });
    assert.equal((f.service.federatedDelegationReconcile({ grant_id: expiredGrant.id, now: "2030-01-01T00:02:00.000Z" }).incident as JsonObject).id, `federated_remote_incident_${expiredGrant.id}`);

    f.store.create("a2a_delegation", "empty-artifacts", { status: "prepared", session_id: f.session.id, delegation_digest: "sha256:empty", expires_at: "2030-01-01T00:01:00.000Z" });
    assert.equal((f.service.federatedDelegationGrantIssue({ grant_id: "empty-artifacts", delegation_id: "empty-artifacts", parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host", artifact_ids: [] }).artifact_grants as JsonObject[]).length, 0);
    f.store.create("artifact", "without-uri", { kind: "file", name: "without-uri" });
    f.store.create("a2a_delegation", "without-uri", { status: "prepared", session_id: f.session.id, delegation_digest: "sha256:without-uri", expires_at: "2030-01-01T00:01:00.000Z", artifact_ids: ["without-uri"] });
    assert.equal((f.service.federatedDelegationGrantIssue({ grant_id: "without-uri", delegation_id: "without-uri", parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).artifact_grants as JsonObject[]).length, 1);
    const drifting = delegation(f, "drifting-card"); const driftingGrant = f.service.federatedDelegationGrantIssue({ grant_id: "drifting-card", delegation_id: drifting.id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject;
    replace(f, "a2a_agent_card", f.card.id, { endpoint: "https://changed.example.test/a2a" });
    assert.throws(() => f.service.federatedDelegationGrantConsume({ grant_id: driftingGrant.id, audience: "remote", consumer_ref: "adapter" }), /drifted/);
    const currentCard = f.store.get("a2a_agent_card", String(f.card.id)); replace(f, "a2a_agent_trust", trustId, { card_version: currentCard.version, card_digest: currentCard.card_digest });
    f.service.federatedAgentHealthRecord({ card_id: currentCard.id, card_digest: currentCard.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" });
    replace(f, "a2a_agent_card", f.card.id, { skills: "not-an-array" }); const nonArrayCard = f.store.get("a2a_agent_card", String(f.card.id)); replace(f, "a2a_agent_trust", trustId, { card_version: nonArrayCard.version, card_digest: nonArrayCard.card_digest });
    f.service.federatedAgentHealthRecord({ card_id: nonArrayCard.id, card_digest: nonArrayCard.card_digest, status: "healthy", evidence_ids: [f.confirmed.id], observed_by: "host" });
    assert.equal(((f.service.federatedDelegationGrantIssue({ grant_id: "non-array-skills", delegation_id: delegation(f, "non-array-skills").id, parent_task_run_id: f.run.id, parent_operation_ref: "parent", audience: "remote", issued_by: "host" }).grant as JsonObject).capability_ids as string[]).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("runtime readiness exposes secret-free model status and bounded probes", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-runtime-probe-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const provider: ModelProviderSpec = { provider: "probe", label: "Probe", protocol: "openai-compatible", base_url: "https://model.example.test/v1", api_key_env: "PROBE_KEY", chat_path: "/chat/completions", models: { standard: "probe-model" }, cost_hint: 1, supports_tools: true };
    const frontier: ModelProviderSpec = { ...provider, provider: "frontier", models: { frontier: "frontier-model" }, api_key_env: "FRONTIER_KEY" };
    const small: ModelProviderSpec = { ...provider, provider: "small", models: { small: "small-model" }, api_key_env: "SMALL_KEY" };
    const emptyModel: ModelProviderSpec = { ...provider, provider: "empty", models: {}, api_key_env: "EMPTY_KEY" };
    const requests: string[] = [];
    const transport: ModelTransport = { complete: async (_spec, request) => { requests.push(request.url); return { text: "OK", model: "probe-model", usage: { input_tokens: 1, output_tokens: 1 } }; } };
    const kernel = new RuntimeModelProbeKernel(store, [provider], transport);
    assert.equal((kernel.status().providers as JsonObject[])[0]!.configured, false);
    const catalog = new RuntimeModelProbeKernel(store, [frontier, small, emptyModel]).status().providers as JsonObject[];
    assert.equal(catalog[0]!.model, "frontier-model"); assert.equal(catalog[1]!.model, "small-model"); assert.equal(catalog[2]!.model, null);
    const unavailable = await kernel.probe({ probe_id: "missing", provider: "probe" });
    assert.equal((unavailable.probe as JsonObject).status, "unavailable");
    process.env.PROBE_KEY = "test-only";
    const available = await kernel.probe({ probe_id: "configured", provider: "probe" });
    assert.equal((available.probe as JsonObject).status, "available");
    assert.equal(requests.length, 1);
    assert.equal((await kernel.probe({ probe_id: "configured", provider: "probe" })).idempotent, true);
    const refreshed = await kernel.probe({ probe_id: "configured", provider: "probe", refresh: true });
    assert.equal((refreshed.probe as JsonObject).status, "available");
    await assert.rejects(kernel.probe({ provider: "unknown" }), /declared/);
    await assert.rejects(kernel.probe({ provider: "" }), /must not be empty/);
    await assert.rejects(new RuntimeModelProbeKernel(store, [emptyModel], transport).probe({ provider: "empty" }), /usable model/);
    process.env.PROBE_KEY = "test-only";
    const defaultProbe = await kernel.probe({});
    assert.equal((defaultProbe.probe as JsonObject).provider, "probe");
    const noTransport = await new RuntimeModelProbeKernel(store, [provider], null).probe({ probe_id: "no-transport", provider: "probe" });
    assert.equal((noTransport.probe as JsonObject).reason, "probe_not_run");
    const failing = new RuntimeModelProbeKernel(store, [provider], { complete: async () => { throw new Error("upstream unavailable"); } });
    process.env.PROBE_KEY = "test-only";
    const failed = await failing.probe({ probe_id: "failed", provider: "probe" });
    assert.equal((failed.probe as JsonObject).status, "unavailable");
    assert.match(String((failed.probe as JsonObject).reason), /upstream unavailable/);
    const emptyResponse = new RuntimeModelProbeKernel(store, [provider], { complete: async () => ({ text: "", model: "probe-model", usage: null }) });
    const empty = await emptyResponse.probe({ probe_id: "empty-response", provider: "probe" });
    assert.equal((empty.probe as JsonObject).reason, "empty_model_response");
    const rawFailure = new RuntimeModelProbeKernel(store, [provider], { complete: async () => { throw "raw failure"; } });
    const raw = await rawFailure.probe({ probe_id: "raw-failure", provider: "probe" });
    assert.equal((raw.probe as JsonObject).reason, "model_probe_failed");
    delete process.env.PROBE_KEY;
    assert.deepEqual(new RuntimeModelProbeKernel(store, []).status(), { providers: [] });
  } finally { delete process.env.PROBE_KEY; store.close(); await rm(root, { recursive: true, force: true }); }
});
