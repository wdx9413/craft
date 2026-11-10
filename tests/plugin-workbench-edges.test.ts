import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeWorkbenchContribution, readDeclarativePage, validateDeclarativePage } from "../core/plugin-workbench.ts";

test("workbench contribution rejects malformed shapes and records sandboxed pages", () => {
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, contextActions: "bad" as never } }), /must be an array/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, contextActions: [null] } }), /must be an object/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, contextActions: [{ id: "Bad", title: "x", target: "memory" }] } }), /id is invalid/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, contextActions: [{ id: "one", title: "x", target: "memory", contexts: "project" as never }] } }), /contexts must be an array/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, contextActions: [{ id: "one", title: "x", target: "memory", contexts: [] }] } }), /context is not supported/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, contextActions: [{ id: "one", title: "x", target: "memory" }, { id: "one", title: "y", target: "knowledge" }] } }), /ids must be unique/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, advancedTools: [{ id: "Bad", title: "x", tool: "craft_memory_search" }] } }), /id is invalid/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, advancedTools: [{ id: "one", title: "x", tool: "craft_memory_search" }, { id: "one", title: "y", tool: "craft_knowledge_search" }] } }), /ids must be unique/);
  assert.equal(normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, advancedTools: [{ id: "custom", title: "Custom", tool: "external" }] } }).advanced_tools[0]?.supported, false);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, themes: "bad" as never } }), /must be an array/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, themes: [{ id: "Bad", title: "x", tokens: {} }] } }), /id is invalid/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, themes: [{ id: "one", title: "x", tokens: null }] } }), /tokens must be an object/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, themes: [{ id: "one", title: "x", tokens: { "--line": 3 } }] } }), /token is unsupported/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, themes: [{ id: "one", title: "x", tokens: {} }, { id: "one", title: "y", tokens: {} }] } }), /ids must be unique/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: [] as never }), /must be an object/);
  assert.deepEqual(normalizeWorkbenchContribution({ workbench: { schemaVersion: 1 } }), {
    pages: [], context_actions: [], advanced_tools: [], themes: [], notes: []
  });
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: {} as never } }), /must be an array/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [null as never] } }), /must be an object/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "p", title: " ", schema: "s" }] } }), /title/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "p", title: "t", schema: "s", requires: "x" as never }] } }), /requires/);
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1,
    themes: [{ id: "unsafe", title: "Unsafe", tokens: { "--bg-base": "#fff" } }] } }), /token is unsupported/u);
  const sandboxed = normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: [{ id: "p", title: "t", kind: "sandboxed" }] } });
  assert.equal(sandboxed.pages[0]!.kind, "sandboxed");
  assert.match(sandboxed.notes[0]!, /sandboxed/);
  // 33 pages exceeds the cap.
  const many = Array.from({ length: 33 }, (_, i) => ({ id: `p${i}`, title: "t", schema: "s" }));
  assert.throws(() => normalizeWorkbenchContribution({ workbench: { schemaVersion: 1, pages: many } }), /at most 32/);
});

test("declarative pages reject non-objects, deep nesting and non-array actions", () => {
  assert.throws(() => validateDeclarativePage([]), /must be an object/);
  assert.throws(() => validateDeclarativePage({ type: "actions", actions: {} }), /actions must be an array/);
  // Nest deeper than the allowed depth.
  let node: any = { type: "section" };
  for (let i = 0; i < 30; i += 1) node = { type: "section", child: node };
  assert.throws(() => validateDeclarativePage(node), /nests too deeply/);
});

test("declarative page files are confined to the plugin and bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-page-"));
  try {
    const plugin = join(root, "plugin"); await mkdir(join(plugin, "wb"), { recursive: true });
    await writeFile(join(plugin, "wb", "ok.json"), JSON.stringify({ type: "section" }));
    await mkdir(join(plugin, "wb", "dir.json"));
    await writeFile(join(plugin, "wb", "big.json"), "x".repeat(256 * 1024 + 1));
    // Unknown root.
    assert.throws(() => readDeclarativePage(null, "wb/ok.json"), /plugin root is unknown/);
    // Traversal out of the plugin.
    assert.throws(() => readDeclarativePage(plugin, "../escape.json"), /inside the plugin/);
    // Missing file and a directory are refused, not read.
    assert.throws(() => readDeclarativePage(plugin, "wb/missing.json"), /was not found/);
    assert.throws(() => readDeclarativePage(plugin, "wb/dir.json"), /must be a file/);
    // Oversized schema is refused.
    assert.throws(() => readDeclarativePage(plugin, "wb/big.json"), /256 KiB/);
    // A junction that escapes the plugin is refused even though the path looks inside.
    const outside = join(root, "outside"); await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "x.json"), JSON.stringify({ type: "section" }));
    await symlink(outside, join(plugin, "wb", "link"), "junction");
    assert.throws(() => readDeclarativePage(plugin, "wb/link/x.json"), /inside the plugin/);
    // The happy path still parses and validates.
    assert.equal((readDeclarativePage(plugin, "wb/ok.json") as { type: string }).type, "section");
  } finally { await rm(root, { recursive: true, force: true }); }
});
