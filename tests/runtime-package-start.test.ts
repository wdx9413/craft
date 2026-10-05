import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { prepareRuntimeArtifact } from "../scripts/release/runtime-artifact.ts";

test("the copied runtime starts CLI and serves Workbench without source or development dependencies", async () => {
  const isolated = await mkdtemp(join(tmpdir(), "craft-runtime-install-"));
  const product = join(isolated, "app");
  try {
    const stage = await prepareRuntimeArtifact(resolve(import.meta.dirname, ".."));
    await cp(stage, product, { recursive: true });
    const node = join(product, basename(process.execPath));
    const execute = promisify(execFile);
    const options = { cwd: product, timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: join(isolated, "data"), NODE_PATH: "" } };
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
          if (response.status !== 200 || !response.body.length) throw new Error('Missing packaged asset: ' + path);
        }
        console.log('isolated-runtime-ok');
      } finally { store.close(); }
    `], options);
    assert.match(probe.stdout, /isolated-runtime-ok/);
  } finally { await rm(isolated, { recursive: true, force: true }); }
});
