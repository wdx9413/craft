import assert from "node:assert/strict";
import { execFile as executeFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { McpServer } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

const execFile = promisify(executeFile);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-v01218-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

function manifest(id: string, overrides: JsonObject = {}): JsonObject {
  return {
    id, version: "1.0.0", name: id, description: "A bounded test Kit", compatibility: "^0.12.18",
    provides: ["project_knowledge"], effects: ["read_only"], data_scopes: ["project_root"],
    entrypoints: ["resolve"], hooks: ["activation.resolve", "instrument.emit"],
    surfaces: ["skill", "mcp", "cli", "plugin"], healthcheck: "declared", eval_suite: "kit-fixture",
    ...overrides,
  };
}

test("Capability Kit installs with pinned dependencies, exposes one distribution descriptor, and remains inactive until resolved", async () => {
  const f = await fixture();
  try {
    const base = f.service.capabilityKitInstall({ manifest: manifest("example.base") }).kit as JsonObject;
    assert.equal((f.service.capabilityKitGet({ kit_id: base.id }).kit as JsonObject).id, base.id);
    assert.equal((f.service.capabilityKitGet({ kit_id: base.id, version: base.version }).kit as JsonObject).version, base.version);
    assert.equal((f.service.capabilityKitList({}).kits as JsonObject[]).length, 1);
    const child = f.service.capabilityKitInstall({ manifest: manifest("example.child", {
      depends_on: [{ kit_id: base.id, manifest_version: base.manifest_version }],
    }) });
    const profiled = f.service.capabilityKitInstall({ manifest: manifest("example.profile", { metadata: { explicit_task_binding: true } }) }).kit as JsonObject;
    assert.deepEqual((profiled.manifest as JsonObject).metadata, { explicit_task_binding: true });
    assert.equal((child.kit as JsonObject).status, "installed");
    assert.equal((f.service.capabilityKitInstall({ manifest: manifest("example.child", {
      depends_on: [{ kit_id: base.id, manifest_version: base.manifest_version }],
    }) }).idempotent), true);
    const descriptor = f.service.capabilityKitDistribution({ kit_id: "example.child" });
    assert.deepEqual((descriptor.distribution as JsonObject).surfaces, ["cli", "mcp", "plugin", "skill"]);
    const activation = f.service.capabilityKitActivate({ kit_id: "example.child", task_id: "task-missing" });
    assert.equal((activation.activation as JsonObject).status, "blocked");
    assert.match(String((activation.activation as JsonObject).reason), /Task/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("example.bad", {
      depends_on: [{ kit_id: "missing", manifest_version: "1.0.0" }],
    }) }), /dependency/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Kit contributions are phase-bound, content-free, and cannot write facts or survive disable and drift", async () => {
  const f = await fixture();
  try {
    const task = f.service.taskOpen({ title: "Knowledge", goal: "Read only" }).task as JsonObject;
    f.service.capabilityKitInstall({ manifest: manifest("example.safe") });
    f.service.capabilityKitConformance({ kit_id: "example.safe" });
    const activated = f.service.capabilityKitActivate({ kit_id: "example.safe", task_id: task.id });
    assert.equal((activated.activation as JsonObject).status, "active");
    const contribution = f.service.capabilityKitContributionRecord({ kit_id: "example.safe", activation_id: (activated.activation as JsonObject).id,
      phase: "activation.resolve", proposal: { selected_refs: ["artifact:one"] }, evidence_ids: [] });
    assert.equal((contribution.contribution as JsonObject).raw_content_stored, false);
    assert.equal((f.service.capabilityKitContributionRecord({ kit_id: "example.safe", activation_id: (activated.activation as JsonObject).id,
      phase: "instrument.emit", proposal: {} }).contribution as JsonObject).evidence_ids instanceof Array, true);
    assert.throws(() => f.service.capabilityKitContributionRecord({ kit_id: "example.safe", activation_id: (activated.activation as JsonObject).id,
      phase: "execute.adapter", proposal: { direct_store_write: true }, evidence_ids: [] }), /not declared/);
    f.service.capabilityKitSetState({ kit_id: "example.safe", state: "disabled", actor: "user", reason: "not needed" });
    assert.throws(() => f.service.capabilityKitContributionRecord({ kit_id: "example.safe", activation_id: (activated.activation as JsonObject).id,
      phase: "activation.resolve", proposal: {}, evidence_ids: [] }), /not active/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Kit conformance publishes Serena and local Workspace samples and keeps MCP core small", async () => {
  const f = await fixture();
  try {
    const installed = f.service.capabilityKitInstallBuiltins().kits as JsonObject[];
    assert.deepEqual(installed.map((kit) => kit.id).sort(), ["builtin.local-workspace", "builtin.serena-project-knowledge"]);
    const report = f.service.capabilityKitConformance({ kit_id: "builtin.serena-project-knowledge" });
    assert.equal((report.report as JsonObject).verdict, "passed");
    const full = new McpServer(f.service, "full"); const core = new McpServer(f.service, "core");
    assert.equal(full.tools.some((tool) => tool.name === "craft_capability_kit_install"), true);
    assert.equal(core.tools.some((tool) => tool.name === "craft_capability_kit_get"), true);
    assert.equal(core.tools.some((tool) => tool.name === "craft_capability_kit_install"), false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Kit CLI exposes the same declarative built-ins without generating executable code", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-v01218-cli-"));
  try {
    const { NODE_V8_COVERAGE: _coverage, ...environment } = process.env;
    const options = { cwd: process.cwd(), env: { ...environment, CRAFT_DATA_DIR: root } };
    const installed = await execFile(process.execPath, ["--no-experimental-test-coverage", "--experimental-strip-types", "core/cli.ts", "kit", "install-builtins"], options);
    assert.equal((JSON.parse(installed.stdout).kits as JsonObject[]).length, 2);
    const described = await execFile(process.execPath, ["--no-experimental-test-coverage", "--experimental-strip-types", "core/cli.ts", "kit", "describe", "builtin.local-workspace"], options);
    const distribution = JSON.parse(described.stdout).distribution as JsonObject;
    assert.equal(distribution.execution_authority, false);
    assert.equal(Object.hasOwn(distribution.descriptors as object, "plugin"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Kit Runtime fails closed on manifest, lifecycle, dependency, conformance, and contribution drift", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.service.capabilityKitInstall({}), /manifest/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("Bad id") }), /manifest.id/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.version", { version: "one" }) }), /semantic/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.compat", { compatibility: "1.0.0" }) }), /compatibility/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.provides", { provides: [] }) }), /non-empty/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.text", { name: "" }) }), /must not be empty/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.effects", { effects: ["unknown"] }) }), /supported/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.depends", { depends_on: "no" }) }), /array/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.depends2", { depends_on: [{ kit_id: "Bad", manifest_version: "1.0.0" }] }) }), /invalid/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.depends3", { depends_on: [{ kit_id: "same", manifest_version: "1.0.0" }, { kit_id: "same", manifest_version: "1.0.0" }] }) }), /repeat/);
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("bad.secret", { description: "token=secret" }) }), /credentials/);
    assert.throws(() => f.service.capabilityKitInstall({ origin: "api_key=secret", manifest: manifest("bad.origin") }), /credentials/);
    const root = f.service.capabilityKitInstall({ manifest: manifest("tree.root") }).kit as JsonObject;
    const other = f.service.capabilityKitInstall({ manifest: manifest("tree.other") }).kit as JsonObject;
    assert.throws(() => f.service.capabilityKitInstall({ manifest: manifest("tree.root", { description: "different" }) }), /digest conflicts/);
    const child = f.service.capabilityKitInstall({ origin: "test", manifest: manifest("tree.child", { depends_on: [{ kit_id: root.id, manifest_version: root.manifest_version }] }) }).kit as JsonObject;
    assert.equal(child.origin, "test");
    const ordered = f.service.capabilityKitInstall({ manifest: manifest("tree.ordered", { depends_on: [{ kit_id: root.id, manifest_version: root.manifest_version }, { kit_id: other.id, manifest_version: other.manifest_version }] }) }).kit as JsonObject;
    assert.deepEqual(((ordered.manifest as JsonObject).depends_on as JsonObject[]).map((item) => item.kit_id), ["tree.other", "tree.root"]);
    assert.throws(() => f.service.capabilityKitList({ limit: 0 }), /between/);
    assert.throws(() => f.service.capabilityKitGet({ kit_id: root.id, version: 99 }), /Unknown/);
    const task = f.service.taskOpen({ title: "T", goal: "T" }).task as JsonObject;
    const noConformance = f.service.capabilityKitActivate({ kit_id: child.id, task_id: task.id, activation_id: "no-conformance" }).activation as JsonObject;
    assert.equal(noConformance.status, "blocked");
    const failed = f.service.capabilityKitInstall({ manifest: manifest("destructive", { effects: ["destructive"], hooks: ["instrument.emit"] }) }).kit as JsonObject;
    assert.equal((f.service.capabilityKitConformance({ kit_id: failed.id }).report as JsonObject).verdict, "failed");
    f.service.capabilityKitConformance({ kit_id: root.id });
    f.service.capabilityKitConformance({ kit_id: child.id });
    const active = f.service.capabilityKitActivate({ kit_id: child.id, task_id: task.id, activation_id: "active" });
    assert.equal((active.activation as JsonObject).status, "active");
    assert.equal((f.service.capabilityKitActivate({ kit_id: child.id, task_id: task.id, activation_id: "active" }).idempotent), true);
    assert.throws(() => f.service.capabilityKitActivate({ kit_id: child.id, task_id: task.id, activation_id: "active", activation_profile_id: "other" }), /idempotency/);
    assert.throws(() => f.service.capabilityKitContributionRecord({ kit_id: child.id, activation_id: (active.activation as JsonObject).id, phase: "activation.resolve", proposal: { token: "secret=x" } }), /credentials/);
    assert.throws(() => f.service.capabilityKitContributionRecord({ kit_id: child.id, activation_id: (active.activation as JsonObject).id, phase: "activation.resolve", proposal: {}, evidence_ids: ["missing"] }), /Unknown evidence/);
    const evidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Kit fixture evidence" });
    assert.throws(() => f.service.capabilityKitContributionRecord({ kit_id: child.id, activation_id: (active.activation as JsonObject).id, phase: "activation.resolve", proposal: {}, evidence_ids: [evidence.id, evidence.id] }), /unique/);
    assert.throws(() => f.service.capabilityKitContributionRecord({ kit_id: child.id, activation_id: (active.activation as JsonObject).id, phase: "activation.resolve", proposal: {}, evidence_ids: "bad" }), /array/);
    const state = f.service.capabilityKitSetState({ kit_id: root.id, state: "revoked", actor: "security", reason: "drift" });
    assert.equal((state.invalidations as JsonObject[]).some((item) => item.id === (active.activation as JsonObject).id), true);
    assert.equal((f.service.capabilityKitSetState({ kit_id: root.id, state: "revoked", actor: "security", reason: "drift" }).idempotent), true);
    assert.equal((f.service.capabilityKitActivate({ kit_id: child.id, task_id: task.id, activation_id: "drifted" }).activation as JsonObject).reason, "Capability Kit dependency drifted");
    f.service.capabilityKitSetState({ kit_id: child.id, state: "disabled", actor: "user", reason: "paused" });
    assert.equal((f.service.capabilityKitActivate({ kit_id: child.id, task_id: task.id, activation_id: "disabled" }).activation as JsonObject).reason, "Capability Kit is not installed");
    assert.equal((f.service.capabilityKitConformance({ kit_id: child.id, report_id: "changed" }).report as JsonObject).verdict, "failed");
    assert.equal((f.service.capabilityKitConformance({ kit_id: child.id, report_id: "changed" }).idempotent), true);
    assert.throws(() => f.service.capabilityKitConformance({ kit_id: root.id, report_id: "changed" }), /idempotency/);
    f.store.create("capability_kit", "corrupt", { manifest: { ...manifest("corrupt"), hooks: ["not.a.phase"] }, manifest_version: "1.0.0", manifest_digest: "sha256:corrupt", status: "installed" });
    assert.equal((f.service.capabilityKitConformance({ kit_id: "corrupt" }).report as JsonObject).verdict, "failed");
    assert.throws(() => f.service.capabilityKitSetState({ kit_id: child.id, state: "unknown", actor: "x", reason: "x" }), /unsupported/);
    assert.throws(() => f.service.capabilityKitSetState({ kit_id: child.id, state: "disabled", actor: "x", reason: "api_key=secret" }), /credentials/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
