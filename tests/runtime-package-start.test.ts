import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { prepareRuntimeArtifact } from "../scripts/release/runtime-artifact.ts";

test("the copied runtime starts CLI and token-gated API without presentation or development dependencies", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "craft-runtime-install-"));
  const product = join(isolated, "app");
  try {
    const stage = await prepareRuntimeArtifact(resolve(import.meta.dirname, ".."));
    await cp(stage, product, { recursive: true });
    const node = join(product, basename(process.execPath));
    const sourcePackage = JSON.parse(await readFile(join(stage, "package.json"), "utf8")) as { version: string };
    const hash = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
    for (const relative of ["package.json", "dist/core/cli.js", basename(process.execPath)]) {
      assert.equal(await hash(join(product, relative)), await hash(join(stage, relative)), `installed ${relative} must match the staged package`);
    }
    const execute = promisify(execFile);
    const options = { cwd: product, timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: join(isolated, "data"), NODE_PATH: "" } };
    const version = await execute(node, ["dist/core/cli.js", "version"], options);
    assert.equal(version.stdout.trim(), sourcePackage.version, "installed CLI must report the staged Craft package version");
    const paths = await execute(node, ["dist/core/cli.js", "paths"], options);
    assert.equal(JSON.parse(paths.stdout).root, options.env.CRAFT_DATA_DIR, "installed CLI must report its selected data root");
    const help = await execute(node, ["dist/core/cli.js", "--help"], options);
    assert.match(help.stdout, /Craft/);
    const probe = await execute(node, ["--input-type=module", "-e", `
      import { CraftService } from './dist/core/application/craft-service.js';
      import { CraftStore } from './dist/core/infrastructure/store.js';
      import { craftPaths } from './dist/core/infrastructure/paths.js';
      import { WorkbenchWebApp } from './dist/core/interfaces/workbench-server.js';
      const store = await new CraftStore(craftPaths(process.env.CRAFT_DATA_DIR)).open();
      try {
        const app = new WorkbenchWebApp(new CraftService(store), 'isolated', 'http://127.0.0.1:1');
        for (const path of ['/', '/workbench/app.js', '/workbench/runtime-client.js', '/workbench/project-page.js', '/workbench/resource-pages.js', '/workbench/model-setup.js']) {
          const response = app.handle({ method: 'GET', path });
          if (response.status !== 404) throw new Error('Core unexpectedly exposes UI: ' + path);
        }
        if (app.handle({ method: 'GET', path: '/api/home' }).status !== 401) throw new Error('API lost authentication');
        if (app.handle({ method: 'GET', path: '/api/home', token: 'isolated' }).status !== 200) throw new Error('Core API unavailable');
        console.log('isolated-runtime-ok');
      } finally { store.close(); }
    `], options);
    assert.match(probe.stdout, /isolated-runtime-ok/);
  } finally { await rm(isolated, { recursive: true, force: true }); }
});
