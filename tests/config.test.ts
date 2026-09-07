import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initializeConfig, loadConfig, setMode, type InitInput } from "../src/config.ts";
import { atomicPrivateJson, craftPaths, dataRoot, ensureLayout } from "../src/paths.ts";

async function temporaryRoot(): Promise<string> {
  const root = join(tmpdir(), `craft-ts-${process.pid}-${Date.now()}-${Math.random()}`);
  await mkdir(root, { recursive: true });
  return root;
}

test("layout and provider config stay under the selected Craft root", async () => {
  const root = await temporaryRoot();
  try {
    const paths = craftPaths(root);
    await ensureLayout(paths);
    const config = await initializeConfig({
      mode: "agent", runtimeKind: "direct-api", now: "2026-09-07T00:00:00Z",
      provider: { protocol: "openai-compatible", name: "Local", baseUrl: "https://api.example/v1", model: "m", apiKeyEnv: "MODEL_KEY" },
    }, paths);
    assert.equal(config.storage.database, join(root, "db", "craft.db"));
    assert.equal(config.runtime.provider?.apiKeyEnv, "MODEL_KEY");
    assert.equal((await loadConfig(paths))?.activeMode, "agent");
    const raw = await readFile(paths.configFile, "utf8");
    assert.ok(!raw.includes("actual-secret"));
    assert.equal((await setMode("provider", paths, "later")).activeMode, "provider");
    await assert.rejects(() => setMode("bad" as never, paths), /Unsupported Craft mode/);
    await atomicPrivateJson(join(root, "unix", "private.json"), { ok: true }, "linux");
    await atomicPrivateJson(join(root, "windows", "private.json"), { ok: true }, "win32");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy database is detected but never moved implicitly", async () => {
  const root = await temporaryRoot();
  try {
    const paths = craftPaths(root);
    await writeFile(paths.legacyDatabaseFile, "legacy");
    const config = await initializeConfig({ mode: "provider" }, paths);
    assert.equal(config.storage.legacyDatabase, paths.legacyDatabaseFile);
    assert.equal(await readFile(paths.legacyDatabaseFile, "utf8"), "legacy");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all execution modes serialize their own configuration", async () => {
  const roots: string[] = [];
  try {
    const cases: Array<[InitInput, string | undefined]> = [
      [{ mode: "agent", runtimeKind: "codex-cli" }, "codex"],
      [{ mode: "agent", runtimeKind: "claude-code" }, "claude"],
      [{ mode: "agent" }, undefined],
      [{ mode: "agent", runtimeKind: "direct-api", provider: {
        protocol: "anthropic", name: "Claude", baseUrl: "https://api.anthropic.com", model: "model",
      } }, undefined],
      [{ mode: "supervisor", supervisorHosts: ["codex-cli"] }, undefined],
      [{ mode: "supervisor" }, undefined],
    ];
    for (const [input, expected] of cases) {
      const root = await temporaryRoot();
      roots.push(root);
      const config = await initializeConfig(input, craftPaths(root));
      assert.equal(config.runtime.command, expected);
    }
  } finally {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("configuration rejects unsafe or incomplete values", async () => {
  const root = await temporaryRoot();
  const paths = craftPaths(root);
  try {
    await assert.rejects(() => initializeConfig({ mode: "bad" as never }, paths), /Unsupported Craft mode/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "bad" as never }, paths), /Unsupported runtime/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "direct-api" }, paths), /requires provider/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: {
      protocol: "bad" as never, name: "x", baseUrl: "https://example.com", model: "m",
    } }, paths), /Unsupported provider protocol/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: {
      protocol: "anthropic", name: "", baseUrl: "https://example.com", model: "",
    } }, paths), /must not be empty/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: {
      protocol: "anthropic", name: "x", baseUrl: "not-a-url", model: "m",
    } }, paths), /valid HTTP/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: {
      protocol: "anthropic", name: "x", baseUrl: "https://user:pass@example.com?q=x", model: "m",
    } }, paths), /without credentials/);
    await assert.rejects(() => initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: {
      protocol: "anthropic", name: "x", baseUrl: "https://example.com", model: "m", apiKeyEnv: "bad-key",
    } }, paths), /uppercase/);
    for (const baseUrl of [
      "ftp://example.com", "https://user@example.com", "https://:pass@example.com",
      "https://example.com?q=x", "https://example.com#x",
    ]) {
      await assert.rejects(() => initializeConfig({
        mode: "agent", runtimeKind: "direct-api",
        provider: { protocol: "anthropic", name: "x", baseUrl, model: "m" },
      }, paths), /without credentials/);
    }
    await assert.rejects(() => initializeConfig({ mode: "supervisor", supervisorHosts: ["bad" as never] }, paths), /Unsupported supervisor host/);
    await assert.rejects(() => setMode("agent", paths), /not initialized/);
    await ensureLayout(paths);
    await writeFile(paths.configFile, "[]");
    await assert.rejects(() => loadConfig(paths), /must be an object/);
    await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 2, activeMode: "agent" }));
    await assert.rejects(() => loadConfig(paths), /invalid Craft config schema/);
    await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 1 }));
    await assert.rejects(() => loadConfig(paths), /invalid Craft config schema/);
    await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 1, activeMode: "bad" }));
    await assert.rejects(() => loadConfig(paths), /invalid Craft config schema/);
    await writeFile(paths.configFile, JSON.stringify({ schemaVersion: 1, activeMode: "agent" }));
    await assert.rejects(() => loadConfig(paths), /invalid runtime/);
    await writeFile(paths.configFile, JSON.stringify({
      schemaVersion: 1, activeMode: "agent", runtime: { kind: "bad" },
    }));
    await assert.rejects(() => loadConfig(paths), /invalid runtime/);
    await writeFile(paths.configFile, JSON.stringify({
      schemaVersion: 1, activeMode: "agent", runtime: { kind: "unconfigured" }, storage: {},
    }));
    await assert.rejects(() => loadConfig(paths), /invalid storage paths/);
    await writeFile(paths.configFile, JSON.stringify({
      schemaVersion: 1, activeMode: "agent", runtime: { kind: "unconfigured" },
      storage: { database: "db" },
    }));
    await assert.rejects(() => loadConfig(paths), /invalid storage paths/);
    const base = { schemaVersion: 1, activeMode: "agent", initializedAt: "now", updatedAt: "now",
      runtime: { kind: "unconfigured" }, supervisor: { hosts: [] },
      storage: { database: "db", capabilityIndex: "index" } };
    await writeFile(paths.configFile, JSON.stringify({ ...base, initializedAt: 1 }));
    await assert.rejects(() => loadConfig(paths), /invalid string fields/);
    await writeFile(paths.configFile, JSON.stringify({ ...base, runtime: { kind: "codex-cli" } }));
    await assert.rejects(() => loadConfig(paths), /requires a command/);
    await writeFile(paths.configFile, JSON.stringify({ ...base, runtime: { kind: "codex-cli", command: "" } }));
    await assert.rejects(() => loadConfig(paths), /requires a command/);
    await writeFile(paths.configFile, JSON.stringify({ ...base, supervisor: { hosts: ["bad"] } }));
    await assert.rejects(() => loadConfig(paths), /invalid supervisor hosts/);
    await writeFile(paths.configFile, JSON.stringify({ ...base, runtime: { kind: "direct-api", provider: 1 } }));
    await assert.rejects(() => loadConfig(paths), /requires provider/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("dataRoot honors CRAFT_DATA_DIR", () => {
  assert.equal(dataRoot({ CRAFT_DATA_DIR: "./custom" }), join(process.cwd(), "custom"));
  assert.equal(dataRoot({ CRAFT_DATA_DIR: "  " }), join(homedir(), ".craft_data"));
  assert.equal(craftPaths().root, dataRoot());
});
