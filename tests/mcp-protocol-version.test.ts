import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { MCP_PREFERRED_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS } from "../core/distribution-and-first-run.ts";

/**
 * The supported MCP revision list must exist once.
 *
 * It previously existed twice: as a constant, and again inline in the
 * `initialize` handler. Nothing compared them, so the two could disagree while
 * every check passed — which is precisely what the declaration/implementation
 * audit exists to catch, and it only caught it because both sides were written
 * down separately.
 */
const ROOT = resolve(import.meta.dirname, "..");

/** The one module allowed to define the list. */
const DEFINITION = "core/distribution-and-first-run.ts";
/**
 * The declaration side is deliberately a second copy: a claim that referenced
 * the implementation constant would compare a value with itself and could never
 * fail. See `declaration-consistency.ts` for the same reasoning.
 */
const INDEPENDENT_DECLARATION = "core/declaration-consistency.ts";

async function sourceFiles(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await sourceFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("the supported MCP revision list is defined in exactly one place", async () => {
  const carriers: string[] = [];
  for (const file of await sourceFiles(resolve(ROOT, "core"))) {
    const source = await readFile(file, "utf8");
    // `2025-03-26` is the oldest supported revision and appears in no prose, so
    // it identifies a literal copy of the list rather than a mention of a
    // version in a comment.
    if (source.includes("\"2025-03-26\"")) carriers.push(relative(ROOT, file).split("\\").join("/"));
  }

  assert.deepEqual(carriers.sort(), [DEFINITION, INDEPENDENT_DECLARATION].sort());

  // The handler must not carry a second copy of the table.
  const handler = await readFile(resolve(ROOT, "core/interfaces/mcp-server.ts"), "utf8");
  assert.equal(handler.includes("\"2025-03-26\""), false, "the initialize handler must not inline the revision list");
});

async function server(t: { after: (fn: () => Promise<void>) => void }): Promise<McpServer> {
  const root = join(tmpdir(), `craft-mcp-version-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return new McpServer(new CraftService(store));
}

test("initialize negotiates a supported revision unchanged", async (t) => {
  const mcp = await server(t);
  for (const version of MCP_PROTOCOL_VERSIONS) {
    const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } });
    const result = response?.result as JsonObject;
    assert.equal(result.protocolVersion, version);
    // A revision this build speaks is not a downgrade, so nothing is reported.
    assert.equal("downgraded" in result, false);
  }
});

test("a client that does not negotiate gets the preferred revision, not a downgrade report", async (t) => {
  const mcp = await server(t);
  const response = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "initialize" });
  const result = response?.result as JsonObject;
  assert.equal(result.protocolVersion, MCP_PREFERRED_PROTOCOL_VERSION);
  assert.equal("downgraded" in result, false);
});

test("an unsupported revision is answered explicitly instead of silently", async (t) => {
  const mcp = await server(t);
  const response = await mcp.handle({
    jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" },
  });
  const result = response?.result as JsonObject;
  // Still a valid, usable response at the revision this build speaks...
  assert.equal(result.protocolVersion, MCP_PREFERRED_PROTOCOL_VERSION);
  // ...but the downgrade is recorded, because "we do not speak this" and "we
  // pretend to" must not look the same to the client.
  assert.equal(result.downgraded, true);
  assert.equal(result.downgrade_reason, "requested_version_unsupported");
  assert.equal(result.requested_protocol_version, "2026-07-28");
  assert.equal(result.assessed_revision, "2026-07-28");
  assert.equal(result.migration_status, "assessed_deferred");
});
