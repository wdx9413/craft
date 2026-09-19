import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HostSessionEventKernel } from "../src/host-session-events.ts";
import { McpServer } from "../src/mcp.ts";
import { OutcomeObserverKernel } from "../src/outcome-observer.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { TraceKernel } from "../src/trace-kernel.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01229-session-")); const store = await new CraftStore(craftPaths(root)).open();
  const trace = new TraceKernel(store); return { root, store, trace, sessions: new HostSessionEventKernel(store, trace), observers: new OutcomeObserverKernel(store, trace) };
}

test("v0.12.29 host session protocol appends contiguous host facts into the canonical Trace", async () => {
  const f = await fixture();
  try {
    const opened = f.sessions.open({ session_id: "session", trace_id: "trace", task_id: "task", host_id: "codex-app", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "capability" });
    assert.equal((opened.session as { status: string }).status, "running");
    assert.equal((f.sessions.open({ session_id: "session", trace_id: "trace", task_id: "task", host_id: "codex-app", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "capability" }) as { idempotent: boolean }).idempotent, true);
    const dispatched = f.sessions.append({ session_id: "session", kind: "host.dispatched", event_id: "dispatch", action_contract_ref: "action:1", state_before_ref: "state:0", state_after_ref: "state:0", artifact_refs: ["artifact:1"] });
    assert.equal((dispatched.trace_event as { event_kind: string }).event_kind, "host.dispatched");
    assert.equal((f.sessions.append({ session_id: "session", kind: "host.dispatched", event_id: "dispatch", action_contract_ref: "action:1", state_before_ref: "state:0", state_after_ref: "state:0", artifact_refs: ["artifact:1"] }) as { idempotent: boolean }).idempotent, true);
    f.sessions.append({ session_id: "session", kind: "session.paused", event_id: "pause" });
    const resumed = f.sessions.resume({ session_id: "session", actor: "user", reason_digest: "sha256:resume" });
    assert.equal((resumed.session as { status: string }).status, "running");
    f.sessions.append({ session_id: "session", kind: "session.completed", event_id: "done", state_after_ref: "state:1" });
    assert.equal((f.sessions.get({ session_id: "session" }).events as unknown[]).length, 5);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt" }), /terminal/);
    assert.throws(() => f.sessions.open({ session_id: "session", trace_id: "other", task_id: "task", host_id: "codex-app", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "capability" }), /idempotency/);
    assert.throws(() => f.sessions.open({ task_id: "task", host_id: " ", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "capability" }), /host_id/);
    const generated = f.sessions.open({ task_id: "task-2", host_id: "host-2", environment_fingerprint: "env-2", policy_fingerprint: "policy-2", capability_fingerprint: "capability-2" });
    assert.match(String((generated.session as { id: string }).id), /^host_session_/);
    const explicit = f.sessions.open({ session_id: "explicit", task_id: "task-3", host_id: "host-3", environment_fingerprint: "env-3", policy_fingerprint: "policy-3", capability_fingerprint: "capability-3" });
    assert.equal((f.sessions.append({ session_id: (explicit.session as { id: string }).id, kind: "host.receipt", sequence: 2 }).event as { sequence: number }).sequence, 2);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.29 session protocol rejects unordered, unknown and sensitive host events", async () => {
  const f = await fixture();
  try {
    f.sessions.open({ session_id: "session", task_id: "task", host_id: "host", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "capability" });
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "unknown" }), /unsupported/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "session.started" }), /unsupported/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", sequence: 3 }), /contiguous/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", sequence: 1.5 }), /contiguous/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", artifact_refs: ["api_key=secret"] }), /sensitive/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", action_contract_ref: "token=secret" }), /sensitive/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", artifact_refs: "bad" as never }), /array/);
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", artifact_refs: ["same", "same"] }), /unique/);
    const first = f.sessions.append({ session_id: "session", kind: "host.receipt", event_id: "receipt", state_before_ref: null, evidence_refs: ["evidence:1"] });
    assert.equal((first.event as { id: string }).id, "receipt");
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt", event_id: "receipt", evidence_refs: ["evidence:2"] }), /idempotency/);
    f.sessions.append({ session_id: "session", kind: "session.paused" });
    assert.throws(() => f.sessions.append({ session_id: "session", kind: "host.receipt" }), /paused/);
    assert.throws(() => f.sessions.resume({ session_id: "session", actor: "user", reason_digest: "plain-text" }), /digest/);
    f.sessions.resume({ session_id: "session", actor: "user", reason_digest: "sha256:ok" });
    assert.throws(() => f.sessions.resume({ session_id: "session", actor: "user", reason_digest: "sha256:ok" }), /paused/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.29 an independent observer records external outcome facts without turning host claims into outcomes", async () => {
  const f = await fixture();
  try {
    f.trace.start({ trace_id: "trace", task_id: "task", environment_fingerprint: "env" });
    f.store.create("evidence", "confirmed", { confidence: "confirmed" }); f.store.create("evidence", "weak", { confidence: "unverified" });
    const observed = f.observers.observe({ observation_id: "observation", trace_id: "trace", host_id: "host", observer_id: "workspace-checker", observer_kind: "program", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "snapshot:1", evidence_ids: ["confirmed"] });
    assert.equal((observed.observation as { promotion_eligible: boolean }).promotion_eligible, false);
    assert.equal((f.observers.observe({ observation_id: "observation", trace_id: "trace", host_id: "host", observer_id: "workspace-checker", observer_kind: "program", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "snapshot:1", evidence_ids: ["confirmed"] }) as { idempotent: boolean }).idempotent, true);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "host", observer_kind: "program", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:2" }), /independent/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: " ", observer_kind: "program", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:2" }), /observer_id/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "program", environment_fingerprint: "other", verdict: "failed", state_snapshot_ref: "snapshot:2" }), /environment/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "external", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "snapshot:2", evidence_ids: ["weak"] }), /confirmed or bounded/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "bad", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:2" }), /kind/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "external", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "snapshot:2" }), /requires Evidence/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "external", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:2", evidence_ids: "bad" as never }), /array/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "external", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:2", evidence_ids: ["confirmed", "confirmed"] }), /unique/);
    assert.throws(() => f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "other", observer_kind: "external", environment_fingerprint: "env", verdict: "bogus", state_snapshot_ref: "snapshot:2" }), /verdict/);
    assert.throws(() => f.observers.observe({ observation_id: "observation", trace_id: "trace", host_id: "host", observer_id: "workspace-checker", observer_kind: "program", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:1" }), /idempotency/);
    assert.equal((f.observers.get({ observation_id: "observation" }).observation as { id: string }).id, "observation");
    const human = f.observers.observe({ trace_id: "trace", host_id: "host", observer_id: "reviewer", observer_kind: "human", environment_fingerprint: "env", verdict: "failed", state_snapshot_ref: "snapshot:3" });
    assert.match(String((human.observation as { id: string }).id), /^outcome_observation_/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("v0.12.29 exposes the session protocol and observer through CraftService and Full MCP", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store); const mcp = new McpServer(service, "full");
    const call = async (name: string, args: Record<string, unknown>) => mcp.handle({ jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: args } });
    await call("craft_host_session_open", { session_id: "mcp-session", trace_id: "mcp-trace", task_id: "task", host_id: "host", environment_fingerprint: "env", policy_fingerprint: "policy", capability_fingerprint: "capability" });
    await call("craft_host_session_append", { session_id: "mcp-session", kind: "host.dispatched", action_contract_ref: "action:1" });
    await call("craft_host_session_append", { session_id: "mcp-session", kind: "session.paused" });
    await call("craft_host_session_resume", { session_id: "mcp-session", actor: "user", reason_digest: "sha256:resume" });
    const session = await call("craft_host_session_get", { session_id: "mcp-session" }); assert.ok(session);
    f.store.create("evidence", "mcp-evidence", { confidence: "confirmed" });
    const observation = await call("craft_outcome_observer_observe", { observation_id: "mcp-observation", trace_id: "mcp-trace", host_id: "host", observer_id: "checker", observer_kind: "program", environment_fingerprint: "env", verdict: "passed", state_snapshot_ref: "state:1", evidence_ids: ["mcp-evidence"] });
    assert.ok(observation); assert.ok(await call("craft_outcome_observer_get", { observation_id: "mcp-observation" }));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
