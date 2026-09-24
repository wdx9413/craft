import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_INTERNAL_AUTHORIZATION, classifyTool } from "../core/internal-tool-authorization.ts";
import { McpServer, TOOLS } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import {
  MCP_ASSESSED_REVISION, MCP_MIGRATION_STATUS, MCP_PREFERRED_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS
} from "../core/distribution-and-first-run.ts";
import { checkConsistency, mcpDeclarations, observeMcpFacts } from "../core/declaration-consistency.ts";
import { forwardCompatibility, outboundResult } from "../core/mcp-forward-compat.ts";

/**
 * The v0.12.41 forward-compatibility facts, defaulting to the true state of this
 * build. Kept in one place so adding a declared fact does not require editing
 * every fixture, which is how a check quietly stops checking.
 */
const forwardFacts = {
  implementsServerDiscover: true,
  emitsResultType: false,
  compliantWithTarget: false,
};

test("v0.12.39 confirms claims the observation supports", () => {
  const report = checkConsistency({
    declarations: [{ id: "a", statement: "s", source: "f", expects: { x: 1, list: ["b", "a"] } }],
    observed: { x: 1, list: ["a", "b"] },
  });
  assert.equal(report.consistent, true);
  assert.equal(report.confirmed, 1);
  assert.equal(report.contradicted, 0);
  assert.equal(report.unverifiable, 0);
  // Array comparison is set-like: these are sets of facts, not sequences.
  assert.equal((report.findings as JsonObject[])[0]!.verdict, "confirmed");
});

test("v0.12.39 treats an unchecked claim as unverified, never as passing", () => {
  // This is the state the MCP revision declaration sat in: nobody ever compared
  // it to the handler, and "not checked" was read as "fine".
  const report = checkConsistency({
    declarations: [{ id: "a", statement: "s", source: "f", expects: { never_observed: true } }],
    observed: { something_else: 1 },
  });
  assert.equal(report.consistent, true, "an unknown is not a contradiction");
  assert.equal(report.confirmed, 0, "but it is certainly not a confirmation");
  assert.equal(report.unverifiable, 1);
  assert.deepEqual(report.unverifiable_ids, ["a"]);
  assert.deepEqual((report.findings as JsonObject[])[0]!.unchecked, ["never_observed"]);
});

test("v0.12.39 reports both sides of a contradiction", () => {
  const report = checkConsistency({
    declarations: [{ id: "a", statement: "s", source: "f", expects: { n: 1 } }],
    observed: { n: 2 },
  });
  assert.equal(report.consistent, false);
  assert.equal(report.contradicted, 1);
  assert.deepEqual(report.contradicted_ids, ["a"]);
  // A mismatch is only actionable when declaration and reality are visible together.
  assert.deepEqual((report.findings as JsonObject[])[0]!.mismatches, ["n: declared 1, observed 2"]);
});

test("v0.12.39 lets a proven contradiction outrank an unchecked fact", () => {
  // If one claim is provably wrong, a missing fact elsewhere cannot rescue it.
  const report = checkConsistency({
    declarations: [{ id: "a", statement: "s", source: "f", expects: { wrong: 1, missing: 2 } }],
    observed: { wrong: 9 },
  });
  const finding = (report.findings as JsonObject[])[0]!;
  assert.equal(finding.verdict, "contradicted");
  assert.deepEqual(finding.mismatches, ["wrong: declared 1, observed 9"]);
  assert.deepEqual(finding.unchecked, ["missing"]);
});

test("v0.12.39 rejects an unusable declaration set", () => {
  const expects = { expects: { x: 1 }, observed: { x: 1 } };
  assert.throws(() => checkConsistency({ declarations: [], observed: { x: 1 } }), /must be a non-empty array/u);
  assert.throws(() => checkConsistency({ declarations: "nope", observed: { x: 1 } }), /must be a non-empty array/u);
  assert.throws(() => checkConsistency({ declarations: [1], observed: { x: 1 } }), /must be an object/u);
  assert.throws(() => checkConsistency({ declarations: [[]], observed: { x: 1 } }), /must be an object/u);
  assert.throws(() => checkConsistency({ ...expects, declarations: [{ statement: "s", source: "f", expects: { x: 1 } }] }), /id must not be empty/u);
  assert.throws(() => checkConsistency({ ...expects, declarations: [{ id: "a", source: "f", expects: { x: 1 } }] }), /statement must not be empty/u);
  assert.throws(() => checkConsistency({ ...expects, declarations: [{ id: "a", statement: "s", expects: { x: 1 } }] }), /source must not be empty/u);
  assert.throws(() => checkConsistency({ ...expects, declarations: [{ id: "a", statement: "s", source: "f" }] }), /expects must be an object/u);
  assert.throws(() => checkConsistency({ ...expects, declarations: [{ id: "a", statement: "s", source: "f", expects: {} }] }), /expects must not be empty/u);
  assert.throws(() => checkConsistency({ declarations: [{ id: "a", statement: "s", source: "f", expects: { x: 1 } }], observed: "nope" }), /observed must be an object/u);
  assert.throws(() => checkConsistency({ declarations: [{ id: "a", statement: "s", source: "f", expects: { x: 1 } }], observed: [] }), /observed must be an object/u);
});

test("v0.12.39 detects a declaration that drifted ahead of the code", () => {
  // The real 2026-07-28 shape: the runtime records that revision as assessed,
  // while the handler advertises only the older set. Reproduced from the actual
  // constants rather than from literals, so the fixture cannot drift itself.
  const facts = observeMcpFacts({
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    advertisedVersions: MCP_PROTOCOL_VERSIONS,
    assessedRevision: MCP_ASSESSED_REVISION,
    implementsPing: true, migrationStatus: MCP_MIGRATION_STATUS,
    unclassifiedMountedTools: [], ...forwardFacts,
  });
  const report = checkConsistency({ declarations: mcpDeclarations(), observed: facts });
  // The handler and the runtime agree, and the assessed revision is not
  // advertised: both of those hold, and the report says so rather than assuming.
  const contradictedIds = report.contradicted_ids as string[];
  assert.equal(contradictedIds.includes("mcp.advertised_versions"), false);
  assert.equal(contradictedIds.includes("mcp.assessed_revision_not_advertised"), false);

  // Now the drift the check exists to catch: advertising the assessed revision
  // while still speaking the old set.
  const drifted = observeMcpFacts({
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    advertisedVersions: [...MCP_PROTOCOL_VERSIONS, MCP_ASSESSED_REVISION],
    assessedRevision: MCP_ASSESSED_REVISION,
    implementsPing: true, migrationStatus: MCP_MIGRATION_STATUS,
    unclassifiedMountedTools: [], ...forwardFacts,
  });
  const driftedReport = checkConsistency({ declarations: mcpDeclarations(), observed: drifted });
  assert.equal(driftedReport.consistent, false);
  assert.deepEqual(driftedReport.contradicted_ids, ["mcp.assessed_revision_not_advertised"]);

  // And a handler that drops a declared version is caught too. `implementsPing`
  // stays true so this case isolates the version claim instead of tripping the
  // ping claim as well.
  const narrowed = observeMcpFacts({
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    advertisedVersions: [MCP_PREFERRED_PROTOCOL_VERSION],
    assessedRevision: MCP_ASSESSED_REVISION,
    implementsPing: true, migrationStatus: MCP_MIGRATION_STATUS,
    unclassifiedMountedTools: [], ...forwardFacts,
  });
  assert.deepEqual(checkConsistency({ declarations: mcpDeclarations(), observed: narrowed }).contradicted_ids,
    ["mcp.advertised_versions"]);
});

test("v0.12.39 checks the live implementation, not a copy of it", async (t) => {
  // These facts are read from the shipping source or from the running handler.
  // If someone adopts 2026-07-28 in the handler without updating the runtime, or
  // updates the runtime without the handler, this fails.
  const runtime = readFileSync("core/distribution-and-first-run.ts", "utf8");
  const server = readFileSync("core/interfaces/mcp-server.ts", "utf8");

  const declared = [...runtime.matchAll(/"(\d{4}-\d{2}-\d{2})"/gu)].map((match) => match[1]!);

  // Which revisions the handler negotiates is observed by *calling* it. It used
  // to be scraped from the handler's source text, which only worked while the
  // revision list was inlined there: as soon as the handler read the runtime
  // constant instead, the regex found nothing and the claim looked contradicted
  // when the code was in fact correct. Driving the handler cannot go blind that
  // way, and it is what the declaration actually claims about.
  const liveRoot = join(tmpdir(), `craft-v01239-live-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(liveRoot, { recursive: true });
  const liveStore = await new CraftStore(craftPaths(liveRoot)).open();
  t.after(async () => { liveStore.close(); await rm(liveRoot, { recursive: true, force: true }); });
  const liveServer = new McpServer(new CraftService(liveStore));

  const negotiated: string[] = [];
  for (const version of [...MCP_PROTOCOL_VERSIONS, MCP_ASSESSED_REVISION]) {
    const response = await liveServer.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } });
    // A supported revision is echoed back; an unsupported one is answered with
    // the preferred revision instead, so it never appears here.
    if ((response?.result as JsonObject).protocolVersion === version) negotiated.push(version);
  }
  const handlerVersions = [...new Set(negotiated)].sort();

  const unclassified = TOOLS
    .filter((tool) => new Set(DEFAULT_INTERNAL_AUTHORIZATION).has(classifyTool(tool.name)))
    .map((tool) => tool.name)
    .filter((name) => !name);

  const facts = observeMcpFacts({
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    advertisedVersions: handlerVersions,
    assessedRevision: MCP_ASSESSED_REVISION,
    implementsPing: /method === "ping"/u.test(server), migrationStatus: MCP_MIGRATION_STATUS,
    unclassifiedMountedTools: unclassified,
    // Read from the shipping files rather than assumed, so the forward-compat
    // claims are checked against what the code does. Two of these call the real
    // functions instead of scanning source text: a regex over source is exactly
    // the fragile check that reported the opposite of the truth here, because
    // `/resultType:/` also matches the note explaining the omission.
    implementsServerDiscover: /request\.method === "server\/discover"/u.test(server),
    emitsResultType: "resultType" in (outboundResult({ result: {} }).result as JsonObject),
    compliantWithTarget: forwardCompatibility().compliant_with_target === true,
  });
  const report = checkConsistency({ declarations: mcpDeclarations(), observed: facts });

  assert.equal(report.consistent, true, `contradictions: ${JSON.stringify(report.findings)}`);
  assert.equal(report.unverifiable, 0);
  // The runtime does mention the assessed revision, so the file really was read.
  assert.equal(declared.includes(MCP_ASSESSED_REVISION), true);
  // `ping` is still present: a recorded, deliberate gap rather than an unknown.
  assert.equal(facts.implements_removed_ping, true);
  assert.equal(report.confirmed, mcpDeclarations().length);

  // The check found a real contradiction on its first run, and the fix was to
  // correct the claim rather than the code. Recording that here so the claim is
  // not "improved" back into an aspiration later.
  const aspirational = observeMcpFacts({
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    advertisedVersions: handlerVersions,
    assessedRevision: MCP_ASSESSED_REVISION,
    implementsPing: false, migrationStatus: MCP_MIGRATION_STATUS,
    unclassifiedMountedTools: unclassified, ...forwardFacts,
  });
  const aspirationalReport = checkConsistency({ declarations: mcpDeclarations(), observed: aspirational });
  assert.equal(aspirationalReport.consistent, false);
  // Falsely claiming the removed method is gone is itself a contradiction.
  assert.deepEqual(aspirationalReport.contradicted_ids, ["mcp.removed_methods_acknowledged"]);
});

test("v0.12.39 is reachable from the loop and from MCP", async (t) => {
  const root = join(tmpdir(), `craft-v01239-mcp-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const server = new McpServer(new CraftService(store));

  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response?.error, undefined, `tool ${name} errored: ${JSON.stringify(response?.error)}`);
    const content = (response?.result as JsonObject).content as Array<{ text: string }>;
    return JSON.parse(content[0]!.text) as JsonObject;
  };

  const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
  assert.equal(listed.some((tool) => tool.name === "craft_consistency_check"), true);
  assert.equal(listed.some((tool) => tool.name === "craft_mcp_declarations_get"), true);

  const declarations = await call("craft_mcp_declarations_get", {});
  assert.equal(Array.isArray(declarations.declarations), true);
  assert.equal((declarations.declarations as unknown[]).length, mcpDeclarations().length);

  // Check those declarations against real facts through the MCP surface.
  const checked = await call("craft_consistency_check", { declarations: declarations.declarations as unknown[], observed: observeFacts() });
  assert.equal(checked.consistent, true);
  assert.equal(checked.unverifiable, 0);

  // A contradicted claim surfaces as inconsistent rather than as a thrown error:
  // an inconsistent build is a finding, not a crash.
  const contradicted = await call("craft_consistency_check", {
    declarations: [{ id: "x", statement: "s", source: "f", expects: { a: 1 } }],
    observed: { a: 2 },
  });
  assert.equal(contradicted.consistent, false);
  assert.deepEqual(contradicted.contradicted_ids, ["x"]);
});

/** The live MCP facts, assembled the same way the self-check test does. */
function observeFacts(): JsonObject {
  return observeMcpFacts({
    protocolVersions: MCP_PROTOCOL_VERSIONS,
    advertisedVersions: MCP_PROTOCOL_VERSIONS,
    assessedRevision: MCP_ASSESSED_REVISION,
    implementsPing: true, migrationStatus: MCP_MIGRATION_STATUS,
    unclassifiedMountedTools: [], ...forwardFacts,
  });
}
