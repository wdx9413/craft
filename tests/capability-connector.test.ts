import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-connectors-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

test("Capability Connectors require explicit source approval, retain only metadata, and make Serena read-only", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.capabilityConnectorRegister({ kind: "github_skill", name: "GitHub" }), /explicit user approval/);
    assert.throws(() => f.service.capabilityConnectorRegister({ kind: "mcp_http", name: "HTTP", approved: true, approval_ref: "user", endpoint: "http://mcp.example.test" }), /HTTPS/);
    assert.throws(() => f.service.capabilityConnectorRegister({ kind: "mcp_http", name: "Malformed", approved: true, approval_ref: "user", endpoint: "not a url" }), /valid HTTPS/);
    assert.throws(() => f.service.capabilityConnectorRegister({ kind: "mcp_stdio", name: "Unsafe", approved: true, approval_ref: "user", endpoint: "stdio://x?token=secret" }), /credentials/);
    const builtin = f.service.capabilityConnectorRegister({ connector_id: "builtin", kind: "builtin", name: "Built-in" }).connector as JsonObject;
    assert.equal(builtin.trust, "verified");
    assert.throws(() => f.service.capabilityConnectorUpdate({ connector_id: builtin.id }), /boolean/);
    assert.equal((f.service.capabilityConnectorUpdate({ connector_id: builtin.id, active: false }).connector as JsonObject).status, "disabled");
    assert.equal((f.service.capabilityConnectorUpdate({ connector_id: builtin.id, active: true }).connector as JsonObject).status, "active");
    const serena = f.service.capabilityConnectorRegister({ connector_id: "serena", kind: "serena_mcp", name: "Serena", approved: true, approval_ref: "user-approved", endpoint: "stdio://serena" }).connector as JsonObject;
    assert.equal(serena.credentials_stored, false);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: [] }), /between 1 and 100/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: "not-an-array" }), /array/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: [null] }), /object/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: [{ logical_id: "memory", name: "Memory", asset_type: "tool", effect: "local_write" }] }), /read-only/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: [
      { logical_id: "memory", name: "Memory", asset_type: "tool", effect: "read_only" },
      { logical_id: "memory", name: "Other", asset_type: "tool", effect: "read_only" },
    ] }), /unique/);
    const discovered = f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: [{ connector_asset_id: "memory", logical_id: "memory", name: "Project memory", summary: "project memory summaries", source_locator: ".serena/memories", source_digest: "sha256:memory", asset_type: "tool", effect: "read_only", aliases: ["serena", "memory"], cost_hint: { latency_ms: 1 } }] });
    const source = (discovered.assets as JsonObject[])[0];
    assert.equal(JSON.stringify(source).includes("project memory summaries"), true);
    assert.throws(() => f.service.capabilityConnectorApprove({ connector_asset_id: source.id }), /approval_ref/);
    const approved = f.service.capabilityConnectorApprove({ connector_asset_id: source.id, approval_ref: "review-1", asset_id: "memory-asset" });
    assert.equal(((approved.asset as JsonObject).trust), "trusted");
    const automatic = (f.service.capabilityConnectorDiscover({ connector_id: serena.id, assets: [{ logical_id: "auto", name: "Auto", asset_type: "tool", effect: "read_only" }] }).assets as JsonObject[])[0];
    assert.match(String((f.service.capabilityConnectorApprove({ connector_asset_id: automatic.id, approval_ref: "review-2" }).asset as JsonObject).id), /^asset_/);
    assert.equal((f.service.capabilityConnectorList({ limit: 1 }).connectors as JsonObject[]).length, 1);
    assert.throws(() => f.service.capabilityConnectorList({ limit: 0 }), /between/);
    assert.equal(VERSION, "0.11.53");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Connector ticket is pinned to an active Profile, exact source version, and one consumption", async () => {
  const f = await fixture();
  try {
    const connector = f.service.capabilityConnectorRegister({ connector_id: "github", kind: "github_skill", name: "GitHub skill", approved: true, approval_ref: "user", endpoint: "https://github.com/example/skill" }).connector as JsonObject;
    const discovered = f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ connector_asset_id: "read-skill", logical_id: "read-skill", name: "Read skill", summary: "inspect source", source_digest: "sha256:read", asset_type: "skill", effect: "read_only", aliases: ["inspect"] }] });
    const source = (discovered.assets as JsonObject[])[0];
    const approved = f.service.capabilityConnectorApprove({ connector_asset_id: source.id, approval_ref: "review", asset_id: "read-skill-asset" });
    const task = f.service.taskOpen({ title: "Inspect", goal: "inspect source" }).task as JsonObject;
    const plan = f.service.capabilityAccessPlan({ task_id: task.id, goal: "inspect", allowed_effects: ["read_only"] }); const profile = plan.profile as JsonObject;
    assert.throws(() => f.service.capabilityCallIssue({ profile_id: profile.id, asset_id: (approved.asset as JsonObject).id, operation: "inspect" }), /Connector ticket/);
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: source.id, operation: "inspect", expires_at: "not-a-time" }), /ISO/);
    const ticket = f.service.capabilityConnectorTicketIssue({ ticket_id: "ticket", call_id: "call", profile_id: profile.id, connector_asset_id: source.id, operation: "inspect" });
    assert.equal(((ticket.ticket as JsonObject).asset_id), (approved.asset as JsonObject).id);
    assert.throws(() => f.service.capabilityCallConsume({ call_id: "call", profile_id: profile.id }), /Connector ticket/);
    assert.throws(() => f.service.capabilityConnectorTicketConsume({ ticket_id: "ticket", profile_id: "other" }), /profile/);
    assert.equal(((f.service.capabilityConnectorTicketConsume({ ticket_id: "ticket", profile_id: profile.id }).ticket as JsonObject).status), "consumed");
    assert.throws(() => f.service.capabilityConnectorTicketConsume({ ticket_id: "ticket", profile_id: profile.id }), /already/);
    const generated = f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: source.id, operation: "inspect" });
    assert.match(String((generated.ticket as JsonObject).id), /^connector_ticket_/);
    const expired = f.service.capabilityConnectorTicketIssue({ ticket_id: "expired", profile_id: profile.id, connector_asset_id: source.id, operation: "inspect", expires_at: "2000-01-01T00:00:00.000Z" });
    assert.equal((expired.ticket as JsonObject).status, "issued");
    assert.throws(() => f.service.capabilityConnectorTicketConsume({ ticket_id: "expired", profile_id: profile.id }), /expired/);
    const drift = f.service.capabilityConnectorTicketIssue({ ticket_id: "drift", profile_id: profile.id, connector_asset_id: source.id, operation: "inspect" });
    f.store.save("capability_connector_asset", String(source.id), { ...source, status: "discovered" });
    assert.equal((drift.ticket as JsonObject).status, "issued");
    assert.throws(() => f.service.capabilityConnectorTicketConsume({ ticket_id: "drift", profile_id: profile.id }), /changed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Capability Connector rejects every unsafe discovery and ticket drift before a Host can act", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.capabilityConnectorRegister({ kind: "unknown", name: "Unknown" }), /Unsupported/);
    const https = f.service.capabilityConnectorRegister({ kind: "mcp_http", name: "HTTPS", endpoint: "https://mcp.example.test", approved: true, approval_ref: "user" }).connector as JsonObject;
    assert.equal(https.status, "active");
    assert.equal(((f.service.capabilityConnectorRegister({ kind: "builtin", name: "Null endpoint", endpoint: null }).connector as JsonObject).endpoint), "craft://builtin/Null endpoint");
    const connector = f.service.capabilityConnectorRegister({ connector_id: "connector", kind: "github_skill", name: "GitHub", approved: true, approval_ref: "user" }).connector as JsonObject;
    f.store.save("capability_connector", String(connector.id), { ...connector, status: "disabled" });
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "x", name: "x", asset_type: "skill", effect: "read_only" }] }), /not active/);
    f.store.save("capability_connector", String(connector.id), { ...connector, status: "active" });
    f.store.save("capability_connector", String(connector.id), { ...f.store.get("capability_connector", String(connector.id)), trust: "untrusted" });
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "untrusted", name: "x", asset_type: "skill", effect: "read_only" }] }), /not active/);
    f.store.save("capability_connector", String(connector.id), { ...f.store.get("capability_connector", String(connector.id)), trust: "trusted" });
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: Array.from({ length: 101 }, (_, index) => ({ logical_id: `x-${index}`, name: "x", asset_type: "skill", effect: "read_only" })) }), /between/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "bad-type", name: "Bad", asset_type: "unknown", effect: "read_only" }] }), /unsupported/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "bad-effect", name: "Bad", asset_type: "skill", effect: "unknown" }] }), /unsupported/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "aliases", name: "Alias", asset_type: "skill", effect: "read_only", aliases: ["same", "same"] }] }), /aliases/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "summary", name: "Summary", asset_type: "skill", effect: "read_only", summary: "token=secret" }] }), /credentials/);
    assert.throws(() => f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ logical_id: "locator", name: "Locator", asset_type: "skill", effect: "read_only", source_locator: "https://a:b@example.test" }] }), /credentials/);
    const write = (f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ connector_asset_id: "write", logical_id: "write", name: "Write", asset_type: "tool", effect: "local_write", requires_credential: true }] }).assets as JsonObject[])[0];
    const writeApproval = f.service.capabilityConnectorApprove({ connector_asset_id: write.id, approval_ref: "review", asset_id: "write-asset" });
    assert.equal((writeApproval.asset as JsonObject).trust, "untrusted");
    assert.throws(() => f.service.capabilityConnectorApprove({ connector_asset_id: write.id, approval_ref: "again" }), /awaiting/);
    const read = (f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ connector_asset_id: "read", logical_id: "read", name: "Read", asset_type: "skill", effect: "read_only" }] }).assets as JsonObject[])[0];
    const approval = f.service.capabilityConnectorApprove({ connector_asset_id: read.id, approval_ref: "review", asset_id: "read-asset" }); const asset = approval.asset as JsonObject;
    const task = f.service.taskOpen({ title: "Read", goal: "read" }).task as JsonObject; const profile = f.service.capabilityAccessPlan({ task_id: task.id, goal: "read" }).profile as JsonObject;
    f.store.create("activation_profile", "wrong-profile", { asset_ids: [], asset_versions: {}, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: "wrong-profile", connector_asset_id: read.id, operation: "read" }), /not in/);
    const sourceWithoutAsset = f.store.create("capability_connector_asset", "missing-asset", { connector_id: connector.id, status: "approved", effect: "read_only" });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: sourceWithoutAsset.id, operation: "read" }), /not approved/);
    f.store.save("activation_profile", String(profile.id), { ...profile, asset_versions: { [String(asset.id)]: 99 } });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: read.id, operation: "read" }), /different asset version/);
    f.store.save("activation_profile", String(profile.id), { ...profile });
    const untrusted = f.store.save("capability_asset", String(asset.id), { ...asset, trust: "untrusted" });
    f.store.save("capability_connector_asset", String(read.id), { ...f.store.get("capability_connector_asset", String(read.id)), capability_asset_version: untrusted.version });
    f.store.save("activation_profile", String(profile.id), { ...f.store.get("activation_profile", String(profile.id)), asset_versions: { [String(asset.id)]: untrusted.version } });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: read.id, operation: "read" }), /not trusted/);
    const credentialed = f.store.save("capability_asset", String(asset.id), { ...f.store.get("capability_asset", String(asset.id)), trust: "trusted", requires_credential: true });
    f.store.save("capability_connector_asset", String(read.id), { ...f.store.get("capability_connector_asset", String(read.id)), capability_asset_version: credentialed.version });
    f.store.save("activation_profile", String(profile.id), { ...f.store.get("activation_profile", String(profile.id)), asset_versions: { [String(asset.id)]: credentialed.version } });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: read.id, operation: "read" }), /not eligible/);
    const restored = f.store.save("capability_asset", String(asset.id), { ...f.store.get("capability_asset", String(asset.id)), requires_credential: false });
    f.store.save("capability_connector_asset", String(read.id), { ...f.store.get("capability_connector_asset", String(read.id)), capability_asset_version: restored.version });
    f.store.save("activation_profile", String(profile.id), { ...f.store.get("activation_profile", String(profile.id)), asset_versions: { [String(asset.id)]: restored.version } });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: read.id, operation: "token=secret" }), /credentials/);
    f.store.save("activation_profile", String(profile.id), { ...f.store.get("activation_profile", String(profile.id)), allowed_effects: ["local_write"] });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: profile.id, connector_asset_id: read.id, operation: "read" }), /not eligible/);
    f.store.save("activation_profile", String(profile.id), { ...f.store.get("activation_profile", String(profile.id)), allowed_effects: ["read_only"] });
    const verified = f.store.save("capability_asset", String(asset.id), { ...f.store.get("capability_asset", String(asset.id)), trust: "verified" });
    f.store.save("capability_connector_asset", String(read.id), { ...f.store.get("capability_connector_asset", String(read.id)), capability_asset_version: verified.version });
    f.store.save("activation_profile", String(profile.id), { ...f.store.get("activation_profile", String(profile.id)), asset_versions: { [String(asset.id)]: verified.version } });
    const blocked = f.service.capabilityConnectorTicketIssue({ ticket_id: "blocked", profile_id: profile.id, connector_asset_id: read.id, operation: "read" });
    f.store.save("capability_connector", String(connector.id), { ...connector, status: "disabled" });
    assert.equal((blocked.ticket as JsonObject).status, "issued"); assert.throws(() => f.service.capabilityConnectorTicketConsume({ ticket_id: "blocked", profile_id: profile.id }), /not active/);
    f.store.save("capability_connector", String(connector.id), { ...connector, status: "active" });
    const unavailable = f.service.capabilityConnectorTicketIssue({ ticket_id: "unavailable", profile_id: profile.id, connector_asset_id: read.id, operation: "read" });
    const call = unavailable.call as JsonObject; f.store.save("capability_call", String(call.id), { ...call, status: "consumed" });
    assert.throws(() => f.service.capabilityConnectorTicketConsume({ ticket_id: "unavailable", profile_id: profile.id }), /Underlying/);
    const serena = f.service.capabilityConnectorRegister({ connector_id: "serena-drift", kind: "serena_mcp", name: "Serena", endpoint: "stdio://serena", approved: true, approval_ref: "user" }).connector as JsonObject;
    f.store.save("capability_asset", String(asset.id), { ...f.store.get("capability_asset", String(asset.id)), effect: "local_write" });
    const changedAsset = f.store.get("capability_asset", String(asset.id));
    f.store.save("capability_connector_asset", String(read.id), { ...f.store.get("capability_connector_asset", String(read.id)), connector_id: serena.id, effect: "local_write", capability_asset_version: changedAsset.version });
    f.store.create("activation_profile", "serena-profile", { asset_ids: [asset.id], asset_versions: { [String(asset.id)]: changedAsset.version }, allowed_effects: ["local_write"] });
    assert.throws(() => f.service.capabilityConnectorTicketIssue({ profile_id: "serena-profile", connector_asset_id: read.id, operation: "write" }), /Serena/);
    f.service.capabilityConnectorRegister({ connector_id: "latest", kind: "builtin", name: "Latest" });
    f.store.create("capability_connector_asset", "orphan", { connector_id: "missing", name: "Orphan" });
    assert.equal((f.service.capabilityConnectorList({ limit: 1 }).assets as JsonObject[]).some((item) => item.id === "orphan"), false);
    assert.ok((f.service.capabilityConnectorList({}).connectors as JsonObject[]).length >= 4);
    assert.throws(() => f.service.capabilityConnectorList({ limit: 101 }), /between/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Core exposes the Work Loop and issued connector calls, while connector administration stays full-only", async () => {
  const f = await fixture();
  try {
    const core = new McpServer(f.service, "core"); const full = new McpServer(f.service, "full");
    for (const name of ["craft_verified_work_loop_prepare", "craft_verified_work_loop_advance", "craft_verified_work_loop_decide", "craft_verified_work_loop_resume", "craft_verified_work_loop_get", "craft_capability_connector_list", "craft_capability_connector_ticket_issue", "craft_capability_connector_ticket_consume"]) assert.ok(core.tools.some((tool) => tool.name === name), name);
    assert.equal(core.tools.some((tool) => tool.name === "craft_capability_connector_register"), false);
    assert.ok(full.tools.some((tool) => tool.name === "craft_capability_connector_register"));
    const response = await core.handle({ id: 1, method: "tools/call", params: { name: "craft_capability_connector_register", arguments: { kind: "builtin", name: "No" } } });
    assert.match(String((response?.error as JsonObject).message), /Unknown tool/);
    const registered = await full.handle({ id: 2, method: "tools/call", params: { name: "craft_capability_connector_register", arguments: { connector_id: "mcp", kind: "mcp_stdio", name: "MCP", endpoint: "stdio://mcp", approved: true, approval_ref: "user" } } });
    assert.equal(((registered?.result as JsonObject).isError), false);
    const discovered = await full.handle({ id: 3, method: "tools/call", params: { name: "craft_capability_connector_discover", arguments: { connector_id: "mcp", assets: [{ connector_asset_id: "mcp-read", logical_id: "mcp-read", name: "Read", asset_type: "tool", effect: "read_only" }] } } });
    assert.equal(((discovered?.result as JsonObject).isError), false);
    const updated = await full.handle({ id: "update", method: "tools/call", params: { name: "craft_capability_connector_update", arguments: { connector_id: "mcp", active: true } } });
    assert.equal(((updated?.result as JsonObject).isError), false);
    const approved = await full.handle({ id: 4, method: "tools/call", params: { name: "craft_capability_connector_approve", arguments: { connector_asset_id: "mcp-read", approval_ref: "review", asset_id: "mcp-read-asset" } } });
    assert.equal(((approved?.result as JsonObject).isError), false);
    const listed = await core.handle({ id: 5, method: "tools/call", params: { name: "craft_capability_connector_list", arguments: {} } });
    assert.equal(((listed?.result as JsonObject).isError), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
