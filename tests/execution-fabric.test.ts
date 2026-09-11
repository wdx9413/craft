import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-execution-fabric-")); await writeFile(join(root, "note.txt"), "before");
  const store = await new CraftStore(craftPaths(root)).open(); const service = new CraftService(store);
  service.codexHost.executor = async () => ({ exitCode: 0, signal: null, stderr: "", timedOut: false, cancelled: false, outputLimited: false, stdout: `${JSON.stringify({ type: "turn.completed", usage: {} })}\n` });
  const workspace = service.workspaceOpen({ workspace_id: "workspace", name: "Workspace", root_path: root, include_paths: ["note.txt"] }).workspace as JsonObject;
  return { root, store, service, workspace };
}

test("Host activation manifest pins only eligible assets and connector tickets", async () => {
const f = await fixture();
  try {
    const task = f.service.taskOpen({ title: "Inspect", goal: "inspect" }).task as JsonObject;
    const local = f.service.capabilityAssetSave({ asset_id: "local", name: "Inspect", asset_type: "skill", source_uri: "file://inspect", effect: "read_only", trust: "verified", health: "healthy" });
    const profile = f.store.create("activation_profile", "profile", { task_id: task.id, asset_ids: [local.id], asset_versions: { [String(local.id)]: local.version }, allowed_effects: ["read_only"] });
    const prepared = f.service.hostActivationManifestPrepare({ manifest_id: "manifest", task_id: task.id, profile_id: profile.id, profile_version: profile.version, host: "codex-cli" }); const manifest = prepared.manifest as JsonObject;
    assert.equal(f.service.hostActivationManifestPrepare({ manifest_id: "manifest", task_id: task.id, profile_id: profile.id, host: "codex-cli" }).idempotent, true);
    assert.equal(f.service.hostActivationManifestValidate({ manifest_id: manifest.id }).valid, true);
    assert.equal((f.service.hostActivationManifestConsume({ manifest_id: manifest.id, call_id: "host-receipt", host: "codex-cli" }).receipt as JsonObject).host, "codex-cli");
    assert.equal(f.service.hostActivationManifestConsume({ manifest_id: manifest.id, call_id: "host-receipt", host: "codex-cli" }).idempotent, true);
    assert.throws(() => f.service.hostActivationManifestConsume({ manifest_id: manifest.id, call_id: "host-receipt", host: "claude-code" }), /host does not match/);
    const claude = f.service.hostActivationManifestPrepare({ manifest_id: "claude", task_id: task.id, profile_id: profile.id, host: "claude-code" }).manifest as JsonObject;
    assert.throws(() => f.service.hostActivationManifestConsume({ manifest_id: claude.id, call_id: "host-receipt", host: "claude-code" }), /conflict/);
    assert.throws(() => f.service.hostActivationManifestGet({ manifest_id: 1 as unknown as string }), /must not be empty/);
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "other" }), /unsupported/);
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli", asset_ids: ["missing"] }), /not in/);
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli", asset_ids: [] }), /non-empty/);
    f.store.save("capability_asset", String(local.id), { ...local, trust: "untrusted" });
    const unsafe = f.store.create("activation_profile", "unsafe", { task_id: task.id, asset_ids: [local.id], asset_versions: { [String(local.id)]: 2 }, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: unsafe.id, host: "codex-cli" }), /eligible/);
    f.store.save("activation_profile", String(profile.id), { ...profile, allowed_effects: ["local_write"] });
    assert.throws(() => f.service.hostActivationManifestValidate({ manifest_id: manifest.id }), /changed/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Connector-backed manifest requires a live exact ticket and never stores credentials", async () => {
  const f = await fixture();
  try {
    const task = f.service.taskOpen({ title: "Inspect", goal: "inspect" }).task as JsonObject;
    const connector = f.service.capabilityConnectorRegister({ connector_id: "serena", kind: "serena_mcp", name: "Serena", endpoint: "stdio://serena", approved: true, approval_ref: "user" }).connector as JsonObject;
    const discovered = f.service.capabilityConnectorDiscover({ connector_id: connector.id, assets: [{ connector_asset_id: "memory", logical_id: "memory", name: "Memory", asset_type: "tool", effect: "read_only" }] }).assets as JsonObject[];
    const asset = f.service.capabilityConnectorApprove({ connector_asset_id: discovered[0].id, approval_ref: "review", asset_id: "memory-asset" }).asset as JsonObject;
    const profile = f.store.create("activation_profile", "profile", { task_id: task.id, asset_ids: [asset.id], asset_versions: { [String(asset.id)]: asset.version }, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli" }), /requires an exact active ticket/);
    const ticket = f.service.capabilityConnectorTicketIssue({ ticket_id: "ticket", profile_id: profile.id, connector_asset_id: discovered[0].id, operation: "read" }).ticket as JsonObject;
    const manifest = f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli", connector_ticket_ids: [ticket.id] }).manifest as JsonObject;
    assert.equal(JSON.stringify(manifest).includes("credential"), false);
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli", connector_ticket_ids: [ticket.id, ticket.id] }), /unique/);
    f.store.save("capability_connector_ticket", String(ticket.id), { ...ticket, status: "consumed" });
    assert.throws(() => f.service.hostActivationManifestValidate({ manifest_id: manifest.id }), /eligible|active/);
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli", connector_ticket_ids: [ticket.id] }), /not active/);
    f.store.save("host_activation_manifest", String(manifest.id), { ...manifest, status: "revoked" });
    assert.throws(() => f.service.hostActivationManifestValidate({ manifest_id: manifest.id }), /not issued/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Host manifests reject every profile, ticket, and asset drift branch", async () => {
  const f = await fixture();
  try {
    const task = f.service.taskOpen({ title: "Read", goal: "read" }).task as JsonObject;
    const other = f.service.taskOpen({ title: "Other", goal: "other" }).task as JsonObject;
    const good = f.store.create("capability_asset", "good", { name: "Good", asset_type: "tool", source_uri: "builtin://good", source_digest: "good", effect: "read_only", trust: "trusted", health: "healthy", requires_credential: false });
    const profile = f.store.create("activation_profile", "profile", { task_id: task.id, asset_ids: [good.id], asset_versions: { [String(good.id)]: good.version }, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, profile_version: 2, host: "codex-cli" }), /version/);
    const foreignProfile = f.store.create("activation_profile", "foreign", { task_id: other.id, asset_ids: [good.id], asset_versions: { [String(good.id)]: good.version }, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: foreignProfile.id, host: "codex-cli" }), /does not match task/);
    const issued = f.service.hostActivationManifestPrepare({ manifest_id: "same", task_id: task.id, profile_id: profile.id, host: "codex-cli" }).manifest as JsonObject;
    assert.throws(() => f.service.hostActivationManifestPrepare({ manifest_id: "same", task_id: task.id, profile_id: profile.id, host: "claude-code" }), /conflict/);
    f.store.save("host_activation_manifest", String(issued.id), { ...issued, identity_digest: "wrong" });
    assert.throws(() => f.service.hostActivationManifestValidate({ manifest_id: issued.id }), /facts drifted/);
    const rejected = (effect: string, trust: string, health: string, requiresCredential: boolean, allowed = ["read_only"]) => {
      const asset = f.store.create("capability_asset", `asset-${effect}-${trust}-${health}-${requiresCredential}-${allowed[0]}`, { name: "Asset", asset_type: "tool", source_uri: `builtin://${effect}${trust}${health}${requiresCredential}${allowed[0]}`, source_digest: effect, effect, trust, health, requires_credential: requiresCredential });
      const p = f.store.create("activation_profile", `profile-${asset.id}`, { task_id: task.id, asset_ids: [asset.id], asset_versions: { [String(asset.id)]: asset.version }, allowed_effects: allowed });
      assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: p.id, host: "codex-cli" }), /eligible/);
    };
    rejected("destructive", "trusted", "healthy", false, ["destructive"]); rejected("local_write", "trusted", "healthy", false); rejected("read_only", "untrusted", "healthy", false); rejected("read_only", "trusted", "stale", false); rejected("read_only", "trusted", "healthy", true);
    const connector = f.store.create("capability_connector", "connector", { status: "active", trust: "trusted" });
    const connectorAsset = f.store.create("capability_asset", "connector-asset", { name: "Connector", asset_type: "tool", source_uri: "connector://x", source_digest: "x", effect: "read_only", trust: "trusted", health: "healthy", requires_credential: false, connector_id: connector.id });
    const connectorProfile = f.store.create("activation_profile", "connector-profile", { task_id: task.id, asset_ids: [connectorAsset.id], asset_versions: { [String(connectorAsset.id)]: connectorAsset.version }, allowed_effects: ["read_only"] });
    const first = f.store.create("capability_connector_ticket", "first", { profile_id: connectorProfile.id, profile_version: connectorProfile.version, asset_id: connectorAsset.id, asset_version: connectorAsset.version, connector_id: connector.id, status: "issued", expires_at: new Date(Date.now() + 60_000).toISOString() });
    const second = f.store.create("capability_connector_ticket", "second", { ...first, id: undefined, expires_at: new Date(Date.now() + 60_000).toISOString() });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: connectorProfile.id, host: "codex-cli", connector_ticket_ids: [first.id, second.id] }), /at most once/);
    f.store.save("capability_connector_ticket", String(first.id), { ...first, expires_at: "not-a-time" });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: connectorProfile.id, host: "codex-cli", connector_ticket_ids: [first.id] }), /not active/);
    const nonConnectorTicket = f.store.create("capability_connector_ticket", "non-connector-ticket", { profile_id: profile.id, profile_version: profile.version, asset_id: good.id, asset_version: good.version, connector_id: connector.id, status: "issued", expires_at: new Date(Date.now() + 60_000).toISOString() });
    assert.throws(() => f.service.hostActivationManifestPrepare({ task_id: task.id, profile_id: profile.id, host: "codex-cli", connector_ticket_ids: [nonConnectorTicket.id] }), /must not have/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Execution Fabric joins the verified loop and Host activation without a second scheduler", async () => {
  const f = await fixture();
  try {
    const noAsset = f.service.executionFabricPrepare({ fabric_id: "no-asset", manifest_id: "no-asset-manifest", workspace_id: f.workspace.id, title: "No asset", goal: "inspect", host: "codex-cli", prompt: "inspect", sandbox: "read-only" });
    await f.service.hostRuns.wait(String((noAsset.launch as JsonObject).run_id));
    f.service.capabilityAssetSave({ asset_id: "fabric-asset", name: "Inspect", asset_type: "skill", source_uri: "file://fabric-asset", effect: "read_only", trust: "verified", health: "healthy" });
    const prepared = f.service.executionFabricPrepare({ fabric_id: "fabric", manifest_id: "manifest", workspace_id: f.workspace.id, title: "Read", goal: "inspect", host: "codex-cli", prompt: "inspect", sandbox: "read-only", environment: { image: "same" }, budget: { usd: 1 } });
    const fabric = prepared.execution_fabric as JsonObject; const launch = prepared.launch as JsonObject;
    assert.equal((prepared.activation_profile as JsonObject).selection, "eligible_local_assets"); await f.service.hostRuns.wait(String(launch.run_id));
    const advanced = f.service.executionFabricAdvance({ fabric_id: fabric.id, environment: { image: "same" }, budget: { usd: 1 } });
    assert.equal((advanced.fabric as JsonObject).lifecycle, "ready_for_delivery");
    const workLoop = advanced.work_loop as JsonObject; const receipt = workLoop.receipt as JsonObject;
    const consumed = f.service.executionFabricConsume({ fabric_id: fabric.id, work_loop_receipt_id: receipt.id, call_id: "accepted", host: "codex-cli" }); assert.equal((consumed.fabric as JsonObject).activation_receipt_id, "accepted");
    assert.equal((f.service.executionFabricGet({ fabric_id: fabric.id }).advances as JsonObject[]).length, 2);
    assert.equal(f.service.executionFabric.advance({ fabric_id: fabric.id, work_loop_receipt_id: receipt.id, activation_receipt_id: "accepted" }).idempotent, true);
    assert.throws(() => f.service.executionFabric.get({ fabric_id: 1 as unknown as string }), /must not be empty/);
    assert.ok((f.service.executionFabric.create({ work_loop_id: (prepared.work_loop as JsonObject).id, manifest_id: (prepared.host_activation_manifest as JsonObject).id }).fabric as JsonObject).id);
    assert.equal(f.service.executionFabric.create({ fabric_id: fabric.id, work_loop_id: (prepared.work_loop as JsonObject).id, manifest_id: (prepared.host_activation_manifest as JsonObject).id }).idempotent, true);
    const differentManifest = f.service.hostActivationManifestPrepare({ manifest_id: "different-manifest", task_id: (prepared.task as JsonObject).id, profile_id: (prepared.activation_profile as JsonObject).id, host: "claude-code" }).manifest as JsonObject;
    assert.throws(() => f.service.executionFabric.create({ fabric_id: fabric.id, work_loop_id: (prepared.work_loop as JsonObject).id, manifest_id: differentManifest.id }), /idempotency conflict/);
    const replanning = f.store.create("verified_work_loop_receipt", "replanning", { work_loop_id: (prepared.work_loop as JsonObject).id, status: "needs_replan" });
    assert.equal((f.service.executionFabric.advance({ fabric_id: fabric.id, work_loop_receipt_id: replanning.id }).fabric as JsonObject).lifecycle, "needs_replan");
    const mismatchManifest = f.store.create("host_activation_receipt", "mismatch-manifest", { manifest_id: "other", identity_digest: "other" });
    assert.throws(() => f.service.executionFabric.advance({ fabric_id: fabric.id, work_loop_receipt_id: receipt.id, activation_receipt_id: mismatchManifest.id }), /does not belong/);
    const secondReceipt = f.store.create("verified_work_loop_receipt", "second-receipt", { work_loop_id: (prepared.work_loop as JsonObject).id, status: "ready_for_delivery" });
    f.service.executionFabric.advance({ fabric_id: fabric.id, work_loop_receipt_id: secondReceipt.id, advance_id: "conflict" });
    assert.throws(() => f.service.executionFabric.advance({ fabric_id: fabric.id, work_loop_receipt_id: receipt.id, advance_id: "conflict" }), /idempotency conflict/);
    const foreignLoop = f.store.create("verified_work_loop", "foreign-loop", { task_id: "foreign", contract_id: (prepared.contract as JsonObject).id, task_run_id: (prepared.task_run as JsonObject).id, workspace_id: f.workspace.id });
    const foreignReceipt = f.store.create("verified_work_loop_receipt", "foreign-receipt", { work_loop_id: foreignLoop.id, status: "ready_for_delivery" });
    assert.throws(() => f.service.executionFabric.advance({ fabric_id: fabric.id, work_loop_receipt_id: foreignReceipt.id }), /does not belong/);
    assert.throws(() => f.service.executionFabric.create({ fabric_id: "foreign-fabric", work_loop_id: foreignLoop.id, manifest_id: (prepared.host_activation_manifest as JsonObject).id }), /requires one Task/);
    assert.throws(() => f.service.executionFabricAdvance({ fabric_id: fabric.id, activation_receipt_id: "wrong" }), /Unknown/);
    const otherTask = f.service.taskOpen({ title: "Other", goal: "other" }).task as JsonObject;
    const profile = f.store.create("activation_profile", "other-profile", { task_id: otherTask.id, asset_ids: [], asset_versions: {}, allowed_effects: ["read_only"] });
    assert.throws(() => f.service.executionFabricPrepare({ workspace_id: f.workspace.id, task_id: (prepared.task as JsonObject).id, goal: "inspect", host: "codex-cli", prompt: "inspect", activation_profile_id: profile.id }), /does not match task/);
    const validProfile = f.store.create("activation_profile", "valid-profile", { task_id: otherTask.id, asset_ids: [], asset_versions: {}, allowed_effects: ["read_only"] });
    const explicit = f.service.executionFabricPrepare({ fabric_id: "explicit", manifest_id: "explicit-manifest", workspace_id: f.workspace.id, task_id: otherTask.id, goal: "other", host: "codex-cli", prompt: "other", activation_profile_id: validProfile.id, activation_profile_version: validProfile.version });
    await f.service.hostRuns.wait(String((explicit.launch as JsonObject).run_id));
    const write = f.service.executionFabricPrepare({ fabric_id: "write", manifest_id: "write-manifest", workspace_id: f.workspace.id, title: "Write", goal: "write", host: "codex-cli", prompt: "write", sandbox: "workspace-write" });
    assert.equal((write.launch as JsonObject).status, "awaiting_approval");
    assert.throws(() => f.service.executionFabricPrepare({ workspace_id: f.workspace.id, task_id: (write.task as JsonObject).id, goal: "write", host: "codex-cli", prompt: "write", sandbox: "workspace-write" }), /already bound|idempotency conflict/);
    assert.throws(() => f.service.executionFabricPrepare({ workspace_id: f.workspace.id, task_id: (prepared.task as JsonObject).id, goal: "inspect", host: "codex-cli", prompt: "inspect", sandbox: "read-only" }), /already bound|idempotency conflict/);
    const conflictingTask = f.service.taskOpen({ title: "Conflicting", goal: "conflicting" }).task as JsonObject;
    f.store.create("activation_profile", "conflicting-profile", { task_id: conflictingTask.id, goal_fingerprint: `sha256:${createHash("sha256").update(JSON.stringify("conflicting")).digest("hex")}`, asset_ids: [], asset_versions: {}, allowed_effects: ["read_only"], activation: "host_mediated", status: "recommended", selection: "no_capability_required" });
    assert.throws(() => f.service.executionFabricPrepare({ workspace_id: f.workspace.id, task_id: conflictingTask.id, goal: "conflicting", host: "codex-cli", prompt: "conflicting", sandbox: "read-only", profile_id: "conflicting-profile" }), /Execution Fabric Activation Profile idempotency conflict/);
    const forcedTask = f.service.taskOpen({ title: "Forced", goal: "forced" }).task as JsonObject;
    const forcedProfile = f.store.create("activation_profile", "forced-profile", { task_id: forcedTask.id, goal_fingerprint: `sha256:${createHash("sha256").update(JSON.stringify("forced")).digest("hex")}`, asset_ids: [], asset_versions: {}, allowed_effects: ["local_write"], activation: "host_mediated", status: "recommended", selection: "no_capability_required" });
    assert.equal((f.service.executionFabricPrepare({ workspace_id: f.workspace.id, task_id: forcedTask.id, goal: "forced", host: "codex-cli", prompt: "forced", sandbox: "workspace-write", profile_id: forcedProfile.id }).activation_profile as JsonObject).id, forcedProfile.id);
    const core = new McpServer(f.service, "core"); for (const name of ["craft_execution_fabric_prepare", "craft_execution_fabric_advance", "craft_execution_fabric_consume", "craft_execution_fabric_get", "craft_host_activation_manifest_prepare"]) assert.ok(core.tools.some((tool) => tool.name === name), name);
    assert.equal(VERSION, "0.11.53");
  } finally { await Promise.all(f.store.list("host_run", 100).map((run) => f.service.hostRuns.wait(String(run.id)))); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
