import assert from "node:assert/strict";
import test from "node:test";
import { workbenchCliEnvironment, workbenchCliPath } from "../core/interfaces/workbench-cli-path.ts";

test("CLI paths preserve existing order and add standard GUI installation directories once", () => {
  assert.equal(workbenchCliPath("/custom:/usr/local/bin", "/home/me", "linux"), "/custom:/usr/local/bin:/home/me/.local/bin");
  assert.equal(workbenchCliPath("/custom", "/Users/me", "darwin"), "/custom:/Users/me/.local/bin:/usr/local/bin:/opt/homebrew/bin");
  assert.equal(workbenchCliPath("C:\\tools", "C:\\Users\\me", "win32", {}), "C:\\tools;C:\\Users\\me\\.local\\bin");
  assert.equal(workbenchCliPath("C:\\tools", "C:\\Users\\me", "win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }),
    "C:\\tools;C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Roaming\\npm");
  assert.equal(workbenchCliPath("", "relative", "win32", {}), "");
  assert.equal(workbenchCliPath("", "relative", "win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }),
    "C:\\Users\\me\\AppData\\Roaming\\npm");
  // LOCALAPPDATA is added too (npm's local prefix), and absent roots are skipped.
  assert.equal(workbenchCliPath("C:\\tools", "C:\\Users\\me", "win32",
    { APPDATA: "C:\\Users\\me\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
  "C:\\tools;C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Roaming\\npm;C:\\Users\\me\\AppData\\Local\\npm");
  assert.equal(workbenchCliPath("C:\\tools", "C:\\Users\\me", "win32",
    { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }),
  "C:\\tools;C:\\Users\\me\\.local\\bin;C:\\Users\\me\\AppData\\Local\\npm");
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

test("CLI environment keeps a pre-existing non-PATH spelling of the variable", { skip: process.platform === "win32" }, () => {
  const previous = process.env.PATH;
  const previousMixed = process.env.Path;
  try {
    delete process.env.PATH;
    process.env.Path = "/custom/bin";
    const env = workbenchCliEnvironment();
    // The existing casing is updated in place instead of adding a second key.
    assert.ok("Path" in env);
    assert.equal(env.PATH, undefined);
    assert.equal(env.Path, workbenchCliPath("/custom/bin"));
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    if (previousMixed === undefined) delete process.env.Path; else process.env.Path = previousMixed;
  }
});

test("workbenchCliPath falls back to an empty PATH value when the environment omits it", () => {
  const previous = process.env.PATH;
  const previousMixed = process.env.Path;
  try {
    delete process.env.PATH;
    delete process.env.Path;
    // No PATH at all: the default parameter resolves to "" and only the
    // standard GUI directories are added.
    const value = workbenchCliPath();
    assert.ok(value.includes("/usr/local/bin") || value.includes(".local"));
    // With no spelling present, the environment helper keys the new value as
    // the canonical "PATH" instead of guessing an existing spelling.
    const env = workbenchCliEnvironment();
    assert.equal(env.PATH, workbenchCliPath(""));
  } finally {
    if (previous !== undefined) process.env.PATH = previous;
    if (previousMixed !== undefined) process.env.Path = previousMixed;
  }
});

test("CLI environment finds the PATH-like key case-insensitively", () => {
  const keys = Object.keys(process.env).filter((name) => name.toLowerCase() === "path");
  if (!keys.length) return;
  const env = workbenchCliEnvironment();
  assert.ok(keys.every((key) => typeof env[key] === "string"));
  // Only one spelling is written: the one that already existed.
  const written = Object.keys(env).filter((name) => name.toLowerCase() === "path");
  assert.equal(written.length, 1);
});
