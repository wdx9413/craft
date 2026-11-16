import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";
import { credentialStatus, publicModel, type ModelProviderSpec } from "../core/model-gateway.ts";
import { readSecrets, hydrateSecretsIntoEnv } from "../core/secrets-store.ts";
import type { CraftModelConfig } from "../core/settings.ts";

const KEY = "{{SECRET_x03rmrpl}}";
const SPEC: ModelProviderSpec = {
  provider: "deepseek", label: "DeepSeek", protocol: "openai-compatible",
  base_url: "https://api.deepseek.com/v1", api_key_env: "DEEPSEEK_API_KEY",
  chat_path: "/chat/completions", models: { standard: "deepseek-chat" },
  cost_hint: 1, supports_tools: true,
};
const MODEL: CraftModelConfig = {
  id: "deepseek", name: "DeepSeek", protocol: "openai-compatible",
  baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat",
  apiKeyEnv: "DEEPSEEK_API_KEY", supportsTools: true,
};

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-secret-e2e-"));
  const paths = craftPaths(root);
  const store = await new CraftStore(paths).open();
  const service = new CraftService(store);
  return { paths, store, service };
}

test("a pasted key flows through the HTTP API into a configured model", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "e2e-token", "http://127.0.0.1:4173");
    const headers = (method: string, body?: string) => ({
      method, path: "/api/settings/secrets", token: "e2e-token",
      ...(body === undefined ? {} : { body }),
    });
    // Before: no key anywhere, the model is not configured.
    const before = await app.handleAsync(headers("GET"));
    assert.equal(before.status, 200);
    assert.deepEqual(JSON.parse(before.body).names, []);
    assert.equal(credentialStatus(SPEC, {} as NodeJS.ProcessEnv).configured, false);

    // A person pastes a key in Settings; the workbench PUTs it.
    const put = await app.handleAsync(headers("PUT", JSON.stringify({ env: "DEEPSEEK_API_KEY", key: KEY })));
    assert.equal(put.status, 200);
    assert.deepEqual(JSON.parse(put.body), { ok: true, env: "DEEPSEEK_API_KEY", configured: true });

    // The GET never reveals the key, only the name.
    const after = await app.handleAsync(headers("GET"));
    assert.deepEqual(JSON.parse(after.body).names, ["DEEPSEEK_API_KEY"]);
    assert.doesNotMatch(after.body, /sk-e2e/u);
    assert.equal(readSecrets(f.paths).DEEPSEEK_API_KEY, KEY);

    // A fresh process (the CLI on next launch) hydrates the stored key and the
    // model gateway now reports the provider/model as configured.
    const env: NodeJS.ProcessEnv = {};
    hydrateSecretsIntoEnv(f.paths, env);
    assert.equal(credentialStatus(SPEC, env).configured, true);
    assert.equal((publicModel(MODEL, env) as { configured: boolean }).configured, true);
    assert.equal((publicModel(MODEL, env) as { apiKeyEnv?: string }).apiKeyEnv, "DEEPSEEK_API_KEY");
    assert.equal(JSON.stringify(publicModel(MODEL, env)).includes(KEY), false, "the public view never carries the key");
  } finally {
    f.store.close();
  }
});

test("a real environment variable keeps precedence over a stale stored key", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "e2e-token", "http://127.0.0.1:4173");
    await app.handleAsync({ method: "PUT", path: "/api/settings/secrets", token: "e2e-token", body: JSON.stringify({ env: "DEEPSEEK_API_KEY", key: "stored" }) });
    const env: NodeJS.ProcessEnv = { DEEPSEEK_API_KEY: "from-shell" };
    hydrateSecretsIntoEnv(f.paths, env);
    assert.equal(env.DEEPSEEK_API_KEY, "from-shell");
  } finally {
    f.store.close();
  }
});

test("the secrets endpoint rejects missing/invalid credentials and bad input", async () => {
  const f = await fixture();
  try {
    const app = new WorkbenchWebApp(f.service, "e2e-token", "http://127.0.0.1:4173");
    const denied = await app.handleAsync({ method: "PUT", path: "/api/settings/secrets", body: JSON.stringify({ env: "DEEPSEEK_API_KEY", key: KEY }) });
    assert.equal(denied.status, 401);
    const crossOrigin = await app.handleAsync({ method: "GET", path: "/api/settings/secrets", token: "e2e-token", origin: "http://evil.example" });
    assert.equal(crossOrigin.status, 403);
    const badName = await app.handleAsync({ method: "PUT", path: "/api/settings/secrets", token: "e2e-token", body: JSON.stringify({ env: "lowercase", key: KEY }) });
    assert.equal(badName.status, 422);
    const unknownMethod = await app.handleAsync({ method: "DELETE", path: "/api/settings/secrets", token: "e2e-token" });
    assert.equal(unknownMethod.status, 404);
    assert.equal(f.store.list("model", 10).length, 0);
  } finally {
    f.store.close();
  }
});
