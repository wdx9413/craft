import assert from "node:assert/strict";
import test from "node:test";
import { surfaceToolNames, TOOLS } from "../core/mcp.ts";
import { discoverContextTools } from "../core/mcp/context-tools.ts";

const GENERAL_EVOLUTION_TOOLS = [
  "craft_evolution_value_decide", "craft_evolution_domain_adapters", "craft_evolution_domain_capture",
  "craft_evolution_program_memory_capture", "craft_evolution_program_memory_list", "craft_evolution_program_memory_submit",
  "craft_evolution_program_memory_submission_due", "craft_evolution_program_memory_promote", "craft_evolution_program_memory_feedback", "craft_evolution_failure_capture",
  "craft_evolution_runbook_capture", "craft_evolution_runbook_revoke",
  "craft_evolution_research_capture", "craft_evolution_research_recall", "craft_evolution_research_impact",
  "craft_evolution_research_forget", "craft_evolution_replication_propose",
  "craft_evolution_travel_capture", "craft_evolution_travel_recall", "craft_evolution_travel_apply", "craft_evolution_travel_forget",
  "craft_evolution_creation_write", "craft_evolution_creation_recall", "craft_evolution_creation_apply", "craft_evolution_creation_forget",
  "craft_evolution_artifact_lineage_record", "craft_evolution_artifact_lineage_recall",
  "craft_evolution_prospective_create", "craft_evolution_prospective_fire", "craft_evolution_eval_summary",
] as const;

test("the full surface exposes general self-evolution tools", () => {
  const full = new Set(surfaceToolNames("full"));
  for (const name of GENERAL_EVOLUTION_TOOLS) {
    assert.ok(full.has(name), `${name} must exist in the full surface`);
    assert.ok(TOOLS.some((tool) => tool.name === name), `${name} must exist in the live catalog`);
  }
});

test("Context discovery exposes project-bound evolution operations with a binding requirement", () => {
  const { tools } = discoverContextTools({ intent: "evolution" }) as { tools: {
    name: string; inputSchema: { required: string[] }; syscall_route: { tool: string };
  }[] };
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const name of ["craft_evolution_program_memory_submit", "craft_evolution_program_memory_submission_due", "craft_evolution_artifact_lineage_forget",
    "craft_evolution_prospective_fire", "craft_evolution_travel_apply", "craft_evolution_research_impact"]) {
    assert.ok(byName.get(name)?.inputSchema.required.includes("project_binding"), name);
    assert.equal(byName.get(name)?.syscall_route.tool, "craft_run");
  }
  assert.equal(byName.has("craft_evolution_domain_adapters"), false);
});

test("split component surfaces never own independent self-evolution state", () => {
  // A split surface may project a subset, but every projected self-evolution
  // tool must be the same catalog entry the full surface exposes.
  for (const surface of ["component-knowledge", "component-memory", "component-experience", "component-codebase"]) {
    const projected = surfaceToolNames(surface);
    for (const name of projected) {
      if (!name.startsWith("craft_evolution_")) continue;
      assert.ok(GENERAL_EVOLUTION_TOOLS.includes(name as typeof GENERAL_EVOLUTION_TOOLS[number]),
        `${surface} projected an unknown self-evolution tool ${name}`);
    }
  }
});

test("no old file-dir-desc naming leaks through any surface projection", () => {
  for (const surface of ["full", "component-context-agent", "component-knowledge", "component-memory", "component-experience", "component-codebase"]) {
    for (const name of surfaceToolNames(surface)) {
      assert.equal(/file[-_]dir[-_]desc/iu.test(name), false, `${surface} still projects ${name}`);
    }
  }
});
