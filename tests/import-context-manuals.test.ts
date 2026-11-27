import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = resolve("scripts/import-context-manuals.ts");
const workspaceText = ["接口返回成功只代表请求已受理", "先进入目标仓库，再检查分支、工作区和关联工作树。", "本地页面的代理地址可能直接决定请求打到本地还是远端。", "推送成功只证明代码进入远端分支。", "合成会话成功与数据集上传成功是两个独立结果。", "写 API 禁止真实调用，这是测试红线。"].join("\n\n");
const dsimuText = ["Fitan `/flow/checkFlow` 会调用状态更新和画布同步逻辑", "三个空间标识用途不同，不可互换。", "以下顺序对应已经执行过的配置路径。", "S2 的 `order_id`、`order_district`、`business_type` 是后续工具的必需来源。", "仓库没有这组标准化资产的通用回退脚本。", "Agent 提示词提到 Tool，但 preCheck 说未添加"].join("\n\n");

test("manual import previews without writes, rejects source drift and is repeatable", () => {
  const temp = mkdtempSync(join(tmpdir(), "craft-manual-import-"));
  try {
    const workspace = join(temp, "workspace"), dsimu = join(workspace, "d-simu"), data = join(temp, "data");
    const first = join(workspace, "AI_WORKSPACE_OPERATIONS.md"), second = join(dsimu, "docs/runbooks/standardized-conversation-agent-setup.md");
    mkdirSync(join(dsimu, "docs/runbooks"), { recursive: true });
    writeFileSync(first, workspaceText); writeFileSync(second, dsimuText);
    const run = (extra: string[] = [], fault?: string) => spawnSync(process.execPath, ["--experimental-strip-types", ...(fault ? ["--experimental-loader", resolve("tests/fixtures/manual-import-fault-loader.mjs")] : []), script, `--workspace-root=${workspace}`, `--dsimu-root=${dsimu}`, ...extra],
      { cwd: resolve("."), env: { ...process.env, CRAFT_DATA_DIR: data, CRAFT_MANUAL_TEST_FAULT: fault }, encoding: "utf8", timeout: 60_000 });
    const preview = run(); assert.equal(preview.status, 0, preview.stderr);
    assert.equal(existsSync(data), false); assert.equal(existsSync(join(workspace, ".craft_data")), false);
    for (const invalid of [["--unknown"], ["--apply"], ["--apply", "--apply"], ["--workspace-root=x"], ["--workspace-digest=bad"], ["--apply", `--workspace-digest=sha256:${"a".repeat(64)}`]]) {
      const rejected = run(invalid); assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /Usage:/u);
    }
    const sameRoot = spawnSync(process.execPath, ["--experimental-strip-types", script, `--workspace-root=${workspace}`, `--dsimu-root=${workspace}`], { env: { ...process.env, CRAFT_DATA_DIR: data }, encoding: "utf8" });
    assert.notEqual(sameRoot.status, 0); assert.match(sameRoot.stderr, /must differ/u);
    writeFileSync(second, "unrelated text");
    const missingExcerpt = run(); assert.notEqual(missingExcerpt.status, 0); assert.match(missingExcerpt.stderr, /Source excerpt missing/u);
    writeFileSync(second, dsimuText);
    const renamed = `${first}.original`;
    const original = readFileSync(first, "utf8"); rmSync(first); writeFileSync(renamed, original); symlinkSync(renamed, first);
    const linked = run(); assert.notEqual(linked.status, 0); assert.match(linked.stderr, /symlink/u);
    rmSync(first); writeFileSync(first, original); rmSync(renamed);
    const init = spawnSync("git", ["init", "-q", workspace], { encoding: "utf8" }); assert.equal(init.status, 0, init.stderr);
    const wrongRoot = run(); assert.notEqual(wrongRoot.status, 0); assert.match(wrongRoot.stderr, /does not match Git root/u);
    rmSync(join(workspace, ".git"), { recursive: true, force: true });
    const oldRuntime = run([], "storage"); assert.notEqual(oldRuntime.status, 0); assert.match(oldRuntime.stderr, /outside the project/u);
    const lines = preview.stdout.trim().split("\n").map(line => JSON.parse(line));
    const argumentsForApply = ["--apply", `--workspace-digest=${lines[0].digest}`, `--dsimu-digest=${lines[1].digest}`];
    writeFileSync(first, workspaceText + "\nchanged");
    const stale = run(argumentsForApply); assert.notEqual(stale.status, 0); assert.match(stale.stderr, /changed since preview/u); assert.equal(existsSync(data), false);
    writeFileSync(first, workspaceText);
    const drift = run(argumentsForApply, "drift"); assert.notEqual(drift.status, 0); assert.match(drift.stderr, /changed before import/u);
    writeFileSync(first, workspaceText);
    const corruptReadback = run(argumentsForApply, "readback"); assert.notEqual(corruptReadback.status, 0); assert.match(corruptReadback.stderr, /Candidate readback mismatch/u);
    const corruptLesson = run(argumentsForApply, "lesson"); assert.notEqual(corruptLesson.status, 0); assert.match(corruptLesson.stderr, /Candidate readback mismatch/u);
    const applied = run(argumentsForApply); assert.equal(applied.status, 0, applied.stderr);
    const result = applied.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(result.slice(-2).map(item => item.experience_candidates), [6, 6]);
    const repeated = run(argumentsForApply); assert.equal(repeated.status, 0, repeated.stderr);
    assert.deepEqual(repeated.stdout.trim().split("\n").map(line => JSON.parse(line)).slice(-2).map(item => item.state), ["candidate", "candidate"]);
    assert.equal(readFileSync(first, "utf8"), workspaceText);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
