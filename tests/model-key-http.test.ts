import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { readSecrets, hydrateSecretsIntoEnv } from "../core/secrets-store.ts";

test("模型页直接 PUT 密钥值：写进本机私有库，GET 不回显，hydrate 后可供网关使用", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-model-key-http-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const service = new CraftService(store);
  const app = new WorkbenchWebApp(service, "secret", "http://127.0.0.1:4173");
  const previous = process.env.CRAFT_TEST_MODEL_KEY;
  try {
    const put = await app.handleAsync({ method: "PUT", path: "/api/settings/secrets", token: "secret",
      body: JSON.stringify({ env: "CRAFT_TEST_MODEL_KEY", key: "  {{SECRET_c7d3e1f0}}  " }) });
    assert.equal(put.status, 200);
    assert.equal(readSecrets(paths).CRAFT_TEST_MODEL_KEY, "{{SECRET_c7d3e1f0}}");
    const get = await app.handleAsync({ method: "GET", path: "/api/settings/secrets", token: "secret" });
    assert.equal(get.status, 200);
    assert.doesNotMatch(get.body, /SECRET_c7d3e1f0|placeholder/u);
    assert.match(get.body, /CRAFT_TEST_MODEL_KEY/u);
    delete process.env.CRAFT_TEST_MODEL_KEY;
    const adopted = hydrateSecretsIntoEnv(paths, process.env);
    assert.ok(adopted.includes("CRAFT_TEST_MODEL_KEY"));
    assert.equal(process.env.CRAFT_TEST_MODEL_KEY, "{{SECRET_c7d3e1f0}}");
  } finally {
    if (previous === undefined) delete process.env.CRAFT_TEST_MODEL_KEY; else process.env.CRAFT_TEST_MODEL_KEY = previous;
    store.close(); await rm(root, { recursive: true, force: true });
  }
});
