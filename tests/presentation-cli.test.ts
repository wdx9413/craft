import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const cli = resolve(import.meta.dirname, "../core/cli.ts");

test("GUI without an explicit mount and invalid mounts fail before starting a server", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-ui-cli-"));
  try {
    const options = { env: { ...process.env, CRAFT_DATA_DIR: join(root, "data") }, timeout: 15_000 };
    await assert.rejects(promisify(execFile)(process.execPath, [cli, "gui"], options), /Workbench has moved to craft-workbench/);
    await assert.rejects(promisify(execFile)(process.execPath, [cli, "serve", "--workbench-dir", join(root, "absent")], options), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mount of [false, true]) {
  test(`CLI starts a real loopback API with presentation ${mount ? "explicitly mounted" : "disabled"}`, { timeout: 30_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "craft-ui-cli-"));
    await writeFile(join(root, "index.html"), "<main>External Workbench</main>");
    const child = spawn(process.execPath, [cli, "serve", "--port", "0", ...(mount ? ["--workbench-dir", root] : [])], {
      env: { ...process.env, CRAFT_DATA_DIR: join(root, "data") }, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = ""; let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const closed = new Promise<void>(done => child.once("close", () => done()));
    t.after(async () => { child.kill("SIGTERM"); await closed; await rm(root, { recursive: true, force: true }); });
    const url = await new Promise<URL>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`API startup timed out: ${errors}`)), 15_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`API exited before startup: ${errors}`)); });
      child.stdout.on("data", chunk => {
        output += chunk;
        const match = output.match(/Craft API: (\S+)/);
        if (match && (!mount || output.includes("Craft Workbench: "))) { clearTimeout(timer); done(new URL(match[1])); }
      });
    });
    assert.equal((await fetch(new URL("/health", url))).status, 200);
    const page = await fetch(url);
    assert.equal(page.status, mount ? 200 : 404);
    if (mount) assert.equal(await page.text(), "<main>External Workbench</main>");
    else assert.doesNotMatch(output, /Craft Workbench:/);
    assert.equal((await fetch(new URL("/api/home", url))).status, 401);
    const token = decodeURIComponent(url.hash.slice("#token=".length));
    assert.equal((await fetch(new URL("/api/home", url), { headers: { authorization: `Bearer ${token}` } })).status, 200);
  });
}
