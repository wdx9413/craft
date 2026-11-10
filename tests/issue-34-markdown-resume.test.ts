import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { ActionGatewayKernel } from "../core/runtime-completion.ts";
import { WorkbenchWebApp } from "../core/interfaces/workbench-server.ts";
import { digestJson } from "../core/digest.ts";

test("reopened task retains web sources, pending work, run and artifact version; targeted Markdown patch preserves human edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-issue-34-"));
  const reportPath = join(root, "competitor-report.md");
  let store = await new CraftStore(craftPaths(root)).open();
  let service = new CraftService(store);
  try {
    const task = service.taskOpen({ title: "竞品价格研究", goal: "比较 Acme 与 Beta 的公开价格并保留来源" }).task as JsonObject;
    const workspace = service.workspaceOpen({ workspace_id: "research", name: "竞品研究", root_path: root, include_paths: ["."] }).workspace as JsonObject;
    const control = service.taskControlSave({ task_id: task.id, workspace: root, allowed_effects: ["read_only"] }).contract as JsonObject;
    const prepared = service.taskRunPrepare({ task_run_id: "research-run", contract_id: control.id, host: "internal", workspace: root,
      prompt: "读取公开页面并整理价格", sandbox: "read-only", defer_host_start: true, budget: { usd: 1 } });
    const initialLaunch = prepared.launch as JsonObject;
    service.taskCheckpoint({ task_id: task.id, summary: "已收集 Acme；等待补充 Beta", status: "active",
      completed: ["读取 Acme 公共页面"], pending: ["补充 Beta 价格", "核对报告来源"] });

    const fetched = await service.webFetch({ task_id: task.id, operation_id: "source-acme", url: "https://shop.example/acme" },
      async () => new Response("<html><title>Acme</title><body>Price: 29 CNY</body></html>", { headers: { "content-type": "text/html" } }),
      async () => [{ address: "93.184.216.34", family: 4 }]);
    const source = fetched.source as JsonObject;
    const pageEvidence = fetched.evidence as JsonObject;
    const before = ["# 竞品价格研究", "", "## 价格", "- Acme：29 CNY [1]", "- Beta：35 CNY [2]", "", "## 人工备注", "- 需核实 Beta 是否含税", ""].join("\n");
    await writeFile(reportPath, before, "utf8");
    const artifactV1 = service.artifactRegister({ artifact_id: "competitor-report", kind: "report", name: "competitor-report.md",
      uri: reportPath, media_type: "text/markdown", digest: digestJson(before), producer_type: "task", producer_id: task.id }) as JsonObject;
    const outputEvidence = service.evidenceRecord({ evidence_id: "report-output-evidence", source_type: "program", confidence: "bounded",
      claim: "报告文件已保存", artifact_id: artifactV1.id, locator: reportPath, metadata: { task_id: task.id } });
    store.create("trial", "research-trial", { task_id: task.id, subject_type: "task", subject_id: task.id, status: "active" });
    store.create("outcome", "outcome_research-trial", { trial_id: "research-trial", verdict: "awaiting_verification",
      summary: "报告等待补充 Beta 与验收", evidence_ids: [pageEvidence.id, outputEvidence.id] });
    store.create("attention_item", "pending-research-decision", { task_id: task.id, status: "open", audience: "human",
      priority: 80, reason: "核对 Beta 页面是否含税", action: "review", source_kind: "task_run", source_id: "research-run" });

    store.close();
    store = await new CraftStore(craftPaths(root)).open();
    service = new CraftService(store);
    const app = new WorkbenchWebApp(service, "local-token", "http://127.0.0.1:4173");
    const response = app.handle({ method: "GET", path: `/api/tasks/${encodeURIComponent(String(task.id))}`, token: "local-token" });
    assert.equal(response.status, 200);
    const reopened = JSON.parse(String(response.body)) as JsonObject;
    const reopenedTask = reopened.task as JsonObject;
    assert.equal(reopenedTask.goal, "比较 Acme 与 Beta 的公开价格并保留来源");
    assert.equal((reopened.checkpoints as JsonObject[])[0]?.summary, "已收集 Acme；等待补充 Beta");
    assert.ok(((reopened.checkpoints as JsonObject[])[0]?.pending as string[]).includes("补充 Beta 价格"));
    assert.ok(((reopened.attention as JsonObject[]).some(item => item.id === "pending-research-decision")));
    assert.ok(((reopened.evidence as JsonObject[]).some(item => (item.locator as JsonObject)?.url === source.url)));
    assert.ok(((reopened.task_runs as JsonObject[]).some(item => item.id === "research-run")));
    const currentArtifact = (reopened.artifacts as JsonObject[]).find(item => item.id === artifactV1.id);
    assert.equal(currentArtifact?.version, artifactV1.version);
    assert.equal(currentArtifact?.digest, digestJson(before));
    assert.equal(((service.taskRunGet({ task_run_id: "research-run" }).run as JsonObject).launch_id), initialLaunch.id);

    const firstWriter = new ActionGatewayKernel(store);
    const staleDigest = digestJson(before);
    const stalePrepare = firstWriter.prepare({ action_id: "beta-stale-patch", task_id: task.id, workspace: root,
      operation: "workspace_patch", effect: "local_write", input_digest: digestJson({ action: "replace Beta price" }) });
    const userEdited = before + "\n- 用户补充：页面截图里的促销价只对会员生效\n";
    await writeFile(reportPath, userEdited, "utf8");
    await assert.rejects(() => firstWriter.execute({ action_id: (stalePrepare.action as JsonObject).id, relative_path: "competitor-report.md",
      expected_digest: staleDigest, edits: [{ old_text: "- Beta：35 CNY [2]", new_text: "- Beta：32 CNY [2]" }], approved: true }), /expected_digest does not match current content/u);
    assert.equal(await readFile(reportPath, "utf8"), userEdited);

    const currentDigest = digestJson(userEdited);
    const freshPrepare = firstWriter.prepare({ action_id: "beta-fresh-patch", task_id: task.id, workspace: root,
      operation: "workspace_patch", effect: "local_write", input_digest: digestJson({ action: "replace Beta price after reread" }) });
    const patched = await firstWriter.execute({ action_id: (freshPrepare.action as JsonObject).id, relative_path: "competitor-report.md",
      expected_digest: currentDigest, edits: [{ old_text: "- Beta：35 CNY [2]", new_text: "- Beta：32 CNY [2]" }], approved: true });
    const finalMarkdown = await readFile(reportPath, "utf8");
    assert.equal((patched.result as JsonObject).after_digest, digestJson(finalMarkdown));
    assert.ok(finalMarkdown.includes("- Acme：29 CNY [1]"));
    assert.ok(finalMarkdown.includes("- Beta：32 CNY [2]"));
    assert.ok(finalMarkdown.includes("- 用户补充：页面截图里的促销价只对会员生效"));
    assert.ok(!finalMarkdown.includes("- Beta：35 CNY [2]"));
    const artifactV2 = service.artifactRegister({ artifact_id: "competitor-report", kind: "report", name: "competitor-report.md",
      uri: reportPath, media_type: "text/markdown", digest: digestJson(finalMarkdown), producer_type: "task", producer_id: task.id }) as JsonObject;
    assert.equal(artifactV2.version, Number(artifactV1.version) + 1);

    store.close();
    store = await new CraftStore(craftPaths(root)).open();
    service = new CraftService(store);
    const finalResponse = new WorkbenchWebApp(service, "local-token", "http://127.0.0.1:4173").handle({
      method: "GET", path: `/api/tasks/${encodeURIComponent(String(task.id))}`, token: "local-token" });
    const finalTaskView = JSON.parse(String(finalResponse.body)) as JsonObject;
    const finalArtifact = (finalTaskView.artifacts as JsonObject[]).find(item => item.id === artifactV2.id);
    assert.equal(finalArtifact?.version, artifactV2.version);
    assert.equal(finalArtifact?.digest, digestJson(finalMarkdown));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
