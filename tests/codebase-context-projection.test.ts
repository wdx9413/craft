import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CodebaseIndexKernel } from "../capability/craft-codebase/codebase-index.ts";
import { contextAssetRef } from "../common/craft-common-base/src/context-assets.ts";
import { payload } from "../core/digest.ts";
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-codebase-projection-")), repo = join(root, "repo"); mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q"]);
  writeFileSync(join(repo, "login.ts"), "export function loginUser() { return true; }\n");
  writeFileSync(join(repo, "other.ts"), "export function untouched() { return false; }\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(), writer = await new CraftStore(craftPaths(join(root, "data"))).open(), service = new CraftService(store);
  const ensured = service.codebaseRepositoryEnsure({ project_root: repo });
  const args = { workspace_id: ensured.workspace_id, index_id: ensured.index_id, query: "login" };
  const sdk = new CodebaseIndexKernel(store);
  return { root, repo, store, writer, service, sdk, args, close() { writer.close(); store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Codebase SDK owns bounded candidates, mandatory completion and exact normalized references", async () => {
  const f = await fixture();
  try {
    const projection = f.sdk.contextProjection(f.args), candidates = projection.candidates as JsonObject[];
    assert(candidates.length > 0); assert(candidates.every(item => item.version === 1 && item.index_id === f.args.index_id));
    assert(!("nodes" in projection)); assert(!JSON.stringify(projection).includes("return true"));
    f.sdk.assertContextProjectionCurrent(projection, candidates);
    const scope = { kind: "project", id: "p" };
    const required = contextAssetRef("codebase", candidates[0]!, scope);
    const noHit = f.sdk.contextProjection({ ...f.args, query: "unmatched", required_refs: [required], scope });
    assert.equal((noHit.candidates as JsonObject[]).length, 1);
    const normal = f.sdk.contextProjection({ ...f.args, required_refs: [required, { member: "memory", id: "m" }], scope }); assert((normal.candidates as JsonObject[]).length);
    const short = f.sdk.contextProjection({ ...f.args, limit: 1 }); assert(Number(short.query_omitted_count) > 0);
    assert.equal((f.sdk.contextProjection({ ...f.args, query: "unmatched" }).candidates as JsonObject[]).length, 0);
    assert.throws(() => f.sdk.contextProjection({ ...f.args, required_refs: "bad" }), /array/);
    assert.throws(() => f.sdk.contextProjection({ ...f.args, required_refs: [{ ...required, digest: "wrong" }] }), /unavailable/);
    assert.throws(() => f.sdk.contextProjection({ ...f.args, workspace_id: "other" }), /requested workspace/);
    assert.throws(() => f.sdk.contextProjection({ ...f.args, query: "" }), /query/);
    assert.throws(() => f.sdk.contextProjection({ ...f.args, limit: 101 }), /limit/);
    assert.throws(() => f.sdk.assertContextProjectionCurrent(projection, [{ ...candidates[0], path: "outside.ts" }]), /not projected/);
    assert.throws(() => f.sdk.assertContextProjectionCurrent({ ...projection, candidates: [{ ...candidates[0], path: "outside.ts" }] }, [{ ...candidates[0], path: "outside.ts" }]), /outside checkpoint/);
  } finally { f.close(); }
});

for (const mutation of ["index", "checkpoint", "deactivate", "file", "config"] as const) {
  test(`projection rejects ${mutation} drift before Context pack publication`, async t => {
    const f = await fixture();
    try {
      const original = f.service.contextWorkingSets.resolve.bind(f.service.contextWorkingSets);
      t.mock.method(f.service.contextWorkingSets, "resolve", async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (mutation === "index") { const row = f.writer.get("codebase_index", String(f.args.index_id)); f.writer.save("codebase_index", String(row.id), { ...payload(row), status: "stale" }); }
        else if (mutation === "checkpoint") f.service.workspaceCheckpoint({ workspace_id: f.args.workspace_id, label: "new snapshot" });
        else if (mutation === "deactivate") f.service.codebaseDeactivate({ workspace_id: f.args.workspace_id });
        else if (mutation === "config") writeFileSync(join(f.repo, ".craft-codebase.json"), '{"enabled":false}');
        else writeFileSync(join(f.repo, "login.ts"), "export function loginUser() { return false; }\n");
        return result;
      });
      await assert.rejects(f.service.contextOpen({ project_root: f.repo, query: "login code" }), /changed|active|stale/);
      assert.equal(f.store.count("context_pack_receipt"), 0);
    } finally { f.close(); }
  });
}

test("Context consumes Codebase projection methods without reaching into the index", async t => {
  const f = await fixture();
  try {
    const projection = f.sdk.contextProjection(f.args), originalGet = f.store.get.bind(f.store);
    t.mock.method(f.service.codebase, "contextProjection", (args: JsonObject) => { assert.equal(args.query, "login code"); return projection; });
    let rechecked = false;
    t.mock.method(f.service.codebase, "assertContextProjectionCurrent", (actual: JsonObject, refs: JsonObject[]) => { assert.equal(actual, projection); assert(refs.length > 0); rechecked = true; });
    t.mock.method(f.store, "get", (...args: Parameters<typeof originalGet>) => { assert.notEqual(args[0], "codebase_index"); return originalGet(...args); });
    const result = await f.service.contextOpen({ project_root: f.repo, query: "login code" });
    assert((result.codebase as JsonObject).references instanceof Array); assert(rechecked);
  } finally { f.close(); }
});

test("projection pins repository configuration without following links", async () => {
  const f = await fixture();
  try {
    const path = join(f.repo, ".craft-codebase.json");
    writeFileSync(path, '{"enabled":true}');
    const projection = f.sdk.contextProjection(f.args);
    assert.equal(typeof projection.configuration_digest, "string");
    f.sdk.assertContextProjectionCurrent(projection, []);
    rmSync(path); symlinkSync(join(f.repo, "login.ts"), path);
    assert.throws(() => f.sdk.contextProjection(f.args), /regular|symlink/);
  } finally { f.close(); }
});
