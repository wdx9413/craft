import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { DEFAULT_RUNTIME_MEMBERS, openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

function cli(root: string, args: string[], owner?: string) {
  return spawnSync(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../core/cli.ts"), ...args], {
    encoding: "utf8", timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_STORAGE_OWNER: owner, CRAFT_CONTINUOUS_LEARNING: "0" },
  });
}

test("CLI init on a new data root creates the Runtime catalog without a shared database", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-cli-init-owned-runtime-"));
  try {
    const initialized = cli(root, ["init", "--mode", "agent", "--runtime", "direct-api", "--provider-protocol", "openai-compatible",
      "--provider-name", "fixture", "--base-url", "https://fixture.invalid/v1", "--model", "fixture"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert(existsSync(join(root, "runtime", "publication.db")));
    assert.equal(lstatSync(join(root, "db", "craft.db"), { throwIfNoEntry: false })?.isFile() ?? false, false);
    assert.equal(lstatSync(join(root, "craft.db"), { throwIfNoEntry: false })?.isFile() ?? false, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI Notes uses its own authority with an explicit product and infers the same owner after restart", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-cli-owned-notes-"));
  try {
    const saved = cli(root, ["--product", "notes", "notes", "locations", "record", "/tmp/fixture", "Fixture workspace", "--promote"]);
    assert.equal(saved.status, 0, saved.stderr);
    assert(existsSync(join(root, "notes", "publication.db")));
    assert(!lstatSync(join(root, "db", "craft.db"), { throwIfNoEntry: false })?.isFile());
    const listed = cli(root, ["notes", "locations", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /Fixture workspace/u);
    const archive = `${root}-archive`, restored = `${root}-restored`;
    try {
      const backup = cli(root, ["--product", "notes", "storage-backup", "--output", archive]);
      assert.equal(backup.status, 0, backup.stderr); assert.equal(JSON.parse(backup.stdout).owner, "notes");
      const restoredResult = cli(root, ["storage-restore", "--backup", archive, "--output", restored]);
      assert.equal(restoredResult.status, 0, restoredResult.stderr);
      assert.match(cli(restored, ["notes", "locations", "list"]).stdout, /Fixture workspace/u);
      assert.notEqual(cli(root, ["--product", "notes", "storage-restore", "--backup", archive, "--output", `${root}-rejected`]).status, 0);
      assert.notEqual(cli(root, ["--product", "invalid", "storage-backup", "--output", `${root}-rejected`]).status, 0);
    } finally { rmSync(archive, { recursive: true, force: true }); rmSync(restored, { recursive: true, force: true }); }

    const wrong = cli(root, ["--product", "memory", "notes", "locations", "list"]);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /belongs to notes/u);
    assert(!existsSync(join(root, "memory", "publication.db")));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("CLI Runtime commands use runtime authority and reject cross-domain migration or unknown commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-cli-owned-runtime-"));
  try {
    const existing = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: root }); existing.close();
    const listed = cli(root, ["task", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert(existsSync(join(root, "runtime", "publication.db")));
    assert(!existsSync(join(root, "context", "publication.db")));
    assert(!lstatSync(join(root, "db", "craft.db"), { throwIfNoEntry: false })?.isFile());
    const migrated = cli(root, ["migrate", "history", "--apply"]);
    assert.notEqual(migrated.status, 0);
    assert.match(migrated.stderr, /verified capability migration/u);
    assert.notEqual(cli(root, ["unknown-command"]).status, 0);
    const invalidWorkerRoot = mkdtempSync(join(tmpdir(), "craft-cli-invalid-worker-"));
    try {
      assert.notEqual(cli(invalidWorkerRoot, ["learning-worker", "typo"]).status, 0);
      assert(!existsSync(join(invalidWorkerRoot, "runtime", "publication.db")), "invalid learning-worker commands must not initialize Runtime storage");
    } finally { rmSync(invalidWorkerRoot, { recursive: true, force: true }); }
    assert.equal(cli(root, ["--product", "runtime", "version"]).status, 0);
    assert.equal(cli(root, ["--product", "runtime", "worker", "status"]).status, 0);
    assert.equal(cli(root, ["settings", "show"], "runtime").status, 0);
    assert.equal(cli(root, ["doctor"]).status, 0);
    assert.equal(cli(root, ["semantic", "status"]).status, 0);
    assert.notEqual(cli(root, ["--product"]).status, 0);
    assert.notEqual(cli(root, [], "memory").status, 0);

  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("historical replay CLI composes all four learning owners without reading archive content", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-cli-self-evolution-replay-"));
  try {
    const rejectedAction = cli(root, ["self-evolution", "replay", "unknown"]);
    assert.notEqual(rejectedAction.status, 0);
    assert.match(rejectedAction.stderr, /self-evolution replay requires capture, cleanup-preview, or cleanup-apply/u);
    const preview = cli(root, ["self-evolution", "replay", "cleanup-preview", "--run-id", "preview-fixture"]);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).replay_run_id, "preview-fixture");
    for (const owner of ["context", "memory", "knowledge", "experience", "notes"]) {
      assert(existsSync(join(root, owner, "publication.db")), `replay runtime must compose ${owner}`);
    }
    const legacyRoot = mkdtempSync(join(tmpdir(), "craft-cli-legacy-replay-"));
    try {
      const store = await new CraftStore(craftPaths(legacyRoot)).open();
      store.close();
      const unowned = cli(legacyRoot, ["self-evolution", "replay", "unknown"]);
      assert.notEqual(unowned.status, 0);
      assert.match(unowned.stderr, /requires the Context owner runtime/u);
    } finally { rmSync(legacyRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("owned standalone CLI runs its provider fixture in the Runtime catalog", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = mkdtempSync(join(tmpdir(), "craft-cli-owned-run-"));
  try {
    const { initializeConfig } = await import("../core/config.ts");
    const { craftPaths } = await import("../core/infrastructure/paths.ts");
    const runtime = await openCapabilityService("runtime", { CRAFT_DATA_DIR: root }); runtime.close();
    await initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: { protocol: "openai-compatible", name: "fixture", baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKeyEnv: "CRAFT_FIXTURE_CREDENTIAL" } }, craftPaths(root));
    const preload = "data:text/javascript," + encodeURIComponent(`globalThis.fetch = async () => new Response(JSON.stringify({ model: "fixture", choices: [{ message: { role: "assistant", content: "Fixture response." }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { headers: { "content-type": "application/json" } });`);
    const result = await promisify(execFile)(process.execPath, ["--import", preload, "--experimental-strip-types", join(import.meta.dirname, "../core/cli.ts"), "--product", "runtime", "run", "--goal", "Return the fixture response.", "--max-steps", "1"], {
      timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: root, CRAFT_STORAGE_OWNER: "runtime", CRAFT_FIXTURE_CREDENTIAL: "local-fixture-value", CRAFT_CONTINUOUS_LEARNING: "0" },
    });
    assert.equal(JSON.parse(result.stdout).receipt.status, "completed");
    const observed = await openCapabilityService("runtime", { CRAFT_DATA_DIR: root, CRAFT_CONTEXT_MEMBERS: DEFAULT_RUNTIME_MEMBERS });
    try {
      const session = observed.store.list("work_session", 10)[0];
      const knowledge = observed.service.ownerServices.get("knowledge");
      assert(session);
      assert(knowledge?.store.find("project_brain", String(session.brain_id)), "the referenced Project Brain remains in Knowledge storage");
      assert.equal(observed.store.find("project_brain", String(session.brain_id)), null, "Runtime does not duplicate Project Brain state");
    } finally { observed.close(); }
    assert(existsSync(join(root, "runtime", "publication.db")));
    assert(!lstatSync(join(root, "db", "craft.db"), { throwIfNoEntry: false })?.isFile());
    assert.equal(cli(root, ["doctor"], "runtime").status, 0);
    assert.equal(cli(root, [], "runtime").status, 0);
    const legacyRoot = join(root, "legacy");
    await initializeConfig({ mode: "agent", runtimeKind: "direct-api", provider: { protocol: "openai-compatible", name: "fixture", baseUrl: "https://fixture.invalid/v1", model: "fixture", apiKeyEnv: "CRAFT_FIXTURE_CREDENTIAL" } }, craftPaths(legacyRoot));
    const legacy = await promisify(execFile)(process.execPath, ["--import", preload, "--experimental-strip-types", join(import.meta.dirname, "../core/cli.ts"), "run", "--goal", "Return the fixture response.", "--max-steps", "1"], { timeout: 30_000, env: { ...process.env, CRAFT_DATA_DIR: legacyRoot, CRAFT_STORAGE_OWNER: undefined, CRAFT_FIXTURE_CREDENTIAL: "local-fixture-value", CRAFT_CONTINUOUS_LEARNING: "0" } });
    assert.equal(JSON.parse(legacy.stdout).receipt.status, "completed");
    assert.equal(cli(legacyRoot, ["doctor"]).status, 0);
    assert.equal(cli(legacyRoot, ["semantic", "status"]).status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLI storage restore reports owner archives that require external-owner revalidation", async () => {
  const { backupOwnerStorage } = await import("../core/storage-backup.ts");
  const root = mkdtempSync(join(tmpdir(), "craft-cli-owner-reference-")), source = join(root, "source");
  const archive = join(root, "archive"), restored = join(root, "restored");
  const legacyRoot = join(root, "legacy"), legacyArchive = join(root, "legacy-archive"), legacyRestored = join(root, "legacy-restored");
  const memory = await openCapabilityService("memory", { CRAFT_DATA_DIR: source });
  try {
    const captured = memory.service.memoryCaptureUserStatement({ session_id: "fixture", session_host: "codex", content: "Use focused fixture checks." });
    const memoryRecord = captured.memory as { content_ref: Record<string, unknown> };
    const experience = await openCapabilityService("experience", { CRAFT_DATA_DIR: source });
    let definition: Record<string, unknown>;
    try {
      const { ProcedureDefinitionStore } = await import("@craft/capability-experience/procedure-definition");
      definition = new ProcedureDefinitionStore(experience.store).write({ schema_version: "craft.procedure.v1", procedure_id: "external", procedure_version: 1, kind: "graph", scope: "global", trigger: "Fixture", preconditions: [], allowed_effects: ["read_only"], acceptance_ref: "fixture", failure_disposition: "stop", scenario_signature: {}, evidence_ids: [], proposal_ref: { id: "fixture", version: 1 }, definition: {} }, "External graph") as unknown as Record<string, unknown>;
    } finally { experience.close(); }
    const knowledge = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: source });
    try { knowledge.store.create("fixture", "external", { content_ref: memoryRecord.content_ref, definition_ref: definition }); }
    finally { knowledge.close(); }
    const manifest = await backupOwnerStorage(source, "knowledge", archive);
    assert((manifest.external_references?.length ?? 0) > 0);
    const result = cli(source, ["storage-restore", "--backup", archive, "--output", restored]);
    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.activation, "restored_owner_requires_external_owners_and_revalidation");
    assert(payload.external_references.length > 0);
    assert(payload.revalidation_required.length > 0);

    const legacy = await new CraftStore(craftPaths(legacyRoot)).open(); legacy.close();
    const settings = cli(legacyRoot, ["settings", "show"]); assert.equal(settings.status, 0, settings.stderr);
    const plainBackup = cli(legacyRoot, ["storage-backup", "--output", legacyArchive]); assert.equal(plainBackup.status, 0, plainBackup.stderr);
    const plainRestore = cli(legacyRoot, ["storage-restore", "--backup", legacyArchive, "--output", legacyRestored]);
    assert.equal(plainRestore.status, 0, plainRestore.stderr);
    assert.equal(JSON.parse(plainRestore.stdout).activation, "staged_restore; place at original_root offline before starting Craft");
  } finally { memory.close(); rmSync(root, { recursive: true, force: true }); }
});
