import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createControlSession, type ControlGrant, type ControlObservation, type ControlAction, type ControlAdapter } from "../capability/control-session.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-control-session-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const scope = { task_id: "task", activation_id: "activation", target_id: "target" };
  let time = 1, calls = 0;
  let grant: ControlGrant = { ...scope, project_id: "project", host_id: "host", activation_version: 1, policy_digest: "policy", capability_digest: "kit",
    target_identity: "window:1:pid:2", operations: ["navigate", "fill", "click"], allowed_origins: ["http://localhost:9000"], expires_at: 100, max_actions: 2, timeout_ms: 1_000 };
  let observation: ControlObservation = { identity: grant.target_identity, state_digest: "snapshot", origin: grant.allowed_origins[0], element_refs: ["element"], user_takeover: false };
  let inspect = async () => structuredClone(observation);
  let dispatch = async (_action: Readonly<ControlAction>) => { calls++; return { receipt_digest: "executed" }; };
  const authority = { principal: "operator", resolve: () => structuredClone(grant) };
  const adapter: ControlAdapter = { observe: () => inspect(), execute: (_target: string, action: Readonly<ControlAction>) => dispatch(action) };
  const host = createControlSession(store, authority, adapter, () => time);
  const approve = (actionId: string, principal = 'operator') => host.approve(actionId, principal, String(host.approvalPacket(actionId).packet_digest));
  const open = () => String(host.client.open(scope).id);
  const prepared = async (session = open(), action: ControlAction = { operation: "click", element_ref: "element" }) => {
    const observed = await host.client.observe(session);
    return { session, observation: observed, action: host.client.prepare(session, String(observed.id), action) };
  };
  return { root, store, scope, authority, adapter, host, open, prepared, approve, getGrant: () => grant, setGrant: (value: ControlGrant) => { grant = value; },
    getObservation: () => observation, setObservation: (value: ControlObservation) => { observation = value; }, setTime: (value: number) => { time = value; }, calls: () => calls,
    inspect: (value: typeof inspect) => { inspect = value; }, dispatch: (value: typeof dispatch) => { dispatch = value; },
    close: async () => { store.close(); await rm(root, { recursive: true, force: true }); } };
}

test("Host-only approval binds a single-use action to Task/Activation/Policy and independent observations", async () => {
  const f = await fixture();
  try {
    assert.ok(!("approve" in f.host.client));
    const p = await f.prepared(undefined, { operation: "fill", element_ref: "element", value: "private-input" });
    await assert.rejects(f.host.client.execute(String(p.action.id)), /approval/);
    assert.throws(() => f.host.approve(String(p.action.id), "forged", "forged"), /principal/);
    assert.throws(() => f.host.approve(String(p.action.id), "operator", "forged"), /digest/);
    const packet = f.host.approvalPacket(String(p.action.id));
    assert.throws(() => { (packet.action as ControlAction).value = 'tampered'; }, TypeError);
    assert.equal((f.host.approvalPacket(String(p.action.id)).action as ControlAction).value, 'private-input');
    f.approve(String(p.action.id));
    assert.throws(() => f.approve(String(p.action.id)), /already decided/);
    const result = await f.host.client.execute(String(p.action.id));
    assert.equal(result.status, "observed"); assert.equal(result.outcome_accepted, false); assert.equal(f.calls(), 1);
    await assert.rejects(f.host.client.execute(String(p.action.id)), /already dispatched/);
    assert.ok(!JSON.stringify(f.store.list("control_action", 100)).includes("private-input"));
    const next = await f.prepared(p.session, { operation: "navigate", url: "http://localhost:9000/form" });
    f.approve(String(next.action.id));
    assert.equal((await f.host.client.execute(String(next.action.id))).status, "observed");
    const exhausted = await f.prepared(p.session);
    f.approve(String(exhausted.action.id));
    await assert.rejects(f.host.client.execute(String(exhausted.action.id)), /budget/);
    assert.equal(f.host.client.close(p.session).status, "closed");
  } finally { await f.close(); }
});

test("malformed or mismatched Host grants cannot open a Session", async () => {
  const f = await fixture();
  try {
    const good = f.getGrant();
    for (const patch of [ { task_id: "wrong" }, { host_id: "" }, { project_id: "" }, { target_identity: "" }, { policy_digest: "" }, { capability_digest: "" },
      { activation_version: 0 }, { activation_version: 1.5 }, { max_actions: 0 }, { max_actions: 101 }, { max_actions: 1.1 },
      { timeout_ms: 0 }, { timeout_ms: 60_001 }, { timeout_ms: 1.1 },
      { expires_at: NaN }, { expires_at: 0 }, { operations: [] }, { operations: ["shell"] }, { allowed_origins: [] }, { raw_page: 'sensitive body' } ]) {
      f.setGrant({ ...good, ...patch }); assert.throws(f.open, /Invalid Host/);
    }
    f.setGrant(good);
    // Exercise the system clock default without trusting a caller-supplied timestamp.
    const host = createControlSession(f.store, { ...f.authority, resolve: () => ({ ...good, expires_at: Date.now() + 60_000 }) }, f.adapter);
    assert.equal(host.client.open(f.scope).status, "active");
  } finally { await f.close(); }
});

test("parameters, element refs, observations and navigation remain inside the frozen scope", async () => {
  const f = await fixture();
  try {
    const p = await f.prepared();
    for (const action of [ { operation: "shell" }, { operation: "click", element_ref: "missing" }, { operation: "click", element_ref: "element", approved: true },
      { operation: "navigate", url: "file:///tmp/private" }, { operation: "navigate", url: "http://user:password@localhost:9000/" },
      { operation: "navigate", url: "http://localhost:9001/" }, { operation: "navigate", url: "http://:password@localhost:9000/" } ]) {
      assert.throws(() => f.host.client.prepare(p.session, String(p.observation.id), action));
    }
    assert.throws(() => f.host.client.prepare(f.open(), String(p.observation.id), { operation: "click" }), /another Session/);
    await f.host.client.observe(p.session);
    assert.throws(() => f.host.client.prepare(p.session, String(p.observation.id), { operation: "click" }), /stale/);
    assert.throws(() => f.approve(String(p.action.id)), /stale/);
    const good = f.getObservation();
    for (const patch of [{ identity: "another-window" }, { state_digest: "" }, { user_takeover: true }, { origin: "https://elsewhere.test" }]) {
      f.setObservation({ ...good, ...patch }); await assert.rejects(f.host.client.observe(f.open()), /Observation failed/);
    }
  } finally { await f.close(); }
});

test("expiry and permission/version drift stop a Session before any effect", async () => {
  const f = await fixture();
  try {
    const p = await f.prepared();
    f.setTime(100);
    assert.throws(() => f.approve(String(p.action.id)), /expired/);
    f.setTime(1);
    await assert.rejects(f.host.client.observe(p.session), /handoff/);
    const other = f.open(); f.setGrant({ ...f.getGrant(), activation_version: 2 });
    await assert.rejects(f.host.client.observe(other), /changed/);
    assert.equal(f.calls(), 0);
    const unavailable = f.open();
    f.authority.resolve = () => { throw new Error('private-policy-error'); };
    await assert.rejects(f.host.client.observe(unavailable), /authority unavailable/);
  } finally { await f.close(); }
});

test("preflight races and restart cannot replay a prepared action", async () => {
  const f = await fixture();
  try {
    for (const fault of ["state", "authority", "cancel", "identity", "revoke", "expiry"]) {
      f.setTime(1);
      f.inspect(async () => structuredClone(f.getObservation()));
      const p = await f.prepared(); f.approve(String(p.action.id));
      const restarted = createControlSession(f.store, f.authority, f.adapter, () => 1);
      await assert.rejects(restarted.client.execute(String(p.action.id)), /restart/);
      assert.throws(() => restarted.approvalPacket(String(p.action.id)), /restart/);
      f.inspect(async () => {
        if (fault === "state") return { ...f.getObservation(), state_digest: "drift" };
        if (fault === "authority") f.setGrant({ ...f.getGrant(), policy_digest: "changed" });
        if (fault === "cancel") restarted.client.close(p.session);
        if (fault === "expiry") f.setTime(100);
        if (fault === "identity") return { ...f.getObservation(), identity: "another-window" };
        if (fault === "revoke") throw new Error("permission revoked");
        return structuredClone(f.getObservation());
      });
      assert.equal((await f.host.client.execute(String(p.action.id))).status, "handoff");
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("unknown effect, post-action identity/permission changes and missing receipts require reconciliation, never replay", async () => {
  const f = await fixture();
  try {
    for (const fault of ["throw", "missing_receipt", "identity", "cancel", "permission", "expiry"]) {
      f.setTime(1); f.inspect(async () => structuredClone(f.getObservation()));
      const p = await f.prepared(); f.approve(String(p.action.id));
      f.dispatch(async () => {
        if (fault === "throw") throw new Error("secret-body-must-not-be-stored");
        if (fault === "identity") f.inspect(async () => ({ ...f.getObservation(), origin: "https://redirect.test" }));
        if (fault === "cancel") f.host.client.close(p.session);
        if (fault === "permission") f.setGrant({ ...f.getGrant(), policy_digest: "revoked" });
        if (fault === "expiry") f.setTime(100);
        return { receipt_digest: fault === "missing_receipt" ? "" : "executed" };
      });
      assert.equal((await f.host.client.execute(String(p.action.id))).status, "effect_unknown");
      await assert.rejects(f.host.client.execute(String(p.action.id)), /handoff/);
      assert.ok(!JSON.stringify(f.store.list("control_action", 100)).includes("secret-body"));
    }
  } finally { await f.close(); }
});

test("timeout, cancellation and unavailable storage clean up without replaying uncertain effects", async () => {
  const f = await fixture();
  try {
    f.setGrant({ ...f.getGrant(), timeout_ms: 10 });
    const p = await f.prepared(); f.approve(String(p.action.id));
    f.dispatch(() => new Promise(() => {}));
    assert.equal((await f.host.client.execute(String(p.action.id))).status, "effect_unknown");
    const other = await f.prepared(); f.approve(String(other.action.id));
    f.inspect(async () => { f.host.client.close(other.session); return f.getObservation(); });
    assert.equal((await f.host.client.execute(String(other.action.id))).status, "handoff");
    f.inspect(async () => f.getObservation());
    const failed = await f.prepared(); f.approve(String(failed.action.id));
    f.inspect(async () => { f.store.close(); return f.getObservation(); });
    await assert.rejects(f.host.client.execute(String(failed.action.id)), /not open/);
  } finally { await f.close(); }
});

test("concurrent Hosts cannot overlap observations or replay a reserved Session; prepared inputs remain bounded", async () => {
  const f = await fixture();
  try {
    const session = f.open();
    let release!: () => void;
    f.inspect(() => new Promise((resolve) => { release = () => resolve(f.getObservation()); }));
    const waiting = f.host.client.observe(session);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const other = createControlSession(f.store, f.authority, f.adapter, () => 1);
    await assert.rejects(other.client.observe(session), /handoff/);
    release(); const observed = await waiting;
    const foreignSession = f.open();
    f.inspect(async () => f.getObservation());
    const foreign = await f.prepared(foreignSession);
    f.host.client.prepare(session, String(observed.id), { operation: 'click', element_ref: 'element' });
    for (let index = 0; index < 98; index++) f.host.client.prepare(session, String(observed.id), { operation: 'click', element_ref: 'element' });
    assert.throws(() => f.host.client.prepare(session, String(observed.id), { operation: 'click', element_ref: 'element' }), /capacity/);
    f.host.client.close(session);
    f.approve(String(foreign.action.id));
    f.inspect(() => new Promise((resolve) => { release = () => resolve(f.getObservation()); }));
    const execution = f.host.client.execute(String(foreign.action.id));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await assert.rejects(other.client.execute(String(foreign.action.id)), /handoff/);
    other.client.close(foreignSession); release();
    assert.equal((await execution).status, 'handoff'); assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});

test("Session authorization expiry bounds a pending Adapter even when its operation timeout is longer", async (t) => {
  const f = await fixture();
  try {
    f.setGrant({ ...f.getGrant(), expires_at: 8, timeout_ms: 1_000 });
    const p = await f.prepared(); f.approve(String(p.action.id));
    let aborted = false;
    f.adapter.execute = (_target, _action, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new Error('adapter cancelled')); }, { once: true });
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = f.host.client.execute(String(p.action.id));
    await new Promise<void>((resolve) => setImmediate(resolve));
    t.mock.timers.tick(7);
    assert.equal((await pending).status, 'effect_unknown'); assert.equal(aborted, true);
  } finally { t.mock.timers.reset(); await f.close(); }
});
