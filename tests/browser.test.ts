import assert from "node:assert/strict";
import test from "node:test";
import { getBrowserInvocation, openBrowser, type BrowserSpawner } from "../core/browser.ts";

test("browser invocation uses the native opener on each desktop platform", () => {
  assert.deepEqual(getBrowserInvocation("win32", "http://localhost"), { command: "cmd.exe", args: ["/c", "start", "", "http://localhost"] });
  assert.deepEqual(getBrowserInvocation("darwin", "http://localhost"), { command: "open", args: ["http://localhost"] });
  assert.deepEqual(getBrowserInvocation("linux", "http://localhost"), { command: "xdg-open", args: ["http://localhost"] });
  assert.deepEqual(getBrowserInvocation("freebsd", "http://localhost"), { command: "xdg-open", args: ["http://localhost"] });
  assert.equal(getBrowserInvocation("aix", "http://localhost"), undefined);
});

test("openBrowser is injectable, disabled for headless runs, and safe on launch errors", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const fake: BrowserSpawner = (command, args) => { calls.push({ command, args }); return { unref() {} }; };
  const old = process.env.CRAFT_NO_BROWSER;
  delete process.env.CRAFT_NO_BROWSER;
  try {
    assert.equal(openBrowser("http://localhost", "win32", fake), true);
    assert.deepEqual(calls[0], { command: "cmd.exe", args: ["/c", "start", "", "http://localhost"] });
    assert.equal(openBrowser("http://localhost", "aix", fake), false);
    process.env.CRAFT_NO_BROWSER = "1";
    assert.equal(openBrowser("http://localhost", "linux", fake), false);
    delete process.env.CRAFT_NO_BROWSER;
    assert.equal(openBrowser("http://localhost", "linux", () => { throw new Error("unavailable"); }), false);
    // Exercise the real spawner's asynchronous ENOENT handler deterministically
    // without launching a desktop browser on the CI runner.
    const path = process.env.PATH;
    process.env.PATH = "__craft_missing_path__";
    try {
      assert.equal(openBrowser("http://127.0.0.1:1", "linux"), true);
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
    }
  } finally {
    if (old === undefined) delete process.env.CRAFT_NO_BROWSER; else process.env.CRAFT_NO_BROWSER = old;
  }
});
