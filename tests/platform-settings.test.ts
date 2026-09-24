import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { craftPaths, dataRoot } from "../core/infrastructure/paths.ts";
import { defaultSettings, loadSettings, loadSettingsSync, normalizeSettings, publicSettings, resetSettings, resetSettingsSync, saveSettings } from "../core/settings.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { UsageKernel } from "../core/usage.ts";
import { McpServer } from "../core/mcp.ts";
import { WorkbenchWebApp } from "../core/workbench-server.ts";

test("settings persist, validate, and support a relocatable data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-settings-"));
  const paths = craftPaths(root);
  const initial = await loadSettings(paths);
  assert.equal(initial.dataRoot, root);
  const updated = await saveSettings({ locale: "en-US", theme: "dark", dataRoot: join(root, "relocated"), workbench: { port: 0, openOnStart: false }, runtime: { defaultTier: "large", maxSteps: 8, maxTokens: 99 }, privacy: { telemetry: true } }, paths, new Date("2026-09-13T00:00:00Z"));
  assert.equal(updated.theme, "dark");
  assert.equal(updated.workbench.port, 0);
  assert.equal(updated.runtime.maxTokens, 99);
  assert.equal((await saveSettings({ theme: "light" }, paths)).theme, "light");
  assert.equal(publicSettings(updated, paths).restartRequiredForDataRoot, true);
  assert.equal(loadSettingsSync(paths).locale, "en-US");
  // The factory and the loader describe the same first launch, so both default to `system`.
  assert.equal(resetSettingsSync(paths, new Date("2026-09-14T00:00:00Z")).theme, "system");
  assert.equal((await resetSettings(paths, new Date("2026-09-15T00:00:00Z"))).runtime.defaultTier, "medium");
  assert.equal(defaultSettings(paths).dataRoot, root);
  assert.equal(normalizeSettings(undefined, paths).locale, "zh-CN");
  assert.equal(normalizeSettings([], paths).theme, "system");
  const model = normalizeSettings({ models: [{ id: "local", name: "Local", protocol: "openai-compatible", baseUrl: "https://example.test/v1/", model: "m", apiKeyEnv: "LOCAL_KEY", supportsTools: false }] }, paths).models[0];
  assert.equal(model.baseUrl, "https://example.test/v1"); assert.equal(model.supportsTools, false);
  assert.throws(() => normalizeSettings({ models: "bad" }, paths), /models must be an array/);
  assert.throws(() => normalizeSettings({ models: [{ id: "x", baseUrl: "ftp://example.test" }] }, paths), /http or https/);
  assert.throws(() => normalizeSettings({ models: [{ id: "x", protocol: "grpc" }] }, paths), /openai-compatible or anthropic/);
  assert.throws(() => normalizeSettings({ models: [{ id: "x" }, { id: "x" }] }, paths), /Duplicate model id/);
  assert.equal(publicSettings(defaultSettings(paths), paths).restartRequiredForDataRoot, false);
  for (const value of [{ locale: "xx" }, { theme: "blue" }, { runtime: { defaultTier: "x" } }, { workbench: { port: 65536 } }, { runtime: { maxSteps: 0 } }, { runtime: { maxTokens: 1.2 } }, { privacy: { telemetry: "yes" } }, { updatedAt: "bad" }, { dataRoot: 4 }, { locale: 4 }]) assert.throws(() => normalizeSettings(value, paths));
  assert.equal(normalizeSettings({ workbench: [], runtime: [], privacy: [] }, paths).workbench.port, 4173);
  const malformed = craftPaths(join(root, "malformed"));
  await mkdir(malformed.root, { recursive: true });
  await writeFile(malformed.settingsFile, "not-json", "utf8");
  assert.equal((await loadSettings(malformed)).theme, "system");
  assert.equal(loadSettingsSync(malformed).theme, "system");
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: malformed.settingsFile }), join(homedir(), ".craft_data"));
  assert.equal(dataRoot({ CRAFT_DATA_DIR: join(root, "env") }), join(root, "env"));
  const bootstrap = join(root, "bootstrap.json");
  await writeFile(bootstrap, JSON.stringify({ dataRoot: join(root, "from-settings") }), "utf8");
  assert.equal(dataRoot({ CRAFT_SETTINGS_FILE: bootstrap }), join(root, "from-settings"));
});

test("usage report aggregates facts by day, ISO week, month, year, and host", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-usage-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const usage = new UsageKernel(store);
  try {
    store.create("codex_receipt", "r1", { host: "codex-cli", completed_at: "2026-09-13T10:00:00Z", usage: { input_tokens: 4, output_tokens: 6 } });
    store.create("claude_receipt", "r2", { host: "claude-code", completed_at: "2026-09-12T10:00:00Z", usage: { promptTokens: 2, completionTokens: 3 } });
    store.create("internal_receipt", "r3", { host: "internal", completed_at: "2026-08-01T10:00:00Z", loop: { tokens: 8 } });
    store.create("outcome", "o1", { completed_at: "2026-09-13T11:00:00Z", costs: { usage: { totalTokens: 7 } } });
    store.create("autonomous_turn", "t1", { host: "internal", observed_at: "2026-09-13T12:00:00Z", tokens: 9 });
    store.create("autonomous_turn", "t3", { observed_at: "2026-09-13T12:30:00Z", tokens: 1 });
    store.create("codex_receipt", "empty", { host: "codex-cli", completed_at: "2026-09-13T13:00:00Z", usage: {} });
    store.create("generic_receipt", "invalid", { completed_at: "2026-09-13T13:00:00Z", usage: { total_tokens: -1 } });
    store.create("generic_receipt", "array", { completed_at: "2026-09-13T13:00:00Z", usage: [] });
    store.create("outcome", "empty-costs", { completed_at: "2026-09-13T13:00:00Z", costs: [] });
    store.create("generic_receipt", "missing-dates", { usage: { tokens: 0 } });
    const report = usage.report({});
    assert.equal(report.totals.total_tokens, 40);
    assert.equal(report.totals.input_tokens, 6);
    assert.equal(report.totals.output_tokens, 9);
    assert.equal(report.totals.requests, 6);
    assert.equal(report.by_host.internal.total_tokens, 18);
    assert.equal(report.by_host.unknown.total_tokens, 7);
    assert.ok(report.daily["2026-09-13"]);
    assert.ok(report.weekly["2026-W37"]);
    assert.ok(report.monthly["2026-09"]);
    assert.ok(report.yearly["2026"]);
    const originalList = store.list.bind(store);
    (store as unknown as { list: (kind: string, limit: number) => Record<string, unknown>[] }).list = (kind, limit) => kind === "generic_receipt" ? [{ usage: { tokens: 1 }, completed_at: "bad", finished_at: "bad", created_at: "bad", updated_at: "bad", observed_at: "bad" }] : originalList(kind, limit);
    assert.equal(usage.report({}).totals.total_tokens, 40);
    (store as unknown as { list: typeof store.list }).list = originalList;
    assert.equal(usage.report({ from: "2026-09-13T00:00:00Z", to: "2026-09-13T23:59:59Z" }).totals.total_tokens, 27);
    assert.throws(() => usage.report({ from: "bad" }), /from/);
    assert.throws(() => usage.report({ to: "bad" }), /to/);
    assert.throws(() => usage.report({ from: "2026-09-14", to: "2026-09-13" }), /after/);
  } finally {
    store.close();
  }
});

test("settings, usage, MCP, and Workbench surfaces are exposed", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-control-center-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const app = new WorkbenchWebApp(service, "token", "http://127.0.0.1:1");
  try {
    assert.equal(app.handle({ method: "GET", path: "/api/settings", token: "token" }).status, 200);
    assert.equal(app.handle({ method: "GET", path: "/api/usage", token: "token" }).status, 200);
    assert.equal(app.handle({ method: "PATCH", path: "/api/settings", token: "token", body: JSON.stringify({ theme: "light" }) }).status, 200);
    assert.equal(app.handle({ method: "POST", path: "/api/settings/reset", token: "token", body: "{}" }).status, 200);
    const html = app.handle({ method: "GET", path: "/" });
    assert.match(html.body, /平台设置与 Token 用量/u);
    assert.equal(app.handle({ method: "GET", path: "/api/settings" }).status, 401);
    assert.equal(app.handle({ method: "GET", path: "/api/settings", token: "token", origin: "http://evil" }).status, 403);
    const mcp = new McpServer(service, "full");
    assert.ok(mcp.tools.some((tool) => tool.name === "craft_usage_report"));
    const result = await mcp.handle({ id: 1, method: "tools/call", params: { name: "craft_usage_report", arguments: {} } });
    assert.equal((result?.result as Record<string, unknown>).isError, false);
    const setting = await mcp.handle({ id: 2, method: "tools/call", params: { name: "craft_settings_get", arguments: {} } });
    assert.equal((setting?.result as Record<string, unknown>).isError, false);
    const update = await mcp.handle({ id: 3, method: "tools/call", params: { name: "craft_settings_update", arguments: { theme: "dark" } } });
    assert.equal((update?.result as Record<string, unknown>).isError, false);
    const reset = await mcp.handle({ id: 4, method: "tools/call", params: { name: "craft_settings_reset", arguments: {} } });
    assert.equal((reset?.result as Record<string, unknown>).isError, false);
  } finally {
    store.close();
  }
});

test("service model management covers add duplicate and delete lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-model-service-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = new CraftService(store);
    const added = service.modelAdd({ id: "Local Model", name: "Local Model", protocol: "openai-compatible", baseUrl: "https://example.test/v1", model: "local", apiKeyEnv: "LOCAL_MODEL_KEY", supportsTools: false });
    assert.equal((added.model as Record<string, unknown>).id, "local-model");
    assert.throws(() => service.modelAdd({ id: "Local Model", name: "Again", protocol: "openai-compatible", baseUrl: "https://example.test/v1", model: "local", apiKeyEnv: "LOCAL_MODEL_KEY" }), /already exists/);
    assert.equal(service.modelDelete({ id: "local-model" }).ok, true);
  } finally { store.close(); }
});
