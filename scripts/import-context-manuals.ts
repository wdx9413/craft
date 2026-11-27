/** Import two explicitly scoped manuals after the local runtime uses project-owned storage. */
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { projectIdentityFromRoot } from "../core/scope-identity.ts";
import { projectStorageDirectory } from "craft-common-store-local/paths";
import { ProcedureStore } from "@craft/capability-experience/procedure-projection";

const args = process.argv.slice(2);
const value = (key: string) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
const keys = ["workspace-root", "dsimu-root", "workspace-digest", "dsimu-digest"];
const apply = args.includes("--apply");
if (args.some(arg => arg !== "--apply" && !keys.some(key => arg.startsWith(`--${key}=`)))
  || args.filter(arg => arg === "--apply").length > 1
  || keys.some(key => args.filter(arg => arg.startsWith(`--${key}=`)).length > 1)
  || !value("workspace-root") || !value("dsimu-root")
  || (apply && (!/^sha256:[a-f0-9]{64}$/u.test(value("workspace-digest") ?? "") || !/^sha256:[a-f0-9]{64}$/u.test(value("dsimu-digest") ?? "")))
  || (!apply && (value("workspace-digest") !== undefined || value("dsimu-digest") !== undefined))) {
  throw new Error("Usage: import-context-manuals.ts --workspace-root=<path> --dsimu-root=<path> [--apply --workspace-digest=<sha256> --dsimu-digest=<sha256>]");
}
const workspaceRoot = realpathSync(value("workspace-root")!);
const dsimuRoot = realpathSync(value("dsimu-root")!);
if (workspaceRoot === dsimuRoot) throw new Error("Workspace and d-simu project roots must differ");
const manuals = [
  { key: "eval-workspace-operations", root: workspaceRoot, file: join(workspaceRoot, "AI_WORKSPACE_OPERATIONS.md"), expected: value("workspace-digest"),
    title: "多仓异步任务核验", excerpt: "接口返回成功只代表请求已受理", applies_when: "排查 eval-all 异步任务及其产物", exclude_when: "不涉及异步任务", pitfall: "请求受理被当成任务完成", cause: "异步流程还有后续阶段", correct_method: "等待终态并分别核对用例、回调和数据集产物", synthetic_example: "请求受理后查询最终状态和产物", done_criteria: "任务终态与产物已核对", failure_handling: "定位首个失败阶段并保留可核对的错误" },
  { key: "dsimu-standardized-agent", root: dsimuRoot, file: join(dsimuRoot, "docs/runbooks/standardized-conversation-agent-setup.md"), expected: value("dsimu-digest"),
    title: "标准化 Agent 只读验收", excerpt: "Fitan `/flow/checkFlow` 会调用状态更新和画布同步逻辑", applies_when: "核对预发标准化 Agent 静态配置", exclude_when: "缺少目标环境或对象身份", pitfall: "将 checkFlow 当作只读检查", cause: "checkFlow 会更新状态并同步画布", correct_method: "使用详情接口回读 Agent、Tool、Scene 和 Solution 的状态及引用", synthetic_example: "通过 Flow detail 核对画布", done_criteria: "静态配置与版本逐项回读", failure_handling: "状态异常时停止并按正常流程核对恢复" },
];
const extraLessons: Record<string, Array<{ title: string; excerpt: string; method: string }>> = {
  "eval-workspace-operations": [
    { title: "多仓 Git 和工作树检查", excerpt: "先进入目标仓库，再检查分支、工作区和关联工作树。", method: "进入目标子仓库，检查状态、分支和工作树，保留已有改动。" },
    { title: "运行配置和代理核验", excerpt: "本地页面的代理地址可能直接决定请求打到本地还是远端。", method: "核对运行 profile、代理配置和实际请求 Host。" },
    { title: "部署后运行进程核验", excerpt: "推送成功只证明代码进入远端分支。", method: "核对流水线制品、进程版本、配置与健康检查，再从入口验证。" },
    { title: "合成上传与重试副作用", excerpt: "合成会话成功与数据集上传成功是两个独立结果。", method: "分别检查会话、上传和数据集，重试前确认回调副作用。" },
    { title: "测试写请求 Mock 隔离", excerpt: "写 API 禁止真实调用，这是测试红线。", method: "检查环境和整条写请求的 Mock 路由与接收侧证据。" },
  ],
  "dsimu-standardized-agent": [
    { title: "标准化资产空间与客户端", excerpt: "三个空间标识用途不同，不可互换。", method: "按目标接口和对象类型分别确认 Agent、资产与 Fitan 空间。" },
    { title: "标准化资产配置顺序", excerpt: "以下顺序对应已经执行过的配置路径。", method: "读取基线，依次准备特征指令、Solution、Scene、Tool 和 Agent，再回读状态。" },
    { title: "对话订单字段来源", excerpt: "S2 的 `order_id`、`order_district`、`business_type` 是后续工具的必需来源。", method: "逐项核对输入 schema、指令特征、节点来源和 Agent 绑定，缺失时停止。" },
    { title: "写入前快照与回退", excerpt: "仓库没有这组标准化资产的通用回退脚本。", method: "写入前保存脱敏快照和版本，回退使用正常 API 并回读。" },
    { title: "Agent 绑定故障排查", excerpt: "Agent 提示词提到 Tool，但 preCheck 说未添加", method: "比较 toolList、instructionConfig 和富文本 mention 的标识与版本。" },
  ],
};
const paths = craftPaths();
for (const item of manuals) {
  const identity = projectIdentityFromRoot(item.root);
  const scope = String((identity.canonical_scope as Record<string, unknown>).id);
  if (identity.local_path_alias !== item.root) throw new Error(`Project root does not match Git root: ${item.key}`);
  if (realpathSync(item.file) !== item.file) throw new Error(`Source path must not traverse a symlink: ${item.key}`);
  const content = readFileSync(item.file);
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (apply && item.expected !== digest) throw new Error(`Source changed since preview: ${item.key}`);
  for (const excerpt of [item.excerpt, ...extraLessons[item.key].map(lesson => lesson.excerpt)]) if (!content.toString("utf8").includes(excerpt)) throw new Error(`Source excerpt missing: ${item.key}`);
  if (projectStorageDirectory(paths, item.root) !== join(item.root, ".craft_data")) throw new Error("Runtime still resolves project data outside the project; upgrade runtime before import");
  console.log(JSON.stringify({ item: item.key, scope, digest, project_data: join(item.root, ".craft_data") }));
}
if (!apply) process.exit(0);
const store = await new CraftStore(paths).open();
try {
  const service = new CraftService(store);
  const procedures = new ProcedureStore(store);
  for (const item of manuals) {
    const identity = service.scopeIdentityResolveProject({ project_root: item.root }).identity as Record<string, unknown>;
    const scope = String((identity.canonical_scope as Record<string, unknown>).id);
    const content = readFileSync(item.file);
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    if (digest !== item.expected || realpathSync(item.file) !== item.file) throw new Error(`Source changed before import: ${item.key}`);
    const sourceId = `manual-${item.key}-${createHash("sha256").update(`${scope}:${digest}`).digest("hex").slice(0, 24)}`;
    service.knowledgeSourceRegister({ source_id: sourceId, kind: "readme", label: item.title, scope_kind: "project", scope_id: scope,
      locator: item.file, project_root: item.root, content_digest: digest, trust: "bounded", access: "read_only" });
    const ingestion = service.knowledgeSourceIngest({ source_id: sourceId, max_files: 1, max_chars_per_fragment: 1500 });
    const captured = procedures.runbookCapture({ decision: "capture_document", scope, source_path: item.file, source_excerpt: item.excerpt,
      title: item.title, applies_when: item.applies_when, exclude_when: item.exclude_when, pitfall: item.pitfall, cause: item.cause,
      correct_method: item.correct_method, synthetic_example: item.synthetic_example, done_criteria: item.done_criteria, failure_handling: item.failure_handling });
    const procedure = captured.procedure as Record<string, unknown>;
    const reread = procedures.get({ procedure_id: procedure.id }).procedure as Record<string, unknown>;
    if ((reread.source_ref as Record<string, unknown>).digest !== digest || reread.scope !== scope || reread.lifecycle !== "candidate") throw new Error(`Candidate readback mismatch: ${item.key}`);
    for (const lesson of extraLessons[item.key]) {
      const candidate = procedures.runbookCapture({ decision: "capture_document", scope, source_path: item.file, source_excerpt: lesson.excerpt,
        title: lesson.title, applies_when: item.applies_when, exclude_when: item.exclude_when, pitfall: lesson.title, cause: "参见来源摘录",
        correct_method: `${lesson.method} 来源中的环境和版本为历史快照，使用前重新核对。`, synthetic_example: "按当前目标重新读取状态",
        done_criteria: "完成当前目标的实际状态核对", failure_handling: "停止并定位无法核实的项目或阶段" });
      const row = candidate.procedure as Record<string, unknown>;
      const verified = procedures.get({ procedure_id: row.id }).procedure as Record<string, unknown>;
      if ((verified.source_ref as Record<string, unknown>).digest !== digest || verified.scope !== scope || verified.lifecycle !== "candidate") throw new Error(`Candidate readback mismatch: ${lesson.title}`);
    }
    console.log(JSON.stringify({ item: item.key, source_id: sourceId, knowledge_candidates: (ingestion.candidates as unknown[]).length, experience_candidates: 1 + extraLessons[item.key].length, state: reread.lifecycle }));
  }
} finally { store.close(); }
