import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { callMcpAdapter, listMcpAdapterTools } from "../core/mcp-adapter-client.ts";

test("the DSH Cordis bridge projects registered tools as MCP", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dsh-bridge-"));
  const bridge = pathToFileURL(join(process.cwd(), "adapters", "dsh-plugin-host", "lib", "index.js")).href;
  const fixture = join(root, "bridge.mjs");
  await writeFile(fixture, `
import { apply } from ${JSON.stringify(bridge)};
const registered = new Map();
const tools = {
  register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
  schemas() { return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); },
  async execute(exec) { return registered.get(exec.name).execute(exec.arguments, exec); },
};
const ctx = { get(name) { return name === "tools" ? tools : undefined; }, effect(factory) { factory(); } };
const running = apply(ctx);
tools.register({ name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } } },
  output: { schema: { type: "object" }, render: () => [] },
  execute: async args => ({ content: [{ type: "text", text: String(args.text) }] }) });
await running;
`, "utf8");
  const manifest = { adapter_id: "dsh.test", version: "1.0.0", kind: "mcp", platforms: ["any"], entry: process.execPath,
    transport: "stdio", capabilities: ["echo"], permissions: [], effects: ["read_only"],
    metadata: { command: process.execPath, args: [fixture], transport: "stdio" } };
  try {
    const listed = await listMcpAdapterTools(manifest);
    const tools = listed.tools as Array<Record<string, unknown>>;
    assert.equal(tools[0]?.name, "echo");
    const called = await callMcpAdapter(manifest, { adapter_id: "dsh.test", tool: "echo", arguments: { text: "hello" } });
    assert.deepEqual((called.result as Record<string, unknown>).content, [{ type: "text", text: "hello" }]);
    // The inventory is opt-in: a plain call reply must not grow another roundtrip.
    assert.equal(called.available_tools, undefined);
    const withInventory = await callMcpAdapter(manifest, { adapter_id: "dsh.test", tool: "echo", arguments: { text: "hello" }, include_tool_inventory: true });
    assert.deepEqual(withInventory.available_tools, { count: 1, truncated: false, tools: [{ name: "echo", description: "Echo" }] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a server without a tool inventory still completes the call it was asked to make", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-dsh-no-inventory-"));
  const bridge = pathToFileURL(join(process.cwd(), "adapters", "dsh-plugin-host", "lib", "index.js")).href;
  const fixture = join(root, "bridge.mjs");
  await writeFile(fixture, `
import { apply } from ${JSON.stringify(bridge)};
const registered = new Map();
let schemaCalls = 0;
const tools = {
  register(definition) { registered.set(definition.name, definition); return () => registered.delete(definition.name); },
  // tools/call resolves its schema first; only the later tools/list throws.
  schemas() { schemaCalls += 1; if (schemaCalls > 1) throw new Error("inventory unavailable");
    return [...registered.values()].map(({ name, description, parameters }) => ({ name, description, parameters })); },
  async execute(exec) { return registered.get(exec.name).execute(exec.arguments, exec); },
};
const ctx = { get(name) { return name === "tools" ? tools : undefined; }, effect(factory) { factory(); } };
const running = apply(ctx);
tools.register({ name: "echo", description: "Echo", parameters: { type: "object", properties: { text: { type: "string" } } },
  output: { schema: { type: "object" }, render: () => [] },
  execute: async args => ({ content: [{ type: "text", text: String(args.text) }] }) });
await running;
`, "utf8");
  const manifest = { adapter_id: "dsh.none", version: "1.0.0", kind: "mcp", platforms: ["any"], entry: process.execPath,
    transport: "stdio", capabilities: ["echo"], permissions: [], effects: ["read_only"],
    metadata: { command: process.execPath, args: [fixture], transport: "stdio" } };
  try {
    const called = await callMcpAdapter(manifest, { adapter_id: "dsh.none", tool: "echo", arguments: { text: "still here" }, include_tool_inventory: true });
    assert.deepEqual((called.result as Record<string, unknown>).content, [{ type: "text", text: "still here" }]);
    assert.equal(called.available_tools, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
