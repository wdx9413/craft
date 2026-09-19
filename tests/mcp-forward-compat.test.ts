import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";
import { MCP_ASSESSED_REVISION, MCP_MIGRATION_STATUS, MCP_PROTOCOL_VERSIONS } from "../src/distribution-and-first-run.ts";
import {
  MCP_REVISION_REQUIREMENTS, discoverResult, forwardCompatibility,
  normalizeResultType, outboundResult, pingPolicy, readRequestMeta
} from "../src/mcp-forward-compat.ts";

async function server(t: { after: (fn: () => Promise<void>) => void }): Promise<McpServer> {
  const root = join(tmpdir(), `craft-v01241-mcp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  return new McpServer(new CraftService(store));
}

test("v0.12.41 answers server/discover without claiming the target revision", () => {
  const discovered = discoverResult({ server_name: "craft", version: "0.12.33" });
  // The revision this build actually speaks.
  assert.equal(discovered.protocolVersion, "2025-11-25");
  assert.deepEqual(discovered.supported_revisions, [...MCP_PROTOCOL_VERSIONS]);
  // A client must not infer support for the assessed revision from the fact that
  // this build knows about it.
  assert.equal((discovered.supported_revisions as string[]).includes(MCP_ASSESSED_REVISION), false);
  assert.equal(discovered.migration_status, MCP_MIGRATION_STATUS);
  assert.equal(discovered.resultType, "complete");
  assert.deepEqual(discovered.serverInfo, { name: "craft", version: "0.12.33" });

  // Defaults name the server rather than emitting an empty identity, and a
  // whitespace-only name is rejected as a name.
  assert.equal((discoverResult().serverInfo as JsonObject).name, "craft");
  assert.equal((discoverResult({ server_name: "   " }).serverInfo as JsonObject).name, "craft");
});

test("v0.12.41 reads resultType the way the revision requires", () => {
  // 2026-07-28: a client MUST treat an absent field as "complete".
  const absent = normalizeResultType({});
  assert.equal(absent.resultType, "complete");
  assert.equal(absent.present, false);
  assert.equal(absent.inferred, true);
  assert.equal(normalizeResultType({ resultType: null }).inferred, true);

  const present = normalizeResultType({ resultType: "complete" });
  assert.equal(present.present, true);
  assert.equal(present.inferred, false);
  assert.equal(present.supported, true);

  // A round-trip request must NOT be silently read as complete: that would skip
  // the client's required follow-up.
  const required = normalizeResultType({ resultType: "input_required" });
  assert.equal(required.supported, false);
  assert.equal(required.inferred, false);

  assert.throws(() => normalizeResultType({ resultType: "maybe" }), /resultType is unsupported/u);
});

test("v0.12.41 does not emit a resultType it cannot honour", () => {
  // Emitting `resultType` while speaking 2025-11-25 would be the premature
  // declaration this project keeps catching, so it is omitted and announced.
  const out = outboundResult({ result: { tools: [] } });
  assert.deepEqual(out.result, { tools: [] });
  assert.equal(out.resultType_omitted, true);
  assert.equal(out.implied_resultType, "complete");
  assert.equal("resultType" in (out.result as JsonObject), false);
  assert.match(String(out.note), /MUST read its absence/u);
  // A missing result is not an error, just an empty one.
  assert.deepEqual(outboundResult({}).result, {});
});

test("v0.12.41 makes ping retention conditional rather than accidental", () => {
  // Serving ping is correct on every revision this build speaks.
  const current = pingPolicy({ protocol_version: "2025-11-25" });
  assert.equal(current.serve_ping, true);
  assert.equal(current.removed_in, MCP_ASSESSED_REVISION);
  assert.match(String(current.reason), /part of 2025-11-25/u);
  assert.match(String(current.removal_condition), /stop serving/u);

  // And must stop the moment the negotiated revision changes, which is the fact
  // a future migration would otherwise rediscover by accident.
  const target = pingPolicy({ protocol_version: MCP_ASSESSED_REVISION });
  assert.equal(target.serve_ping, false);
  assert.match(String(target.reason), /non-conformant/u);
  // No argument means the preferred revision.
  assert.equal(pingPolicy().speaking, "2025-11-25");
});

test("v0.12.41 tolerates per-request _meta from a newer client", () => {
  // A 2025-11-25 client never sends this, so reading it is purely additive.
  const none = readRequestMeta({});
  assert.equal(none.present, false);
  assert.equal(none.protocol_version, null);
  assert.deepEqual(none.unknown_keys, []);

  const full = readRequestMeta({
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": { tools: {} },
      // An unrecognised key in the MCP namespace is reported, not silently lost.
      "io.modelcontextprotocol/futureThing": true,
      // And a key outside the namespace is not protocol drift.
      "custom/trace": "abc",
    },
  });
  assert.equal(full.present, true);
  assert.equal(full.protocol_version, "2026-07-28");
  assert.deepEqual(full.client_capabilities, { tools: {} });
  assert.deepEqual(full.unknown_keys, ["io.modelcontextprotocol/futureThing"]);

  // Empty or malformed values degrade to null instead of throwing: a peer's
  // sloppy _meta must not break the request.
  const sloppy = readRequestMeta({ _meta: { "io.modelcontextprotocol/protocolVersion": "  ", "io.modelcontextprotocol/clientCapabilities": [] } });
  assert.equal(sloppy.protocol_version, null);
  assert.equal(sloppy.client_capabilities, null);

  assert.throws(() => readRequestMeta({ _meta: "nope" }), /_meta must be an object/u);
  assert.throws(() => readRequestMeta({ _meta: [] }), /_meta must be an object/u);
});

test("v0.12.41 reports readiness as a number and never claims compliance", () => {
  const report = forwardCompatibility();
  assert.equal(report.target_revision, MCP_ASSESSED_REVISION);
  assert.equal(report.total_requirements, MCP_REVISION_REQUIREMENTS.length);
  // The most important assertion in this file: this build is NOT compliant, and
  // says so.
  assert.equal(report.compliant_with_target, false);
  const remaining = report.remaining as string[];
  assert.ok(remaining.length > 0);
  // The two strictly-additive changes are addressed; the breaking ones are not.
  assert.equal(remaining.includes("server_discover"), false);
  assert.equal(remaining.includes("result_type"), false);
  assert.equal(remaining.includes("stateless_meta"), true);
  assert.equal(remaining.includes("mrtr"), true);
  assert.equal(report.addressed, MCP_REVISION_REQUIREMENTS.length - remaining.length);
  // Every requirement is listed with its status, so the gap is auditable.
  assert.equal((report.requirements as unknown[]).length, MCP_REVISION_REQUIREMENTS.length);
  assert.equal(forwardCompatibility({ protocol_version: "2025-11-25" }).speaking, "2025-11-25");
});

test("v0.12.41 serves discover and tolerates _meta on the live server", async (t) => {
  const mcp = await server(t);

  // A real `server/discover` round trip, as a 2026-07-28 client would issue it.
  const discovered = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "server/discover", params: {} });
  assert.equal(discovered?.error, undefined);
  const result = discovered?.result as JsonObject;
  assert.equal(result.protocolVersion, "2025-11-25");
  assert.equal(result.resultType, "complete");
  assert.deepEqual(result.supported_revisions, [...MCP_PROTOCOL_VERSIONS]);

  // `ping` still works for the revision this build speaks.
  const ping = await mcp.handle({ jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(ping?.result, {});

  // And a request carrying 2026-07-28 `_meta` is served rather than rejected.
  const withMeta = await mcp.handle({
    jsonrpc: "2.0", id: 3, method: "tools/list",
    params: {}, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
  });
  assert.equal(withMeta?.error, undefined);
  assert.ok(((withMeta?.result as JsonObject).tools as unknown[]).length > 0);

  // `initialize` still negotiates exactly the declared revisions.
  const init = await mcp.handle({ jsonrpc: "2.0", id: 4, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal((init?.result as JsonObject).protocolVersion, "2025-06-18");

  // The read-only report tools are callable and honest.
  const call = async (name: string): Promise<JsonObject> => {
    const response = await mcp.handle({ id: 9, method: "tools/call", params: { name, arguments: {} } });
    assert.equal(response?.error, undefined, `${name}: ${JSON.stringify(response?.error)}`);
    return JSON.parse(((response?.result as JsonObject).content as Array<{ text: string }>)[0]!.text) as JsonObject;
  };
  assert.equal((await call("craft_mcp_discover_get")).protocolVersion, "2025-11-25");
  assert.equal((await call("craft_mcp_forward_compat_get")).compliant_with_target, false);
});
