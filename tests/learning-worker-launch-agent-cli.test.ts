import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { main } from "../core/cli.ts";
import { type LaunchAgentDependencies } from "../core/learning-worker-launch-agent.ts";

test("CLI routes every LaunchAgent lifecycle command and supports resume as start", async () => {
  const home = mkdtempSync(join(tmpdir(), "craft-launch-agent-cli-"));
  const previousData = process.env.CRAFT_DATA_DIR;
  process.env.CRAFT_DATA_DIR = join(home, "data");
  const files = new Map<string, string>();
  let loaded = false;
  const dependencies: LaunchAgentDependencies = {
    platform: "darwin", home_dir: home, uid: process.getuid?.() ?? 501, exec_path: "/usr/bin/node",
    worker_entrypoint: "/opt/craft/worker.js", env: { CRAFT_DATA_DIR: join(home, "data") }, mkdir: () => {},
    exists: () => true,
    read_file: path => {
      const value = files.get(path);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
    write_file: (path, value) => { files.set(path, value); },
    chmod: () => {},
    rename: (from, to) => { const value = files.get(from); if (value === undefined) throw new Error("missing temporary plist"); files.set(to, value); files.delete(from); },
    unlink: path => { files.delete(path); },
    launchctl: args => {
      if (args[0] === "print") {
        if (!loaded) throw Object.assign(new Error("not loaded"), { status: 113 });
        return "loaded";
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      return "";
    },
  };
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    for (const command of ["install", "status", "start", "resume", "stop", "upgrade", "uninstall"]) {
      await main(["learning-worker", "launch-agent", command], dependencies);
      assert.deepEqual(JSON.parse(writes.pop() ?? "null"), {
        install: { status: "installed", plist_path: join(home, "Library", "LaunchAgents", "com.craft.learning-worker.plist") },
        status: { installed: true, loaded: true, plist_path: join(home, "Library", "LaunchAgents", "com.craft.learning-worker.plist"), reason: null },
        start: { status: "already_running" }, resume: { status: "already_running" }, stop: { status: "stopped" },
        upgrade: { status: "already_current", plist_path: join(home, "Library", "LaunchAgents", "com.craft.learning-worker.plist") },
        uninstall: { status: "uninstalled" },
      }[command]);
    }
    await assert.rejects(main(["learning-worker", "launch-agent", "unknown"], dependencies), /requires install, status, start, stop, resume, upgrade, or uninstall/u);
    await main(["learning-worker", "launch-agent", "status", "--help"], dependencies);
    assert.match(writes.pop() ?? "", /Manage the explicitly installed macOS learning Worker/u);
  } finally {
    process.stdout.write = originalWrite;
    if (previousData === undefined) delete process.env.CRAFT_DATA_DIR;
    else process.env.CRAFT_DATA_DIR = previousData;
    rmSync(home, { recursive: true, force: true });
  }
});
