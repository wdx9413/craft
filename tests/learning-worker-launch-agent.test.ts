import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LEARNING_WORKER_LAUNCH_AGENT_LABEL, installLearningWorkerLaunchAgent, learningWorkerLaunchAgentStatus,
  renderLearningWorkerLaunchAgent, startLearningWorkerLaunchAgent, stopLearningWorkerLaunchAgent,
  ensureLearningWorkerLaunchAgent, uninstallLearningWorkerLaunchAgent, upgradeLearningWorkerLaunchAgent, type LaunchAgentDependencies } from "../core/learning-worker-launch-agent.ts";

function fixture(options: { installed?: boolean; loaded?: boolean; contents?: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}) {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const modes: number[] = [];
  const chmodPaths: string[] = [];
  const directories: string[] = [];
  const unlinked: string[] = [];
  const plistPath = "/tmp/craft-test-home/Library/LaunchAgents/com.craft.learning-worker.plist";
  if (options.installed) files.set(plistPath, options.contents ?? "installed");
  let loaded = options.loaded ?? false;
  const deps: LaunchAgentDependencies = {
    platform: options.platform ?? "darwin", home_dir: "/tmp/craft-test-home", uid: 501, exec_path: "/usr/bin/node",
    worker_entrypoint: "/opt/craft/worker.js", env: { CRAFT_DATA_DIR: "/tmp/craft-test-data", PATH: process.env.PATH, ...options.env },
    exists: () => true,
    mkdir: path => { directories.push(path); },
    read_file: path => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    write_file: (path, value, options) => {
      if (options.flag === "wx" && files.has(path)) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      files.set(path, value); modes.push(options.mode);
    },
    chmod: path => { chmodPaths.push(path); },
    unlink: path => { unlinked.push(path); files.delete(path); },
    rename: (oldPath, newPath) => { const value = files.get(oldPath); if (value === undefined) throw new Error("missing temp plist"); files.set(newPath, value); files.delete(oldPath); },
    launchctl: args => {
      calls.push(args);
      if (args[0] === "print") {
        if (!loaded) throw Object.assign(new Error("not loaded"), { status: 113 });
        return "loaded";
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return "";
    },
  };
  return { deps, files, calls, modes, chmodPaths, directories, unlinked, plistPath, loaded: () => loaded };
}

function installedPlist(worker: string, dataRoot = "/tmp/craft-test-data") {
  return renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: worker, data_root: dataRoot,
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", CRAFT_EXPERIENCE_MCP_COMMAND: "/usr/bin/node",
      CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify([join(worker, "..", "craft-mcp.cjs"), "--surface", "component-context-complete"]) } });
}

test("LaunchAgent plist pins the exact worker and scoped data root without credentials", () => {
  const plist = renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/opt/Craft & Co/worker.js", data_root: "/tmp/data<&>" });
  assert.match(plist, new RegExp(LEARNING_WORKER_LAUNCH_AGENT_LABEL));
  assert.match(plist, /\/opt\/Craft &amp; Co\/worker\.js/u);
  assert.match(plist, /\/tmp\/data&lt;&amp;&gt;/u);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/u);
  assert.match(plist, /<key>StartInterval<\/key><integer>60<\/integer>/u);
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>/u);
  assert.match(plist, /<key>PATH<\/key><string>[^<]+<\/string>/u);
  assert.match(plist, /CRAFT_LEARNING_WORKER_REVISION/u);
  assert.doesNotMatch(plist, /TOKEN|SECRET|API_KEY/u);
});

test("LaunchAgent preserves held-out evaluator configuration without copying credentials", () => {
  const f = fixture({ env: { CRAFT_LEARNING_PROJECT_SCOPES: '[{"kind":"project","id":"project:fixture"}]', CRAFT_PROGRAM_MEMORY_DESIGNS: "{}",
    CRAFT_HELD_OUT_ADAPTER_COMMAND: '["/opt/craft/evaluator","--stdio"]', CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS: "120000",
    CRAFT_TRUSTED_EVALUATORS: '[{"id":"fixture-evaluator","version":"1"}]',
    OPENAI_API_KEY: "must-not-be-copied" } });
  installLearningWorkerLaunchAgent(f.deps);
  const plist = f.files.get(f.plistPath)!;
  assert.match(plist, /CRAFT_LEARNING_PROJECT_SCOPES/u);
  assert.match(plist, /CRAFT_PROGRAM_MEMORY_DESIGNS/u);
  assert.match(plist, /CRAFT_HELD_OUT_ADAPTER_COMMAND/u);
  assert.match(plist, /\[&quot;\/opt\/craft\/evaluator&quot;,&quot;--stdio&quot;\]/u);
  assert.match(plist, /CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS/u);
  assert.match(plist, /CRAFT_TRUSTED_EVALUATORS/u);
  assert.doesNotMatch(plist, /OPENAI_API_KEY|TOKEN|SECRET/u);
  const readiness = learningWorkerLaunchAgentStatus(f.deps);
  assert.equal(readiness.held_out_adapter_configured, true);
  assert.equal(readiness.program_memory_designs_configured, true);
});

test("install writes a private plist once and an identical reinstall is idempotent", () => {
  const f = fixture();
  const installed = installLearningWorkerLaunchAgent(f.deps);
  assert.equal(installed.status, "installed");
  assert.deepEqual(f.modes, [0o600]);
  assert.deepEqual(f.chmodPaths, [f.plistPath]);
  assert.equal(f.loaded(), true);
  assert.match(f.files.get(f.plistPath) ?? "", /CRAFT_EXPERIENCE_MCP_COMMAND/u);
  assert.match(f.files.get(f.plistPath) ?? "", /craft-mcp\.cjs/u);
  assert.equal(installLearningWorkerLaunchAgent(f.deps).status, "already_installed");
  assert.equal(f.calls.filter(args => args[0] === "bootstrap").length, 1);
});

test("install reloads a matching but currently unloaded service", () => {
  const contents = installedPlist("/opt/craft/worker.js");
  const f = fixture({ installed: true, contents });
  assert.equal(installLearningWorkerLaunchAgent(f.deps).status, "already_installed");
  assert.deepEqual(f.calls.filter(args => args[0] === "bootstrap").map(args => args[0]), ["bootstrap"]);
});

test("install refuses to overwrite a conflicting LaunchAgent", () => {
  const f = fixture({ installed: true });
  assert.throws(() => installLearningWorkerLaunchAgent(f.deps), /conflicting_installation/u);
  assert.equal(f.calls.length, 0);
});

test("SessionStart ensure installs, reloads and upgrades only an owned LaunchAgent", () => {
  const first = fixture();
  first.deps.env = { ...first.deps.env, CRAFT_LEARNING_MODEL_HOST: "codex" };
  assert.equal(ensureLearningWorkerLaunchAgent(first.deps).status, "installed");
  assert.equal(first.loaded(), true);
  assert.match(first.files.get(first.plistPath) ?? "", /CRAFT_LEARNING_MODEL_HOST/u);
  assert.equal(ensureLearningWorkerLaunchAgent(first.deps).status, "already_current");
  assert.equal(first.calls.filter(args => args[0] === "bootstrap").length, 1);

  const stopped = fixture({ installed: true, contents: installedPlist("/opt/craft/worker.js") });
  assert.equal(ensureLearningWorkerLaunchAgent(stopped.deps).status, "already_current");
  assert.equal(stopped.loaded(), true);
  assert.equal(stopped.calls.filter(args => args[0] === "bootstrap").length, 1);

  const upgraded = fixture({ installed: true, loaded: true, contents: installedPlist("/opt/old/worker.js") });
  assert.equal(ensureLearningWorkerLaunchAgent(upgraded.deps).status, "upgraded");
  assert.match(upgraded.files.get(upgraded.plistPath) ?? "", /\/opt\/craft\/worker\.js/u);
  assert.deepEqual(upgraded.calls.filter(args => args[0] === "bootout" || args[0] === "bootstrap").map(args => args[0]), ["bootout", "bootstrap"]);
});

test("SessionStart ensure refuses an unowned or conflicting LaunchAgent and honors explicit worker disable", () => {
  const conflict = fixture({ installed: true, contents: "<key>Label</key><string>com.craft.learning-worker</string>" });
  assert.throws(() => ensureLearningWorkerLaunchAgent(conflict.deps), /conflicting_installation/u);
  assert.equal(conflict.calls.length, 0);

  const disabled = fixture();
  disabled.deps.env = { CRAFT_CONTINUOUS_LEARNING: "0" };
  assert.equal(ensureLearningWorkerLaunchAgent(disabled.deps).status, "disabled");
  assert.equal(disabled.files.size, 0);
  assert.equal(disabled.calls.length, 0);

  const unsupported = fixture({ platform: "linux" });
  assert.equal(ensureLearningWorkerLaunchAgent(unsupported.deps).status, "unsupported_platform");
  assert.equal(unsupported.calls.length, 0);

  const orphan = fixture({ loaded: true });
  assert.throws(() => ensureLearningWorkerLaunchAgent(orphan.deps), /conflicting_installation/u);
  assert.deepEqual(orphan.calls.map(args => args[0]), ["print"]);

  const missingProgram = fixture({ installed: true, loaded: true, contents: installedPlist("/opt/craft/worker.js") });
  missingProgram.deps.worker_entrypoint = "/opt/craft/current-worker.js";
  missingProgram.deps.exists = path => path !== "/opt/craft/worker.js";
  assert.equal(ensureLearningWorkerLaunchAgent(missingProgram.deps).status, "upgraded");
  assert.match(missingProgram.files.get(missingProgram.plistPath) ?? "", /\/opt\/craft\/current-worker\.js/u);
  assert.deepEqual(missingProgram.calls.filter(args => args[0] === "bootout" || args[0] === "bootstrap").map(args => args[0]), ["bootout", "bootstrap"]);

  const badRead = fixture();
  badRead.deps.read_file = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.throws(() => ensureLearningWorkerLaunchAgent(badRead.deps), /denied/u);
});

test("SessionStart ensure uses process defaults while keeping filesystem effects in the selected home", () => {
  const temporary = mkdtempSync(join(tmpdir(), "craft-launch-agent-ensure-"));
  const previous = process.env.CRAFT_CONTINUOUS_LEARNING;
  try {
    process.env.CRAFT_CONTINUOUS_LEARNING = "0";
    assert.equal(ensureLearningWorkerLaunchAgent().status, "disabled");
    delete process.env.CRAFT_CONTINUOUS_LEARNING;
    const calls: string[][] = [];
    const result = ensureLearningWorkerLaunchAgent({ platform: "darwin", home_dir: temporary, exec_path: "/usr/bin/node",
      worker_entrypoint: "/opt/craft/worker.js", env: { CRAFT_DATA_DIR: join(temporary, "data") }, exists: () => true,
      launchctl(args) { calls.push(args); if (args[0] === "print") throw Object.assign(new Error("not loaded"), { status: 113 }); return ""; } });
    assert.equal(result.status, "installed");
    assert(existsSync(join(temporary, "Library", "LaunchAgents", `${LEARNING_WORKER_LAUNCH_AGENT_LABEL}.plist`)));
    assert(calls.some(args => args[0] === "bootstrap"));
  } finally {
    if (previous === undefined) delete process.env.CRAFT_CONTINUOUS_LEARNING;
    else process.env.CRAFT_CONTINUOUS_LEARNING = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("install propagates LaunchAgents directory and file access failures", () => {
  const badRead = fixture();
  badRead.deps.read_file = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.throws(() => installLearningWorkerLaunchAgent(badRead.deps), /denied/u);
  const badWrite = fixture();
  badWrite.deps.write_file = () => { throw Object.assign(new Error("read only"), { code: "EROFS" }); };
  assert.throws(() => installLearningWorkerLaunchAgent(badWrite.deps), /read only/u);
});

test("status, start, stop, resume, and uninstall preserve explicit lifecycle semantics", () => {
  const f = fixture({ installed: true, contents: renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/opt/craft/worker.js", data_root: "/tmp/craft-test-data" }) });
  assert.deepEqual(learningWorkerLaunchAgentStatus(f.deps), { installed: true, loaded: false, plist_path: f.plistPath, reason: "not_loaded",
    held_out_adapter_configured: false, program_memory_designs_configured: false });
  assert.deepEqual(startLearningWorkerLaunchAgent(f.deps), { status: "started" });
  assert.deepEqual(startLearningWorkerLaunchAgent(f.deps), { status: "already_running" });
  assert.deepEqual(stopLearningWorkerLaunchAgent(f.deps), { status: "stopped" });
  assert.deepEqual(stopLearningWorkerLaunchAgent(f.deps), { status: "already_stopped" });
  assert.deepEqual(startLearningWorkerLaunchAgent(f.deps), { status: "started" });
  assert.deepEqual(uninstallLearningWorkerLaunchAgent(f.deps), { status: "uninstalled" });
  assert.equal(f.unlinked.length, 1);
  assert.equal(f.loaded(), false);
});

test("lifecycle commands fail closed for unsupported platforms and missing installations", () => {
  const unsupported = fixture({ platform: "linux" });
  assert.throws(() => learningWorkerLaunchAgentStatus(unsupported.deps), /requires_macos/u);
  const missing = fixture();
  assert.deepEqual(learningWorkerLaunchAgentStatus(missing.deps), { installed: false, loaded: false, plist_path: missing.plistPath, reason: "not_installed",
    held_out_adapter_configured: false, program_memory_designs_configured: false });
  assert.throws(() => startLearningWorkerLaunchAgent(missing.deps), /not_installed/u);
  assert.deepEqual(stopLearningWorkerLaunchAgent(missing.deps), { status: "not_installed" });
  assert.deepEqual(uninstallLearningWorkerLaunchAgent(missing.deps), { status: "already_uninstalled" });
});

test("uninstall stops an orphaned loaded job when its plist is already missing", () => {
  const f = fixture({ loaded: true });
  assert.deepEqual(uninstallLearningWorkerLaunchAgent(f.deps), { status: "orphaned_job_stopped" });
  assert.equal(f.loaded(), false);
  assert.deepEqual(f.calls.filter(args => args[0] === "bootout"), [["bootout", "gui/501/com.craft.learning-worker"]]);
});

test("uninstall refuses to delete a plist changed since this version installed it", () => {
  const f = fixture({ installed: true, loaded: true, contents: "edited" });
  assert.throws(() => uninstallLearningWorkerLaunchAgent(f.deps), /changed_after_install/u);
  assert.equal(f.unlinked.length, 0);
  assert.equal(f.loaded(), true);
});

test("uninstall removes the owned agent after the current data root changes", () => {
  const original = renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/opt/old/worker.js", data_root: "/tmp/old-data" });
  const f = fixture({ installed: true, loaded: true, contents: original });
  f.deps.env = { CRAFT_DATA_DIR: "/tmp/new-data" };
  assert.deepEqual(uninstallLearningWorkerLaunchAgent(f.deps), { status: "uninstalled" });
  assert.equal(f.unlinked.length, 1);
});

test("upgrade atomically replaces only the owned plist and restarts the service", () => {
  const old = renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/opt/old/worker.js", data_root: "/tmp/craft-test-data" });
  const f = fixture({ installed: true, loaded: true, contents: old });
  f.deps.worker_entrypoint = "/opt/new/worker.js";
  f.deps.worker_revision = "revision-2";
  assert.deepEqual(upgradeLearningWorkerLaunchAgent(f.deps), { status: "upgraded", plist_path: f.plistPath });
  assert.match(f.files.get(f.plistPath) ?? "", /\/opt\/new\/worker\.js/u);
  assert.deepEqual(f.calls.filter(args => args[0] === "bootout" || args[0] === "bootstrap").map(args => args[0]), ["bootout", "bootstrap"]);
  assert.deepEqual(upgradeLearningWorkerLaunchAgent(f.deps), { status: "already_current", plist_path: f.plistPath });
});

test("upgrade preserves a usable plist and reports a failed reload", () => {
  const f = fixture({ installed: true, loaded: true, contents: renderLearningWorkerLaunchAgent({
    exec_path: "/usr/bin/node", worker_entrypoint: "/opt/old/worker.js", data_root: "/tmp/craft-test-data",
  }) });
  let bootstraps = 0;
  f.deps.launchctl = args => {
    f.calls.push(args);
    if (args[0] === "print") return "loaded";
    if (args[0] === "bootstrap") { bootstraps += 1; throw new Error("bootstrap failed"); }
    return "";
  };
  f.deps.unlink = undefined;
  assert.throws(() => upgradeLearningWorkerLaunchAgent(f.deps), /bootstrap failed/u);
  assert.equal(bootstraps, 2, "failed upgrade retries bootstrap against the published plist");
  assert.equal(f.files.has(`${f.plistPath}.upgrade.${process.pid}`), false);
  assert.match(f.files.get(f.plistPath) ?? "", /\/opt\/craft\/worker\.js/u);
});

test("upgrade creates its log directory and clears a stale temporary plist before replacing", () => {
  const f = fixture({ installed: true, loaded: true, contents: renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/opt/old/worker.js", data_root: "/tmp/craft-test-data" }) });
  const temporary = `${f.plistPath}.upgrade.${process.pid}`;
  f.files.set(temporary, "stale");
  f.deps.worker_entrypoint = "/opt/new/worker.js";
  assert.equal(upgradeLearningWorkerLaunchAgent(f.deps).status, "upgraded");
  assert(f.directories.includes("/tmp/craft-test-home/Library/LaunchAgents"));
  assert(f.directories.includes("/tmp/craft-test-data/runtime"));
  assert.equal(f.files.has(temporary), false);
});

test("upgrade installs when absent, reuses the current service, and rejects unrelated plist data", () => {
  const absent = fixture();
  assert.deepEqual(upgradeLearningWorkerLaunchAgent(absent.deps), { status: "installed", plist_path: absent.plistPath });
  const current = fixture({ installed: true, contents: installedPlist("/opt/craft/worker.js") });
  assert.deepEqual(upgradeLearningWorkerLaunchAgent(current.deps), { status: "already_current", plist_path: current.plistPath });
  assert.equal(current.calls.filter(args => args[0] === "bootstrap").length, 1);
  current.deps.worker_revision = "revision-2";
  assert.equal(upgradeLearningWorkerLaunchAgent(current.deps).status, "upgraded", "same entrypoint path restarts after the payload revision changes");
  const unrelated = fixture({ installed: true, contents: "<key>Label</key><string>someone.else</string>" });
  assert.throws(() => upgradeLearningWorkerLaunchAgent(unrelated.deps), /changed_after_install/u);
  const inaccessible = fixture();
  inaccessible.deps.read_file = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.throws(() => upgradeLearningWorkerLaunchAgent(inaccessible.deps), /denied/u);
});

test("upgrade uses process defaults when no data root or Node path is configured", () => {
  const f = fixture({ installed: true, contents: renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/opt/old/worker.js", data_root: "/tmp/old-data" }) });
  f.deps.exec_path = undefined;
  f.deps.env = undefined;
  f.deps.worker_entrypoint = "/opt/new/worker.js";
  assert.equal(upgradeLearningWorkerLaunchAgent(f.deps).status, "upgraded");
  assert.match(f.files.get(f.plistPath) ?? "", new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
});

test("LaunchAgent source worker command includes Node type stripping", () => {
  const plist = renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/repo/worker.ts", data_root: "/tmp/data" });
  assert.match(plist, /<string>--experimental-strip-types<\/string>/u);
});

test("LaunchAgent uses a safe default PATH when the installer environment omits it", () => {
  const path = process.env.PATH;
  try {
    delete process.env.PATH;
    const plist = renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: "/repo/worker.js", data_root: "/tmp/data" });
    assert.match(plist, /<key>PATH<\/key><string>\/usr\/bin:\/bin<\/string>/u);
  } finally { if (path === undefined) delete process.env.PATH; else process.env.PATH = path; }
});

test("default package and source worker resolution use the precise installed entrypoint", () => {
  const packageFixture = fixture();
  packageFixture.deps.worker_entrypoint = undefined;
  const checked: string[] = [];
  packageFixture.deps.exists = path => { checked.push(path); return path.endsWith("craft-experience-learning-worker.js") || path.endsWith("craft-mcp.cjs"); };
  installLearningWorkerLaunchAgent(packageFixture.deps);
  assert(checked.length >= 2);
  assert.match(packageFixture.files.get(packageFixture.plistPath) ?? "", /<string>[^<]*craft-experience-learning-worker\.js<\/string>/u);

  const sourceFixture = fixture();
  sourceFixture.deps.worker_entrypoint = undefined;
  sourceFixture.deps.exists = path => path.endsWith("/deploy/experience-learning/worker.ts") || path.endsWith("/bin/craft-mcp.ts");
  installLearningWorkerLaunchAgent(sourceFixture.deps);
  assert.match(sourceFixture.files.get(sourceFixture.plistPath) ?? "", /<string>--experimental-strip-types<\/string>/u);
  assert.match(sourceFixture.files.get(sourceFixture.plistPath) ?? "", /<string>[^<]*\/deploy\/experience-learning\/worker\.ts<\/string>/u);
});

test("default filesystem adapters upgrade an existing service atomically", () => {
  const home = mkdtempSync(join(tmpdir(), "craft-launch-agent-upgrade-"));
  try {
    const directory = join(home, "Library", "LaunchAgents");
    const plistPath = join(directory, "com.craft.learning-worker.plist");
    const worker = "/opt/old/worker.js";
    mkdirSync(directory, { recursive: true });
    writeFileSync(plistPath, renderLearningWorkerLaunchAgent({ exec_path: "/usr/bin/node", worker_entrypoint: worker, data_root: "/tmp/old" }), { mode: 0o600 });
    let loaded = true;
    const deps: LaunchAgentDependencies = { platform: "darwin", home_dir: home, uid: 501, worker_entrypoint: "/opt/new/worker.js",
      env: { CRAFT_DATA_DIR: "/tmp/new" }, exists: path => path === "/opt/new/craft-mcp.cjs", launchctl: args => {
        if (args[0] === "print") return loaded ? "loaded" : (() => { throw Object.assign(new Error("not loaded"), { status: 113 }); })();
        if (args[0] === "bootout") loaded = false;
        if (args[0] === "bootstrap") loaded = true;
        return "";
      } };
    assert.deepEqual(upgradeLearningWorkerLaunchAgent(deps), { status: "upgraded", plist_path: plistPath });
    assert.match(readFileSync(plistPath, "utf8"), /\/opt\/new\/worker\.js/u);
    assert.equal(existsSync(`${plistPath}.upgrade.${process.pid}`), false);
    assert.equal(loaded, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("default filesystem adapters install and uninstall within the selected home directory", () => {
  const home = mkdtempSync(join(tmpdir(), "craft-launch-agent-"));
  try {
    const calls: string[][] = [];
    const deps: LaunchAgentDependencies = { platform: "darwin", home_dir: home, uid: 501, exec_path: "/usr/bin/node",
      worker_entrypoint: "/opt/craft/worker.js", env: { CRAFT_DATA_DIR: join(home, "data") }, exists: path => path === "/opt/craft/craft-mcp.cjs",
      launchctl: args => { calls.push(args); if (args[0] === "print") throw Object.assign(new Error("not loaded"), { status: 113 }); return ""; } };
    const installed = installLearningWorkerLaunchAgent(deps);
    assert.equal(installed.status, "installed");
    assert.deepEqual(learningWorkerLaunchAgentStatus({ ...deps, launchctl: args => { calls.push(args); return "loaded"; } }).installed, true);
    assert.deepEqual(uninstallLearningWorkerLaunchAgent(deps), { status: "uninstalled" });
    assert.equal(calls.some(args => args[0] === "bootout"), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("status defaults resolve the current login home and uid", () => {
  const result = learningWorkerLaunchAgentStatus({ read_file: () => "plist", launchctl: () => "loaded" });
  assert.equal(result.installed, true);
  assert.equal(result.loaded, true);
  assert.match(result.plist_path, /\/Library\/LaunchAgents\/com\.craft\.learning-worker\.plist$/u);
  assert.equal(result.reason, null);
});

test("status reports a missing ProgramArguments executable or worker entrypoint", () => {
  const plist = renderLearningWorkerLaunchAgent({ exec_path: "/missing/node", worker_entrypoint: "/missing/worker.js", data_root: "/tmp/data" });
  const result = learningWorkerLaunchAgentStatus({ read_file: () => plist, exists: () => false, launchctl: () => "loaded" });
  assert.deepEqual({ installed: result.installed, loaded: result.loaded, reason: result.reason },
    { installed: true, loaded: true, reason: "program_missing" });
  const malformed = learningWorkerLaunchAgentStatus({ read_file: () => "<key>ProgramArguments</key><string>invalid</string>",
    exists: () => true, launchctl: () => "loaded" });
  assert.equal(malformed.reason, "program_missing");
  const realFiles = learningWorkerLaunchAgentStatus({ read_file: () => renderLearningWorkerLaunchAgent({ exec_path: process.execPath,
    worker_entrypoint: process.execPath, data_root: "/tmp/data" }), launchctl: () => "loaded" });
  assert.equal(realFiles.reason, null, "status defaults to the real filesystem when no adapter is injected");
  assert.throws(() => startLearningWorkerLaunchAgent({ ...fixture({ installed: true, contents: plist }).deps, exists: () => false }),
    /learning_worker_launch_agent_program_missing/u);
});

test("platform defaults query launchctl without mutating service state", { skip: process.platform !== "darwin" }, () => {
  const result = learningWorkerLaunchAgentStatus({ home_dir: "/tmp/craft-launch-agent-query", uid: process.getuid?.() ?? 501,
    read_file: () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); } });
  assert.equal(result.installed, false);
  assert.equal(result.reason, "not_installed");
});

test("status propagates non-absence filesystem and non-launchctl failures", () => {
  const filesystem = fixture();
  filesystem.deps.read_file = () => { throw Object.assign(new Error("permission denied"), { code: "EACCES" }); };
  assert.throws(() => learningWorkerLaunchAgentStatus(filesystem.deps), /permission denied/u);
  const launchctl = fixture();
  launchctl.deps.launchctl = () => { throw new Error("unexpected launchctl failure"); };
  assert.throws(() => learningWorkerLaunchAgentStatus(launchctl.deps), /unexpected launchctl failure/u);
});

test("install resolves the source Worker with the real filesystem adapter", () => {
  const home = mkdtempSync(join(tmpdir(), "craft-launch-agent-source-"));
  try {
    const calls: string[][] = [];
    const result = installLearningWorkerLaunchAgent({ platform: "darwin", home_dir: home, uid: 501,
      launchctl: args => { calls.push(args); return ""; } });
    assert.equal(result.status, "installed");
    assert.match(readFileSync(result.plist_path, "utf8"), /<string>--experimental-strip-types<\/string>/u);
    assert.equal(calls.at(-1)?.[0], "bootstrap");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("install fails when neither packaged nor source worker entrypoint exists", () => {
  const f = fixture();
  f.deps.worker_entrypoint = undefined;
  f.deps.exists = () => false;
  assert.throws(() => installLearningWorkerLaunchAgent(f.deps), /worker_unavailable/u);
  f.deps.worker_entrypoint = "/opt/craft/worker.js";
  f.deps.exists = path => path === "/opt/craft/worker.js";
  assert.throws(() => installLearningWorkerLaunchAgent(f.deps), /mcp_server_unavailable/u);
});
