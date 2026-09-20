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

test("v0.12.34 binds remote task operations to one tenant, principal, receipt, scope and opaque one-time handle", async () => {
  const f = await fixture();
  try {
    const tenant = f.service.remoteTenantRegister({ tenant_id: "tenant", data_space_id: "space", key_envelope_ref: "kms:key", retention_policy_ref: "retention:v1", deletion_policy_ref: "delete:v1" }).tenant as JsonObject;
    assert.throws(() => f.service.remoteTenantRegister({ tenant_id: "", data_space_id: "space", key_envelope_ref: "kms:key", retention_policy_ref: "retention:v1", deletion_policy_ref: "delete:v1" }), /tenant_id/);
    assert.equal(f.service.remoteTenantRegister({ tenant_id: "tenant", data_space_id: "space", key_envelope_ref: "kms:key", retention_policy_ref: "retention:v1", deletion_policy_ref: "delete:v1" }).idempotent, true);
    assert.throws(() => f.service.remoteTenantRegister({ tenant_id: "tenant", data_space_id: "different", key_envelope_ref: "kms:key", retention_policy_ref: "retention:v1", deletion_policy_ref: "delete:v1" }), /idempotency/);
    const bindingArgs = { binding_id: "binding", task_id: "task", tenant_id: tenant.id, principal_digest: d("a"), access_receipt_digest: d("b"), audience: "craft", scopes: ["craft.read"], now: "2030-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:05:00.000Z" };
    assert.throws(() => f.service.remoteTaskBind({ ...bindingArgs, scopes: [] }), /at least/);
    assert.throws(() => f.service.remoteTaskBind({ ...bindingArgs, scopes: ["craft.read", "craft.read"] }), /unique/);
    assert.throws(() => f.service.remoteTaskBind({ ...bindingArgs, principal_digest: "bad" }), /SHA-256/);
    assert.throws(() => f.service.remoteTaskBind({ ...bindingArgs, expires_at: "2020-01-01T00:00:00.000Z" }), /expired/);
    const created = f.service.remoteTaskBind(bindingArgs);
    const handle = String(created.handle); assert.match(handle, /^[A-Za-z0-9_-]+$/); assert.equal(JSON.stringify(created.binding).includes(handle), false);
    assert.equal(f.service.remoteTaskBind(bindingArgs).idempotent, true); assert.equal((f.service.remoteTaskGet({ binding_id: "binding" }).receipts as JsonObject[]).length, 0);
    const generatedBinding = f.service.remoteTaskBind({ task_id: "task", tenant_id: tenant.id, principal_digest: d("c"), access_receipt_digest: d("d"), audience: "craft", scopes: ["craft.read"], expires_at: "2030-01-01T00:05:00.000Z" });
    assert.equal((generatedBinding.binding as JsonObject).status, "active");
    const generatedHandle = String(generatedBinding.handle);
    assert.equal((f.service.remoteTaskAuthorize({ binding_id: String((generatedBinding.binding as JsonObject).id), handle: generatedHandle, tenant_id: "tenant", principal_digest: d("c"), access_receipt_digest: d("d"), audience: "craft", scopes: ["craft.read"], operation: "get" }).receipt as JsonObject).operation, "get");
    const auth = { binding_id: "binding", handle, tenant_id: "tenant", principal_digest: d("a"), access_receipt_digest: d("b"), audience: "craft", scopes: ["craft.read", "other"], operation: "get", now: "2030-01-01T00:01:00.000Z" };
    assert.equal((f.service.remoteTaskAuthorize({ ...auth, receipt_id: "access" }).receipt as JsonObject).operation, "get");
    assert.equal(f.service.remoteTaskAuthorize({ ...auth, receipt_id: "access" }).idempotent, true);
    assert.throws(() => f.service.remoteTaskAuthorize({ ...auth, receipt_id: "access", operation: "result" }), /idempotency/);
    assert.equal((f.service.remoteTaskGet({ binding_id: "binding" }).receipts as JsonObject[]).length, 1);
    for (const bad of [{ ...auth, handle: "wrong" }, { ...auth, tenant_id: "other" }, { ...auth, principal_digest: d("c") }, { ...auth, access_receipt_digest: d("c") }, { ...auth, audience: "other" }, { ...auth, scopes: ["other"] }, { ...auth, operation: "write" }, { ...auth, now: "2030-01-01T00:06:00.000Z" }]) assert.throws(() => f.service.remoteTaskAuthorize(bad), /handle|tenant|principal|authorization|audience|scope|unsupported|inactive/);
    assert.equal((f.service.remoteTaskRevoke({ binding_id: "binding", reason: "operator" }).binding as JsonObject).status, "revoked");
    assert.throws(() => f.service.remoteTaskAuthorize(auth), /inactive/); assert.equal(f.service.remoteTaskRevoke({ binding_id: "binding", reason: "again" }).idempotent, true);
    f.store.save("remote_task_binding", "binding-expired", { ...(created.binding as JsonObject), id: "binding-expired", status: "expired" });
    assert.throws(() => f.service.remoteTaskRevoke({ binding_id: "binding-expired", reason: "cleanup" }), /active/);
    f.store.save("remote_tenant", "tenant", { ...f.store.get("remote_tenant", "tenant"), status: "disabled" });
    assert.throws(() => f.service.remoteTaskBind({ task_id: "task", tenant_id: "tenant", principal_digest: d("a"), access_receipt_digest: d("b"), audience: "craft", scopes: ["x"], expires_at: "2030-01-01T00:05:00.000Z", now: "2030-01-01T00:00:00.000Z" }), /tenant/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.34 verifies a real JWKS-signed OIDC resource token without retaining it", async () => {
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

test("OIDC JWKS verifier fails closed for malformed metadata, keys, claims, and signatures", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }); const jwk = keys.publicKey.export({ format: "jwk" }) as JsonObject; jwk.kid = "key";
  const encode = (value: JsonObject) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const make = (header: JsonObject, claims: JsonObject, privateKey = keys.privateKey) => { const h = encode(header); const c = encode(claims); return `${h}.${c}.${sign("RSA-SHA256", Buffer.from(`${h}.${c}`), privateKey).toString("base64url")}`; };
  const base = { iss: "https://issuer.example.test/", aud: "craft", sub: "subject", exp: 1_900_000_000 };
  const verifier = (body: unknown, status = 200) => createOidcJwksVerifier({ issuer: "https://issuer.example.test", audience: "craft", now: () => 1_800_000_000_000, fetch: async () => ({ status, json: async () => body }) });
  assert.throws(() => createOidcJwksVerifier({ issuer: "", audience: "craft" }), /issuer/);
  assert.throws(() => createOidcJwksVerifier({ issuer: "https://issuer.example.test", audience: "", cacheTtlMs: 0 }), /audience/);
  await assert.rejects(verifier({}, 503)(make({ alg: "RS256", kid: "key" }, base)), /HTTP/);
  await assert.rejects(verifier({ keys: [] })(make({ alg: "RS256", kid: "key" }, base)), /usable/);
  await assert.rejects(verifier({ keys: [null] })(make({ alg: "RS256", kid: "key" }, base)), /usable/);
  await assert.rejects(verifier({ nope: [] })(make({ alg: "RS256", kid: "key" }, base)), /invalid/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "HS256", kid: "key" }, base)), /algorithm/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256" }, base)), /kid/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "other" }, base)), /unknown/);
  const badKey = { ...jwk, n: "bad" };
  await assert.rejects(verifier({ keys: [badKey] })(make({ alg: "RS256", kid: "key" }, base)), /signature|key is invalid/);
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "key" }, base, other.privateKey)), /signature/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "key" }, { ...base, iss: "https://other/" })), /issuer/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "key" }, { ...base, aud: ["other"] })), /audience/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "key" }, { ...base, exp: 1 })), /expired/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "key" }, { ...base, sub: "" })), /subject/);
  await assert.rejects(verifier({ keys: [jwk] })(make({ alg: "RS256", kid: "key" }, { ...base, scope: 1 })), /scope/);
  const encodeRaw = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  await assert.rejects(verifier({ keys: [jwk] })(`${encodeRaw([])}.${encodeRaw(base)}.sig`), /header/);
  await assert.rejects(verifier({ keys: [jwk] })(`${encodeRaw({ alg: "RS256", kid: "key" })}.${encodeRaw([])}.sig`), /claims/);
  assert.throws(() => createOidcJwksVerifier({ issuer: "https://issuer.example.test", audience: "craft", cacheTtlMs: 0 }), /positive integer/);
  const explicit = createOidcJwksVerifier({ issuer: "https://issuer.example.test", audience: "craft", jwksUrl: "https://keys.example.test/jwks", fetch: async () => ({ status: 200, json: async () => ({ keys: [jwk] }) }), now: () => 1_800_000_000_000, cacheTtlMs: 1 });
  assert.equal((await explicit(make({ alg: "RS256", kid: "key" }, base))).subject, "subject");
});

test("v0.12.34 keeps publisher signatures separate from capability activation and makes drift fail closed", async () => {
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

test("v0.12.34 accepts only observed two-Host/two-Case five-trial evidence before default activation", async () => {
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

test("runtime acceptance rejects malformed, mismatched and incomplete observations", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.runtimeAcceptancePlan({ case_ids: ["one"], host_ids: ["h1", "h2"], baseline_harness: "a", candidate_harness: "b", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 3, observer_kind: "o" }), /exactly/);
    assert.throws(() => f.service.runtimeAcceptancePlan({ case_ids: ["one", "two"], host_ids: ["h1", "h2"], baseline_harness: "a", candidate_harness: "a", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 3, observer_kind: "o" }), /differ/);
    const plan = f.service.runtimeAcceptancePlan({ plan_id: "edge-acceptance", case_ids: ["one", "two"], host_ids: ["h1", "h2"], baseline_harness: "a", candidate_harness: "b", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 3, observer_kind: "o" }).plan as JsonObject;
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "other", case_id: "one", arm: "baseline", harness: "a", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "missing", observation_id: "missing" }), /not in the plan/);
    f.store.create("host_session", "edge-session", { host_id: "h1", environment_fingerprint: "e", trace_id: "edge-trace" });
    f.store.create("outcome_observation", "edge-observation", { trace_id: "edge-trace", host_id: "h1", observer_kind: "o", observer_id: "h1", verdict: "failed" });
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "invalid", harness: "a", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" }), /unsupported/);
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "baseline", harness: "wrong", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" }), /does not match/);
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "baseline", harness: "a", trial_index: 1, environment_fingerprint: "bad", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" }), /environment/);
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "baseline", harness: "a", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" }), /independent/);
    f.store.save("outcome_observation", "edge-observation", { ...f.store.get("outcome_observation", "edge-observation"), observer_id: "different" });
    const record = f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "baseline", harness: "a", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" });
    assert.equal((record.record as JsonObject).verdict, "failed");
    assert.equal((f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "baseline", harness: "a", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" }) as JsonObject).idempotent, true);
    assert.throws(() => f.service.runtimeAcceptancePlan({ plan_id: "edge-acceptance", case_ids: ["one", "two"], host_ids: ["h1", "h2"], baseline_harness: "a", candidate_harness: "changed", environment_fingerprint: "e", budget_fingerprint: "b", trials_per_pair: 3, observer_kind: "o" }), /idempotency conflict/);
    f.store.create("host_session", "mismatch-session", { host_id: "h2", environment_fingerprint: "other", trace_id: "edge-trace" });
    f.store.create("outcome_observation", "mismatch-observation", { trace_id: "edge-trace", host_id: "h2", observer_kind: "o", observer_id: "observer", verdict: "passed" });
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "candidate", harness: "b", trial_index: 1, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "mismatch-session", observation_id: "mismatch-observation" }), /Host Session does not match/);
    assert.equal((f.service.runtimeAcceptanceEvaluate({ plan_id: plan.id }).evaluation as JsonObject).status, "inconclusive");
    assert.throws(() => f.service.runtimeAcceptanceRecord({ plan_id: plan.id, host_id: "h1", case_id: "one", arm: "candidate", harness: "b", trial_index: 4, environment_fingerprint: "e", budget_fingerprint: "b", host_session_id: "edge-session", observation_id: "edge-observation" }), /not collecting/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.34 adapts A2A v1 only through a consumed read-only delegation grant", async () => {
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

test("A2A v1 adapter covers protocol validation, idempotency and remote failures", async () => {
  const f = await fixture();
  try {
    const grant = f.store.create("federated_delegation_grant", "g-v1", { status: "consumed", effect: "read_only", grant_digest: d("g-v1") });
    const cardFetch = async (_url: string) => ({ status: 200, json: async () => ({ protocolVersion: "1.0", url: "https://agent.example.test/rpc" }) });
    await assert.rejects(() => f.service.a2aV1.discover({ endpoint: "http://agent.example.test" }, cardFetch), /HTTPS/);
    await assert.rejects(() => f.service.a2aV1.discover({ endpoint: "https://agent.example.test" }, async () => ({ status: 500, json: async () => ({}) })), /HTTP 500/);
    await assert.rejects(() => f.service.a2aV1.discover({ endpoint: "https://agent.example.test" }, async () => ({ status: 200, json: async () => [] })), /object/);
    await assert.rejects(() => f.service.a2aV1.discover({ endpoint: "https://agent.example.test" }, async () => ({ status: 200, json: async () => ({ protocolVersion: "2.0", url: "https://agent.example.test" }) })), /compatible/);
    const card = await f.service.a2aV1.discover({ endpoint: "https://agent.example.test", observation_id: "edge-card" }, cardFetch);
    assert.equal((await f.service.a2aV1.discover({ endpoint: "https://agent.example.test", observation_id: "edge-card" }, cardFetch)).idempotent, true);
    const generatedCard = await f.service.a2aV1.discover({ endpoint: "https://generated.example.test" }, cardFetch);
    assert.ok((generatedCard.observation as JsonObject).id);
    await assert.rejects(() => f.service.a2aV1.discover({ endpoint: "https://other.example.test", observation_id: String((generatedCard.observation as JsonObject).id) }, cardFetch), /idempotency conflict/);
    await assert.rejects(() => f.service.a2aV1.submit({ grant_id: "missing", card_observation_id: "edge-card", request_id: "x", input_digest: d("x") }, cardFetch), /Unknown/);
    const remoteError = async () => ({ status: 200, json: async () => ({ error: { code: -1 } }) });
    await assert.rejects(() => f.service.a2aV1.submit({ task_id: "edge-task", grant_id: grant.id, card_observation_id: card.observation && (card.observation as JsonObject).id, request_id: "send-error", input_digest: d("x") }, remoteError), /remote returned/);
    const remoteBadStatus = async () => ({ status: 200, json: async () => ({ result: { id: "remote", status: "unknown" } }) });
    await assert.rejects(() => f.service.a2aV1.submit({ task_id: "edge-task-2", grant_id: grant.id, card_observation_id: "edge-card", request_id: "send-bad", input_digest: d("x") }, remoteBadStatus), /unsupported/);
    const remoteOk = async (_url: string, init?: { method?: string; body?: string }) => {
      const method = init?.body ? (JSON.parse(init.body) as JsonObject).method : "";
      if (method === "message/send") return { status: 200, json: async () => ({ result: { id: "remote", status: "submitted" } }) };
      if (method === "tasks/get") return { status: 503, json: async () => ({}) };
      return { status: 200, json: async () => ({ result: { id: "remote", status: "canceled" } }) };
    };
    const created = await f.service.a2aV1.submit({ task_id: "edge-task-3", grant_id: grant.id, card_observation_id: "edge-card", request_id: "send", input_digest: d("x") }, remoteOk);
    const generatedTask = await f.service.a2aV1.submit({ grant_id: grant.id, card_observation_id: "edge-card", request_id: "generated", input_digest: d("generated") }, remoteOk);
    assert.ok((generatedTask.task as JsonObject).id);
    assert.equal((await f.service.a2aV1.submit({ task_id: "edge-task-3", grant_id: grant.id, card_observation_id: "edge-card", request_id: "send", input_digest: d("x") }, remoteOk)).idempotent, true);
    await assert.rejects(() => f.service.a2aV1.submit({ task_id: "edge-task-3", grant_id: grant.id, card_observation_id: "edge-card", request_id: "send", input_digest: d("different") }, remoteOk), /idempotency conflict/);
    await assert.rejects(() => f.service.a2aV1.taskGet({ task_id: "edge-task-3", request_id: "get" }, remoteOk), /HTTP 503/);
    await assert.rejects(() => f.service.a2aV1.taskGet({ task_id: String((generatedTask.task as JsonObject).id), request_id: "get" }, async () => ({ status: 200, json: async () => ({ error: { code: -1 } }) })), /remote returned/);
    f.store.save("a2a_v1_task", "edge-task-3", { ...(created.task as JsonObject), status: "completed" });
    assert.equal((await f.service.a2aV1.taskGet({ task_id: "edge-task-3", request_id: "get" }, remoteOk)).idempotent, true);
    await assert.rejects(() => f.service.a2aV1.cancel({ task_id: "edge-task-3", request_id: "cancel", reason_digest: d("r") }, async () => ({ status: 500, json: async () => ({}) })), /HTTP 500/);
    await assert.rejects(() => f.service.a2aV1.cancel({ task_id: String((generatedTask.task as JsonObject).id), request_id: "cancel-error", reason_digest: d("r") }, async () => ({ status: 200, json: async () => ({ error: { code: -1 } }) })), /remote returned/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
