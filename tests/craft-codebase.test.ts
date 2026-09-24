import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { codebaseCapability, CODEBASE_KERNELS } from "../capability/craft-codebase/capability.ts";
import { CodebaseIndexKernel } from "../capability/craft-codebase/codebase-index.ts";
import { CODEBASE_OWNS } from "../capability/craft-codebase/ownership.ts";
import { CRAFT_CAPABILITIES } from "../core/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS } from "../core/capability-protocol.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import { McpServer, surfaceToolNames } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-codebase-")); const project = join(root, "project"); await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "target.ts"), "export function target() { return 1; }\nexport function targetHelper() { return target(); }\nexport const shared = 1;\n");
  await writeFile(join(project, "src", "caller.ts"), "import { target } from './target';\nexport function caller() { missing(); shared(); return target(); }\n");
  await writeFile(join(project, "src", "duplicate.ts"), "export function shared() { return 2; }\n");
  await writeFile(join(project, "src", "external.ts"), "import value from 'outside';\nexport function unrelated() { if (value) return target(); return 0; }\n");
  await writeFile(join(project, "src", "direct.ts"), "import { target } from './target.ts';\nexport const direct = () => target();\n");
  await writeFile(join(project, "src", "view.tsx"), "export const View = () => <div />;\n");
  await writeFile(join(project, "src", "generated.py"), "print('unsupported')\n");
  await writeFile(join(project, "src", "README.md"), "not source\n");
  const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  const workspace = service.workspaceOpen({ workspace_id: "ws", name: "Project", root_path: project, include_paths: ["src"] }).workspace as JsonObject;
  const checkpoint = service.workspaceCheckpoint({ workspace_id: workspace.id, checkpoint_id: "base", label: "base" }).checkpoint as JsonObject;
  return { root, project, store, service, workspace, checkpoint, kernel: service.codebase };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) { f.store.close(); await rm(f.root, { recursive: true, force: true }); }

function active(f: Awaited<ReturnType<typeof fixture>>) { return f.kernel.activate({ workspace_id: f.workspace.id, actor: "tester" }).activation as JsonObject; }
function index(f: Awaited<ReturnType<typeof fixture>>) { return f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }).index as JsonObject; }
function symbol(f: Awaited<ReturnType<typeof fixture>>, indexId: string, query = "target") {
  return (f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: indexId, query }).symbols as JsonObject[])[0];
}

test("craft-codebase is an internal non-context Capability with an owned read-only surface", async () => {
  const f = await fixture();
  try {
    assert.equal(codebaseCapability.name, "codebase"); assert.equal(codebaseCapability.product, undefined); assert.equal(codebaseCapability.contributes, undefined);
    for (const name of ["craft_codebase_activate", "craft_codebase_index_build", "craft_codebase_context_slice"]) assert(CODEBASE_OWNS.test(name));
    assert.equal(CODEBASE_OWNS.test("craft_knowledge_search"), false);
    const disabled = f.kernel.status({ workspace_id: f.workspace.id }); assert.equal(disabled.enabled, false); assert.equal(disabled.readiness, "disabled");
    const defaultActivation = f.kernel.activate({ workspace_id: f.workspace.id, activation_id: "default_activation" }).activation as JsonObject;
    assert.equal(defaultActivation.status, "active"); assert.equal(f.kernel.deactivate({ workspace_id: f.workspace.id, activation_id: "default_activation" }).idempotent, false);
    assert.throws(() => f.kernel.activate({ workspace_id: "../bad" }), /relative|only letters/);
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, { [CORE_KERNELS.store]: f.store, [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG });
    assert(registry.require<CodebaseIndexKernel>(CODEBASE_KERNELS.index));
    assert.equal(CRAFT_CAPABILITIES.includes(codebaseCapability), true);
  } finally { await close(f); }
});

test("craft-codebase is explicit, snapshot-pinned, content-free, and exposes structural queries", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id }), /not explicitly active/);
    const activation = active(f); assert.equal(f.kernel.activate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, true);
    const before = f.kernel.status({ workspace_id: f.workspace.id }); assert.equal(before.enabled, true); assert.equal(before.readiness, "index_required"); assert.equal((before.indexes as JsonObject[]).length, 0);
    const built = f.kernel.build({ workspace_id: f.workspace.id }).index as JsonObject; assert.equal(built.status, "ready"); assert.equal(built.raw_content_stored, false); assert.equal((built.analysis as JsonObject).certainty, "partial"); assert(Number((built.analysis as JsonObject).unsupported_file_count) >= 1); assert.equal(f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }).idempotent, true);
    assert.equal(f.kernel.status({ workspace_id: f.workspace.id }).readiness, "ready");
    const found = f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "TARGET" }); const target = (found.symbols as JsonObject[])[0];
    assert.equal(target.name, "target"); assert.equal((found.receipt as JsonObject).content_free, true); assert.equal((found.receipt as JsonObject).analyzer, "builtin-regex-static-v1"); assert.equal(((found.receipt as JsonObject).analysis as JsonObject).certainty, "partial");
    assert.equal((f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "shared" }).symbols as JsonObject[]).length, 2);
    const callers = f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: built.id, symbol_id: target.id, limit: 1 });
    assert((callers.callers as JsonObject[]).length >= 1); assert.equal((((callers.callers as JsonObject[])[0].edge as JsonObject).confidence), "partial");
    assert(Number(((callers.receipt as JsonObject).query as JsonObject).omitted_count) > 0);
    const impact = f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, limit: 1 }); assert.equal(impact.candidate_only, true); assert.equal((impact.edges as JsonObject[]).length, 1);
    assert((f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 2, limit: 10 }).edges as JsonObject[]).length > 1);
    const direct = symbol(f, String(built.id), "direct"); const slice = f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id, node_ids: [target.id, direct.id], limit: 1 }); assert.equal(slice.content_included, false); assert.equal((slice.references as JsonObject[])[0].path, "src/target.ts"); assert.equal(((slice.receipt as JsonObject).query as JsonObject).omitted_count, 1);
    assert.equal((f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }).receipt as JsonObject).id, (found.receipt as JsonObject).id);
    assert.equal(String((activation as JsonObject).effect), "read_only");
  } finally { await close(f); }
});

test("craft-codebase rejects stale, inactive, unsafe, malformed, and ambiguous inputs without fallback", async () => {
  const f = await fixture();
  try {
    active(f); const built = index(f); const target = symbol(f, String(built.id));
    assert.throws(() => f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: " " }), /must not be empty/);
    assert.throws(() => f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: built.id, node_id: (built.nodes as JsonObject[]).find((node) => node.kind === "file")!.id }), /requires a symbol/);
    assert((f.kernel.findCallers({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id }).callers as JsonObject[]).length > 0);
    assert.throws(() => f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id, node_ids: [] }), /must contain unique/);
    assert.throws(() => f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id }), /must contain unique/);
    assert.throws(() => f.kernel.contextSlice({ workspace_id: f.workspace.id, index_id: built.id, node_ids: [target.id, target.id] }), /must contain unique/);
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: target.id, max_depth: 6 }), /between/);
    assert.throws(() => f.kernel.impact({ workspace_id: f.workspace.id, index_id: built.id, node_id: "missing" }), /not in index/);
    await writeFile(join(f.project, "src", "target.ts"), "export function target() { return 2; }\n");
    const next = f.service.workspaceCheckpoint({ workspace_id: f.workspace.id, checkpoint_id: "next", label: "next" }).checkpoint as JsonObject;
    const stale = f.kernel.status({ workspace_id: f.workspace.id }); assert.equal(stale.readiness, "rebuild_required"); assert.equal(((stale.indexes as JsonObject[])[0].status), "stale");
    assert.throws(() => f.kernel.findSymbol({ workspace_id: f.workspace.id, index_id: built.id, query: "target" }), /stale/);
    assert.equal(f.kernel.deactivate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, false); assert.equal(f.kernel.status({ workspace_id: f.workspace.id }).readiness, "disabled");
    assert.equal(f.kernel.deactivate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, true);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "next" }), /not explicitly active/);
    assert.equal(f.kernel.activate({ workspace_id: f.workspace.id, actor: "tester" }).idempotent, false);
    const rebuilt = f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: next.id }).index as JsonObject;
    assert.equal(rebuilt.status, "ready"); assert.equal((f.store.get("codebase_index", String(built.id))).status, "stale"); assert.equal((f.kernel.status({ workspace_id: f.workspace.id }).indexes as JsonObject[]).length, 2);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: next.id, index_id: built.id }), /idempotency/);
    assert.throws(() => f.kernel.activate({ workspace_id: f.workspace.id, actor: "other" }), /idempotency/);
  } finally { await close(f); }
});

test("craft-codebase checks checkpoint bytes and never follows a snapshot symlink", async () => {
  const f = await fixture();
  try {
    active(f); const snapshotFile = join(String(f.checkpoint.snapshot_root), "src", "target.ts");
    await writeFile(snapshotFile, "tampered"); assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }), /changed since checkpoint/);
    await writeFile(snapshotFile, "export function target() { return 1; }\nexport function targetHelper() { return target(); }\nexport const shared = 1;\n");
    await unlink(snapshotFile); await symlink(join(f.project, "src", "target.ts"), snapshotFile);
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }), /regular files only/);
  } finally { await close(f); }
});

test("craft-codebase rejects malformed checkpoint ownership and unsafe source paths", async () => {
  const f = await fixture();
  try {
    active(f);
    f.store.create("workspace_checkpoint", "foreign", { workspace_id: "other", snapshot_root: f.checkpoint.snapshot_root, entries: [] });
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "foreign" }), /does not belong/);
    f.store.create("workspace_checkpoint", "unsafe", { workspace_id: f.workspace.id, snapshot_root: f.checkpoint.snapshot_root, entries: [{ path: "../outside.ts", digest: "x", size_bytes: 1 }] });
    assert.throws(() => f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "unsafe" }), /unsafe/);
    f.store.create("workspace_checkpoint", "empty", { workspace_id: f.workspace.id, snapshot_root: f.checkpoint.snapshot_root, entries: "not-an-array" });
    assert.equal((f.kernel.build({ workspace_id: f.workspace.id, checkpoint_id: "empty" }).index as JsonObject).source_file_count, 0);
  } finally { await close(f); }
});

test("craft-codebase is reachable only from full MCP and does not widen published component surfaces", async () => {
  const f = await fixture();
  try {
    const full = new McpServer(f.service, "full"); const knowledge = new McpServer(f.service, "component-knowledge");
    assert(full.tools.some((tool) => tool.name === "craft_codebase_status")); assert.equal(knowledge.tools.some((tool) => tool.name === "craft_codebase_status"), false);
    assert.equal(surfaceToolNames("codebase").includes("craft_codebase_symbol_find"), true);
    const activated = await full.handlers.craft_codebase_activate({ workspace_id: f.workspace.id, actor: "mcp" }); assert.equal((activated.activation as JsonObject).status, "active");
    assert.equal((await full.handlers.craft_codebase_status({ workspace_id: f.workspace.id })).readiness, "index_required");
    const built = await full.handlers.craft_codebase_index_build({ workspace_id: f.workspace.id, checkpoint_id: f.checkpoint.id }); assert.equal((built.index as JsonObject).status, "ready");
    const target = ((await full.handlers.craft_codebase_symbol_find({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, query: "target" })).symbols as JsonObject[])[0]!;
    await full.handlers.craft_codebase_callers_find({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, symbol_id: target.id });
    await full.handlers.craft_codebase_impact_query({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_id: target.id });
    await full.handlers.craft_codebase_context_slice({ workspace_id: f.workspace.id, index_id: (built.index as JsonObject).id, node_ids: [target.id] });
    const deactivated = await full.handlers.craft_codebase_deactivate({ workspace_id: f.workspace.id, actor: "mcp" });
    assert.equal((deactivated.activation as JsonObject).status, "disabled");
  } finally { await close(f); }
});
