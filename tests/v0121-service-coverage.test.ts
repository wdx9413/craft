import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";
import { defineHostProfile, type HostProfile } from "../src/host-registry.ts";

async function fixture(name: string, hostProfiles?: HostProfile[]) {
  const root = await mkdtemp(join(tmpdir(), `craft-svc-${name}-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, hostProfiles);
  return { root, store, service };
}

const ghost = () => defineHostProfile({
  host: "ghost-cli", kind: "agent-cli", command: "ghost", output_format: "text",
  argv_template: ["-p", "{prompt}"],
});

test("a launch whose host profile disappeared fails closed", async () => {
  const f = await fixture("ghost", [ghost()]);
  try {
    const task = f.store.create("task", `task_${process.pid}`, { title: "t", goal: "g" });
    // A launch prepared under a host profile that was later removed from config:
    // the record still names the host, but no driver can serve it any more.
    f.store.create("work_launch", "launch_ghost", { task_id: task.id, host: "ghost-cli", workspace: f.root,
      sandbox: "read-only", status: "failed", prompt_digest: "sha256:" + "0".repeat(64) });
    const narrowed = new CraftService(f.store);
    const mcp = new McpServer(narrowed, "full");
    await assert.rejects(async () => mcp.handlers.craft_work_launch_retry({ launch_id: "launch_ghost", prompt: "go" }),
      /host is unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("workflow registry scan and retirement honour explicit limits and policy", async () => {
  const f = await fixture("wf");
  try {
    await mkdir(join(f.root, "workflows"), { recursive: true });
    await writeFile(join(f.root, "workflows", "a.workflow.json"), JSON.stringify({ id: "alpha", title: "A", steps: [{ type: "command", command: ["echo"] }] }));
    await writeFile(join(f.root, "workflows", "b.workflow.json"), JSON.stringify({ id: "beta", title: "B", steps: [{ type: "command", command: ["echo"] }] }));
    const mcp = new McpServer(f.service, "full");
    const scan = await mcp.handlers.craft_workflow_registry_scan({ project_root: join(f.root, "workflows"), limit: 5 }) as JsonObject;
    assert.equal((scan.descriptors as JsonObject[]).length, 2);
    await assert.rejects(async () => mcp.handlers.craft_workflow_registry_scan({ project_root: join(f.root, "workflows"), limit: 1 }), /exceeds 1 files/);

    f.store.create("workflow_run", "run_a", { workflow_id: "alpha", workflow_version: 1, status: "passed", created_at: new Date().toISOString() });
    f.store.create("workflow_run", "run_b", { workflow_id: "beta", workflow_version: 1, status: "failed", created_at: new Date().toISOString() });
    const plan = await mcp.handlers.craft_workflow_retirement_plan({ workflow_ids: ["alpha"],
      policy: { min_uses: 3, stale_days: 30, min_success_rate: 0.9 }, now: new Date().toISOString() }) as JsonObject;
    const decisions = plan.decisions as JsonObject[];
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].workflow_id, "alpha");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("knowledge index falls back to its default file and accepts explicit limits", async () => {
  const f = await fixture("kn");
  try {
    const paths = { ...craftPaths(f.root) } as Record<string, unknown>;
    delete paths.knowledgeIndex;
    const store = await new CraftStore(paths as never).open();
    const service = new CraftService(store);
    const mcp = new McpServer(service, "full");
    await writeFile(join(f.root, "a.md"), "# A\nalpha beta gamma");
    const sync = await mcp.handlers.craft_knowledge_index_sync({ project_root: f.root, limit: 10 }) as JsonObject;
    assert.equal(sync.documents, 1);
    const search = await mcp.handlers.craft_knowledge_search({ query: "alpha", limit: 5 }) as JsonObject;
    assert.equal((search.hits as JsonObject[]).length, 1);
    store.close();
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("execution budget plan handles defaults, tiers and truncation", async () => {
  const f = await fixture("budget");
  try {
    const mcp = new McpServer(f.service, "full");
    const minimal = await mcp.handlers.craft_execution_budget_plan({ host: "codex-cli", limit: 100 }) as JsonObject;
    assert.equal(minimal.estimated_tokens, 0);
    assert.equal(minimal.truncation, null);
    const full = await mcp.handlers.craft_execution_budget_plan({ host: "codex-cli", limit: 100_000, reserve: 10,
      texts: ["hello"], steps: 20, distinct_paths: 20, max_result_tokens: 1,
      tiers: { frontier: "strong-model" } }) as JsonObject;
    assert.equal(full.complexity, "frontier");
    assert.equal((full.routing as JsonObject).model, "strong-model");
    assert.equal((full.truncation as JsonObject).truncated, true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("hook run accepts an explicit payload object", async () => {
  const f = await fixture("hookpayload");
  try {
    const mcp = new McpServer(f.service, "full");
    const run = await mcp.handlers.craft_hook_run({ point: "after_receipt",
      hooks: [{ id: "a", point: "after_receipt", kind: "builtin", target: "builtin:receipt-check" }],
      payload: { receipt_id: "r1" } }) as JsonObject;
    assert.equal(run.blocked, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
