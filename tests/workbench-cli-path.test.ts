import assert from "node:assert/strict";
import test from "node:test";
import { workbenchCliEnvironment, workbenchCliPath } from "../core/interfaces/workbench-cli-path.ts";

test("CLI paths preserve existing order and add standard GUI installation directories once", () => {
  assert.equal(workbenchCliPath("/custom:/usr/local/bin", "/home/me", "linux"), "/custom:/usr/local/bin:/home/me/.local/bin");
  assert.equal(workbenchCliPath("/custom", "/Users/me", "darwin"), "/custom:/Users/me/.local/bin:/usr/local/bin:/opt/homebrew/bin");
  assert.equal(workbenchCliPath("C:\\tools", "C:\\Users\\me", "win32"), "C:\\tools;C:\\Users\\me\\.local\\bin");
  assert.equal(workbenchCliPath("", "relative", "win32"), "");
  assert.equal(workbenchCliPath("/home/me/.local/bin::/usr/local/bin", "/home/me", "linux"), "/home/me/.local/bin:/usr/local/bin");
  assert.ok(workbenchCliPath(undefined, undefined, undefined).length > 0);
  const env = workbenchCliEnvironment();
  const key = Object.keys(env).find(name => name.toLowerCase() === "path")!;
  assert.equal(env[key], workbenchCliPath(process.env[key]));
});

test("CLI environment supplies PATH when it is absent", { skip: process.platform === "win32" }, () => {
  const previous = process.env.PATH;
  try { delete process.env.PATH; assert.equal(workbenchCliEnvironment().PATH, workbenchCliPath("")); }
  finally { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; }
});
