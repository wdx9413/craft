import assert from "node:assert/strict";
import test from "node:test";
import { installCommand, TOOL_INSTALL_CATALOG, ToolInstallManager } from "../core/interfaces/workbench-tool-install.ts";

async function settle(manager: ToolInstallManager, id: string) {
  for (let index = 0; index < 50; index += 1) {
    const job = manager.get(id);
    if (job && job.state !== "running") return job;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("install job did not settle");
}

test("the installer catalog is an exact allow-list", () => {
  assert.deepEqual(Object.keys(TOOL_INSTALL_CATALOG).sort(), ["claude", "codex", "dsh"]);
  assert.match(installCommand("codex").label, /^npm install -g/);
  assert.throws(() => installCommand("bash" as never), /没有可自动执行/);
});

test("a successful install verifies the executable and exposes bounded output", async () => {
  const manager = new ToolInstallManager({
    run: async (_command, _args, output) => { output("installed\n"); return { code: 0 }; },
    detect: async () => ({ available: true, executable: "/usr/local/bin/codex" }),
  });
  const started = manager.start("codex");
  assert.equal(started.state, "running");
  const finished = await settle(manager, started.id);
  assert.equal(finished.state, "succeeded");
  assert.equal(finished.stage, "done");
  assert.equal(finished.exit_code, 0);
  assert.equal(finished.detected_executable, "/usr/local/bin/codex");
  assert.match(finished.output, /installed/);
  assert.match(finished.output, /已验证/);
});

test("a non-zero exit or an unverified executable is a failure, not success", async () => {
  const failed = new ToolInstallManager({ run: async () => ({ code: 1 }), detect: async () => ({ available: true, executable: null }) });
  assert.equal((await settle(failed, failed.start("claude").id)).state, "failed");
  const unverified = new ToolInstallManager({ run: async () => ({ code: 0 }), detect: async () => ({ available: false, executable: null }) });
  const job = await settle(unverified, unverified.start("dsh").id);
  assert.equal(job.state, "failed");
  assert.match(job.error ?? "", /未检测到可运行/);
});

test("a runner error is reported and concurrent installs are rejected", async () => {
  let release: (() => void) | undefined;
  const manager = new ToolInstallManager({ run: () => new Promise((done) => { release = () => done({ code: 0 }); }), detect: async () => ({ available: true, executable: "/bin/x" }) });
  const first = manager.start("codex");
  assert.throws(() => manager.start("claude"), /已有安装任务/);
  release?.();
  await settle(manager, first.id);
  const broken = new ToolInstallManager({ run: async () => { throw new Error("npm missing"); }, detect: async () => ({ available: false, executable: null }) });
  const job = await settle(broken, broken.start("codex").id);
  assert.equal(job.state, "failed");
  assert.match(job.error ?? "", /npm missing/);
});

test("older npm without --allow-scripts falls back to a plain global install", async () => {
  const calls: string[][] = [];
  const manager = new ToolInstallManager({
    run: async (_command, args, output) => {
      calls.push(args);
      if (calls.length === 1) { output("npm error unknown option '--allow-scripts'\n"); return { code: 1 }; }
      output("added 1 package\n");
      return { code: 0 };
    },
    detect: async () => ({ available: true, executable: "/bin/codex" }),
  });
  const job = await settle(manager, manager.start("codex").id);
  assert.equal(job.state, "succeeded");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], ["install", "-g", "@openai/codex"]);
});

test("cancel is terminal and listing includes the allow-listed commands", async () => {
  const manager = new ToolInstallManager({ run: () => new Promise(() => {}), detect: async () => ({ available: true, executable: null }) });
  const job = manager.start("dsh");
  assert.equal(manager.cancel(job.id).state, "cancelled");
  assert.equal(manager.cancel(job.id).state, "cancelled");
  const listed = manager.list();
  assert.equal(listed.providers.length, 3);
  assert.ok(listed.providers.every((entry) => entry.command.startsWith("npm install -g")));
  assert.throws(() => manager.cancel("missing"), /不存在/);
});
