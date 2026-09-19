import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createOidcJwksVerifier } from "../src/oidc-jwks.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

const d = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-v01230-")); const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  store.create("task", "task", { title: "runtime proof" }); store.create("evidence", "evidence", { confidence: "confirmed" });
  return { root, store, service };
}

test("v0.12.33 binds remote task operations to one tenant, principal, receipt, scope and opaque one-time handle", async () => {
  const f = await fixture();
  try {
    const tenant = f.service.remoteTenantRegister({ tenant_id: "tenant", data_space_id: "space", key_envelope_ref: "kms:key", retention_policy_ref: "retention:v1", deletion_policy_ref: "delete:v1" }).tenant as JsonObject;
    assert.equal(f.service.remoteTenantRegister({ tenant_id: "tenant", data_space_id: "space", key_envelope_ref: "kms:key", retention_policy_ref: "retention:v1", deletion_policy_ref: "delete:v1" }).idempotent, true);
    const bindingArgs = { binding_id: "binding", task_id: "task", tenant_id: tenant.id, principal_digest: d("a"), access_receipt_digest: d("b"), audience: "craft", scopes: ["craft.read"], now: "2030-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:05:00.000Z" };
    const created = f.service.remoteTaskBind(bindingArgs);
    const handle = String(created.handle); assert.match(handle, /^[A-Za-z0-9_-]+$/); assert.equal(JSON.stringify(created.binding).includes(handle), false);
    assert.equal(f.service.remoteTaskBind(bindingArgs).idempotent, true); assert.equal((f.service.remoteTaskGet({ binding_id: "binding" }).receipts as JsonObject[]).length, 0);
    const auth = { binding_id: "binding", handle, tenant_id: "tenant", principal_digest: d("a"), access_receipt_digest: d("b"), audience: "craft", scopes: ["craft.read", "other"], operation: "get", now: "2030-01-01T00:01:00.000Z" };
    assert.equal((f.service.remoteTaskAuthorize({ ...auth, receipt_id: "access" }).receipt as JsonObject).operation, "get");
    assert.equal(f.service.remoteTaskAuthorize({ ...auth, receipt_id: "access" }).idempotent, true);
    assert.equal((f.service.remoteTaskGet({ binding_id: "binding" }).receipts as JsonObject[]).length, 1);
    for (const bad of [{ ...auth, handle: "wrong" }, { ...auth, tenant_id: "other" }, { ...auth, scopes: ["other"] }, { ...auth, operation: "write" }, { ...auth, now: "2030-01-01T00:06:00.000Z" }]) assert.throws(() => f.service.remoteTaskAuthorize(bad), /handle|tenant|scope|unsupported|inactive/);
    assert.equal((f.service.remoteTaskRevoke({ binding_id: "binding", reason: "operator" }).binding as JsonObject).status, "revoked");
    assert.throws(() => f.service.remoteTaskAuthorize(auth), /inactive/); assert.equal(f.service.remoteTaskRevoke({ binding_id: "binding", reason: "again" }).idempotent, true);
    f.store.save("remote_tenant", "tenant", { ...f.store.get("remote_tenant", "tenant"), status: "disabled" });
    assert.throws(() => f.service.remoteTaskBind({ task_id: "task", tenant_id: "tenant", principal_digest: d("a"), access_receipt_digest: d("b"), audience: "craft", scopes: ["x"], expires_at: "2030-01-01T00:05:00.000Z", now: "2030-01-01T00:00:00.000Z" }), /tenant/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.33 verifies a real JWKS-signed OIDC resource token without retaining it", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const jwk = keys.publicKey.export({ format: "jwk" }) as JsonObject; jwk.kid = "key"; jwk.use = "sig";
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key" })).toString("base64url"); const claims = Buffer.from(JSON.stringify({ iss: "https://issuer.example.test/", aud: ["craft"], sub: "subject", scope: "craft.read craft.write", client_id: "client", exp: 1_900_000_000 })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey).toString("base64url"); const token = `${header}.${claims}.${signature}`;
  let calls = 0; const verifier = createOidcJwksVerifier({ issuer: "https://issuer.example.test", audience: "craft", now: () => 1_800_000_000_000, fetch: async () => ({ status: 200, json: async () => ({ keys: [jwk] }) }) });
  const principal = await verifier(token); assert.equal(principal.subject, "subject"); assert.deepEqual(principal.scopes, ["craft.read", "craft.write"]); assert.equal(principal.client_id, "client");
  const noScopeClaims = Buffer.from(JSON.stringify({ iss: "https://issuer.example.test/", aud: "craft", sub: "subject", exp: 1_900_000_000 })).toString("base64url"); const noScope = `${header}.${noScopeClaims}.${sign("RSA-SHA256", Buffer.from(`${header}.${noScopeClaims}`), keys.privateKey).toString("base64url")}`;
  assert.deepEqual((await verifier(noScope)).scopes, []);
  const badAudienceClaims = Buffer.from(JSON.stringify({ iss: "https://issuer.example.test/", aud: 1, sub: "subject", exp: 1_900_000_000 })).toString("base64url"); const badAudience = `${header}.${badAudienceClaims}.${sign("RSA-SHA256", Buffer.from(`${header}.${badAudienceClaims}`), keys.privateKey).toString("base64url")}`;
  await assert.rejects(() => verifier(badAudience), /audience/);
  const cached = createOidcJwksVerifier({ issuer: "https://issuer.example.test", audience: "craft", now: () => 1_800_000_000_000, fetch: async () => { calls += 1; return { status: 200, json: async () => ({ keys: [jwk] }) }; } }); await cached(token); await cached(token); assert.equal(calls, 1);
  assert.throws(() => createOidcJwksVerifier({ issuer: "http://issuer.example.test", audience: "craft" }), /HTTPS/);
  await assert.rejects(() => verifier(`x.${claims}.${signature}`), /header/);
});

test("v0.12.33 keeps publisher signatures separate from capability activation and makes drift fail closed", async () => {
  const f = await fixture();
  try {
    const keys = generateKeyPairSync("ed25519"); const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString(); const subjectDigest = d("c");
    assert.equal((f.service.supplyChainPublisherRegister({ publisher_id: "publisher", public_key_pem: publicKey, identity_ref: "did:example:p" }).publisher as JsonObject).status, "active");
    const signature = sign(null, Buffer.from(subjectDigest), keys.privateKey).toString("base64url"); const attestation = f.service.supplyChainAttest({ attestation_id: "att", publisher_id: "publisher", subject_kind: "capability_asset", subject_id: "asset", subject_digest: subjectDigest, signature }).attestation as JsonObject;
    assert.equal(f.service.supplyChainAttestationAssert({ attestation_id: attestation.id, current_subject_digest: subjectDigest }).matches, true);
    assert.equal(f.service.supplyChainAttestationAssert({ attestation_id: attestation.id, current_subject_digest: d("d") }).activation_permitted, false);
    assert.equal((f.service.supplyChainAttestationRevoke({ attestation_id: attestation.id, reason: "withdrawn" }).attestation as JsonObject).status, "revoked");
    assert.throws(() => f.service.supplyChainAttest({ publisher_id: "publisher", subject_kind: "bad", subject_id: "asset", subject_digest: subjectDigest, signature }), /unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.33 accepts only observed two-Host/two-Case five-trial evidence before default activation", async () => {
  const f = await fixture();
  try {
    const plan = f.service.runtimeAcceptancePlan({ plan_id: "plan", case_ids: ["code", "file"], host_ids: ["codex", "other"], baseline_harness: "single", candidate_harness: "retrieval", environment_fingerprint: "env", budget_fingerprint: "budget", trials_per_pair: 5, observer_kind: "workspace" }).plan as JsonObject;
    for (const host of ["codex", "other"]) for (const caseId of ["code", "file"]) for (const arm of ["baseline", "candidate"]) for (let trial = 1; trial <= 5; trial += 1) {
      const sessionId = `${host}-${caseId}-${arm}-${trial}`; f.store.create("host_session", sessionId, { host_id: host, environment_fingerprint: "env", trace_id: `trace-${sessionId}` });
      const observationId = `obs-${sessionId}`; f.store.create("outcome_observation", observationId, { trace_id: `trace-${sessionId}`, host_id: host, observer_id: "observer", observer_kind: "workspace", verdict: arm === "candidate" ? "passed" : "failed" });
      f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: host, case_id: caseId, arm, harness: arm === "candidate" ? "retrieval" : "single", trial_index: trial, environment_fingerprint: "env", budget_fingerprint: "budget", host_session_id: sessionId, observation_id: observationId });
    }
    const result = f.service.runtimeAcceptanceEvaluate({ plan_id: plan.id }).evaluation as JsonObject; assert.equal(result.status, "eligible"); assert.equal(result.candidate_default_activation_permitted, true); assert.equal((f.service.runtimeAcceptanceGet({ plan_id: plan.id }).records as JsonObject[]).length, 40);
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "codex", case_id: "code", arm: "candidate", harness: "retrieval", trial_index: 1, environment_fingerprint: "env", budget_fingerprint: "budget", host_session_id: "x", observation_id: "x" }), /not collecting/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.33 adapts A2A v1 only through a consumed read-only delegation grant", async () => {
  const f = await fixture();
  try {
    f.store.create("federated_delegation_grant", "grant", { status: "consumed", effect: "read_only", grant_digest: d("g") });
    const remote = async (_url: string, init?: { method?: string; body?: string }) => {
      const request = init?.body ? JSON.parse(init.body) as JsonObject : null;
      if (init?.method === "GET") return { status: 200, json: async () => ({ protocolVersion: "1.0", url: "https://agent.example.test/rpc" }) };
      if (request?.method === "message/send") return { status: 200, json: async () => ({ result: { id: "remote-task", status: { state: "working" } } }) };
      if (request?.method === "tasks/get") return { status: 200, json: async () => ({ result: { id: "remote-task", status: { state: "completed" } } }) };
      return { status: 200, json: async () => ({ result: { id: "remote-task", status: { state: "canceled" } } }) };
    };
    const card = await f.service.a2aV1.discover({ endpoint: "https://agent.example.test" , observation_id: "card" }, remote);
    assert.equal((card.observation as JsonObject).protocol_version, "1.0");
    const task = await f.service.a2aV1.submit({ task_id: "a2a-task", grant_id: "grant", card_observation_id: "card", request_id: "send", input_digest: d("input") }, remote); assert.equal((task.task as JsonObject).status, "working");
    assert.equal(((await f.service.a2aV1.taskGet({ task_id: "a2a-task", request_id: "get" }, remote)).task as JsonObject).status, "completed");
    assert.equal(((await f.service.a2aV1.cancel({ task_id: "a2a-task", request_id: "cancel", reason_digest: d("reason") }, remote)).task as JsonObject).status, "canceled");
    f.store.create("federated_delegation_grant", "unconsumed", { status: "active", effect: "read_only", grant_digest: d("h") });
    await assert.rejects(() => f.service.a2aV1.submit({ grant_id: "unconsumed", card_observation_id: "card", request_id: "bad", input_digest: d("input") }, remote), /consumed/);
    f.store.create("federated_delegation_grant", "unsafe", { status: "consumed", effect: "write", grant_digest: d("i") });
    await assert.rejects(() => f.service.a2aV1.submit({ grant_id: "unsafe", card_observation_id: "card", request_id: "unsafe", input_digest: d("input") }, remote), /read-only/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
