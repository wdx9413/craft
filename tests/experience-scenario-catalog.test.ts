import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { completeExperienceScenarioClassificationRequest, createExperienceScenarioClassificationRequest, experienceScenarioCanClassify as canClassify, experienceScenarioIsRetired as isRetired, getExperienceScenarioClassificationRequest, listExperienceScenarios as listScenarios, proposeExperienceScenarioMigration as proposeMigration, recordExperienceScenario as persistExperienceScenario, retireExperienceScenario as persistRetirement, validateExperienceScenarioDefinition } from "../capability/craft-experience/scenario-catalog.ts";

const digest = (value: string) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
const classificationContext = { sanitized: true, content_stored: false, task_goal: "Repair validation", effect_summary: "Checks pass", outcome: "passed",
  observed_paths: ["src/validation.ts"], host: "codex", task_id: "task-1", turn_id: "turn-1", context_receipt_id: "receipt-1",
  observation_id: "workflow_evolution_observation_123", verification_ref: "test:focused" };
function recordExperienceScenario(args: Omit<Parameters<typeof persistExperienceScenario>[0], "verified_task_id"> & { verified_task_id?: string }) {
  return persistExperienceScenario({ ...args, experience_dir: projectDirectory(args.experience_dir, args.project_id), verified_task_id: args.verified_task_id ?? args.observation_id });
}
function projectDirectory(directory: string, projectId: string) { const path = join(directory, projectId); fs.mkdirSync(path, { recursive: true }); return path; }
function listExperienceScenarios(directory: string, projectId: string) { return listScenarios(join(directory, projectId), projectId); }
function experienceScenarioCanClassify(directory: string, projectId: string, key: string) { return canClassify(join(directory, projectId), projectId, key); }
function experienceScenarioIsRetired(directory: string, projectId: string, key: string) { return isRetired(join(directory, projectId), projectId, key); }
function retireExperienceScenario(args: Parameters<typeof persistRetirement>[0]) { return persistRetirement({ ...args, experience_dir: projectDirectory(args.experience_dir, args.project_id) }); }
function proposeExperienceScenarioMigration(args: Parameters<typeof proposeMigration>[0]) { return proposeMigration({ ...args, experience_dir: projectDirectory(args.experience_dir, args.project_id) }); }

test("Experience scenario listing is read-only, bounded, and project-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-scenario-list-")), experienceDir = join(root, "experience");
  try {
    assert.deepEqual(listExperienceScenarios(experienceDir, "project-a"), { catalog_version: 0, scenarios: [] });
    assert.equal(existsSync(experienceDir), false);
    assert.throws(() => listExperienceScenarios(experienceDir, "../outside"), /identity is invalid/u);
    const args = { experience_dir: experienceDir, project_id: "project-a", scenario_key: "engineering.tests.unit",
      coarse_scenario_key: "engineering.code-change", verifier_digest: digest("pnpm test:unit"),
      definition: { summary: "单元测试修复", applies_when: "修改后要由单测验收", excludes: "仅做部署验证" } };
    recordExperienceScenario({ ...args, observation_id: "observation-one" });
    recordExperienceScenario({ ...args, observation_id: "observation-one-second-task" });
    recordExperienceScenario({ ...args, scenario_key: "engineering.docs", observation_id: "observation-two" });
    recordExperienceScenario({ ...args, scenario_key: "engineering.docs", observation_id: "observation-two-second-task" });
    const listed = listExperienceScenarios(experienceDir, "project-a");
    assert.equal(listed.catalog_version, 4);
    const nodes = listed.scenarios as JsonObject[];
    const fine = nodes.find(item => item.scenario_key === args.scenario_key)!;
    const coarse = nodes.find(item => item.scenario_key === args.coarse_scenario_key)!;
    assert.equal(fine.lifecycle, "active");
    assert.equal(fine.tier, "fine");
    assert.deepEqual(fine.verification_digests, [args.verifier_digest]);
    assert.deepEqual(fine.definition, args.definition);
    assert.equal(fine.observation_count, 2);
    assert.equal(fine.verified_task_count, 2);
    assert.equal(coarse.active_fine_child_count, 2);
    assert.equal(JSON.stringify(listed).includes("observation_refs"), false);

    const projectDirectory = join(experienceDir, "linked-project"), target = join(root, "outside");
    await mkdir(target);
    await symlink(target, projectDirectory);
    assert.throws(() => listExperienceScenarios(experienceDir, "linked-project"), /regular directories/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience taxonomy creates its missing project capability directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-scenario-create-dir-"));
  const experienceDir = join(root, "experience");
  try {
    assert.equal(existsSync(experienceDir), false);
    const result = await persistExperienceScenario({ experience_dir: experienceDir, project_id: "project-new",
      scenario_key: "engineering.tests.unit", observation_id: "verified-task-one", verified_task_id: "verified-task-one" });
    assert.equal(result.status, "candidate");
    assert.equal(existsSync(join(experienceDir, "experience-scenarios.json")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience scenario classification requests are bounded, idempotent, and versioned in the project directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-classification-request-")), experienceDir = join(root, "project", ".craft_data", "experience");
  const requestId = "scenario_classification_test-1", resultDigest = digest("classification result");
  try {
    await mkdir(experienceDir, { recursive: true });
    const created = createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: "project:project-a", context: classificationContext });
    assert.equal(created.idempotent, false);
    const stored = created.request as JsonObject;
    assert.equal(stored.status, "awaiting_model");
    assert.equal(stored.version, 1);
    assert.deepEqual(getExperienceScenarioClassificationRequest(experienceDir, requestId).context, classificationContext);
    assert.equal(createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: "project:project-a", context: classificationContext }).idempotent, true);
    assert.throws(() => createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: "project:project-a",
      context: { ...classificationContext, effect_summary: "Different task" } }), /idempotency conflict/u);
    const completed = completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, expected_version: 1,
      status: "classified", result_digest: resultDigest });
    assert.equal((completed.request as JsonObject).version, 2);
    assert.equal(completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, expected_version: 1,
      status: "classified", result_digest: resultDigest }).idempotent, true);
    assert.throws(() => completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, expected_version: 1,
      status: "unclassified", result_digest: resultDigest }), /conflicts/u);
    assert.throws(() => getExperienceScenarioClassificationRequest(experienceDir, "missing_request"), /not found/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience scenario classification request storage rejects malformed, unsafe, stale, and linked inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-classification-invalid-")), experienceDir = join(root, "experience");
  const resultDigest = digest("classification result"), requestId = "scenario_classification_valid";
  try {
    assert.throws(() => getExperienceScenarioClassificationRequest(join(root, "missing"), requestId), /not found/u);
    assert.throws(() => createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: "global", context: classificationContext }), /explicit project scope/u);
    await mkdir(experienceDir);
    assert.throws(() => createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: "../escape", scope: "project:project-a", context: classificationContext }), /id is invalid/u);
    for (const context of [
      { ...classificationContext, sanitized: false },
      { ...classificationContext, task_goal: "token=abcdefghijk" },
      { ...classificationContext, observed_paths: ["../private.ts"] },
      { ...classificationContext, outcome: "inconclusive" },
      { ...classificationContext, host: "BAD HOST" },
      { ...classificationContext, task_id: "" },
      { ...classificationContext, observation_id: "bad" },
      { ...classificationContext, verification_ref: "password=abcdefgh" },
    ]) assert.throws(() => createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: "project:project-a", context }), /context|identity/u);

    const first = createExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, scope: "project:project-a", context: classificationContext });
    assert.equal(first.idempotent, false);
    assert.throws(() => completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, expected_version: 0,
      status: "classified", result_digest: resultDigest }), /completion is invalid/u);
    assert.throws(() => completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: "missing_request", expected_version: 1,
      status: "classified", result_digest: resultDigest }), /not found/u);
    assert.throws(() => completeExperienceScenarioClassificationRequest({ experience_dir: experienceDir, request_id: requestId, expected_version: 2,
      status: "classified", result_digest: resultDigest }), /stale/u);

    const queueDir = join(experienceDir, "scenario-classification");
    const file = join(queueDir, `${requestId}.json`);
    await writeFile(file, "not-json", "utf8");
    assert.throws(() => getExperienceScenarioClassificationRequest(experienceDir, requestId), /JSON/u);
    await writeFile(file, JSON.stringify({ schema: "wrong" }), "utf8");
    assert.throws(() => getExperienceScenarioClassificationRequest(experienceDir, requestId), /request is invalid/u);
    await writeFile(file, JSON.stringify({ schema: "craft.experience-scenario-classification-request.v1", id: requestId, version: 1,
      status: "awaiting_model", scope: "project:project-a", identity_digest: digest("id"), context: classificationContext }), "utf8");
    const linked = join(queueDir, "linked.json");
    await symlink(file, linked);
    assert.throws(() => getExperienceScenarioClassificationRequest(experienceDir, "linked"), /linked, non-regular/u);

    const blockedRoot = join(root, "blocked");
    await mkdir(blockedRoot);
    await symlink(queueDir, join(blockedRoot, "scenario-classification"));
    assert.throws(() => getExperienceScenarioClassificationRequest(blockedRoot, requestId), /regular/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience taxonomy stores classifications in the project data directory and promotes from independent evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-taxonomy-")), experienceDir = join(root, "experience");
  try {
    const args = { experience_dir: experienceDir, project_id: "project-ab12", scenario_key: "engineering.tests.typescript",
      coarse_scenario_key: "engineering.code-change", verifier_digest: digest("pnpm test:focused"),
      definition: { summary: "修复 TypeScript 问题并验证行为", applies_when: "目标涉及 TypeScript 变更和测试", excludes: "仅修改文档" },
      coarse_definition: { summary: "交付仓库变更", applies_when: "修改项目文件并验收", excludes: "只读咨询" } };
    const first = recordExperienceScenario({ ...args, observation_id: "observation-one" });
    assert.equal(first.status, "candidate");
    assert.equal(first.coarse_lifecycle, "candidate");
    assert.equal(first.verification_digest_recorded, true);
    const replay = recordExperienceScenario({ ...args, observation_id: "observation-one" });
    assert.equal(replay.observation_count, 1);
    assert.equal(replay.catalog_version, 2);
    assert.equal(replay.status, "candidate");
    const repeatedTask = recordExperienceScenario({ ...args, observation_id: "observation-one-retry", verified_task_id: "observation-one" });
    assert.equal(repeatedTask.observation_count, 2);
    assert.equal(repeatedTask.verified_task_count, 1);
    assert.equal(repeatedTask.status, "candidate");

    const second = recordExperienceScenario({ ...args, observation_id: "observation-two" });
    assert.equal(second.status, "active");
    assert.equal(second.observation_count, 3);
    assert.equal(second.verified_task_count, 2);
    assert.equal(second.coarse_lifecycle, "candidate");
    const nextFine = recordExperienceScenario({ ...args, scenario_key: "engineering.docs.markdown", observation_id: "observation-three" });
    assert.equal(nextFine.status, "candidate");
    const promotedChild = recordExperienceScenario({ ...args, scenario_key: "engineering.docs.markdown", observation_id: "observation-four" });
    assert.equal(promotedChild.status, "active");
    assert.equal(promotedChild.coarse_lifecycle, "active");

    const path = join(experienceDir, "project-ab12", "experience-scenarios.json");
    const catalog = JSON.parse(await readFile(path, "utf8")) as JsonObject;
    assert.equal(catalog.catalog_version, 6);
    const nodes = catalog.scenarios as JsonObject[];
    const fine = nodes.find(node => node.scenario_key === args.scenario_key)!;
    assert.equal(fine.lifecycle, "active");
    assert.deepEqual(fine.definition, args.definition);
    assert.deepEqual(fine.observation_refs, ["observation-one", "observation-one-retry", "observation-two"]);
    assert.equal((fine.verified_task_digests as string[]).length, 2);
    assert.deepEqual(fine.verification_digests, [args.verifier_digest]);
    const coarse = nodes.find(node => node.scenario_key === args.coarse_scenario_key)!;
    assert.deepEqual(coarse.definition, args.coarse_definition);

    const conflict = recordExperienceScenario({ ...args, coarse_scenario_key: "engineering.other", observation_id: "observation-five" });
    assert.equal(conflict.status, "conflicted");
    assert.equal(conflict.observation_count, 3);
    const conflictReplay = recordExperienceScenario({ ...args, coarse_scenario_key: "engineering.other", observation_id: "observation-six" });
    assert.equal(conflictReplay.status, "conflicted");
    const explicitCoarse = recordExperienceScenario({ ...args, scenario_key: "engineering.build", coarse_scenario_key: "engineering.delivery",
      observation_id: "observation-seven" });
    assert.equal(explicitCoarse.coarse_lifecycle, "candidate");
    recordExperienceScenario({ ...args, scenario_key: "engineering.build", coarse_scenario_key: "engineering.delivery", observation_id: "observation-seven-second-task" });
    const secondChild = recordExperienceScenario({ ...args, scenario_key: "engineering.deploy.release", coarse_scenario_key: "engineering.delivery", observation_id: "observation-seven-second-child" });
    assert.equal(secondChild.coarse_lifecycle, "candidate");
    const promotedSecondChild = recordExperienceScenario({ ...args, scenario_key: "engineering.deploy.release", coarse_scenario_key: "engineering.delivery", observation_id: "observation-seven-second-child-verified" });
    assert.equal(promotedSecondChild.coarse_lifecycle, "active");
    const tierConflict = recordExperienceScenario({ ...args, scenario_key: "engineering.deploy", coarse_scenario_key: args.scenario_key,
      observation_id: "observation-eight" });
    assert.equal(tierConflict.status, "conflicted");
    const afterTierConflict = recordExperienceScenario({ ...args, scenario_key: "engineering.hotfix", observation_id: "observation-nine" });
    assert.equal(afterTierConflict.status, "candidate");
    recordExperienceScenario({ ...args, scenario_key: args.coarse_scenario_key, coarse_scenario_key: undefined,
      observation_id: "coarse-as-fine" });
    const conflictedParent = recordExperienceScenario({ ...args, scenario_key: "engineering.parent-child", coarse_scenario_key: args.coarse_scenario_key,
      observation_id: "child-of-conflicted-parent" });
    assert.equal(conflictedParent.status, "conflicted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience fine scenes can gain a coarse parent without changing scene identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-scenario-parent-refinement-")), experienceDir = join(root, "experience");
  try {
    const args = { experience_dir: experienceDir, project_id: "project-refine", scenario_key: "engineering.validation.tests" };
    const first = recordExperienceScenario({ ...args, observation_id: "task-one" });
    assert.equal(first.status, "candidate");
    assert.equal(first.coarse_scenario_key, null);
    const refined = recordExperienceScenario({ ...args, coarse_scenario_key: "engineering.validation", observation_id: "task-two" });
    assert.equal(refined.status, "active");
    assert.equal(refined.coarse_scenario_key, "engineering.validation");
    const omittedLater = recordExperienceScenario({ ...args, observation_id: "task-three" });
    assert.equal(omittedLater.status, "active");
    assert.equal(omittedLater.coarse_scenario_key, "engineering.validation");
    const listed = listExperienceScenarios(experienceDir, "project-refine");
    assert.equal((listed.scenarios as JsonObject[]).find(node => node.scenario_key === args.scenario_key)?.parent_scenario_key, "engineering.validation");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience scene definition drift conflicts the key instead of silently rewriting it", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-definition-conflict-")), experienceDir = join(root, "experience");
  try {
    const args = { experience_dir: experienceDir, project_id: "project-definition", scenario_key: "engineering.review", coarse_scenario_key: "engineering" };
    const definition = { summary: "代码审查", applies_when: "检查变更并给出问题", excludes: "实现新功能" };
    const coarseDefinition = { summary: "工程交付", applies_when: "项目仓库发生并验收变更", excludes: "只读咨询" };
    recordExperienceScenario({ ...args, definition, coarse_definition: coarseDefinition, observation_id: "task-one" });
    const drift = recordExperienceScenario({ ...args, definition, coarse_definition: { ...coarseDefinition, summary: "知识问答" }, observation_id: "task-two" });
    assert.equal(drift.status, "conflicted");
    assert.equal(drift.coarse_lifecycle, "conflicted");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience taxonomy reads legacy entries and serializes catalog updates", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-taxonomy-lock-")), experienceDir = join(root, "experience");
  const directory = join(experienceDir, "project-1"), path = join(directory, "experience-scenarios.json");
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path, JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "legacy.review" }] }));
    const legacy = recordExperienceScenario({ experience_dir: experienceDir, project_id: "project-1", scenario_key: "legacy.review",
      observation_id: "legacy-observation" });
    assert.equal(legacy.catalog_version, 1);
    assert.equal(legacy.status, "active");

    const lockPath = `${path}.lock`;
    await writeFile(lockPath, "999999999\n");
    const old = new Date(Date.now() - 120_000);
    await utimes(lockPath, old, old);
    const recovered = recordExperienceScenario({ experience_dir: experienceDir, project_id: "project-1", scenario_key: "legacy.review",
      observation_id: "after-stale-lock" });
    assert.equal(recovered.observation_count, 2);
    assert.equal(recovered.catalog_version, 2);

    await writeFile(lockPath, `${process.pid}\n`);
    await utimes(lockPath, old, old);
    assert.throws(() => recordExperienceScenario({ experience_dir: experienceDir, project_id: "project-1", scenario_key: "legacy.review",
      observation_id: "live-lock" }), /busy; retry/u);
    await rm(lockPath);

    await writeFile(lockPath, `${process.pid}\n`);
    assert.throws(() => recordExperienceScenario({ experience_dir: experienceDir, project_id: "project-1", scenario_key: "legacy.review",
      observation_id: "contended-observation" }), /busy; retry/u);
    await rm(lockPath);
    const resumed = recordExperienceScenario({ experience_dir: experienceDir, project_id: "project-1", scenario_key: "legacy.review",
      observation_id: "after-contention" });
    assert.equal(resumed.observation_count, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience taxonomy propagates lock creation errors and tolerates a lock removed during inspection", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-taxonomy-lock-race-")), experienceDir = join(root, "experience");
  const path = join(experienceDir, "project-1", "experience-scenarios.json"), lockPath = `${path}.lock`;
  const args = { experience_dir: experienceDir, project_id: "project-1", scenario_key: "scenario.one", observation_id: "observation-one" };
  try {
    const originalOpen = fs.openSync;
    fs.openSync = ((...call: Parameters<typeof fs.openSync>) => {
      if (String(call[0]) === lockPath) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      return originalOpen(...call);
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try { assert.throws(() => recordExperienceScenario(args), /permission denied/u); }
    finally { fs.openSync = originalOpen; syncBuiltinESMExports(); }

    await mkdir(join(experienceDir, "project-1"), { recursive: true });
    await writeFile(lockPath, `${process.pid}\n`);
    const originalLstat = fs.lstatSync;
    let firstInspection = true;
    fs.lstatSync = ((...call: Parameters<typeof fs.lstatSync>) => {
      if (String(call[0]) === lockPath && firstInspection) {
        firstInspection = false;
        throw Object.assign(new Error("lock already released"), { code: "ENOENT" });
      }
      return originalLstat(...call);
    }) as typeof fs.lstatSync;
    syncBuiltinESMExports();
    try { assert.throws(() => recordExperienceScenario(args), /busy; retry/u); }
    finally { fs.lstatSync = originalLstat; syncBuiltinESMExports(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience scenario catalog handles fine-only scenes and rejects unsafe paths or keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-taxonomy-safety-"));
  try {
    const fineOnly = recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "engineering.review", observation_id: "observation", verified_task_id: "task-one" });
    assert.equal(fineOnly.coarse_scenario_key, null);
    assert.equal(fineOnly.coarse_lifecycle, undefined);
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "../outside",
      scenario_key: "engineering.review", observation_id: "observation" }), /identity is invalid/u);
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "Bad Key", observation_id: "observation" }), /identity is invalid/u);
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "engineering.review", coarse_scenario_key: "engineering.review", observation_id: "observation" }), /identity is invalid/u);
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "engineering.review", verifier_digest: "not-a-digest", observation_id: "observation" }), /identity is invalid/u);

    const actual = join(root, "actual"); await mkdir(actual);
    const linked = join(root, "linked"); await symlink(actual, linked);
    assert.throws(() => persistExperienceScenario({ experience_dir: linked, project_id: "project-1",
      scenario_key: "engineering.review", observation_id: "observation", verified_task_id: "task" }), /regular directories/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience scenario catalog rejects malformed and conflicting persisted taxonomies", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-taxonomy-invalid-"));
  const directory = join(root, "experience", "project-1"), path = join(directory, "experience-scenarios.json");
  await mkdir(directory, { recursive: true });
  try {
    const entry = { scenario_key: "fine.scene", tier: "fine", parent_scenario_key: "coarse.scene", verification_commands: [] };
    const coarse = { scenario_key: "coarse.scene", tier: "coarse", verification_commands: [] };
    const invalid = [
      { schema: "wrong", scenarios: [] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: null },
      { schema: "craft.experience-scenario-catalog.v1", catalog_version: -1, scenarios: [] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [null] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "bad key", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", tier: "middle", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", tier: "fine", parent_scenario_key: "fine.scene", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", tier: "fine", parent_scenario_key: "missing.parent", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [entry, { scenario_key: "also.fine", tier: "fine", parent_scenario_key: "fine.scene", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verification_commands: "not-array" }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verification_commands: ["x".repeat(501)] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", lifecycle: "archived", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verification_digests: ["bad"], verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", observation_refs: [12], verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verified_task_digests: "not-array", verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verified_task_digests: ["not-a-digest"], verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verified_task_digests: [digest("one"), digest("two"), digest("three")], verification_commands: [] }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [], transitions: "invalid" },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [], transitions: [null] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verification_commands: [], definition: null }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ scenario_key: "fine.scene", verification_commands: [], definition: { summary: "", applies_when: "x", excludes: "y" } }] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [{ ...coarse, verification_commands: ["pnpm test"] }, entry] },
      { schema: "craft.experience-scenario-catalog.v1", scenarios: [coarse, entry, { ...entry }] },
    ];
    for (const [index, catalog] of invalid.entries()) {
      await writeFile(path, JSON.stringify(catalog));
      assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
        scenario_key: "new.scene", coarse_scenario_key: "new.coarse", observation_id: "new-observation" }), `invalid catalog case ${index}`);
    }
    await writeFile(path, "x".repeat(16_385));
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "new.scene", observation_id: "new-observation" }), /oversized/u);
    await writeFile(path, "not-json");
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "new.scene", observation_id: "new-observation" }), SyntaxError);
    await rm(path); await mkdir(path);
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "new.scene", observation_id: "new-observation" }), /non-regular/u);
    await rm(path, { recursive: true, force: true });
    const target = join(root, "target.json"); await writeFile(target, JSON.stringify({ schema: "craft.experience-scenario-catalog.v1", scenarios: [] }));
    await symlink(target, path);
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "new.scene", observation_id: "new-observation" }), /linked/u);

    const capped = { schema: "craft.experience-scenario-catalog.v1", catalog_version: 1,
      scenarios: Array.from({ length: 64 }, (_, index) => ({ scenario_key: `scene.${index}`, verification_commands: [] })) };
    await rm(path); await writeFile(path, JSON.stringify(capped));
    assert.throws(() => recordExperienceScenario({ experience_dir: join(root, "experience"), project_id: "project-1",
      scenario_key: "new.scene", coarse_scenario_key: "new.coarse", observation_id: "new-observation" }), /at most 64/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience scene definitions reject unsafe or incomplete fields", () => {
  assert.equal(validateExperienceScenarioDefinition(undefined), undefined);
  for (const value of [null, [], {}, { summary: 1, applies_when: "a", excludes: "e" },
    { summary: " ", applies_when: "a", excludes: "e" }, { summary: "s", applies_when: "a", excludes: "e".repeat(501) },
    { summary: "release token=abcdefghijklmno", applies_when: "a", excludes: "e" }]) {
    assert.throws(() => validateExperienceScenarioDefinition(value), /definition is invalid/u);
  }
});

test("Experience scenario retirement preserves references and requires versioned idempotent requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-scenario-retirement-")), experienceDir = join(root, "experience");
  const base = { experience_dir: experienceDir, project_id: "retire-project", scenario_key: "engineering.tests", coarse_scenario_key: "engineering" };
  try {
    recordExperienceScenario({ ...base, observation_id: "task-one" });
    const before = listExperienceScenarios(experienceDir, base.project_id);
    assert.equal(before.catalog_version, 1);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: "engineering",
      expected_catalog_version: 1, request_id: "retire-parent-first", reason: "obsolete" }), /all child Experience scenarios/u);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: base.scenario_key,
      expected_catalog_version: 0, request_id: "stale-version", reason: "obsolete" }), /version changed/u);

    const retiredFine = retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: base.scenario_key,
      expected_catalog_version: 1, request_id: "retire-fine", reason: "obsolete scene" });
    assert.equal(retiredFine.status, "retired");
    assert.equal(retiredFine.catalog_version, 2);
    assert.equal(JSON.stringify(retiredFine).includes("obsolete scene"), false);
    assert.equal(experienceScenarioCanClassify(experienceDir, base.project_id, base.scenario_key), false);
    assert.equal(experienceScenarioIsRetired(experienceDir, base.project_id, base.scenario_key), true);
    assert.equal(experienceScenarioIsRetired(experienceDir, base.project_id, "engineering"), false);
    assert.equal(experienceScenarioIsRetired(experienceDir, base.project_id, "missing.scene"), false);
    assert.equal(experienceScenarioIsRetired(experienceDir, "bad/id", base.scenario_key), false);
    assert.equal(experienceScenarioIsRetired(experienceDir, base.project_id, "bad key"), false);
    assert.equal(experienceScenarioCanClassify(experienceDir, base.project_id, "bad key"), false);
    assert.throws(() => recordExperienceScenario({ ...base, observation_id: "late-task" }), /retired/u);

    const replay = retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: base.scenario_key,
      expected_catalog_version: 1, request_id: "retire-fine", reason: "obsolete scene" });
    assert.equal(replay.idempotent, true);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: base.scenario_key,
      expected_catalog_version: 1, request_id: "retire-fine", reason: "different reason" }), /request id conflicts/u);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: base.scenario_key,
      expected_catalog_version: 2, request_id: "retire-again", reason: "obsolete" }), /already retired/u);

    const retiredParent = retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: "engineering",
      expected_catalog_version: 2, request_id: "retire-parent", reason: "obsolete" });
    assert.equal(retiredParent.catalog_version, 3);
    const listed = listExperienceScenarios(experienceDir, base.project_id);
    const fine = (listed.scenarios as JsonObject[]).find(node => node.scenario_key === base.scenario_key)!;
    assert.equal(fine.lifecycle, "retired");
    assert.equal(fine.observation_count, 1);
    assert.equal((listed.transitions as JsonObject[]).length, 2);
    assert.equal(JSON.stringify(listed).includes("obsolete scene"), false);
    assert.equal(experienceScenarioCanClassify(experienceDir, base.project_id, "new.scene"), true);
    assert.equal(experienceScenarioCanClassify(experienceDir, "../outside", base.scenario_key), false);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: "missing.scene",
      expected_catalog_version: 3, request_id: "missing", reason: "obsolete" }), /does not exist/u);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: "bad key",
      expected_catalog_version: 3, request_id: "bad", reason: "obsolete" }), /request is invalid/u);
    assert.throws(() => retireExperienceScenario({ experience_dir: experienceDir, project_id: base.project_id, scenario_key: base.scenario_key,
      expected_catalog_version: 3, request_id: "blank-reason", reason: "  " }), /request is invalid/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience coarse scene remains active while at least two other active children remain", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-scenario-parent-retirement-")), experienceDir = join(root, "experience");
  const coarseKey = "engineering";
  try {
    for (const scene of ["engineering.first", "engineering.second", "engineering.third"]) {
      for (const task of [`${scene}-one`, `${scene}-two`]) {
        recordExperienceScenario({ experience_dir: experienceDir, project_id: "retire-project", scenario_key: scene,
          coarse_scenario_key: coarseKey, observation_id: task, verified_task_id: task });
      }
    }
    const current = listExperienceScenarios(experienceDir, "retire-project");
    assert.equal((current.scenarios as JsonObject[]).find(item => item.scenario_key === coarseKey)?.lifecycle, "active");
    const retired = retireExperienceScenario({ experience_dir: experienceDir, project_id: "retire-project", scenario_key: "engineering.first",
      expected_catalog_version: Number(current.catalog_version), request_id: "retire-one-child", reason: "duplicate" });
    assert.equal(retired.status, "retired");
    assert.equal((listExperienceScenarios(experienceDir, "retire-project").scenarios as JsonObject[]).find(item => item.scenario_key === coarseKey)?.lifecycle, "active");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Experience taxonomy merge and split proposals preserve live scenes until candidate evidence promotes replacements", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-scenario-migration-")), experienceDir = join(root, "experience");
  const definition = { summary: "验证工程变更", applies_when: "项目变更需要自动化验证", excludes: "纯文档咨询" };
  try {
    for (const scenario_key of ["engineering.tests.unit", "engineering.tests.integration"]) {
      for (const verified_task_id of [`${scenario_key}-one`, `${scenario_key}-two`]) {
        recordExperienceScenario({ experience_dir: experienceDir, project_id: "migration-project", scenario_key,
          observation_id: verified_task_id, verified_task_id, definition });
      }
    }
    const before = listExperienceScenarios(experienceDir, "migration-project");
    const mergeArgs = { experience_dir: experienceDir, project_id: "migration-project", mode: "merge" as const,
      source_keys: ["engineering.tests.unit", "engineering.tests.integration"], targets: [{ scenario_key: "engineering.tests", definition }],
      expected_catalog_version: Number(before.catalog_version), request_id: "merge-experience-tests", reason: "same validated outcome" };
    const merged = proposeExperienceScenarioMigration(mergeArgs);
    assert.equal(merged.status, "candidate");
    assert.equal(merged.idempotent, false);
    assert.deepEqual(merged.target_keys, ["engineering.tests"]);
    const afterMerge = listExperienceScenarios(experienceDir, "migration-project");
    const scenarios = afterMerge.scenarios as JsonObject[];
    assert.equal(scenarios.find(item => item.scenario_key === "engineering.tests.unit")?.lifecycle, "active");
    assert.equal(scenarios.find(item => item.scenario_key === "engineering.tests")?.lifecycle, "candidate");
    assert.equal(proposeExperienceScenarioMigration(mergeArgs).idempotent, true);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, reason: "different" }), /request id conflicts/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: 0, request_id: "stale" }), /version changed/u);

    const splitArgs = { experience_dir: experienceDir, project_id: "migration-project", mode: "split" as const,
      source_keys: ["engineering.tests.unit"], targets: [{ scenario_key: "engineering.tests.unit.typescript", definition },
        { scenario_key: "engineering.tests.unit.python", definition: { ...definition, summary: "Python 单测验证" } }],
      expected_catalog_version: Number(afterMerge.catalog_version), request_id: "split-experience-tests", reason: "distinct runtime and verifier" };
    const split = proposeExperienceScenarioMigration(splitArgs);
    assert.equal(split.status, "candidate");
    assert.deepEqual(split.target_keys, splitArgs.targets.map(target => target.scenario_key));
    const afterSplit = listExperienceScenarios(experienceDir, "migration-project");
    assert.equal((afterSplit.scenarios as JsonObject[])
      .find(item => item.scenario_key === "engineering.tests.unit")?.lifecycle, "active");
    assert.throws(() => proposeExperienceScenarioMigration({ ...splitArgs, source_keys: [], request_id: "bad-empty" }), /proposal is invalid/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...splitArgs, source_keys: "invalid" as unknown as string[], request_id: "bad-source-shape" }), /proposal is invalid/u);
    const currentVersion = Number(afterSplit.catalog_version);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: currentVersion,
      mode: "split", source_keys: ["engineering.tests.unit"], request_id: "bad-target-count" }), /proposal is invalid/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: currentVersion,
      source_keys: ["engineering.tests.unit"], targets: [{ scenario_key: "new.target", definition }], request_id: "bad-merge-count" }), /proposal is invalid/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: currentVersion,
      targets: [{ scenario_key: "bad key", definition }], request_id: "bad-key" }), /targets are invalid/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: currentVersion,
      targets: [{ scenario_key: "new.target", definition: undefined }], request_id: "bad-definition" }), /requires a definition/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, targets: [{ scenario_key: "new.target", definition }], expected_catalog_version: -1, request_id: "bad-version" }), /proposal is invalid/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: currentVersion,
      mode: "merge", source_keys: ["missing.scene", "engineering.tests.unit"], request_id: "bad-source" }), /existing, live fine scenes/u);
    assert.throws(() => proposeExperienceScenarioMigration({ ...mergeArgs, expected_catalog_version: currentVersion,
      targets: [{ scenario_key: "engineering.tests.unit", definition }], request_id: "source-as-target" }), /targets are invalid/u);

    assert.throws(() => proposeExperienceScenarioMigration({ ...splitArgs, expected_catalog_version: currentVersion,
      targets: [{ scenario_key: "engineering.tests", definition }, { scenario_key: "engineering.tests.unit.go", definition }],
      request_id: "existing-non-source-target" }), /new keys within the catalog limit/u);

    const catalogPath = join(experienceDir, "migration-project", "experience-scenarios.json");
    const fullCatalog = JSON.parse(await readFile(catalogPath, "utf8")) as { scenarios: JsonObject[] };
    fullCatalog.scenarios.push(...Array.from({ length: 64 - fullCatalog.scenarios.length }, (_, index) => ({
      scenario_key: `capacity.scene.${index}`, tier: "fine", verification_commands: [],
    })));
    await writeFile(catalogPath, JSON.stringify({ ...fullCatalog, catalog_version: currentVersion }));
    assert.throws(() => proposeExperienceScenarioMigration({ ...splitArgs, expected_catalog_version: currentVersion,
      targets: [{ scenario_key: "capacity.new.one", definition }, { scenario_key: "capacity.new.two", definition }],
      request_id: "catalog-capacity" }), /new keys within the catalog limit/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});
