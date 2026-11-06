import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CapabilityKitRuntime } from "../core/capability-kit-runtime.ts";
import { createStoreControlAuthority, type ControlHostBinding } from "../core/application/control-authority.ts";
import { createControlSession } from "../capability/control-session.ts";
import { payload, stableDigest } from "../core/digest.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-control-authority-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const kits = new CapabilityKitRuntime(store);
  const task = service.taskOpen({ title: "Local control test", goal: "Observe a test page", project_id: "project", permission_mode: "human_approval" }).task as JsonObject;
  store.create("activation_profile", "profile", { task_id: task.id, allowed_effects: ["external_write"], activation: "host_mediated", status: "recommended" });
  service.taskControlSave({ contract_id: "contract", task_id: task.id, workspace: root, allowed_effects: ["external_write"], acceptance_required: true, activation_profile_id: "profile", activation_profile_version: 1 });
  const manifest = (id: string) => ({ id, version: "1.0.0", name: "Test control", description: "Explicit controlled fixture", compatibility: "^0.12.37", provides: ["browser_control"], effects: ["external_write"], data_scopes: ["project_root"], entrypoints: ["observe"], hooks: ["execute.adapter"], surfaces: ["cli"], healthcheck: "fixture", eval_suite: "fixture" });
  kits.install({ manifest: manifest("test.dependency") });
  kits.install({ manifest: { ...manifest("test.control"), depends_on: [{ kit_id: "test.dependency", manifest_version: "1.0.0" }] } });
  kits.conformance({ kit_id: "test.control" });
  kits.activate({ kit_id: "test.control", task_id: task.id, activation_id: "activation", activation_profile_id: "profile" });
  const binding: ControlHostBinding = { task_id: String(task.id), activation_id: "activation", target_id: "page", project_id: "project", host_id: "host", principal: "operator", contract_id: "contract", effect: "external_write",
    target_identity: "browser:page", operations: ["click"], allowed_origins: ["http://localhost:9000"], expires_at: Date.now() + 60_000, max_actions: 2, timeout_ms: 1_000 };
  const scope = { task_id: binding.task_id, activation_id: binding.activation_id, target_id: binding.target_id };
  const change = (kind: string, id: string, patch: JsonObject) => store.save(kind, id, { ...payload(store.get(kind, id)), ...patch });
  return { store, kits, binding, scope, change, close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("real ledger authorization pins records and cannot be mutated through Host input or returned grants", async () => {
  const f = await fixture();
  try {
    const authority = createStoreControlAuthority(f.store, f.binding);
    const grant = authority.resolve(f.scope);
    assert.equal(grant.activation_version, 1); assert.equal(authority.principal, "operator");
    assert.match(grant.policy_digest, /^sha256:/); assert.match(grant.capability_digest, /^sha256:/);
    f.binding.operations.push("delete"); grant.operations.push("delete"); grant.allowed_origins.push("http://evil.test");
    assert.deepEqual(authority.resolve(f.scope).operations, ["click"]);
    assert.deepEqual(authority.resolve(f.scope).allowed_origins, ["http://localhost:9000"]);
    for (const key of ["task_id", "activation_id", "target_id"]) assert.throws(() => authority.resolve({ ...f.scope, [key]: "wrong" }), /scope/);
    f.change("task", f.scope.task_id, { title: "Changed task" });
    assert.throws(() => authority.resolve(f.scope), /changed/);
  } finally { await f.close(); }
});

test("every ledger association, policy, conformance and dependency fails closed", async () => {
  const changes: [string, string, JsonObject][] = [
    ["task", "TASK", { status: "completed" }], ["task", "TASK", { project_id: "other" }], ["task", "TASK", { permission_mode: "automatic" }],
    ["task_control_contract", "contract", { status: "revoked" }], ["task_control_contract", "contract", { task_id: "other" }], ["task_control_contract", "contract", { acceptance_required: false }], ["task_control_contract", "contract", { activation_profile: null }],
    ["capability_kit_activation", "activation", { status: "needs_replan" }], ["capability_kit_activation", "activation", { task_id: "other" }], ["capability_kit_activation", "activation", { activation_profile_id: "other" }],
    ["activation_profile", "profile", { task_id: "other" }], ["activation_profile", "profile", { activation: "automatic" }], ["activation_profile", "profile", { status: "revoked" }],
    ["capability_kit", "test.control", { status: "disabled" }], ["capability_kit_activation", "activation", { kit_version: 2 }], ["capability_kit_activation", "activation", { manifest_digest: "forged" }],
    ["capability_kit_conformance", "kit_conformance_test.control_1", { verdict: "failed" }], ["capability_kit_conformance", "kit_conformance_test.control_1", { kit_version: 2 }], ["capability_kit_conformance", "kit_conformance_test.control_1", { manifest_digest: "forged" }],
    ["task_control_contract", "contract", { allowed_effects: null }], ["task_control_contract", "contract", { allowed_effects: ["read_only"] }], ["activation_profile", "profile", { allowed_effects: ["read_only"] }],
    ["capability_kit", "test.dependency", { status: "disabled" }], ["capability_kit", "test.dependency", { manifest_version: "2.0.0" }], ["capability_kit", "test.dependency", { manifest_digest: "forged" }],
  ];
  for (const [kind, id, patch] of changes) {
    const f = await fixture();
    try {
      f.change(kind, id === "TASK" ? f.scope.task_id : id, patch);
      assert.throws(() => createStoreControlAuthority(f.store, f.binding), Error, `${kind}: ${JSON.stringify(patch)}`);
    } finally { await f.close(); }
  }
});

test("digest and execution declarations cannot be repaired into a stale pinned authority", async () => {
  for (const patch of [{ effects: ["read_only"] }, { hooks: [] }, { hooks: null }, { depends_on: null }, { description: "tampered" }]) {
    const f = await fixture();
    try {
      const kit = f.store.get("capability_kit", "test.control");
      const manifest = { ...(kit.manifest as JsonObject), ...patch };
      const digest = stableDigest(manifest);
      // Update all declared links: semantic validation still must fail independently.
      f.change("capability_kit", "test.control", { manifest, manifest_digest: digest });
      f.change("capability_kit_activation", "activation", { kit_version: 2, manifest_digest: digest });
      f.store.create("capability_kit_conformance", "kit_conformance_test.control_2", { kit_version: 2, manifest_digest: digest, verdict: "passed" });
      if (patch.description) {
        f.change("capability_kit", "test.control", { manifest_digest: "forged" });
      }
      assert.throws(() => createStoreControlAuthority(f.store, f.binding));
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    assert.throws(() => createStoreControlAuthority(f.store, { ...f.binding, principal: " " }), /principal/);
    assert.throws(() => createStoreControlAuthority(f.store, { ...f.binding, effect: "read_only" as "external_write" }), /effect/);
    // Active profile is valid only with its exact contract version.
    const profile = f.change("activation_profile", "profile", { status: "active" });
    f.change("task_control_contract", "contract", { activation_profile: { id: profile.id, version: profile.version } });
    assert.ok(createStoreControlAuthority(f.store, f.binding).resolve(f.scope));
  } finally { await f.close(); }
});

test("revocation between observation and approval hands off without Adapter dispatch", async () => {
  const f = await fixture();
  try {
    let executions = 0;
    const authority = createStoreControlAuthority(f.store, f.binding);
    const host = createControlSession(f.store, authority, {
      observe: async () => ({ identity: f.binding.target_identity, state_digest: "page", origin: f.binding.allowed_origins[0], element_refs: ["button"], user_takeover: false }),
      execute: async () => { executions++; return { receipt_digest: "execution" }; },
    });
    const session = host.client.open(f.scope);
    const observation = await host.client.observe(String(session.id));
    const action = host.client.prepare(String(session.id), String(observation.id), { operation: "click", element_ref: "button" });
    f.kits.setState({ kit_id: "test.control", state: "revoked", actor: "operator", reason: "stop" });
    assert.throws(() => host.approvalPacket(String(action.id)), /unavailable/);
    assert.equal(f.store.get("control_session", String(session.id)).status, "handoff");
    assert.equal(executions, 0);
  } finally { await f.close(); }
});
