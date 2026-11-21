import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ComponentAssets } from "../core/application/coordinators/component-assets.ts";

test("exact asset reads distinguish storage failure, expiry and withdrawn source authority", async t => {
  const root = mkdtempSync(join(tmpdir(), "craft-reference-lifecycle-"));
  const store = await new CraftStore(craftPaths(root)).open({ fileRecords: true, ownerRecords: true });
  const assets = new ComponentAssets(store), scope = { kind: "global", id: "global" };
  const args = { asset_id: "memory", scope_kind: "global", scope_id: "global" };
  const source = { scope, status: "active", trust: "verified" };
  const memory = { scope, source_id: "source", status: "active", content: "Synthetic reader contract." };
  const resolve = (reference: unknown) => assets.inspect("memory", { ...args, action: "resolve", reference });
  try {
    store.create("knowledge_source", "source", source); store.create("memory_ledger", "memory", memory);
    const reference = assets.inspect("memory", { ...args, action: "reference", version: 1 }).reference;
    assert.equal(resolve(reference).status, "resolved");
    assert.equal(resolve({ ...reference, scope: { kind: "global", id: "other" } }).status, "denied");
    assert.equal(resolve({ ...reference, id: "missing" }).status, "missing");
    assert.equal(resolve({ ...reference, version: 2 }).status, "version_mismatch");
    assert.equal(resolve({ ...reference, digest: "wrong-digest" }).status, "digest_mismatch");
    const get = store.get.bind(store);
    const broken = t.mock.method(store, "get", (kind: string, id: string, ...rest: [number?]) => {
      if (kind === "memory_ledger") throw new Error("Record file digest drifted");
      return get(kind, id, ...rest);
    });
    assert.equal(resolve(reference).status, "digest_mismatch"); broken.mock.restore();
    const unavailable = t.mock.method(store, "get", () => { throw new Error("Storage unavailable"); });
    assert.equal(resolve(reference).status, "unavailable"); unavailable.mock.restore();
    const missing = t.mock.method(store, "get", (kind: string, id: string, ...rest: [number?]) => kind === "memory_ledger"
      ? { ...get(kind, id, ...rest), content_unavailable: true } : get(kind, id, ...rest));
    assert.equal(resolve(reference).status, "unavailable"); missing.mock.restore();
    store.save("knowledge_source", "source", { ...source, trust: "untrusted" });
    assert.equal(resolve(reference).status, "revoked");
    store.save("knowledge_source", "source", { ...source, valid_until: "2000-01-01T00:00:00Z" });
    assert.equal(resolve(reference).status, "expired");
    store.save("knowledge_source", "source", source);
    store.save("memory_ledger", "memory", { ...memory, valid_until: "2000-01-01T00:00:00Z" });
    assert.equal(resolve(reference).status, "expired");
    store.save("memory_ledger", "memory", { ...memory, status: "expired" }); assert.equal(resolve(reference).status, "expired");
    store.save("memory_ledger", "memory", { ...memory, status: "superseded" }); assert.equal(resolve(reference).status, "revoked");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("exact procedure and Codebase references recheck the current release and checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-reference-activation-"));
  const store = await new CraftStore(craftPaths(root)).open({ fileRecords: true, ownerRecords: true }), assets = new ComponentAssets(store);
  const procedure = { scope: "global", lifecycle: "routeable", routeable: true, definition_digest: "fixture-v1" };
  const pArgs = { asset_id: "procedure", scope_kind: "global", scope_id: "global" };
  try {
    // Reader fixtures deliberately bypass admission. They never claim evaluation or execution qualification.
    store.create("experience_procedure", "canonical-project", { ...procedure, scope: "project:canonical-fixture" });
    const canonical = assets.inspect("experience", { asset_id: "canonical-project", scope_kind: "project", scope_id: "project:canonical-fixture", action: "reference", version: 1 }).reference;
    assert.equal(assets.inspect("experience", { asset_id: "canonical-project", scope_kind: "project", scope_id: "project:canonical-fixture", action: "resolve", reference: canonical }).status, "resolved");
    assert.throws(() => assets.inspect("experience", { asset_id: "canonical-project", scope_kind: "project", scope_id: "project:foreign", action: "read", version: 1 }), /scope or audience denied/u);
    store.create("experience_procedure", "procedure", procedure);
    const reference = assets.inspect("experience", { ...pArgs, action: "reference", version: 1 }).reference;
    const resolve = () => assets.inspect("experience", { ...pArgs, action: "resolve", reference });
    assert.equal(resolve().status, "resolved");
    store.save("experience_procedure", "procedure", { ...procedure, definition_digest: "fixture-v2" });
    assert.equal(resolve().status, "revoked");
    store.save("experience_procedure", "procedure", { ...procedure, lifecycle: "rolled_back", routeable: false });
    assert.equal(resolve().status, "revoked");
    store.create("workspace", "workspace", { latest_checkpoint_id: "checkpoint" });
    store.create("codebase_activation", "codebase_activation_workspace", { status: "active" });
    store.create("codebase_index", "index", { workspace_id: "workspace", checkpoint_id: "checkpoint", input_digest: "fixture" });
    const cArgs = { asset_id: "index", scope_kind: "workspace", scope_id: "workspace" };
    const code = assets.inspect("codebase", { ...cArgs, action: "reference", version: 1 }).reference;
    const codeResolve = () => assets.inspect("codebase", { ...cArgs, action: "resolve", reference: code });
    assert.equal(codeResolve().status, "resolved");
    store.save("codebase_activation", "codebase_activation_workspace", { status: "disabled" }); assert.equal(codeResolve().status, "revoked");
    store.save("codebase_activation", "codebase_activation_workspace", { status: "active" });
    store.save("workspace", "workspace", { latest_checkpoint_id: "new-checkpoint" }); assert.equal(codeResolve().status, "revoked");
    store.remove("workspace", "workspace"); assert.equal(codeResolve().status, "revoked");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
