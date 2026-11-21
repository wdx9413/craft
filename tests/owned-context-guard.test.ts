import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { ContextReadGuard, assertContextReadCurrent, type ContextReadRef } from "../core/context-access-guard.ts";

test("owner-qualified authorization fences cannot use a same-id local row when that owner is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-read-fence-"));
  const runtime = await openCapabilityService("context", { CRAFT_DATA_DIR: root });
  const ref = { owner: "memory", kind: "memory_ledger", id: "same-id", version: 1 } as ContextReadRef;
  try {
    runtime.store.create("memory_ledger", "same-id", { scope: { kind: "project", id: "fixture" }, status: "active" });
    assert.throws(() => new ContextReadGuard(runtime.store, [ref]), /owner is unavailable/u);
    assert.throws(() => assertContextReadCurrent(runtime.store, { read_refs: [ref] }), /owner is unavailable/u);
    const guard = new ContextReadGuard(runtime.store);
    assert.throws(() => guard.track("memory_ledger", "same-id"), /memory owner is unavailable/u);
    assert.throws(() => guard.track("experience_procedure", "same-id"), /experience owner is unavailable/u);
    assert.throws(() => guard.track("knowledge_claim", "same-id"), /knowledge owner is unavailable/u);
    assert.throws(() => guard.contribution("memory", {}), /memory owner is unavailable/u);
    guard.assertCurrent(); assert.deepEqual(guard.refs(), []); assertContextReadCurrent(runtime.store, null);
    const stores = new Map([["memory", runtime.store]]);
    const current = new ContextReadGuard(runtime.store, undefined, undefined, [], stores);
    current.track("memory_ledger", "same-id", 1, "memory"); current.assertCurrent();
    const receipt = { read_refs: current.refs() }; assertContextReadCurrent(runtime.store, receipt, stores);
    new ContextReadGuard(runtime.store, current.refs(), undefined, [], stores).assertCurrent();
    runtime.store.save("memory_ledger", "same-id", { scope: { kind: "project", id: "fixture" }, status: "revoked" });
    assert.throws(() => assertContextReadCurrent(runtime.store, receipt, stores));
  } finally { runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
