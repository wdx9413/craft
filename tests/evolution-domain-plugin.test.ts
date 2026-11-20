import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { mintEvolutionProjectBinding } from "../core/evolution-project-binding.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { McpServer } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";
import { parseToolName } from "../core/tool-plane.ts";

test("Context plugin serves scoped artifact, intention, travel, and research lifecycles", async t => {
  const root = await mkdtemp(join(tmpdir(), "craft-domain-plugin-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  try {
    const service = await CraftService.open(store);
    const mcp = new McpServer(service, "component-context-agent");
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    async function bind(project: string, host: "codex" | "claude") {
      const projectRoot = join(root, project);
      await mkdir(projectRoot);
      const identity = service.scopeIdentityResolveProject({ project_root: projectRoot }).identity as JsonObject;
      const scope = identity.canonical_scope as { kind: "project"; id: string };
      return mintEvolutionProjectBinding(store, { host, session_id: project, turn_id: "turn-1",
        project_root: projectRoot, scope });
    }
    const alpha = await bind("alpha", "codex");
    const beta = await bind("beta", "claude");
    async function call(name: string, args: JsonObject, projectBinding = alpha) {
      const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
        name: "craft_run", arguments: { ...parseToolName(`craft_evolution_${name}`), args: { ...args, project_binding: projectBinding } },
      } });
      assert.ok(response?.result, JSON.stringify(response));
      return response.result as JsonObject;
    }
    async function run(name: string, args: JsonObject, projectBinding = alpha) {
      const result = await call(name, args, projectBinding);
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent as JsonObject;
    }

    const handoff = await run("artifact_lineage_record", { artifact_type: "text", source_refs: ["doc://handoff"] });
    const releaseNotes = await run("artifact_lineage_record", { artifact_type: "text", source_refs: ["doc://release-notes"] });
    const office = await run("artifact_lineage_recall", { artifact_type: "text" });
    assert.deepEqual(new Set((office.items as JsonObject[]).map(item => item.id)), new Set([handoff.id, releaseNotes.id]));

    for (const [family, write, type] of [["artifact_lineage", "record", "slides"], ["creation", "write", "image"]] as const) {
      const ref = await run(`${family}_${write}`, { artifact_type: type, reliability: 0.8, source_refs: ["asset://local"] });
      assert.deepEqual((await run(`${family}_recall`, { artifact_type: type }, beta)).items, []);
      assert.equal((await call(`${family}_apply`, { id: ref.id }, beta)).isError, true);
      assert.deepEqual((await run(`${family}_apply`, { id: ref.id, expected_version: ref.version })).source_refs, ["asset://local"]);
      assert.equal((await run(`${family}_forget`, { id: ref.id })).status, "forgotten");
      assert.equal((await call(`${family}_apply`, { id: ref.id })).isError, true);
      assert.deepEqual((await run(`${family}_recall`, { artifact_type: type })).items, []);
    }

    const trigger = { state: "report_ready" };
    const intent = await run("prospective_create", { intention: "Prepare the team report", trigger,
      not_before: new Date(now + 1000).toISOString(), expires_at: new Date(now + 3000).toISOString() });
    assert.deepEqual((await run("prospective_list", {}, beta)).items, []);
    assert.equal((await call("prospective_fire", { id: intent.id, trigger }, beta)).isError, true);
    assert.equal((await run("prospective_fire", { id: intent.id, trigger })).reason, "not_before");
    now += 1500;
    assert.equal((await run("prospective_fire", { id: intent.id, trigger: { state: "draft" } })).reason, "trigger_mismatch");
    const matched = await run("prospective_fire", { id: intent.id, trigger });
    assert.equal(matched.status, "awaiting_host");
    assert.equal((matched.receipt as JsonObject).action_authorized, false);
    assert.equal((await run("prospective_fire", { id: intent.id, trigger })).version, matched.version);
    now += 2000;
    assert.equal((await run("prospective_fire", { id: intent.id, trigger })).status, "expired");
    assert.equal((await run("prospective_revoke", { id: intent.id })).status, "revoked");
    assert.equal((await run("prospective_fire", { id: intent.id, trigger })).status, "revoked");

    const trip = await run("travel_capture", { statement: "我偏好高铁靠窗座位；预算不超过 8000 元；航班 MU523" });
    const flight = (trip.plans as JsonObject[]).find(item => item.kind === "booking")!;
    assert.equal((await call("travel_recall", { now: "2001-01-01", include_stale: true })).isError, true);
    assert.equal((await call("travel_capture", { statement: "航班 MU52", now: "2099-01-01" })).isError, true);
    assert.deepEqual((await run("travel_recall", {}, beta)).items, []);
    assert.equal((await call("travel_apply", { memory_id: flight.id }, beta)).isError, true);
    assert.equal((await run("travel_apply", { memory_id: flight.id })).status, "applied");
    await run("travel_forget", { memory_id: flight.id });
    assert.equal((await call("travel_apply", { memory_id: flight.id })).isError, true);
    assert.deepEqual((await run("travel_recall", { query: "MU523" })).items, []);

    await run("research_capture", { id: "premise", content: "Published premise", layer: "literature_fact", source_refs: ["doi:10.0/example"] });
    await run("research_capture", { id: "result", content: "Replication measurement", layer: "experiment_observation" });
    await run("research_link", { source_id: "result", target_id: "premise", relation: "derives_from" });
    assert.deepEqual((await run("research_recall", {}, beta)).items, []);
    assert.equal((await call("research_impact", { node_id: "premise" }, beta)).isError, true);
    assert.equal(((await run("research_impact", { node_id: "premise" })).impacted as JsonObject[]).length, 1);
    const candidate = await run("replication_propose", { id: "replicate", title: "Reproduce the measurement",
      source_id: "premise", steps: ["Repeat the measurement"] });
    assert.deepEqual(candidate.source_ref, { id: "premise", kind: "knowledge_claim", version: 1 });
    await run("research_forget", { id: "result" });
    assert.deepEqual((await run("research_impact", { node_id: "premise" })).impacted, []);
    assert.equal((await call("research_impact", { node_id: "result" })).isError, true);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
