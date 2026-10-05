import assert from "node:assert/strict";
import test from "node:test";
import { credentialStatus, selectModel, type ModelProviderSpec } from "../common/craft-common-base/src/model-compat.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeEnvelopeReceipt, scopeFromKey, sourceAllows } from "../common/craft-common-base/src/scope-policy.ts";
import { runPhase, type Hook } from "../common/craft-common-base/src/capability-protocol.ts";

const project = { kind: "project", id: "p" };

test("local capability model compatibility selects a usable tier without leaking credentials", () => {
  const spec: ModelProviderSpec = { provider: "demo", label: "Demo", protocol: "openai-compatible", base_url: "https://example.test", api_key_env: "TEST_KEY", chat_path: "/chat", models: { standard: "demo-model" }, cost_hint: 1, supports_tools: true };
  assert.deepEqual(credentialStatus(spec, { TEST_KEY: "secret" }), { provider: "demo", configured: true, api_key_env: "TEST_KEY" });
  assert.equal(credentialStatus(spec, {}).configured, false);
  assert.deepEqual(selectModel(spec, "frontier"), { tier: "standard", model: "demo-model", downgraded: true });
  assert.deepEqual(selectModel(spec, "standard"), { tier: "standard", model: "demo-model", downgraded: false });
  assert.throws(() => selectModel(spec, "huge" as never), /Unsupported model tier/);
  assert.throws(() => selectModel({ ...spec, models: {} }, "small"), /no usable model tier/);
});

test("scope envelopes preserve legacy access but bind audience, tenant and purpose", () => {
  assert.equal(scopeEnvelope(undefined, { kind: "task", id: "t" }).retention, "working");
  assert.equal(scopeEnvelope(undefined, { kind: "session", id: "s" }).purpose, "working_note");
  assert.equal(scopeEnvelope(null, { kind: "user", id: "u" }).purpose, "preference");
  assert.equal(scopeEnvelope(undefined, { kind: "global", id: "global" }).audience.mode, "public");
  assert.equal(scopeEnvelope({}, { kind: "global", id: "global" }).audience.mode, "public");
  assert.equal(scopeEnvelope({ purpose: "episode" }, project).retention, "archival");
  assert.equal(scopeEnvelope({ purpose: "fact" }, project).retention, "long_term");
  assert.throws(() => scopeEnvelope("bad", project), /must be an object/);
  assert.throws(() => scopeEnvelope({ applicability: [] }, project), /scope must be an object/);
  assert.throws(() => scopeEnvelope({ applicability: { kind: "unknown", id: "p" } }, project), /kind is unsupported/);
  const legacy = { kind: "legacy", id: "project:old" };
  assert.deepEqual(scopeEnvelope({ applicability: legacy, custody: legacy }, legacy).applicability, legacy);
  assert.throws(() => scopeEnvelope({ applicability: { kind: "legacy", id: "other" } }, legacy), /kind is unsupported/);
  assert.throws(() => scopeEnvelope({ applicability: legacy }, project), /kind is unsupported/);
  assert.throws(() => scopeEnvelope({ applicability: { kind: "project", id: "other" } }, project), /must match/);
  assert.throws(() => scopeEnvelope({ purpose: "other" }, project), /purpose is unsupported/);
  assert.throws(() => scopeEnvelope({ retention: "other" }, project), /retention is unsupported/);
  assert.throws(() => scopeEnvelope({ audience: null }, project), /audience must be an object/);
  assert.throws(() => scopeEnvelope({ audience: { mode: "other" } }, project), /mode is unsupported/);
  assert.throws(() => scopeEnvelope({ audience: { principal_ids: [1] } }, project), /principal_ids must be strings/);
  assert.throws(() => scopeEnvelope({ audience: { mode: "private" } }, project), /exactly one/);
  const restricted = scopeEnvelope({ custody: { kind: "team", id: "t" }, audience: { mode: "private", principal_ids: ["alice", "alice"] }, tenant_id: "tenant", purpose: "procedure", retention: "archival" }, project);
  assert.deepEqual(restricted.custody, { kind: "team", id: "t" });
  assert.equal(scopeAllows(restricted, { tenant_id: "other", principal_id: "alice" }), false);
  assert.equal(scopeAllows(restricted, { tenant_id: "tenant", principal_id: "alice", purpose: "fact" }), false);
  assert.equal(scopeAllows(restricted, { tenant_id: "tenant", principal_id: "bob" }), false);
  assert.equal(scopeAllows(restricted, { tenant_id: "tenant", principal_ids: ["alice"] }), true);
  assert.equal(scopeAllows(scopeEnvelope(undefined, project), {}), true);
  assert.equal(scopeAllows(scopeEnvelope(undefined, { kind: "global", id: "global" }), {}), true);
  assert.deepEqual(scopeEnvelopeReceipt(restricted), { applicability: project, custody: { kind: "team", id: "t" }, audience: { mode: "private", principal_count: 1 }, purpose: "procedure", retention: "archival", tenant_bound: true });
  assert.equal(sourceAllows({ scope: project, scope_envelope: restricted }, { tenant_id: "tenant", principal_id: "alice", purpose: "fact" }), true);
  assert.equal(sourceAllows({}, {}), true);
});

test("capability hook outcomes name an owner only when one was registered", async () => {
  const hook: Hook = { name: "probe", phase: "turn_end", order: 1, run: async () => ({ kind: "observed", refs: [] }) };
  assert.equal((await runPhase("turn_end", { input_digest: "sha256:input" }, [hook])).outcomes[0]?.capability, undefined);
  assert.equal((await runPhase("turn_end", { input_digest: "sha256:input" }, [{ ...hook, owned: "external" }])).outcomes[0]?.capability, "external");
});

test("host-attested scope access rejects malformed identities and parses legacy keys", () => {
  assert.deepEqual(scopeAccess({}), { principal_id: undefined, principal_ids: [], tenant_id: undefined, purpose: undefined });
  assert.deepEqual(scopeAccess({ principal_id: " alice ", principal_ids: ["alice", "alice", "bob"], tenant_id: "t", cognitive_purpose: "fact" }), { principal_id: "alice", principal_ids: ["alice", "bob"], tenant_id: "t", purpose: "fact" });
  assert.throws(() => scopeAccess({ principal_id: "" }), /principal_id/);
  assert.throws(() => scopeAccess({ principal_ids: "alice" }), /principal_ids/);
  assert.throws(() => scopeAccess({ principal_ids: [" "] }), /principal_ids/);
  assert.throws(() => scopeAccess({ cognitive_purpose: "other" }), /unsupported/);
  assert.throws(() => scopeAccess({ tenant_id: "" }), /tenant_id/);
  assert.deepEqual(scopeFromKey("global"), { kind: "global", id: "global" });
  assert.deepEqual(scopeFromKey("project:a:b"), { kind: "project", id: "a:b" });
  assert.throws(() => scopeFromKey("invalid"), /kind:id/);
  assert.throws(() => scopeFromKey(":id"), /kind:id/);
});
