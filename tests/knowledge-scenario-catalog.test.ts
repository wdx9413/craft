import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { knowledgeScenarioCanClassify, knowledgeScenarioIsActive, listKnowledgeScenarios, proposeKnowledgeScenarioMigration, recordKnowledgeScenario, retireKnowledgeScenario, updateKnowledgeScenarioClaim, validateKnowledgeScenarioDefinition } from "../capability/craft-knowledge/scenario-catalog.ts";

const args = { project_id: "project-a", scenario_key: "engineering.build.typescript", coarse_scenario_key: "engineering.build",
  claim_id: "claim-a", source_id: "source-a", evidence_ids: ["evidence-a"], status: "candidate" as const,
  definition: { summary: "工程构建中的 TypeScript 规则", applies_when: "内容适用于 TypeScript 构建", excludes: "与构建无关的代码规范" },
  coarse_definition: { summary: "项目工程构建", applies_when: "内容属于项目构建或验证", excludes: "业务领域知识" } };

test("Knowledge scenario catalog stores claim references and promotes on independent reviewed Sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenarios-")), knowledgeDir = join(root, "knowledge");
  try {
    const first = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir });
    assert.equal(first.status, "candidate");
    const reviewedFirst = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, status: "reviewed" });
    assert.equal(reviewedFirst.reviewed_source_count, 1);
    assert.equal(reviewedFirst.status, "candidate");
    const independent = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, claim_id: "claim-b", source_id: "source-b", evidence_ids: ["evidence-b"], status: "reviewed" });
    assert.equal(independent.status, "active");
    assert.equal(independent.reviewed_source_count, 2);
    recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, scenario_key: "engineering.build.docs", claim_id: "claim-c", source_id: "source-c", status: "reviewed" });
    const secondScene = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, scenario_key: "engineering.build.docs", claim_id: "claim-d", source_id: "source-d", status: "reviewed" });
    assert.equal(secondScene.status, "active");
    assert.equal(secondScene.coarse_lifecycle, "active");

    const path = join(knowledgeDir, "projects", "project-a", "knowledge-scenarios.json");
    const catalog = JSON.parse(await readFile(path, "utf8")) as JsonObject;
    const entries = catalog.scenarios as JsonObject[];
    assert.equal(catalog.schema, "craft.knowledge-scenario-catalog.v1");
    assert.equal(entries.length, 3);
    assert.equal(JSON.stringify(catalog).includes("knowledge body"), false);
    const fine = entries.find(item => item.scenario_key === args.scenario_key)!;
    assert.equal(fine.lifecycle, "active");
    assert.deepEqual((fine.claim_refs as JsonObject[]).map(item => item.source_id), ["source-a", "source-b"]);
    const listed = listKnowledgeScenarios(knowledgeDir, "project-a");
    const listedFine = (listed.scenarios as JsonObject[]).find(item => item.scenario_key === args.scenario_key)!;
    const listedCoarse = (listed.scenarios as JsonObject[]).find(item => item.scenario_key === "engineering.build")!;
    assert.equal(listed.catalog_version, 5);
    assert.equal(listedFine.reviewed_source_count, 2);
    assert.deepEqual(listedFine.definition, args.definition);
    assert.deepEqual(listedCoarse.definition, args.coarse_definition);
    assert.equal(listedCoarse.active_fine_child_count, 2);
    assert.equal(JSON.stringify(listed).includes("evidence_ids"), false);

    const demoted = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, claim_id: "claim-b", source_id: "source-b", status: "inactive" });
    assert.equal(demoted.status, "candidate");
    assert.equal(demoted.reviewed_source_count, 1);
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, args.project_id, args.scenario_key), false);
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, args.project_id, "engineering.build.docs"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario catalog normalizes canonical project scope ids at its public boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenarios-canonical-")), knowledgeDir = join(root, "knowledge");
  try {
    const saved = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, project_id: "project:canonical-project", definition: undefined, coarse_definition: undefined });
    assert.equal(saved.scenario_key, args.scenario_key);
    assert.equal(listKnowledgeScenarios(knowledgeDir, "project:canonical-project").catalog_version, 1);
    assert.equal("definition" in ((listKnowledgeScenarios(knowledgeDir, "canonical-project").scenarios as JsonObject[])[0] ?? {}), false);
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, "project:canonical-project", args.scenario_key), false);
    assert.equal(fs.existsSync(join(knowledgeDir, "projects", "canonical-project", "knowledge-scenarios.json")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario reads an absent data root as an empty scope catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-empty-scenarios-"));
  try {
    assert.deepEqual(listKnowledgeScenarios(join(root, "not-created"), "project-a"), { catalog_version: 0, scenarios: [] });
    assert.deepEqual(listKnowledgeScenarios(join(root, "not-created"), "global", "global"), { catalog_version: 0, scenarios: [] });
    assert.equal(knowledgeScenarioIsActive(join(root, "not-created"), "global", "scene.one", "global"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario catalog propagates a non-ENOENT root inspection failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-scenario-root-file-"));
  try {
    const fileRoot = join(root, "not-a-directory");
    await writeFile(fileRoot, "file", "utf8");
    assert.throws(() => listKnowledgeScenarios(fileRoot, "project-a"), /regular directories/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Knowledge global scenario scope requires the canonical global identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-scenario-global-id-"));
  try {
    assert.throws(() => listKnowledgeScenarios(root, "not-global", "global"), /global scenario scope identity is invalid/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("global Knowledge scenarios use an isolated catalog and independent promotion evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-global-scenarios-")), knowledgeDir = join(root, "knowledge");
  try {
    const globalArgs = { ...args, project_id: "global", scope_kind: "global" as const, knowledge_dir: knowledgeDir };
    assert.equal(recordKnowledgeScenario(globalArgs).status, "candidate");
    const first = recordKnowledgeScenario({ ...globalArgs, status: "reviewed" });
    assert.equal(first.status, "candidate");
    const second = recordKnowledgeScenario({ ...globalArgs, claim_id: "global-claim-b", source_id: "global-source-b", status: "reviewed" });
    assert.equal(second.status, "active");
    const project = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, status: "reviewed" });
    assert.equal(project.status, "candidate", "global sources must not count toward a project scene");
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, "global", args.scenario_key, "global"), true);
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, args.project_id, args.scenario_key), false);
    assert.equal(listKnowledgeScenarios(knowledgeDir, "global", "global").catalog_version, 3);
    assert.equal(fs.existsSync(join(knowledgeDir, "global", "knowledge-scenarios.json")), true);
    assert.equal(fs.existsSync(join(knowledgeDir, "projects", "project-a", "knowledge-scenarios.json")), true);
    const demoted = recordKnowledgeScenario({ ...globalArgs, claim_id: "global-claim-b", source_id: "global-source-b", status: "inactive" });
    assert.equal(demoted.status, "candidate");
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, "global", args.scenario_key, "global"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario catalog keeps conflicting identities out of promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenarios-conflict-")), knowledgeDir = join(root, "knowledge");
  try {
    recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, status: "reviewed" });
    const conflict = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, claim_id: "claim-b", source_id: "source-b",
      scenario_key: "engineering.deploy", coarse_scenario_key: args.scenario_key, status: "reviewed" });
    assert.equal(conflict.status, "conflicted");
    const replay = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, claim_id: "claim-c", source_id: "source-c", status: "reviewed" });
    assert.equal(replay.status, "conflicted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scene can gain a coarse parent as evidence grows without treating omission as conflict", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenario-parent-refinement-")), knowledgeDir = join(root, "knowledge");
  try {
    const first = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, coarse_scenario_key: undefined,
      claim_id: "fine-first", source_id: "source-first", status: "reviewed" });
    assert.equal(first.status, "candidate");
    assert.equal(first.coarse_scenario_key, null);
    const refined = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, claim_id: "fine-second",
      source_id: "source-second", status: "reviewed" });
    assert.equal(refined.status, "active");
    assert.equal(refined.coarse_scenario_key, args.coarse_scenario_key);
    const omittedLater = recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, coarse_scenario_key: undefined,
      claim_id: "fine-third", source_id: "source-third", status: "reviewed" });
    assert.equal(omittedLater.status, "active");
    assert.equal(omittedLater.coarse_scenario_key, args.coarse_scenario_key);
    assert.equal(omittedLater.coarse_lifecycle, "candidate");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario catalog serializes writers and recovers only stale dead locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenarios-lock-")), knowledgeDir = join(root, "knowledge");
  const path = join(knowledgeDir, "projects", "project-a", "knowledge-scenarios.json"), lockPath = `${path}.lock`;
  const input = { ...args, knowledge_dir: knowledgeDir };
  try {
    await mkdir(join(knowledgeDir, "projects", "project-a"), { recursive: true });
    const old = new Date(Date.now() - 120_000);
    await writeFile(lockPath, "999999999\n"); await utimes(lockPath, old, old);
    assert.equal(recordKnowledgeScenario(input).status, "candidate");

    await writeFile(lockPath, `${process.pid}\n`); await utimes(lockPath, old, old);
    assert.throws(() => recordKnowledgeScenario({ ...input, claim_id: "live-lock" }), /busy; retry/u);
    await rm(lockPath);

    await writeFile(lockPath, `${process.pid}\n`);
    const originalLstat = fs.lstatSync;
    let firstInspection = true;
    fs.lstatSync = ((...call: Parameters<typeof fs.lstatSync>) => {
      if (String(call[0]) === lockPath && firstInspection) {
        firstInspection = false;
        throw Object.assign(new Error("lock disappeared during inspection"), { code: "ENOENT" });
      }
      return originalLstat(...call);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    try { assert.throws(() => recordKnowledgeScenario({ ...input, claim_id: "racing-lock" }), /busy; retry/u); }
    finally { fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
    await rm(lockPath);

    const originalOpen = fs.openSync;
    fs.openSync = ((...call: Parameters<typeof fs.openSync>) => {
      if (String(call[0]) === lockPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return originalOpen(...call);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.throws(() => recordKnowledgeScenario({ ...input, claim_id: "denied-lock" }), /permission denied/u); }
    finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario catalog propagates a catalog inspection failure and rejects unsafe scenario lookups", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenarios-inspection-")), knowledgeDir = join(root, "knowledge");
  const path = join(knowledgeDir, "projects", "project-a", "knowledge-scenarios.json");
  try {
    await mkdir(join(knowledgeDir, "projects", "project-a"), { recursive: true });
    const originalLstat = fs.lstatSync;
    fs.lstatSync = ((...call: Parameters<typeof fs.lstatSync>) => {
      if (String(call[0]) === path) throw Object.assign(new Error("catalog permissions denied"), { code: "EACCES" });
      return originalLstat(...call);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    try { assert.throws(() => recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir }), /catalog permissions denied/u); }
    finally { fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, "../unsafe", args.scenario_key), false);
    assert.equal(knowledgeScenarioIsActive(knowledgeDir, args.project_id, "Invalid Key"), false);
    assert.throws(() => listKnowledgeScenarios(knowledgeDir, "../unsafe"), /project identity is invalid/u);
    assert.deepEqual(listKnowledgeScenarios(knowledgeDir, "empty-project"), { catalog_version: 0, scenarios: [] });
    const linkedProject = join(knowledgeDir, "projects", "linked-project");
    const targetProject = join(root, "outside-project");
    await mkdir(targetProject, { recursive: true });
    await symlink(targetProject, linkedProject);
    assert.throws(() => listKnowledgeScenarios(knowledgeDir, "linked-project"), /regular directories/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario catalog rejects malformed identities, catalog files, and symlink paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenarios-invalid-")), knowledgeDir = join(root, "knowledge");
  const valid = { ...args, knowledge_dir: knowledgeDir };
  try {
    assert.throws(() => recordKnowledgeScenario({ ...valid, project_id: "../outside" }), /identity is invalid/u);
    assert.throws(() => recordKnowledgeScenario({ ...valid, scenario_key: "Bad Key" }), /identity is invalid/u);
    assert.throws(() => recordKnowledgeScenario({ ...valid, coarse_scenario_key: args.scenario_key }), /identity is invalid/u);
    assert.throws(() => recordKnowledgeScenario({ ...valid, evidence_ids: ["e".repeat(201)] }), /identity is invalid/u);

    await mkdir(join(knowledgeDir, "projects", "project-a"), { recursive: true });
    const path = join(knowledgeDir, "projects", "project-a", "knowledge-scenarios.json");
    const malformed = [
      { schema: "wrong", scenarios: [] },
      { schema: "craft.knowledge-scenario-catalog.v1", catalog_version: -1, scenarios: [] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [null] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "bad key" }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: [], definition: null }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: [], definition: { summary: "", applies_when: "x", excludes: "y" } }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", lifecycle: "archived", claim_refs: [] }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", tier: "invalid" }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: "no" }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [], transitions: "invalid" },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [], transitions: [null] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", tier: "coarse", parent_scenario_key: "scene.parent", claim_refs: [] }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: [{ claim_id: "c", source_id: "s", evidence_ids: [], status: "unknown" }] }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: [null] }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: [{ claim_id: "", source_id: "s", evidence_ids: [], status: "candidate" }] }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", claim_refs: [{ claim_id: "c", source_id: "s", evidence_ids: ["e".repeat(201)], status: "candidate" }] }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one" }, { scenario_key: "scene.one" }] },
      { schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "scene.one", tier: "fine", parent_scenario_key: "missing.parent", claim_refs: [] }] },
    ];
    for (const item of malformed) {
      await writeFile(path, JSON.stringify(item));
      assert.throws(() => recordKnowledgeScenario(valid), /Knowledge scenario/u);
    }
    await writeFile(path, "x".repeat(65_537));
    assert.throws(() => recordKnowledgeScenario(valid), /oversized/u);
    await writeFile(path, "not-json");
    assert.throws(() => recordKnowledgeScenario(valid), SyntaxError);
    await rm(path); await mkdir(path);
    assert.throws(() => recordKnowledgeScenario(valid), /non-regular/u);
    await rm(path, { recursive: true, force: true });
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify({ schema: "craft.knowledge-scenario-catalog.v1", scenarios: [] }));
    await symlink(target, path);
    assert.throws(() => recordKnowledgeScenario(valid), /linked/u);

    await rm(path); await writeFile(path, JSON.stringify({ schema: "craft.knowledge-scenario-catalog.v1", scenarios: [{ scenario_key: "legacy.scene", claim_refs: [] }] }));
    const legacy = recordKnowledgeScenario({ ...valid, scenario_key: "legacy.scene", coarse_scenario_key: undefined, claim_id: "legacy", status: "candidate" });
    assert.equal(legacy.catalog_version, 1);
    assert.equal(legacy.coarse_scenario_key, null);
    const noCoarse = recordKnowledgeScenario({ ...valid, scenario_key: "another.fine", coarse_scenario_key: undefined, claim_id: "another", status: "candidate" });
    assert.equal(noCoarse.coarse_lifecycle, undefined);

    const capped = { schema: "craft.knowledge-scenario-catalog.v1", catalog_version: 1,
      scenarios: Array.from({ length: 64 }, (_, index) => ({ scenario_key: `scene.${index}`, claim_refs: [] })) };
    await writeFile(path, JSON.stringify(capped));
    assert.throws(() => recordKnowledgeScenario({ ...valid, coarse_scenario_key: undefined, scenario_key: "new.scene" }), /at most 64/u);

    const badRoot = join(root, "regular-file"); await writeFile(badRoot, "x");
    assert.throws(() => recordKnowledgeScenario({ ...valid, knowledge_dir: badRoot }), /regular directories/u);
    const linkedRoot = join(root, "linked-root"); await symlink(join(root, "missing-root"), linkedRoot);
    assert.throws(() => recordKnowledgeScenario({ ...valid, knowledge_dir: linkedRoot }), /regular directories/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario claim references default scope, provenance, and lifecycle safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenario-projection-"));
  try {
    assert.equal(updateKnowledgeScenarioClaim(root, { id: "missing-key", scope: "project:p" }), null);
    const global = updateKnowledgeScenarioClaim(root, { id: "global-scene", scenario_key: "scene.global" });
    assert.equal(global?.status, "candidate");
    assert.equal(fs.existsSync(join(root, "global", "knowledge-scenarios.json")), true);
    assert.equal(updateKnowledgeScenarioClaim(root, { id: "user-scene", scenario_key: "scene.user", scope: "user:u" }), null);
    const projected = updateKnowledgeScenarioClaim(root, { id: "inactive-scene", scenario_key: "scene.inactive", scope: "project:p", status: "stale" });
    assert.equal(projected?.status, "candidate");
    const catalog = JSON.parse(await readFile(join(root, "projects", "p", "knowledge-scenarios.json"), "utf8")) as JsonObject;
    const ref = ((catalog.scenarios as JsonObject[])[0]!.claim_refs as JsonObject[])[0]!;
    assert.equal(ref.source_id, "unknown");
    assert.equal(ref.status, "inactive");
    const reviewed = updateKnowledgeScenarioClaim(root, { id: "reviewed-scene", scenario_key: "scene.reviewed", coarse_scenario_key: "scene.parent",
      scope: "project:p", evidence_ids: ["evidence"], source_id: "source-reviewed", status: "reviewed" });
    assert.equal(reviewed?.status, "candidate");
    const candidate = updateKnowledgeScenarioClaim(root, { id: "candidate-scene", scenario_key: "scene.candidate", scope: "project:p",
      source_id: "source-candidate", status: "candidate" });
    assert.equal(candidate?.status, "candidate");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scene definitions validate their bounded semantic fields", () => {
  assert.equal(validateKnowledgeScenarioDefinition(undefined), undefined);
  for (const value of [null, [], {}, { summary: 1, applies_when: "a", excludes: "e" },
    { summary: " ", applies_when: "a", excludes: "e" }, { summary: "s", applies_when: "a", excludes: "e".repeat(501) }]) {
    assert.throws(() => validateKnowledgeScenarioDefinition(value), /definition is invalid/u);
  }
});

test("Knowledge scenario updates carry model definitions into the project catalog", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenario-definition-update-"));
  try {
    const result = updateKnowledgeScenarioClaim(root, { id: "claim-def", scope: "project:project-def", status: "candidate",
      scenario_key: "engineering.build", coarse_scenario_key: "engineering", source_id: "source-def", evidence_ids: ["evidence-def"],
      scenario_definition: args.definition, coarse_scenario_definition: args.coarse_definition });
    assert.equal(result?.scenario_key, "engineering.build");
    const nodes = listKnowledgeScenarios(root, "project-def").scenarios as JsonObject[];
    assert.deepEqual(nodes.find(item => item.scenario_key === "engineering.build")?.definition, args.definition);
    assert.deepEqual(nodes.find(item => item.scenario_key === "engineering")?.definition, args.coarse_definition);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge definition drift conflicts a scene instead of silently rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-definition-conflict-")), knowledgeDir = join(root, "knowledge");
  try {
    const definition = { summary: "工程构建", applies_when: "涉及项目构建", excludes: "无关业务知识" };
    const coarseDefinition = { summary: "项目工程", applies_when: "项目工程决策或实践", excludes: "产品业务事实" };
    const base = { knowledge_dir: knowledgeDir, project_id: "project-definition", scenario_key: "engineering.build", coarse_scenario_key: "engineering",
      claim_id: "claim-one", source_id: "source-one", evidence_ids: ["evidence-one"], status: "candidate" as const, definition, coarse_definition: coarseDefinition };
    recordKnowledgeScenario(base);
    const drift = recordKnowledgeScenario({ ...base, claim_id: "claim-two", definition, coarse_definition: { ...coarseDefinition, summary: "业务发布" } });
    assert.equal(drift.status, "conflicted");
    assert.equal(drift.coarse_lifecycle, "conflicted");
    const fineOnly = { ...base, project_id: "project-fine-definition", scenario_key: "engineering.release", coarse_scenario_key: undefined,
      coarse_definition: undefined, claim_id: "claim-three" };
    recordKnowledgeScenario(fineOnly);
    const fineDrift = recordKnowledgeScenario({ ...fineOnly, claim_id: "claim-four", definition: { ...definition, summary: "产品发布" } });
    assert.equal(fineDrift.status, "conflicted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge scenario retirement is versioned, idempotent, and excludes stale classifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenario-retirement-")), knowledgeDir = join(root, "knowledge");
  const base = { ...args, knowledge_dir: knowledgeDir, definition: undefined, coarse_definition: undefined };
  try {
    recordKnowledgeScenario(base);
    const before = listKnowledgeScenarios(knowledgeDir, args.project_id);
    assert.equal(before.catalog_version, 1);
    assert.throws(() => retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.coarse_scenario_key,
      expected_catalog_version: 1, request_id: "retire-parent-first", reason: "obsolete" }), /all child Knowledge scenarios/u);
    assert.throws(() => retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.scenario_key,
      expected_catalog_version: 0, request_id: "stale-version", reason: "obsolete" }), /version changed/u);

    const retiredFine = retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.scenario_key,
      expected_catalog_version: 1, request_id: "retire-fine", reason: "obsolete scene" });
    assert.equal(retiredFine.status, "retired");
    assert.equal(retiredFine.catalog_version, 2);
    assert.equal(JSON.stringify(retiredFine).includes("obsolete scene"), false);
    assert.equal(knowledgeScenarioCanClassify(knowledgeDir, args.project_id, args.scenario_key), false);
    assert.equal(knowledgeScenarioCanClassify(knowledgeDir, args.project_id, "bad key"), false);
    assert.throws(() => recordKnowledgeScenario({ ...base, claim_id: "late-claim" }), /retired/u);

    const replay = retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.scenario_key,
      expected_catalog_version: 1, request_id: "retire-fine", reason: "obsolete scene" });
    assert.equal(replay.idempotent, true);
    assert.throws(() => retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.scenario_key,
      expected_catalog_version: 1, request_id: "retire-fine", reason: "different reason" }), /request id conflicts/u);
    assert.throws(() => retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.scenario_key,
      expected_catalog_version: 2, request_id: "retire-again", reason: "obsolete" }), /already retired/u);

    const retiredParent = retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: args.coarse_scenario_key,
      expected_catalog_version: 2, request_id: "retire-parent", reason: "obsolete" });
    assert.equal(retiredParent.catalog_version, 3);
    const listed = listKnowledgeScenarios(knowledgeDir, args.project_id);
    assert.equal((listed.scenarios as JsonObject[]).find(node => node.scenario_key === args.scenario_key)?.lifecycle, "retired");
    assert.equal((listed.transitions as JsonObject[]).length, 2);
    assert.equal(JSON.stringify(listed).includes("obsolete scene"), false);
    assert.equal(knowledgeScenarioCanClassify(knowledgeDir, args.project_id, "new.scene"), true);
    assert.throws(() => retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: "missing.scene",
      expected_catalog_version: 3, request_id: "missing", reason: "obsolete" }), /does not exist/u);
    assert.throws(() => retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: "bad key",
      expected_catalog_version: 3, request_id: "bad", reason: "obsolete" }), /request is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge coarse scene remains active while at least two other active children remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenario-parent-retirement-")), knowledgeDir = join(root, "knowledge");
  const coarseKey = "engineering";
  try {
    for (const scene of ["engineering.first", "engineering.second", "engineering.third"]) {
      for (const source of ["source-a", "source-b"]) {
        recordKnowledgeScenario({ ...args, knowledge_dir: knowledgeDir, scenario_key: scene, coarse_scenario_key: coarseKey,
          claim_id: `${scene}-${source}`, source_id: source, status: "reviewed" });
      }
    }
    const current = listKnowledgeScenarios(knowledgeDir, args.project_id);
    assert.equal((current.scenarios as JsonObject[]).find(item => item.scenario_key === coarseKey)?.lifecycle, "active");
    const retired = retireKnowledgeScenario({ knowledge_dir: knowledgeDir, project_id: args.project_id, scenario_key: "engineering.first",
      expected_catalog_version: Number(current.catalog_version), request_id: "retire-one-child", reason: "duplicate" });
    assert.equal(retired.status, "retired");
    assert.equal((listKnowledgeScenarios(knowledgeDir, args.project_id).scenarios as JsonObject[]).find(item => item.scenario_key === coarseKey)?.lifecycle, "active");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Knowledge taxonomy merge and split proposals create candidates without disrupting source scenes", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-scenario-migration-")), knowledgeDir = join(root, "knowledge");
  const base = { knowledge_dir: knowledgeDir, project_id: "project-migrate", claim_id: "claim", source_id: "source", evidence_ids: [], status: "reviewed" as const };
  const definition = { summary: "工程规则", applies_when: "适用于工程构建", excludes: "业务知识" };
  try {
    recordKnowledgeScenario({ ...base, scenario_key: "engineering.build.a", claim_id: "claim-a1", source_id: "source-a1" });
    recordKnowledgeScenario({ ...base, scenario_key: "engineering.build.a", claim_id: "claim-a2", source_id: "source-a2" });
    recordKnowledgeScenario({ ...base, scenario_key: "engineering.build.b", claim_id: "claim-b1", source_id: "source-b1" });
    recordKnowledgeScenario({ ...base, scenario_key: "engineering.build.b", claim_id: "claim-b2", source_id: "source-b2" });
    const before = listKnowledgeScenarios(knowledgeDir, base.project_id);
    const mergeArgs = { knowledge_dir: knowledgeDir, project_id: base.project_id, mode: "merge" as const,
      source_keys: ["engineering.build.a", "engineering.build.b"], targets: [{ scenario_key: "engineering.build", definition }],
      expected_catalog_version: Number(before.catalog_version), request_id: "merge-builds", reason: "shared acceptance boundary" };
    const merged = proposeKnowledgeScenarioMigration(mergeArgs);
    assert.equal(merged.status, "candidate");
    assert.equal(merged.idempotent, false);
    assert.deepEqual(merged.target_keys, ["engineering.build"]);
    const afterMerge = listKnowledgeScenarios(knowledgeDir, base.project_id);
    const scenarios = afterMerge.scenarios as JsonObject[];
    assert.equal(scenarios.find(item => item.scenario_key === "engineering.build.a")?.lifecycle, "active");
    assert.equal(scenarios.find(item => item.scenario_key === "engineering.build")?.lifecycle, "candidate");
    assert.deepEqual(scenarios.find(item => item.scenario_key === "engineering.build")?.proposed_migration,
      { mode: "merge", source_keys: mergeArgs.source_keys, request_id: "merge-builds" });
    assert.equal(proposeKnowledgeScenarioMigration(mergeArgs).idempotent, true);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, reason: "different" }), /request id conflicts/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, expected_catalog_version: 0, request_id: "stale" }), /version changed/u);

    const splitArgs = { knowledge_dir: knowledgeDir, project_id: base.project_id, mode: "split" as const,
      source_keys: ["engineering.build.a"], targets: [{ scenario_key: "engineering.build.typescript", definition },
        { scenario_key: "engineering.build.java", definition: { ...definition, summary: "Java 构建规则" } }],
      expected_catalog_version: Number(afterMerge.catalog_version), request_id: "split-build", reason: "distinct validation paths" };
    const split = proposeKnowledgeScenarioMigration(splitArgs);
    assert.equal(split.status, "candidate");
    assert.deepEqual(split.target_keys, splitArgs.targets.map(target => target.scenario_key));
    assert.equal((listKnowledgeScenarios(knowledgeDir, base.project_id).scenarios as JsonObject[])
      .find(item => item.scenario_key === "engineering.build.a")?.lifecycle, "active");
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...splitArgs, source_keys: [], request_id: "bad-empty" }), /proposal is invalid/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...splitArgs, source_keys: ["engineering.build.a", "engineering.build.b"], request_id: "bad-split" }), /proposal is invalid/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, mode: "split", source_keys: ["engineering.build.a"], request_id: "bad-target-count" }), /proposal is invalid/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, targets: [{ scenario_key: "invalid key", definition }], request_id: "bad-key" }), /targets are invalid/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, targets: [{ scenario_key: "new.target", definition: undefined }], request_id: "bad-definition" }), /requires a definition/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, targets: [{ scenario_key: "new.target", definition }], expected_catalog_version: -1, request_id: "bad-version" }), /proposal is invalid/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, source_keys: ["missing.scene", "engineering.build.a"],
      expected_catalog_version: Number(listKnowledgeScenarios(knowledgeDir, base.project_id).catalog_version), request_id: "missing-source" }), /existing, live fine scenes/u);
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, source_keys: undefined,
      expected_catalog_version: Number(listKnowledgeScenarios(knowledgeDir, base.project_id).catalog_version), request_id: "missing-arrays" } as never), /proposal is invalid/u);
    recordKnowledgeScenario({ ...base, scenario_key: "engineering.build.existing", claim_id: "claim-existing", source_id: "source-existing" });
    assert.throws(() => proposeKnowledgeScenarioMigration({ ...mergeArgs, targets: [{ scenario_key: "engineering.build.existing", definition }],
      expected_catalog_version: Number(listKnowledgeScenarios(knowledgeDir, base.project_id).catalog_version), request_id: "existing-target" }), /targets must be new/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
