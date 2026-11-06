import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/application/craft-service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-mod-trace-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, service: new CraftService(store) };
}

test("a Pilot turn records the active Mod versions and plugin bindings in its Trace", async () => {
  const { store, service } = await fixture();
  try {
    const created = service.modCreate({ name: "no-hardcode", body: "x", scope_kind: "global", plugin_id: "plugin-a" }) as unknown as { id: string };
    service.modApprove({ id: created.id, approved_by: "op" });
    // A draft Mod must not appear in the trace.
    service.modCreate({ name: "draft", body: "y", scope_kind: "global" });
    const sessionId = "session-trace";
    service.pilotSessionOpen({ session_id: sessionId, input: "do a thing" });
    service.pilotTurnSubmit({ session_id: sessionId, input: "do a thing",
      split: [{ title: "t", goal: "g", executor_template: "craft" }] });
    const events = store.events(`pilot:${sessionId}`);
    const trace = events.find((event) => event.event_type === "pilot.turn.mods");
    assert.ok(trace);
    const payload = trace.payload as JsonObject;
    const mods = payload.active_mods as JsonObject[];
    assert.equal(mods.length, 1);
    assert.equal(mods[0].id, created.id);
    // approve() is itself a versioned write, so the active rule is v2.
    assert.equal(mods[0].version, 2);
    assert.equal(mods[0].plugin_id, "plugin-a");
    assert.deepEqual(payload.executors, ["craft"]);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});
