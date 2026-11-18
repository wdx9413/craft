import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ProcedureStore } from '@craft/capability-experience/procedure-projection';
import { evaluateEvolutionValue } from "../core/evolution-value-gate.ts";
import { captureUserStatedRunbook, extractUserStatedOperatingSteps } from "../core/evolution-runbook-candidate.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";
import { projectExperienceDirectory } from "../core/project-experience-directory.ts";
import { retrievalTerms } from 'craft-common-base/retrieval-terms';

const examples = [
  { name: "web", statement: "网页操作流程：先打开登录页，再输入测试账号，然后查看仪表盘，最后退出登录。", query: "网页操作流程：先打开登录页" },
  { name: "ppt", statement: "如何制作 PPT：先确定大纲，再选择模板，然后填写每页内容，最后导出 PDF。", query: "如何制作 PPT：先确定大纲" },
  { name: "experiment", statement: "实验操作流程：先校准设备，再记录基线，然后运行三组样本，最后整理结果。", query: "实验操作流程：先校准设备" },
] as const;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-evolution-runbook-"));
  const store = await new CraftStore(craftPaths(root)).open();
  store.create("scope_alias", "project-alias", { status: "active", alias_kind: "path", alias: root, alias_digest: stableDigest(root), scope: { kind: "project", id: "project:self-evolution" } });
  projectExperienceDirectory(store, "project:self-evolution", root, true);
  store.create("evidence", "gate-evidence", { source_type: "human", confidence: "bounded", claim: "Fixture evidence for gate eligibility checks.", locator: "fixture:gate" });
  return { root, store, procedures: new ProcedureStore(store), close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function sourceRef(statement: string, index: number): JsonObject {
  return { kind: "user-statement", statement, session_id: "session-runbook", turn_id: `turn-${index}` };
}

function recalledCandidates(store: CraftStore, query: string): JsonObject[] {
  const terms = retrievalTerms(query);
  return store.list("experience_procedure", 100, (item) => {
    if (item.runbook_candidate !== true || item.lifecycle !== "candidate" || item.routeable === true || item.domain !== "coding") return false;
    const text = `${String(item.title)} ${String(item.applies_when)} ${String(item.pitfall)} ${String(item.correct_method)}`.toLowerCase();
    return terms.some((term) => text.includes(term));
  });
}

test("explicit operating steps are extracted only from user-stated step declarations", () => {
  for (const item of examples) {
    assert.deepEqual(extractUserStatedOperatingSteps(item.statement), [item.statement]);
  }
  assert.deepEqual(extractUserStatedOperatingSteps("帮我打开网页然后点击登录按钮"), []);
  assert.deepEqual(extractUserStatedOperatingSteps("网页操作流程：先打开登录页，api_key=abcdefghijklmnop。"), []);
});

for (const example of examples) {
  test(`${example.name} operating steps become a diagnostic-only Runbook candidate`, async () => {
    const f = await fixture();
    try {
      const decision = evaluateEvolutionValue({ statement: example.statement, source_kind: "user-statement", explicit: true, verification: "passed", scope: { scope_kind: "project", scope_id: "self-evolution" } });
      assert.equal(decision.action, "candidate_procedure");
      const captured = captureUserStatedRunbook(f.store, { statement: example.statement, session_id: "session-runbook", turn_id: "turn-web", source_refs: [sourceRef(example.statement, 0)] });
      const procedure = captured.procedure as JsonObject;
      assert.equal(captured.diagnostic_only, true);
      assert.equal(procedure.runbook_candidate, true);
      assert.equal(procedure.lifecycle, "candidate");
      assert.equal(procedure.routeable, false);
      assert.equal(procedure.publication_allowed, false);
      assert.equal(procedure.execution_visible, false);
      assert.deepEqual(procedure.applicable_when, ["用户口述的操作步骤"]);
      assert.deepEqual(procedure.excluded_when, ["未经人工评审", "未获得独立验证证据"]);
      assert.equal(procedure.completion_criteria, "步骤可在同项目中由人工按记录复核");
      assert.equal(procedure.failure_handling, "停止执行并交由人工评审或撤销候选");
      assert.deepEqual(procedure.source_statement_refs, [sourceRef(example.statement, 0)]);
      const body = f.store.contentStore.readCompatSync((procedure.content_ref as unknown as never)).body;
      assert.match(String(body), new RegExp(retrievalTerms(example.query)[0] ?? "", "iu"));

      const recalled = recalledCandidates(f.store, example.query);
      assert.equal(recalled.length, 1);
      const firstRecalled = recalled[0] as JsonObject | undefined;
      assert.equal(firstRecalled?.runbook_candidate, true);
      assert.equal(firstRecalled?.routeable, false);
      assert.equal(firstRecalled?.diagnostic_only, true);

      assert.throws(() => f.procedures.gate({ procedure_id: String(procedure.id), stage: "shadow", passed: true, evidence_ids: ["missing"] }), /Runbook candidates cannot pass Procedure gates directly/u);
      assert.throws(() => f.procedures.skillExport({ procedure_id: String(procedure.id) }), /Only routeable/u);
      const procedures = (f.procedures.list({ scope: "project:self-evolution" }).procedures as JsonObject[]);
      assert.equal(procedures.some((item) => item.user_stated_runbook === true && item.id === procedure.id), true);

      const revoked = f.store.save("experience_procedure", String(procedure.id), { ...procedure, lifecycle: "rolled_back", routeable: false, revocation_reason: "reviewed" });
      assert.equal(revoked.lifecycle, "rolled_back");
      assert.equal(recalledCandidates(f.store, example.query).length, 0);
    } finally { f.close(); }
  });
}

test("user-stated Runbook capture is idempotent and rejects unsafe or non-step statements", async () => {
  const f = await fixture();
  try {
    const statement = examples[0]!.statement;
    const args = { statement, session_id: "session-runbook", turn_id: "turn-web", source_refs: [sourceRef(statement, 0)] };
    const first = captureUserStatedRunbook(f.store, args);
    const second = captureUserStatedRunbook(f.store, args);
    assert.equal(second.idempotent, true);
    assert.deepEqual(second.procedure, first.procedure);
    assert.throws(() => captureUserStatedRunbook(f.store, { ...args, turn_id: "turn-other" }), /different Runbook candidate/u);
    assert.throws(() => captureUserStatedRunbook(f.store, { ...args, statement: "帮我打开网页然后点击登录按钮", source_refs: [] }), /operating steps/u);
    assert.throws(() => captureUserStatedRunbook(f.store, { ...args, source_refs: [] }), /source statement reference/u);
  } finally { f.close(); }
});
