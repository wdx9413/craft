import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v1158-"));
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  const task = service.taskOpen({ title: "Task", goal: "Verify boundaries" }).task as JsonObject;
  const confirmed = service.evidenceRecord({ evidence_id: "confirmed", source_type: "human", confidence: "confirmed", claim: "reviewed" }) as JsonObject;
  const bounded = service.evidenceRecord({ evidence_id: "bounded", source_type: "program", confidence: "bounded", claim: "bounded" }) as JsonObject;
  return { root, store, service, task, confirmed, bounded };
}

test("v0.11.59 schedules reviewed real-case evaluation without starting a Host", async () => {
  const f = await fixture();
  try {
    f.service.deliveryEvaluationCaseSave({ case_id: "development", name: "研发故障", domain: "software", partition: "development", acceptance_contract_ref: "test", sanitized: true });
    f.service.deliveryEvaluationCaseSave({ case_id: "held", name: "视频文件", domain: "video", partition: "held_out", acceptance_contract_ref: "review", sanitized: true, approved_by: "independent" });
    const input = { program_id: "program", name: "真实任务", owner_ref: "owner", reviewer_ref: "reviewer", domain_terms: ["software", "video"], development_case_ids: ["development"], held_out_case_ids: ["held"], cadence_hours: 1 };
    const saved = f.service.evaluationProgramSave(input); assert.equal((saved.program as JsonObject).last_planned_at, null); assert.equal(f.service.evaluationProgramSave(input).idempotent, true);
    assert.equal(f.service.evaluationProgramDue({ program_id: "program", now: "2030-01-01T00:00:00.000Z" }).due, true);
    const planned = f.service.evaluationProgramPlan({ program_id: "program", baseline_harness: "single", candidate_harness: "retrieval", acceptance_ref: "file-check", environment: { image: "stable" }, budget: { tokens: 10 }, planned_by: "operator", now: "2030-01-01T00:00:00.000Z", trials_per_case: 2 });
    assert.equal((planned.run as JsonObject).raw_business_content_stored, false); assert.equal(planned.campaign, null); assert.equal(planned.next_action, "prepare_development_trials_with_explicit_host");
    assert.equal(f.service.evaluationProgramDue({ program_id: "program", now: "2030-01-01T00:30:00.000Z" }).reason, "cadence_not_elapsed");
    assert.throws(() => f.service.evaluationProgramPlan({ program_id: "program", baseline_harness: "single", candidate_harness: "retrieval", acceptance_ref: "file-check", environment: {}, budget: {}, planned_by: "operator", now: "2030-01-01T00:30:00.000Z" }), /not due/);
    assert.throws(() => f.service.evaluationProgramPlan({ program_id: "program", baseline_harness: "same", candidate_harness: "same", acceptance_ref: "file-check", environment: {}, budget: {}, planned_by: "operator", now: "2030-01-01T02:00:00.000Z" }), /distinct/);
    assert.throws(() => f.service.evaluationProgramPlan({ program_id: "program", baseline_harness: "single", candidate_harness: "retrieval", acceptance_ref: "file-check", environment: {}, budget: {}, planned_by: "operator", partition: "held_out", independent_approval_ref: "owner", now: "2030-01-01T02:00:00.000Z" }), /independent/);
    const held = f.service.evaluationProgramPlan({ program_id: "program", baseline_harness: "single", candidate_harness: "retrieval", acceptance_ref: "review", environment: { image: "stable" }, budget: { tokens: 10 }, planned_by: "operator", partition: "held_out", independent_approval_ref: "approval", now: "2030-01-01T02:00:00.000Z" }); assert.equal(((held.campaign as JsonObject).case_ids as string[])[0], "held");
    const report = f.service.evaluationProgramReport({ program_id: "program" }); assert.equal((report.runs as JsonObject[]).length, 2);
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core");
    assert.ok(full.tools.some((item) => item.name === "craft_evaluation_program_plan")); assert.ok(core.tools.some((item) => item.name === "craft_evaluation_program_report")); assert.equal(core.tools.some((item) => item.name === "craft_evaluation_program_plan"), false);
    assert.equal((await full.handlers.craft_evaluation_program_save(input)).idempotent, true);
    assert.equal((await full.handlers.craft_evaluation_program_due({ program_id: "program", now: "2030-01-01T02:00:00.000Z" })).due, false);
    assert.equal(((await full.handlers.craft_evaluation_program_report({ program_id: "program" })).campaigns as JsonObject[]).length, 1);
    f.store.save("evaluation_program", "program", { ...(f.store.get("evaluation_program", "program")), last_planned_at: null });
    assert.equal((await full.handlers.craft_evaluation_program_plan({ program_id: "program", program_run_id: (planned.run as JsonObject).id, baseline_harness: "single", candidate_harness: "retrieval", acceptance_ref: "file-check", environment: { image: "stable" }, budget: { tokens: 10 }, planned_by: "operator", now: "2030-01-01T03:00:00.000Z", trials_per_case: 2 })).idempotent, true);
    assert.throws(() => f.service.evaluationProgramSave({ ...input, program_id: "bad", development_case_ids: ["held"], held_out_case_ids: ["held"] }), /overlap|sanitized development/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.59 requires verified enterprise identity, a short lease, and exact adapter boundaries", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.enterpriseIdentityProviderRegister({ provider_id: "bad", kind: "oidc_workload_identity", issuer: "http://issuer", audience: "craft", broker_ref: "broker", organization_ref: "org" }), /HTTPS/);
    const provider = f.service.enterpriseIdentityProviderRegister({ provider_id: "idp", kind: "oidc_workload_identity", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "oidc-broker", organization_ref: "org" }).provider as JsonObject;
    assert.equal(f.service.enterpriseIdentityProviderRegister({ provider_id: "idp", kind: "oidc_workload_identity", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "oidc-broker", organization_ref: "org" }).idempotent, true);
    assert.throws(() => f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials"], verified_by: "security" }), /at least|missing/);
    const verified = f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security", max_ttl_seconds: 600 }).provider as JsonObject;
    assert.equal(verified.lifecycle, "verified"); assert.equal(f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: [], verified_by: "security" }).idempotent, true);
    assert.throws(() => f.service.enterprisePrincipalBind({ principal_id: "bad", provider_id: provider.id, task_id: f.task.id, subject_digest: "person", roles: ["operator"] }), /SHA/);
    const principal = f.service.enterprisePrincipalBind({ principal_id: "principal", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"], now: "2030-01-01T00:00:00.000Z" }).principal as JsonObject;
    f.store.create("capability_asset", "asset", { trust: "verified", health: "healthy", effect: "read_only" }); f.store.create("contract_publication", "publication", { status: "active", asset_id: "asset", asset_version: 1 });
    assert.throws(() => f.service.enterpriseAdapterBind({ binding_id: "bad-binding", provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["external_write"], target_host: "api.example.test" }), /widen/);
    const binding = f.service.enterpriseAdapterBind({ binding_id: "binding", provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["read_only"], target_host: "api.example.test" }).binding as JsonObject;
    const handle = f.service.credentialHandleRegister({ handle_id: "handle", provider: "idp", secret_ref: "env:CRAFT_TEST_TOKEN" }).handle as JsonObject;
    const lease = f.service.credentialLeaseIssue({ lease_id: "lease", task_id: f.task.id, handle_id: handle.id, allowed_hosts: ["api.example.test"], allowed_actions: ["read"], now: "2030-01-01T00:00:00.000Z" }).lease as JsonObject;
    const ticket = f.service.enterpriseAccessTicketIssue({ ticket_id: "ticket", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "read_only", request_digest: `sha256:${"b".repeat(64)}`, now: "2030-01-01T00:00:00.000Z" }).ticket as JsonObject;
    assert.equal(ticket.status, "issued"); assert.equal(JSON.stringify(ticket).includes("CRAFT_TEST_TOKEN"), false);
    assert.throws(() => f.service.enterpriseAccessTicketConsume({ ticket_id: ticket.id, request_digest: "wrong", consumer_ref: "broker", now: "2030-01-01T00:00:01.000Z" }), /mismatch/);
    assert.equal((f.service.enterpriseAccessTicketConsume({ ticket_id: ticket.id, request_digest: ticket.request_digest, consumer_ref: "broker", now: "2030-01-01T00:00:01.000Z" }).ticket as JsonObject).status, "consumed");
    assert.equal(f.service.enterpriseAccessTicketConsume({ ticket_id: ticket.id, request_digest: ticket.request_digest, consumer_ref: "broker" }).idempotent, true);
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core"); assert.ok(full.tools.some((item) => item.name === "craft_enterprise_access_ticket_issue")); assert.ok(core.tools.some((item) => item.name === "craft_enterprise_access_ticket_get"));
    assert.equal((await full.handlers.craft_enterprise_identity_provider_register({ provider_id: "idp", kind: "oidc_workload_identity", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "oidc-broker", organization_ref: "org" })).idempotent, true);
    assert.equal((await full.handlers.craft_enterprise_identity_provider_verify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: [], verified_by: "security" })).idempotent, true);
    assert.equal((await full.handlers.craft_enterprise_principal_bind({ principal_id: principal.id, provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"] })).idempotent, true);
    assert.equal((await full.handlers.craft_enterprise_adapter_bind({ binding_id: binding.id, provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["read_only"], target_host: "api.example.test" })).idempotent, true);
    assert.equal((await full.handlers.craft_enterprise_access_ticket_issue({ ticket_id: ticket.id, binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "read_only", request_digest: ticket.request_digest, now: "2030-01-01T00:00:00.000Z" })).idempotent, true);
    assert.equal((await full.handlers.craft_enterprise_access_ticket_consume({ ticket_id: ticket.id, request_digest: ticket.request_digest, consumer_ref: "broker" })).idempotent, true);
    assert.equal(((await full.handlers.craft_enterprise_access_ticket_get({ ticket_id: ticket.id })).ticket as JsonObject).id, ticket.id);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.59 governs A2A delegation with a proven baseline and no raw remote context", async () => {
  const f = await fixture();
  try {
    const provider = f.service.enterpriseIdentityProviderRegister({ provider_id: "idp", kind: "short_lived_broker", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" }).provider as JsonObject;
    f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security" });
    f.store.create("a2a_agent_card", "card", { card_digest: "sha256:card", name: "Remote", endpoint: "https://remote.example.test/a2a" }); f.store.create("delivery_evaluation_run", "baseline", { status: "eligible_for_signoff" });
    assert.throws(() => f.service.a2aAgentTrustApprove({ trust_id: "bad", card_id: "card", provider_id: provider.id, allowed_effects: ["external_write"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }), /read-only/);
    const trust = f.service.a2aAgentTrustApprove({ trust_id: "trust", card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }).trust as JsonObject;
    assert.equal(f.service.a2aAgentTrustApprove({ trust_id: "trust", card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }).idempotent, true);
    assert.throws(() => f.service.a2aCollaborationSessionCreate({ session_id: "bad", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.bounded.id, budget: {} }), /confirmed/);
    const session = f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: { tokens: 10 }, max_delegations: 1 }).session as JsonObject;
    const artifact = f.service.artifactRegister({ artifact_id: "artifact", kind: "file", name: "proof", uri: "file:///proof", producer_type: "test", producer_id: "test" }) as JsonObject;
    const delegation = f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "research", artifact_ids: [artifact.id], evidence_ids: [f.confirmed.id], now: "2030-01-01T00:00:00.000Z" }).delegation as JsonObject;
    assert.equal(delegation.effect, "read_only"); assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: "another", session_id: session.id, objective: "research", evidence_ids: [f.confirmed.id] }), /limit/);
    assert.throws(() => f.service.a2aDelegationDispatch({ delegation_id: delegation.id, transport_evidence_id: f.bounded.id, dispatched_by: "adapter" }), /confirmed/);
    const issued = f.service.a2aDelegationDispatch({ delegation_id: delegation.id, transport_evidence_id: f.confirmed.id, dispatched_by: "adapter", now: "2030-01-01T00:01:00.000Z" }); assert.equal((issued.envelope as JsonObject).raw_context_included, false);
    assert.throws(() => f.service.a2aDelegationReport({ delegation_id: delegation.id, receipt_id: "bad", verdict: "passed", evidence_ids: [f.confirmed.id], result: { token: "secret" } }), /credential/);
    const reported = f.service.a2aDelegationReport({ delegation_id: delegation.id, receipt_id: "receipt", verdict: "passed", evidence_ids: [f.confirmed.id], result: { conclusion: "digest-only" } }); assert.equal((reported.receipt as JsonObject).raw_result_stored, false);
    assert.equal(f.service.a2aDelegationReport({ delegation_id: delegation.id, receipt_id: "receipt", verdict: "failed", evidence_ids: [f.confirmed.id], result: {} }).idempotent, true);
    assert.throws(() => f.service.a2aDelegationReport({ delegation_id: delegation.id, receipt_id: "other", verdict: "failed", evidence_ids: [f.confirmed.id], result: {} }), /does not match/);
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core"); assert.ok(full.tools.some((item) => item.name === "craft_a2a_delegation_dispatch")); assert.ok(core.tools.some((item) => item.name === "craft_a2a_delegation_get"));
    assert.equal((await full.handlers.craft_a2a_agent_trust_approve({ trust_id: trust.id, card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" })).idempotent, true);
    assert.equal((await full.handlers.craft_a2a_collaboration_session_create({ session_id: session.id, task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: { tokens: 10 }, max_delegations: 1 })).idempotent, true);
    assert.equal((await full.handlers.craft_a2a_delegation_prepare({ delegation_id: delegation.id, session_id: session.id, objective: "research", artifact_ids: [artifact.id], evidence_ids: [f.confirmed.id], now: "2030-01-01T00:00:00.000Z" })).idempotent, true);
    assert.equal((await full.handlers.craft_a2a_delegation_dispatch({ delegation_id: delegation.id, transport_evidence_id: f.confirmed.id, dispatched_by: "adapter" })).idempotent, true);
    assert.equal((await full.handlers.craft_a2a_delegation_report({ delegation_id: delegation.id, receipt_id: "receipt", verdict: "passed", evidence_ids: [f.confirmed.id], result: { conclusion: "digest-only" } })).idempotent, true);
    assert.equal(((await full.handlers.craft_a2a_delegation_get({ delegation_id: delegation.id })).receipt as JsonObject).id, "receipt");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.59 keeps operational, enterprise, and remote-collaboration rejection paths explicit", async () => {
  const f = await fixture();
  try {
    f.service.deliveryEvaluationCaseSave({ case_id: "development", name: "dev", domain: "software", partition: "development", acceptance_contract_ref: "test", sanitized: true });
    f.service.deliveryEvaluationCaseSave({ case_id: "held", name: "held", domain: "software", partition: "held_out", acceptance_contract_ref: "test", sanitized: true, approved_by: "reviewer" });
    const programInput = { program_id: "program", name: "program", owner_ref: "owner", reviewer_ref: "reviewer", development_case_ids: ["development"], held_out_case_ids: ["held"], lifecycle: "paused" };
    f.service.evaluationProgramSave(programInput); assert.equal(f.service.evaluationProgramDue({ program_id: "program" }).reason, "program_paused");
    assert.throws(() => f.service.evaluationProgramSave({ ...programInput, program_id: "bad-life", lifecycle: "broken" }), /lifecycle/);
    assert.throws(() => f.service.evaluationProgramSave({ ...programInput, program_id: "bad-cases", development_case_ids: ["held"], held_out_case_ids: ["development"] }), /sanitized/);
    f.store.save("evaluation_program", "program", { ...(f.store.get("evaluation_program", "program")), lifecycle: "active", last_planned_at: null });
    const planInput = { program_id: "program", program_run_id: "run", baseline_harness: "base", candidate_harness: "candidate", acceptance_ref: "accept", environment: {}, budget: {}, planned_by: "operator", now: "2030-01-01T00:00:00.000Z" };
    f.service.evaluationProgramPlan(planInput); f.store.save("evaluation_program", "program", { ...(f.store.get("evaluation_program", "program")), last_planned_at: null });
    assert.equal(f.service.evaluationProgramPlan(planInput).idempotent, true);
    f.store.create("evaluation_program_run", "collision", { run_digest: "wrong" }); f.store.save("evaluation_program", "program", { ...(f.store.get("evaluation_program", "program")), last_planned_at: null });
    assert.throws(() => f.service.evaluationProgramPlan({ ...planInput, program_run_id: "collision" }), /conflict/);
    assert.throws(() => f.service.evaluationProgramPlan({ ...planInput, partition: "unknown" }), /partition/);

    const provider = f.service.enterpriseIdentityProviderRegister({ provider_id: "provider", kind: "short_lived_broker", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" }).provider as JsonObject;
    assert.throws(() => f.service.enterpriseIdentityProviderRegister({ provider_id: "provider-kind", kind: "static", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" }), /kind/);
    assert.throws(() => f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.bounded.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security" }), /confirmed/);
    f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security" });
    assert.throws(() => f.service.enterpriseIdentityProviderRegister({ provider_id: provider.id, kind: "short_lived_broker", issuer: "https://other.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" }), /conflict/);
    const principal = f.service.enterprisePrincipalBind({ principal_id: "principal", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"] }).principal as JsonObject;
    assert.equal(f.service.enterprisePrincipalBind({ principal_id: "principal", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"] }).idempotent, true);
    f.store.create("capability_asset", "asset", { trust: "verified", health: "healthy", effect: "external_write" }); f.store.create("contract_publication", "publication", { status: "active", asset_id: "asset", asset_version: 1 });
    const binding = f.service.enterpriseAdapterBind({ binding_id: "binding", provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["external_write"], target_host: "api.example.test" }).binding as JsonObject;
    assert.equal(f.service.enterpriseAdapterBind({ binding_id: "binding", provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["external_write"], target_host: "api.example.test" }).idempotent, true);
    const handle = f.service.credentialHandleRegister({ handle_id: "handle", provider: "provider", secret_ref: "env:CRAFT_TEST_TOKEN" }).handle as JsonObject;
    const lease = f.service.credentialLeaseIssue({ lease_id: "lease", task_id: f.task.id, handle_id: handle.id, allowed_hosts: ["api.example.test"], allowed_actions: ["write"] }).lease as JsonObject;
    const requestDigest = `sha256:${"b".repeat(64)}`;
    assert.throws(() => f.service.enterpriseAccessTicketIssue({ ticket_id: "write", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "external_write", request_digest: requestDigest }), /approval/);
    f.store.create("autonomy_consumption", "wrong-consumption", { task_id: f.task.id, action: "read" });
    assert.throws(() => f.service.enterpriseAccessTicketIssue({ ticket_id: "write", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "external_write", request_digest: requestDigest, approval_ref: "approval", autonomy_consumption_id: "wrong-consumption" }), /not valid/);
    f.store.create("autonomy_consumption", "consumption", { task_id: f.task.id, action: "external_write" });
    const write = f.service.enterpriseAccessTicketIssue({ ticket_id: "write", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "external_write", request_digest: requestDigest, approval_ref: "approval", autonomy_consumption_id: "consumption" }).ticket as JsonObject;
    assert.equal(f.service.enterpriseAccessTicketIssue({ ticket_id: "write", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "external_write", request_digest: requestDigest, approval_ref: "approval", autonomy_consumption_id: "consumption" }).idempotent, true);
    assert.throws(() => f.service.enterpriseAccessTicketIssue({ ticket_id: "write", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "external_write", request_digest: `sha256:${"c".repeat(64)}`, approval_ref: "approval", autonomy_consumption_id: "consumption" }), /conflict/);
    assert.throws(() => f.service.enterpriseAccessTicketConsume({ ticket_id: write.id, request_digest: requestDigest, consumer_ref: "broker", now: "2100-01-01T00:00:00.000Z" }), /expired/);

    f.store.create("a2a_agent_card", "card", { card_digest: "sha256:card" }); f.store.create("delivery_evaluation_run", "baseline", { status: "inconclusive" }); f.store.save("enterprise_identity_provider", String(provider.id), { ...(f.store.get("enterprise_identity_provider", String(provider.id))), lifecycle: "declared" });
    assert.throws(() => f.service.a2aAgentTrustApprove({ trust_id: "trust", card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }), /verified/);
    f.store.save("enterprise_identity_provider", String(provider.id), { ...(f.store.get("enterprise_identity_provider", String(provider.id))), lifecycle: "verified" });
    const trust = f.service.a2aAgentTrustApprove({ trust_id: "trust", card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }).trust as JsonObject;
    assert.throws(() => f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: {} }), /baseline/);
    f.store.save("delivery_evaluation_run", "baseline", { status: "eligible_for_signoff" }); const session = f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: {} }).session as JsonObject;
    assert.equal(f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: {} }).idempotent, true);
    const delegation = f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "read", evidence_ids: [f.confirmed.id] }).delegation as JsonObject;
    assert.equal(f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "read", evidence_ids: [f.confirmed.id] }).idempotent, true);
    assert.throws(() => f.service.a2aDelegationDispatch({ delegation_id: delegation.id, transport_evidence_id: f.confirmed.id, dispatched_by: "adapter", now: "2100-01-01T00:00:00.000Z" }), /expired/);
    assert.throws(() => f.service.a2aDelegationReport({ delegation_id: delegation.id, receipt_id: "receipt", verdict: "unknown", evidence_ids: [f.confirmed.id], result: {} }), /verdict/);
    assert.throws(() => f.service.a2aDelegationReport({ delegation_id: delegation.id, receipt_id: "receipt", verdict: "passed", evidence_ids: [f.confirmed.id], result: {} }), /not been issued/);
    assert.equal(f.service.a2aDelegationGet({ delegation_id: delegation.id }).receipt, null);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.59 evaluation programs reject malformed, conflicting, and unapproved planning inputs", async () => {
  const f = await fixture();
  try {
    f.service.deliveryEvaluationCaseSave({ case_id: "development", name: "dev", domain: "software", partition: "development", acceptance_contract_ref: "test", sanitized: true });
    f.service.deliveryEvaluationCaseSave({ case_id: "held", name: "held", domain: "software", partition: "held_out", acceptance_contract_ref: "test", sanitized: true, approved_by: "reviewer" });
    f.store.create("delivery_evaluation_case", "unapproved", { name: "unapproved", domain: "software", partition: "held_out", acceptance_contract_ref: "test", sanitized: true, approved_by: null });
    const input = { program_id: "program", name: "program", owner_ref: "owner", reviewer_ref: "reviewer", development_case_ids: ["development"], held_out_case_ids: ["held"] };
    assert.throws(() => f.service.evaluationProgramSave({ ...input, name: "" }), /name/);
    assert.throws(() => f.service.evaluationProgramSave({ ...input, development_case_ids: [] }), /at least/);
    assert.throws(() => f.service.evaluationProgramSave({ ...input, development_case_ids: ["development", "development"] }), /unique/);
    assert.throws(() => f.service.evaluationProgramSave({ ...input, cadence_hours: 0 }), /integer/);
    f.service.evaluationProgramSave(input);
    assert.throws(() => f.service.evaluationProgramSave({ ...input, name: "changed" }), /conflict/);
    assert.throws(() => f.service.evaluationProgramSave({ ...input, program_id: "unapproved", held_out_case_ids: ["unapproved"] }), /independent approval/);
    assert.throws(() => f.service.evaluationProgramDue({ program_id: "program", now: "not-time" }), /ISO/);
    assert.throws(() => f.service.evaluationProgramPlan({ program_id: "program", baseline_harness: "base", candidate_harness: "candidate", acceptance_ref: "check", environment: [], budget: {}, planned_by: "operator" }), /object/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.59 enterprise contracts reject every inactive, widened, or stale boundary", async () => {
  const f = await fixture();
  try {
    const args = { provider_id: "provider", kind: "short_lived_broker", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" };
    assert.throws(() => f.service.enterpriseIdentityProviderRegister({ ...args, provider_id: "credentials", issuer: "https://user:pass@issuer.example.test" }), /without credentials/);
    const provider = f.service.enterpriseIdentityProviderRegister(args).provider as JsonObject;
    assert.throws(() => f.service.enterpriseIdentityProviderRegister({ ...args, provider_id: "empty-kind", kind: "" }), /kind/);
    assert.throws(() => f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "other"], verified_by: "security" }), /missing/);
    f.store.save("enterprise_identity_provider", String(provider.id), { ...(f.store.get("enterprise_identity_provider", String(provider.id))), lifecycle: "blocked" });
    assert.throws(() => f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: [], verified_by: "security" }), /current lifecycle/);
    f.store.save("enterprise_identity_provider", String(provider.id), { ...(f.store.get("enterprise_identity_provider", String(provider.id))), lifecycle: "declared" });
    f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security", max_ttl_seconds: 600 });
    assert.throws(() => f.service.enterprisePrincipalBind({ principal_id: "duplicate-role", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator", "operator"] }), /unique/);
    f.store.save("enterprise_identity_provider", String(provider.id), { ...(f.store.get("enterprise_identity_provider", String(provider.id))), lifecycle: "declared" });
    assert.throws(() => f.service.enterprisePrincipalBind({ principal_id: "declared-provider", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"] }), /not verified/);
    f.store.save("enterprise_identity_provider", String(provider.id), { ...(f.store.get("enterprise_identity_provider", String(provider.id))), lifecycle: "verified" });
    assert.throws(() => f.service.enterprisePrincipalBind({ principal_id: "principal", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"], ttl_seconds: 0 }), /integer/);
    const principal = f.service.enterprisePrincipalBind({ principal_id: "principal", provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["operator"] }).principal as JsonObject;
    assert.throws(() => f.service.enterprisePrincipalBind({ principal_id: principal.id, provider_id: provider.id, task_id: f.task.id, subject_digest: `sha256:${"a".repeat(64)}`, roles: ["other"] }), /conflict/);
    f.store.create("capability_asset", "unhealthy", { trust: "candidate", health: "unhealthy", effect: "read_only" }); f.store.create("contract_publication", "inactive", { status: "draft", asset_id: "unhealthy", asset_version: 1 });
    assert.throws(() => f.service.enterpriseAdapterBind({ binding_id: "inactive", provider_id: provider.id, contract_publication_id: "inactive", allowed_effects: ["read_only"], target_host: "api.example.test" }), /active Contract/);
    f.store.create("contract_publication", "unhealthy", { status: "active", asset_id: "unhealthy", asset_version: 1 });
    assert.throws(() => f.service.enterpriseAdapterBind({ binding_id: "unhealthy", provider_id: provider.id, contract_publication_id: "unhealthy", allowed_effects: ["read_only"], target_host: "api.example.test" }), /healthy/);
    f.store.create("capability_asset", "asset", { trust: "verified", health: "healthy", effect: "external_write" }); f.store.create("contract_publication", "publication", { status: "active", asset_id: "asset", asset_version: 1 });
    assert.throws(() => f.service.enterpriseAdapterBind({ binding_id: "effect", provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["not-an-effect"], target_host: "api.example.test" }), /unsupported/);
    const binding = f.service.enterpriseAdapterBind({ binding_id: "binding", provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["external_write"], target_host: "api.example.test" }).binding as JsonObject;
    assert.throws(() => f.service.enterpriseAdapterBind({ binding_id: binding.id, provider_id: provider.id, contract_publication_id: "publication", allowed_effects: ["external_write"], target_host: "other.example.test" }), /conflict/);
    const handle = f.service.credentialHandleRegister({ handle_id: "handle", provider: "provider", secret_ref: "env:CRAFT_TEST_TOKEN" }).handle as JsonObject;
    const lease = f.service.credentialLeaseIssue({ lease_id: "lease", task_id: f.task.id, handle_id: handle.id, allowed_hosts: ["api.example.test"], allowed_actions: ["write"] }).lease as JsonObject;
    const ticketArgs = { ticket_id: "ticket", binding_id: binding.id, principal_id: principal.id, task_id: f.task.id, credential_lease_id: lease.id, effect: "external_write", request_digest: `sha256:${"b".repeat(64)}`, approval_ref: "approval", autonomy_consumption_id: "consumption" };
    assert.throws(() => f.service.enterpriseAccessTicketIssue({ ...ticketArgs, effect: "read_only" }), /not allowed/);
    f.store.save("enterprise_adapter_binding", String(binding.id), { ...(f.store.get("enterprise_adapter_binding", String(binding.id))), lifecycle: "revoked" });
    assert.throws(() => f.service.enterpriseAccessTicketIssue(ticketArgs), /not active/);
    f.store.save("enterprise_adapter_binding", String(binding.id), { ...(f.store.get("enterprise_adapter_binding", String(binding.id))), lifecycle: "active" }); f.store.save("enterprise_principal", String(principal.id), { ...(f.store.get("enterprise_principal", String(principal.id))), status: "revoked" });
    assert.throws(() => f.service.enterpriseAccessTicketIssue(ticketArgs), /inactive/);
    f.store.save("enterprise_principal", String(principal.id), { ...(f.store.get("enterprise_principal", String(principal.id))), status: "active" }); f.store.save("credential_lease", String(lease.id), { ...(f.store.get("credential_lease", String(lease.id))), status: "revoked" });
    assert.throws(() => f.service.enterpriseAccessTicketIssue(ticketArgs), /short-lived credential lease/);
    f.store.save("credential_lease", String(lease.id), { ...(f.store.get("credential_lease", String(lease.id))), status: "active" }); f.store.create("autonomy_consumption", "consumption", { task_id: f.task.id, action: "external_write" });
    assert.throws(() => f.service.enterpriseAccessTicketIssue({ ...ticketArgs, now: "not-time" }), /ISO/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.11.59 A2A controls reject inactive sessions and conflicting delegation identities", async () => {
  const f = await fixture();
  try {
    const provider = f.service.enterpriseIdentityProviderRegister({ provider_id: "provider", kind: "short_lived_broker", issuer: "https://issuer.example.test", audience: "craft", broker_ref: "broker", organization_ref: "org" }).provider as JsonObject;
    f.service.enterpriseIdentityProviderVerify({ provider_id: provider.id, evidence_ids: [f.confirmed.id], observed_claims: ["short_lived_credentials", "token_exchange", "audit_subject", "revocation"], verified_by: "security" });
    f.store.create("a2a_agent_card", "card", { card_digest: "sha256:card" }); f.store.create("delivery_evaluation_run", "baseline", { status: "eligible_for_signoff" });
    assert.throws(() => f.service.a2aAgentTrustApprove({ trust_id: "trust", card_id: "card", provider_id: provider.id, allowed_effects: ["read_only", "read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }), /unique/);
    const trust = f.service.a2aAgentTrustApprove({ trust_id: "trust", card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "approval" }).trust as JsonObject;
    f.store.save("a2a_agent_card", "card", { ...(f.store.get("a2a_agent_card", "card")), card_digest: "sha256:changed" });
    assert.throws(() => f.service.a2aAgentTrustApprove({ trust_id: trust.id, card_id: "card", provider_id: provider.id, allowed_effects: ["read_only"], evidence_ids: [f.confirmed.id], approval_ref: "other" }), /conflict/);
    f.store.save("a2a_agent_trust", String(trust.id), { ...(f.store.get("a2a_agent_trust", String(trust.id))), status: "revoked" });
    assert.throws(() => f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: {} }), /not active/);
    f.store.save("a2a_agent_trust", String(trust.id), { ...(f.store.get("a2a_agent_trust", String(trust.id))), status: "active" });
    assert.throws(() => f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: [] }), /object/);
    const session = f.service.a2aCollaborationSessionCreate({ session_id: "session", task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: {} }).session as JsonObject;
    assert.throws(() => f.service.a2aCollaborationSessionCreate({ session_id: session.id, task_id: f.task.id, trust_id: trust.id, evaluation_run_id: "baseline", justification_evidence_id: f.confirmed.id, budget: { changed: true } }), /conflict/);
    f.store.save("a2a_collaboration_session", String(session.id), { ...(f.store.get("a2a_collaboration_session", String(session.id))), lifecycle: "closed" });
    assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "read", evidence_ids: [f.confirmed.id] }), /not active/);
    f.store.save("a2a_collaboration_session", String(session.id), { ...(f.store.get("a2a_collaboration_session", String(session.id))), lifecycle: "active" });
    assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "", evidence_ids: [f.confirmed.id] }), /objective/);
    assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "read", evidence_ids: [], ttl_seconds: 0, now: "not-time" }), /at least/);
    const delegation = f.service.a2aDelegationPrepare({ delegation_id: "delegation", session_id: session.id, objective: "read", evidence_ids: [f.confirmed.id], now: "2030-01-01T00:00:00.000Z" }).delegation as JsonObject;
    assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: delegation.id, session_id: session.id, objective: "changed", evidence_ids: [f.confirmed.id], now: "2030-01-01T00:00:00.000Z" }), /conflict/);
    assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: "other", session_id: session.id, objective: "read", evidence_ids: [f.confirmed.id], ttl_seconds: 0 }), /integer/);
    assert.throws(() => f.service.a2aDelegationPrepare({ delegation_id: "other", session_id: session.id, objective: "read", evidence_ids: [f.confirmed.id], now: "not-time" }), /ISO/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
