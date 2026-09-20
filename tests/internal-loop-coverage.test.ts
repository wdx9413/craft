import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftService } from "../src/service.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { publicModel, specFromConfig, specsFromModels } from "../src/model-gateway.ts";
import type { CraftModelConfig } from "../src/settings.ts";

/**
 * Coverage hedge for the seams the tiered internal loop introduced.
 *
 * The authorization module and the MCP catalog are already exercised from the
 * MCP and internal-host suites, but three groups of branches are only reachable
 * from the facade itself: the canonical-handler dispatch path, the model
 * management surface that reads/writes `settings.json`, and the public model
 * projection. Keeping them here means a change to any of those seams fails in
 * one obvious place rather than as a coverage delta.
 */

async function fixture(): Promise<{ store: CraftStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), `craft-internal-loop-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, root };
}

function modelArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Local",
    protocol: "anthropic",
    baseUrl: "https://api.example.test/v1///",
    model: "claude-local",
    apiKeyEnv: "CRAFT_TEST_KEY",
    supportsTools: true,
    ...overrides,
  };
}

test("registering the canonical handlers routes the loop through the MCP dispatch", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const server = new McpServer(service);
    // The server contributes the canonical table on construction, so a real
    // read-tier action must resolve through it rather than the fallback table.
    const viaMcp = await server.handle({ id: 1, method: "tools/call",
      params: { name: "craft_capability_search", arguments: { query: "knowledge" } } });
    assert.equal((viaMcp?.result as Record<string, unknown>).isError, false);
    const dispatched = await (service as unknown as {
      invokeInternalAction: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }).invokeInternalAction("capability_search", { query: "knowledge" });
    assert.ok(Array.isArray(dispatched.capabilities));
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the fallback table still answers when no MCP server is mounted", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const invoked = await (service as unknown as {
      invokeInternalAction: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    }).invokeInternalAction("capability_search", { query: "anything" });
    assert.ok(Array.isArray(invoked.capabilities));
    // A read-tier action that is in neither the canonical table nor the fallback
    // table passes the tier gate and is then rejected by dispatch.
    await assert.rejects(
      (service as unknown as {
        invokeInternalAction: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }).invokeInternalAction("widget_search", {}),
      /not a known operation/,
    );
    // An action whose tier is not mounted never reaches dispatch at all.
    await assert.rejects(
      (service as unknown as {
        invokeInternalAction: (action: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }).invokeInternalAction("contract_publish", {}),
      /outside the mounted authorization/,
    );
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("model management validates, persists, updates and removes a configured model", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const count = (): number => (service.modelList().models as unknown[]).length;
    assert.equal(count(), 0);
    const added = service.modelAdd(modelArgs({ id: "Local" })) as { model: Record<string, unknown> };
    assert.equal(added.model.id, "local");
    // The trailing slashes are trimmed and the protocol is preserved.
    assert.equal(added.model.baseUrl, "https://api.example.test/v1");
    assert.equal(added.model.protocol, "anthropic");
    assert.equal(added.model.supportsTools, true);
    assert.equal(count(), 1);
    assert.throws(() => service.modelAdd(modelArgs({ id: "local" })), /already exists/);
    assert.throws(() => service.modelAdd(modelArgs()), /id must not be empty/);
    assert.throws(() => service.modelAdd(modelArgs({ id: "local2", name: "  " })), /name must not be empty/);
    assert.throws(() => service.modelAdd(modelArgs({ id: "local2", baseUrl: "ftp://x" })), /must start with http/);
    assert.throws(() => service.modelAdd(modelArgs({ id: "local2", apiKeyEnv: "not a name" })), /environment variable name/);
    // An unknown protocol falls back to the OpenAI-compatible wire format.
    const generic = service.modelAdd(modelArgs({ id: "Generic Model!", protocol: "weird", supportsTools: false })) as { model: Record<string, unknown> };
    assert.equal(generic.model.id, "generic-model-");
    assert.equal(generic.model.protocol, "openai-compatible");
    assert.equal(generic.model.supportsTools, false);
    const updated = service.modelUpdate(modelArgs({ id: "local", name: "Renamed" })) as { model: Record<string, unknown> };
    assert.equal(updated.model.name, "Renamed");
    assert.throws(() => service.modelUpdate(modelArgs({ id: "missing" })), /model not found/);
    assert.throws(() => service.modelDelete({ id: "missing" }), /model not found/);
    assert.deepEqual(service.modelDelete({ id: "local" }), { ok: true });
    assert.equal(count(), 1);
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the credential resolver prefers a desktop launcher file over the environment", async () => {
  const f = await fixture();
  const secretName = "CRAFT_INTERNAL_LOOP_COVERAGE_TOKEN";
  try {
    const service = new CraftService(f.store);
    const withoutFile = service.credentialResolve({ env: { [secretName]: "value" } });
    assert.equal(withoutFile.credential_source, "process_environment");
    assert.ok((withoutFile.names as string[]).includes(secretName));
    const missing = join(f.root, "absent.env");
    assert.throws(() => service.credentialResolve({ credential_file: missing }), /does not exist/);
    const file = join(f.root, "launcher.env");
    await writeFile(file, `${secretName}=from-file\n`, "utf8");
    const fromFile = service.credentialResolve({ credential_file: file });
    assert.equal(fromFile.credential_source, "desktop_launcher");
    assert.ok((fromFile.names as string[]).includes(secretName));
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the public model projection reports configuration without leaking a key", () => {
  const model: CraftModelConfig = { id: "local", name: "Local", protocol: "openai-compatible",
    baseUrl: "https://api.example.test/v1", model: "gpt-local", apiKeyEnv: "CRAFT_PUBLIC_MODEL_KEY", supportsTools: false };
  assert.equal(publicModel(model, {}).configured, false);
  const configured = publicModel(model, { CRAFT_PUBLIC_MODEL_KEY: "present" });
  assert.equal(configured.configured, true);
  assert.ok(!JSON.stringify(configured).includes("present"));
  const spec = specFromConfig(model);
  assert.equal(spec.chat_path, "/chat/completions");
  assert.equal(specFromConfig({ ...model, protocol: "anthropic" }).chat_path, "/messages");
  assert.equal(specsFromModels([model, { ...model, id: "second" }]).length, 2);
});

test("a task conversation turn records the user turn, streams the model reply and falls back on failure", async () => {
  const f = await fixture();
  const secret = "CRAFT_TASK_TURN_KEY";
  const originalFetch = globalThis.fetch;
  const originalKey = process.env[secret];
  try {
    const service = new CraftService(f.store);
    service.modelAdd(modelArgs({ id: "local", protocol: "anthropic", apiKeyEnv: secret }));
    process.env[secret] = "task-turn-secret";
    const task = service.taskOpen({ title: "Thread", goal: "Keep context", model_id: "local" }).task as Record<string, unknown>;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      model: "claude-local", content: [{ type: "text", text: "A safe next step." }],
      usage: { input_tokens: 3, output_tokens: 5 } }), { status: 200 })) as typeof fetch;
    const turn = await service.taskMessageSend({ task_id: String(task.id), content: "What next?" }) as { user: Record<string, unknown>; assistant: Record<string, unknown> };
    assert.equal(turn.user.role, "user");
    assert.equal(turn.assistant.role, "assistant");
    assert.equal(turn.assistant.content, "A safe next step.");
    // An empty message is refused before any network call is attempted.
    await assert.rejects(service.taskMessageSend({ task_id: String(task.id), content: "   " }), /not be empty/);
    // A transport failure is surfaced and recorded as a failed event instead of
    // a fabricated assistant turn.
    globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
    await assert.rejects(service.taskMessageSend({ task_id: String(task.id), content: "again" }), /network down/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env[secret]; else process.env[secret] = originalKey;
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("the v0.12.34 readiness, protocol and isolation facade methods project the runtime helpers", async () => {
    const f = await fixture();
    try {
      const service = new CraftService(f.store);
      const readiness = service.firstRunReadiness({ models: [{ id: "local", apiKeyEnv: "CRAFT_READY_KEY" }], env: { CRAFT_READY_KEY: "set" } });
      assert.equal(readiness.configured_count, 1);
      const negotiated = service.mcpProtocolNegotiate({ protocolVersion: "2099-01-01" });
      assert.equal(negotiated.negotiated, "2025-11-25");
      assert.equal(negotiated.downgraded, true);
      assert.equal(negotiated.migration_status, "assessed_deferred");
      const migration = service.mcpMigrationAssess({});
      assert.equal(migration.status, "blocked");
      const isolation = service.isolationCapabilityGet({ platform: "linux" });
      assert.equal(isolation.mechanism, "bwrap");
    } finally {
      f.store.close();
      await rm(f.root, { recursive: true, force: true });
    }
});

test("the distribution plan reports the download story and the remaining gap", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const plan = service.distributionPlanGet({});
    assert.equal(plan.version, "0.12.35");
    assert.equal(plan.user_download_available, false);
    assert.equal(plan.channel, "developer_command_only");
    assert.ok(Array.isArray(plan.remainder));
    const published = service.distributionPlanGet({ release_assets_available: true });
    assert.equal(published.user_download_available, true);
    assert.equal(published.channel, "github_release_asset");
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
