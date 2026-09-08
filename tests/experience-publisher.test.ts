import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../src/paths.ts";
import { McpServer } from "../src/mcp.ts";
import { CraftService } from "../src/service.ts";
import { publishSkill } from "../src/skill-publisher.ts";
import { CraftStore } from "../src/store.ts";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");

test("经验模式生成可评测的 Skill 候选，并只在已验证且显式授权时安全发布和回滚", async () => {
  const root = join(tmpdir(), `craft-experience-${process.pid}-${Date.now()}`);
  const skillRoot = join(root, "skills");
  const skillPath = join(skillRoot, "example", "SKILL.md");
  const outsideSkillPath = join(root, "outside", "SKILL.md");
  const original = "---\nname: example\ndescription: original\n---\noriginal body\n";
  await mkdir(join(skillRoot, "example"), { recursive: true });
  await mkdir(join(root, "outside"), { recursive: true });
  await writeFile(skillPath, original);
  await writeFile(outsideSkillPath, original);
  await writeFile(join(skillRoot, "README.md"), original);
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "修复超时", goal: "保留可验证经验" }).task as Record<string, unknown>;
    const source = await service.sourceAdd({ path: skillRoot, scan: true });
    const evidence = service.evidenceRecord({ evidence_id: "evidence_experience", source_type: "test",
      claim: "两次试验的结果已记录", confidence: "confirmed" });
    const workflow = service.workflowSave({ workflow_id: "workflow_experience", name: "历史流程" });
    const trialIds = ["trial_experience_pass", "trial_experience_fail"];
    for (const [trialId, verdict] of [[trialIds[0], "passed"], [trialIds[1], "failed"]] as const) {
      service.trialStart({ trial_id: trialId, task_id: task.id, subject_type: "workflow",
        subject_id: workflow.id, subject_version: workflow.version });
      service.outcomeRecord({ trial_id: trialId, verdict, summary: `${verdict} summary`,
        failure_type: verdict === "failed" ? "timeout" : undefined, evidence_ids: [evidence.id] });
    }
    assert.throws(() => service.experiencePatternCreate({ task_id: task.id, summary: "too small",
      success_strategy: "retry", applicability: "java", trial_ids: [trialIds[0]], evidence_ids: [evidence.id] }),
    /at least 2/);
    const pattern = service.experiencePatternCreate({ pattern_id: "pattern_timeout", task_id: task.id,
      summary: "超时修复经验", success_strategy: "先锁定基线，再做最小改动", failure_modes: ["timeout"],
      applicability: "有超时回归证据的 Java 服务", trial_ids: trialIds, evidence_ids: [evidence.id] });
    assert.deepEqual(pattern.outcomes, [
      { trial_id: trialIds[0], verdict: "passed", failure_type: null },
      { trial_id: trialIds[1], verdict: "failed", failure_type: "timeout" },
    ]);
    assert.throws(() => service.experiencePatternCreate({ task_id: task.id, summary: "duplicate",
      success_strategy: "retry", applicability: "java", failure_modes: [],
      trial_ids: [trialIds[0], trialIds[0]], evidence_ids: [evidence.id] }), /unique/);

    const skillMarkdown = "---\nname: timeout-repair\ndescription: Verified repair loop\n---\n# Timeout repair\n";
    assert.throws(() => service.skillProposalCreate({ name: "invalid", summary: "invalid", skill_markdown: "",
      pattern_ids: [pattern.id] }), /skill_markdown/);
    const proposal = service.skillProposalCreate({ proposal_id: "proposal_timeout", name: "timeout-repair",
      summary: "由经验模式生成", skill_markdown: skillMarkdown, pattern_ids: [pattern.id] });
    await assert.rejects(() => service.skillProposalPublish({ proposal_id: proposal.id, source_id: source.id,
      target_path: skillPath, expected_digest: digest(original), allow_external_write: true }), /verified/);
    const candidate = service.skillProposalTransition({ proposal_id: proposal.id, target: "candidate", reason: "评测" });
    const suite = service.evaluationSuiteSave({ suite_id: "suite_proposal", name: "候选集",
      cases: [{ case_id: "held", split: "held_out" }] });
    const trial = service.trialStart({ trial_id: "trial_proposal", task_id: task.id, case_id: "held",
      subject_type: "skill_proposal", subject_id: candidate.id, subject_version: candidate.version });
    service.outcomeRecord({ trial_id: trial.id, verdict: "passed", summary: "候选通过", evidence_ids: [evidence.id] });
    const evaluation = service.evaluationRunRecord({ suite_id: suite.id, split: "held_out",
      subject_type: "skill_proposal", subject_id: candidate.id, subject_version: candidate.version,
      trial_ids: [trial.id] });
    const policy = service.signoffPolicySave({ policy_id: "policy_proposal", name: "候选准入", requirements: [] });
    const signoff = service.signoffEvaluate({ policy_id: policy.id, evaluation_run_id: evaluation.id });
    const verified = service.skillProposalTransition({ proposal_id: candidate.id, target: "verified",
      reason: "现有 Gate 已通过", signoff_id: signoff.id });
    const mcp = new McpServer(service);
    const mcpPattern = await mcp.handlers.craft_experience_pattern_create({ pattern_id: "pattern_mcp", task_id: task.id,
      summary: "MCP pattern", success_strategy: "reuse evidence", applicability: "test", failure_modes: [],
      trial_ids: trialIds, evidence_ids: [evidence.id] });
    await mcp.handlers.craft_experience_pattern_get({ pattern_id: mcpPattern.id });
    await mcp.handlers.craft_experience_pattern_list({});
    const mcpProposal = await mcp.handlers.craft_skill_proposal_create({ proposal_id: "proposal_mcp", name: "mcp",
      summary: "MCP proposal", skill_markdown: skillMarkdown, pattern_ids: [mcpPattern.id] });
    await mcp.handlers.craft_skill_proposal_get({ proposal_id: mcpProposal.id });
    await mcp.handlers.craft_skill_proposal_list({});
    await mcp.handlers.craft_skill_proposal_transition({ proposal_id: mcpProposal.id, target: "candidate", reason: "MCP" });
    await mcp.handlers.craft_skill_proposal_transition({ proposal_id: verified.id, target: "deprecated", reason: "exercise rollback" });
    await mcp.handlers.craft_skill_proposal_rollback({ proposal_id: verified.id, target_version: verified.version,
      reason: "restore verified candidate" });
    await assert.rejects(() => service.skillProposalPublish({ proposal_id: verified.id, source_id: source.id,
      target_path: skillPath, expected_digest: digest(original) }), /allow_external_write/);
    await assert.rejects(() => service.skillProposalPublish({ proposal_id: verified.id, source_id: source.id,
      target_path: join(skillRoot, "README.md"), expected_digest: digest(original), allow_external_write: true }), /SKILL.md/);
    await assert.rejects(() => service.skillProposalPublish({ proposal_id: verified.id, source_id: source.id,
      target_path: outsideSkillPath, expected_digest: digest(original), allow_external_write: true }), /inside/);
    await assert.rejects(() => service.skillProposalPublish({ proposal_id: verified.id, source_id: source.id,
      target_path: skillPath, expected_digest: digest("stale review"), allow_external_write: true }), /changed since/);
    await assert.rejects(() => publishSkill({ sourceRoot: String(source.real_path), targetPath: skillPath,
      expectedDigest: digest(original), content: skillMarkdown, backupsDir: store.paths.backupsDir,
      proposalId: "proposal_race", allowExternalWrite: true,
      onBeforeFinalCheck: async () => writeFile(skillPath, "changed during publication\n") }), /during publication/);
    await writeFile(skillPath, original);
    const publication = await service.skillProposalPublish({ proposal_id: verified.id, source_id: source.id,
      target_path: skillPath, expected_digest: digest(original), allow_external_write: true });
    assert.equal(await readFile(skillPath, "utf8"), skillMarkdown);
    assert.equal(await readFile(String(publication.backup_path), "utf8"), original);
    assert.equal(publication.status, "published");
    await mcp.handlers.craft_skill_publication_get({ publication_id: publication.id });
    await mcp.handlers.craft_skill_publication_list({});
    const mcpPublication = await mcp.handlers.craft_skill_proposal_publish({ proposal_id: verified.id, source_id: source.id,
      target_path: skillPath, expected_digest: digest(skillMarkdown), allow_external_write: true });
    await mcp.handlers.craft_skill_publication_rollback({ publication_id: mcpPublication.id,
      expected_digest: digest(skillMarkdown), allow_external_write: true });

    await writeFile(skillPath, "user changed this\n");
    await assert.rejects(() => service.skillPublicationRollback({ publication_id: publication.id,
      expected_digest: digest(skillMarkdown), allow_external_write: true }), /digest/);
    const userDigest = digest("user changed this\n");
    await assert.rejects(() => service.skillPublicationRollback({ publication_id: publication.id,
      expected_digest: userDigest, allow_external_write: true }), /digest/);
    await writeFile(skillPath, skillMarkdown);
    const rollback = await service.skillPublicationRollback({ publication_id: publication.id,
      expected_digest: digest(skillMarkdown), allow_external_write: true });
    assert.equal(rollback.status, "rolled_back");
    assert.equal(await readFile(skillPath, "utf8"), original);
    await assert.rejects(() => service.skillPublicationRollback({ publication_id: publication.id,
      expected_digest: digest(original), allow_external_write: true }), /Only a published/);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
