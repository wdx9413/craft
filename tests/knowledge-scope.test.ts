import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KnowledgeIndex } from "../src/knowledge-index.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function indexUnder(name: string) {
  const root = await mkdtemp(join(tmpdir(), `craft-scope-${name}-${process.pid}-`));
  return { root, index: new KnowledgeIndex(join(root, "index.db")) };
}

test("knowledge scope declaration validates and upserts", async () => {
  const { root, index } = await indexUnder("set");
  try {
    const created = index.setScope([{ path: "a.md", scope: "project" }, { path: "b.md", scope: "task", ttl_days: 1 }]);
    assert.equal(created[0].expires_at, null);
    assert.ok(created[1].expires_at);
    // Re-declaring the same path replaces the row instead of duplicating it.
    const replaced = index.setScope([{ path: "a.md", scope: "user", ttl_days: 30 }]);
    assert.equal(replaced[0].scope, "user");
    assert.equal(index.scopeCatalog().length, 2);

    assert.throws(() => index.setScope("nope" as never), /must be an array/);
    assert.throws(() => index.setScope([null as never]), /must be an object/);
    assert.throws(() => index.setScope([{ path: "x", scope: "galaxy" }]), /Unsupported knowledge scope/);
    assert.throws(() => index.setScope([{ path: "x", scope: "task", ttl_days: 0 }]), /ttl_days/);
    assert.throws(() => index.setScope([{ path: "x", scope: "task", ttl_days: 9_999 }]), /ttl_days/);
    assert.throws(() => index.setScope([{ path: "  ", scope: "task" }]), /scope path/);
    assert.throws(() => index.scopeCatalog("galaxy"), /Unsupported knowledge scope/);
    assert.deepEqual(index.scopeCatalog("user").map((entry) => entry.path), ["a.md"]);
  } finally { index.close(); await rm(root, { recursive: true, force: true }); }
});

test("expired documents are reported and can be forgotten without touching Markdown", async () => {
  const { root, index } = await indexUnder("expire");
  try {
    await writeFile(join(root, "fresh.md"), "# Fresh\nalpha beta gamma");
    await writeFile(join(root, "stale.md"), "# Stale\nalpha beta gamma");
    index.apply({ added: [{ path: "fresh.md", digest: "d1", size_bytes: 10, chunks: 1 },
      { path: "stale.md", digest: "d2", size_bytes: 10, chunks: 1 }], changed: [], removed: [] }, root);
    assert.equal(index.status().documents, 2);

    const now = Date.parse("2026-01-01T00:00:00.000Z");
    index.setScope([{ path: "stale.md", scope: "task", ttl_days: 1 }], now);
    index.setScope([{ path: "fresh.md", scope: "project" }], now);

    // One day later the task note has lapsed; the project note never expires.
    const later = now + 2 * 86_400_000;
    assert.deepEqual(index.expired(later).map((entry) => entry.path), ["stale.md"]);
    const forgotten = index.forgetExpired(later);
    assert.deepEqual(forgotten.forgotten, ["stale.md"]);
    assert.equal(index.status().documents, 1);
    assert.deepEqual(index.scopeCatalog().map((entry) => entry.path), ["fresh.md"]);
    // The Markdown file itself survives: forgetting removes a projection, not a source.
    assert.match(await readFile(join(root, "stale.md"), "utf8"), /Stale/);

    const again = index.forgetExpired(later);
    assert.deepEqual(again.forgotten, []);
  } finally { index.close(); await rm(root, { recursive: true, force: true }); }
});

test("knowledge scope is reachable over MCP and stays out of the search index once forgotten", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-scope-mcp-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const server = new McpServer(service, "full");
  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = response?.result as JsonObject;
    assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
    return result.structuredContent as JsonObject;
  };
  try {
    await writeFile(join(root, "note.md"), "# Note\nalpha beta gamma");
    await call("craft_knowledge_index_sync", { project_root: root });
    const set = await call("craft_knowledge_scope_set", { entries: [
      { path: "note.md", scope: "task", ttl_days: 1 },
    ] });
    assert.equal((set.entries as JsonObject[]).length, 1);
    const listed = await call("craft_knowledge_scope_list", {});
    assert.equal((listed.entries as JsonObject[]).length, 1);
    assert.deepEqual(listed.expired, []);
    const scoped = await call("craft_knowledge_scope_list", { scope: "project" });
    assert.equal((scoped.entries as JsonObject[]).length, 0);
    await call("craft_knowledge_scope_forget", {});
    const after = await call("craft_knowledge_scope_list", {});
    assert.equal((after.entries as JsonObject[]).length, 1);

    const badEntries = await server.handle({ id: 2, method: "tools/call", params: { name: "craft_knowledge_scope_set",
      arguments: { entries: "nope" } } });
    assert.equal(((badEntries?.result as JsonObject).isError), true);
    const badEntry = await server.handle({ id: 3, method: "tools/call", params: { name: "craft_knowledge_scope_set",
      arguments: { entries: [1] } } });
    assert.equal(((badEntry?.result as JsonObject).isError), true);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
