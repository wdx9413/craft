import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import { backupOwnerStorage, restoreStorage } from "../core/storage-backup.ts";

test("one owner archive restores Markdown and special shards into a different data root", async () => {
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-backup-"));
  const root = join(directory, "original"), archive = join(directory, "archive"), restoredRoot = join(directory, "restored");
  const runtime = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: root });
  try {
    runtime.service.knowledgeMemoryInstallBuiltins();
    runtime.service.evidenceRecord({ evidence_id: "proof", source_type: "human", confidence: "bounded", claim: "A user stated the fixture rule.", metadata: { capability_owner: "knowledge", scope: "global" } });
    runtime.service.knowledgeClaimSave({ claim_id: "rule", kind: "rule", content: "Run the focused fixture test before accepting the change.", evidence_ids: ["proof"], scope: "global" });
    runtime.service.knowledgeClaimReview({ claim_id: "rule", status: "expired", reviewer: "fixture", reason: "This fixture is retired." });
    runtime.store.create("trace", "fixture", { status: "completed", report: "Owner trace payload." });
    runtime.store.codebaseShards.save("codebase_index_shard", "graph", { definition: "Owner graph payload." });
    const peer = await openCapabilityService("memory", { CRAFT_DATA_DIR: root }); peer.close();
    const originalRef = runtime.store.get("knowledge_claim", "rule", 1).content_ref as Record<string, unknown>;
    runtime.store.create("fixture", "missing-reference", { content_ref: { ...originalRef, path: join(root, "absent.md") } });
    await assert.rejects(backupOwnerStorage(root, "knowledge", join(directory, "missing-archive")), /reference is missing/u);
    runtime.store.remove("fixture", "missing-reference");
    runtime.store.create("fixture", "external-reference", { content_ref: { ...originalRef, path: join(directory, "external.md") } });
    await assert.rejects(backupOwnerStorage(root, "knowledge", join(directory, "external-archive")), /inside its data root/u);
    runtime.store.remove("fixture", "external-reference");
    await assert.rejects(backupOwnerStorage(root, "invalid" as never, join(directory, "invalid")), /Unknown storage owner/u);
    writeFileSync(join(root, "knowledge", "duplicate-a.bin"), "same immutable authority bytes");
    writeFileSync(join(root, "knowledge", "duplicate-b.bin"), "same immutable authority bytes");
    const snapshot = await backupOwnerStorage(root, "knowledge", archive);
    assert.equal(lstatSync(join(archive, "knowledge", "duplicate-a.bin")).ino, lstatSync(join(archive, "knowledge", "duplicate-b.bin")).ino);
    assert.equal(snapshot.owner, "knowledge");
    assert(!snapshot.entries.some(entry => entry.path.startsWith("memory/")));
    assert(snapshot.entries.some(entry => entry.path.endsWith(".md")));
    const restored = await restoreStorage(archive, restoredRoot);
    assert(restored.relocation!.changed > 0);
    assert.equal(lstatSync(join(restoredRoot, "knowledge", "duplicate-a.bin")).ino, lstatSync(join(restoredRoot, "knowledge", "duplicate-b.bin")).ino);
    assert(!existsSync(join(restoredRoot, ".craft-history-import")));
    assert(lstatSync(join(restoredRoot, "db", "craft.db")).isDirectory());
    assert(lstatSync(join(restoredRoot, "craft.db")).isDirectory());
    const reopened = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: restoredRoot });
    try {
      assert.equal(reopened.store.get("knowledge_claim", "rule").status, "expired");
      const historical = reopened.store.get("knowledge_claim", "rule", 1);
      assert.equal(historical.content, "Run the focused fixture test before accepting the change.");
      assert(String((historical.content_ref as { path: string }).path).startsWith(restoredRoot));
      assert.equal(reopened.store.get("trace", "fixture").report, "Owner trace payload.");
      assert.equal(reopened.store.codebaseShards.find("codebase_index_shard", "graph")?.definition, "Owner graph payload.");
      assert(!existsSync(join(restoredRoot, "memory", "publication.db")));
    } finally { reopened.close(); }
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Experience definition references relocate while Notes workspace links remain external", async () => {
  const { ProcedureDefinitionStore } = await import("@craft/capability-experience/procedure-definition");
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-definition-backup-"));
  const root = join(directory, "source"), restoredRoot = join(directory, "restored");
  const runtime = await openCapabilityService("experience", { CRAFT_DATA_DIR: root });
  try {
    const definitions = new ProcedureDefinitionStore(runtime.store);
    const reference = definitions.write({ schema_version: "craft.procedure.v1", procedure_id: "fixture", procedure_version: 1, kind: "graph", scope: "global", trigger: "Fixture review", preconditions: [], allowed_effects: ["read_only"], acceptance_ref: "fixture", failure_disposition: "stop", scenario_signature: { target_class: "fixture" }, evidence_ids: [], proposal_ref: { id: "fixture", version: 1 }, definition: { graph_control: {} } }, "Fixture graph");
    runtime.store.create("experience_procedure", "fixture", { scope: "global", definition_ref: reference });
    await backupOwnerStorage(root, "experience", join(directory, "archive"));
    await restoreStorage(join(directory, "archive"), restoredRoot);
    const restored = await openCapabilityService("experience", { CRAFT_DATA_DIR: restoredRoot });
    try {
      const ref = restored.store.get("experience_procedure", "fixture").definition_ref;
      assert(String((ref as { path: string }).path).startsWith(restoredRoot));
      assert.deepEqual(new ProcedureDefinitionStore(restored.store).read(ref as typeof reference), definitions.read(reference));
    } finally { restored.close(); }
    const notes = await openCapabilityService("notes", { CRAFT_DATA_DIR: root });
    const workspace = join(directory, "workspace.txt"); writeFileSync(workspace, "External workspace content.");
    try { notes.service.craftNotesLocationRecord({ path: workspace, description: "External workspace file", promote: true }); }
    finally { notes.close(); }
    const archive = await backupOwnerStorage(root, "notes", join(directory, "notes-archive"));
    assert(!archive.entries.some(entry => entry.path.includes("workspace.txt")));
    await restoreStorage(join(directory, "notes-archive"), join(directory, "notes-restored"));
    const restoredNotes = await openCapabilityService("notes", { CRAFT_DATA_DIR: join(directory, "notes-restored") });
    try { assert(JSON.stringify(restoredNotes.service.craftNotesLocationList({})).includes(workspace)); }
    finally { restoredNotes.close(); }
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("owner backup rejects incomplete authority and restore refuses forged owner bindings", async () => {
  const { mkdirSync, cpSync, readFileSync } = await import("node:fs");
  const { initializeOwnedCatalog } = await import("../core/infrastructure/owned-catalog.ts");
  const { CraftStore } = await import("craft-common-store-local/store");
  const { craftPaths } = await import("craft-common-store-local/paths");
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-backup-reject-")), root = join(directory, "source"); mkdirSync(root);
  try {
    await assert.rejects(backupOwnerStorage(root, "knowledge", join(directory, "unowned")), /matching catalog marker/u);
    initializeOwnedCatalog(root, "knowledge");
    await assert.rejects(backupOwnerStorage(root, "knowledge", join(directory, "missing")), /publication catalog is missing/u);
    const legacy = await new CraftStore({ ...craftPaths(root), databaseDir: join(root, "knowledge"), databaseFile: join(root, "knowledge", "publication.db") }).open({ fileRecords: true });
    try { await assert.rejects(backupOwnerStorage(root, "knowledge", join(directory, "legacy")), /verified owner-record storage/u); }
    finally { legacy.close(); }
    rmSync(root, { recursive: true });
    const runtime = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: root }); runtime.close();
    const archive = join(directory, "valid"); await backupOwnerStorage(root, "knowledge", archive);
    const manifestPath = join(archive, "craft-storage-backup.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, owner: "unknown" }));
    await assert.rejects(restoreStorage(archive, join(directory, "unknown")), /Invalid backup owner/u);
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, owner: "memory" }));
    await assert.rejects(restoreStorage(archive, join(directory, "different")), /another publication catalog/u);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const bad = join(directory, "bad-marker"); cpSync(archive, bad, { recursive: true });
    const marker = "knowledge/.craft-storage-owner";
    rmSync(join(bad, marker));
    writeFileSync(join(bad, "craft-storage-backup.json"), JSON.stringify({ ...manifest, entries: manifest.entries.filter((entry: { path: string }) => entry.path !== marker) }));
    await assert.rejects(restoreStorage(bad, join(directory, "mismatched")), /marker is missing or mismatched/u);
    assert(!existsSync(join(directory, "mismatched")));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Eval owner backs up frozen inputs and reports while leaving original workspace bindings external", async () => {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { WorkbenchEvaluations } = await import("../core/workbench-evaluations.ts");
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-eval-backup-")), root = join(directory, "source"), restoredRoot = join(directory, "restored");
  const runtime = await openCapabilityService("eval", { CRAFT_DATA_DIR: root });
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");
  try {
    const reportRoot = join(root, "evaluations", "fixture"), runDirectory = join(reportRoot, "runs", "run"); mkdirSync(runDirectory, { recursive: true });
    const values = [{ fixture: "suite" }, { fixture: "subject" }, { fixture: "runtime" }], bytes = values.map(value => JSON.stringify(value));
    for (const [index, name] of ["suite", "subject", "runtime"].entries()) writeFileSync(join(reportRoot, `${name}.json`), bytes[index]!);
    writeFileSync(join(reportRoot, "controlled-report.json"), JSON.stringify({ fixture_only: true }));
    writeFileSync(join(runDirectory, "result.json"), JSON.stringify({ retained: "report bytes" }));
    const paths = ["/external/suite.json", "/external/subject.json", "/external/runtime.json"], workspace = "/external/workspace";
    const record = runtime.store.create("workbench_evaluation", "fixture", { state: "completed", report_root: reportRoot, run_directory: runDirectory, input_paths: paths, workspace, input_digest: sha(JSON.stringify({ paths: [...paths, workspace], digests: bytes.map(sha) })) });
    const archive = await backupOwnerStorage(root, "eval", join(directory, "archive"));
    assert(archive.entries.some(entry => entry.path === "evaluations/fixture/suite.json"));
    assert(!archive.entries.some(entry => entry.path.includes("external")));
    await restoreStorage(join(directory, "archive"), restoredRoot);
    const reopened = await openCapabilityService("eval", { CRAFT_DATA_DIR: restoredRoot });
    try {
      const moved = reopened.store.get("workbench_evaluation", "fixture");
      assert(String(moved.report_root).startsWith(restoredRoot));
      assert(String(moved.run_directory).startsWith(restoredRoot));
      assert.deepEqual(moved.input_paths, record.input_paths); assert.equal(moved.workspace, workspace);
      assert.deepEqual(await new WorkbenchEvaluations(reopened.store).inputs("fixture"), { suite: values[0], subject: values[1], runtime: values[2] });
      assert.equal(readFileSync(join(String(moved.run_directory), "result.json"), "utf8"), JSON.stringify({ retained: "report bytes" }));
    } finally { reopened.close(); }
    runtime.store.save("workbench_evaluation", "fixture", { ...record, report_root: join(directory, "external-report") });
    await assert.rejects(backupOwnerStorage(root, "eval", join(directory, "external")), /managed evaluations directory/u);
    runtime.store.remove("workbench_evaluation", "fixture");
    runtime.store.create("workbench_evaluation", "missing", { state: "completed", report_root: join(root, "evaluations", "missing") });
    await assert.rejects(backupOwnerStorage(root, "eval", join(directory, "missing")), /authoritative directory is missing/u);
    runtime.store.remove("workbench_evaluation", "missing");
    runtime.store.create("workbench_evaluation", "pending", { state: "starting", report_root: join(root, "evaluations", "pending") });
    await backupOwnerStorage(root, "eval", join(directory, "pending"));
  } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("Codebase and Runtime owner archives retain managed checkpoint bytes without copying their workspace", async () => {
  const { mkdirSync, readFileSync } = await import("node:fs");
  const { WorkspaceState } = await import("../core/workspace.ts");
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-checkpoint-backup-"));
  try {
    for (const owner of ["codebase", "runtime"] as const) {
      const root = join(directory, owner), workspace = join(directory, `${owner}-workspace`), restoredRoot = join(directory, `${owner}-restored`);
      mkdirSync(workspace); writeFileSync(join(workspace, "fixture.txt"), "Retained checkpoint bytes.");
      const runtime = await openCapabilityService(owner, { CRAFT_DATA_DIR: root });
      try {
        const state = new WorkspaceState(runtime.store, runtime.store.paths);
        state.open({ workspace_id: "fixture", root_path: workspace, name: "Fixture workspace", include_paths: ["fixture.txt"] });
        state.checkpoint({ workspace_id: "fixture", checkpoint_id: "snapshot", label: "Before change" });
        const checkpoint = runtime.store.get("workspace_checkpoint", "snapshot");
        const archive = await backupOwnerStorage(root, owner, join(directory, `${owner}-archive`));
        assert(archive.entries.some(entry => entry.path.endsWith("/snapshot/fixture.txt")));
        assert(!archive.entries.some(entry => entry.path.startsWith(`${owner}-workspace/`)));
        await restoreStorage(join(directory, `${owner}-archive`), restoredRoot);
        const restored = await openCapabilityService(owner, { CRAFT_DATA_DIR: restoredRoot });
        try {
          const moved = restored.store.get("workspace_checkpoint", "snapshot");
          assert(String(moved.snapshot_root).startsWith(restoredRoot));
          assert.equal(restored.store.get("workspace", "fixture").root_path, workspace);
          writeFileSync(join(workspace, "fixture.txt"), "Changed workspace bytes.");
          assert.throws(() => new WorkspaceState(restored.store, restored.store.paths).restore({ workspace_id: "fixture", checkpoint_id: "snapshot", approved: true }), /workspace restore disabled/u);
          assert.equal(readFileSync(join(String(moved.snapshot_root), "fixture.txt"), "utf8"), "Retained checkpoint bytes.");
          assert.equal(readFileSync(join(workspace, "fixture.txt"), "utf8"), "Changed workspace bytes.");
        } finally { restored.close(); }
        runtime.store.create("workspace_checkpoint", "missing", { snapshot_root: String(checkpoint.snapshot_root) + "-missing", entries: [{ path: "fixture.txt" }] });
        await assert.rejects(backupOwnerStorage(root, owner, join(directory, `${owner}-missing`)), /authoritative directory is missing/u);
        runtime.store.remove("workspace_checkpoint", "missing");
        runtime.store.create("workspace_checkpoint", "outside", { snapshot_root: workspace, entries: [] });
        await assert.rejects(backupOwnerStorage(root, owner, join(directory, `${owner}-outside`)), /managed snapshots directory/u);
        runtime.store.remove("workspace_checkpoint", "outside");
        runtime.store.create("workspace_checkpoint", "wrong-managed-shape", { snapshot_root: join(root, "wrong") });
        await assert.rejects(backupOwnerStorage(root, owner, join(directory, `${owner}-wrong`)), /managed snapshots directory/u);
        runtime.store.remove("workspace_checkpoint", "wrong-managed-shape");
        runtime.store.create("workspace_checkpoint", "metadata-only", { workspace_id: "fixture" });
        runtime.store.create("workspace_checkpoint", "diagnostic", { snapshot_root: String(checkpoint.snapshot_root) + "-diagnostic" });
        runtime.store.create("workspace_checkpoint", "empty", { snapshot_root: String(checkpoint.snapshot_root) + "-empty", entries: [] });
        await backupOwnerStorage(root, owner, join(directory, `${owner}-empty`));
      } finally { runtime.close(); }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Memory restores its own Markdown while Knowledge preserves foreign references without copying their bodies", async () => {
  const { ProcedureDefinitionStore } = await import("@craft/capability-experience/procedure-definition");
  const directory = mkdtempSync(join(tmpdir(), "craft-owner-reference-backup-")), root = join(directory, "source");
  const memory = await openCapabilityService("memory", { CRAFT_DATA_DIR: root });
  let knowledge: Awaited<ReturnType<typeof openCapabilityService>> | undefined;
  try {
    const captured = memory.service.memoryCaptureUserStatement({ session_id: "fixture", session_host: "codex", content: "I prefer focused checks for routine engineering changes." });
    const memoryRecord = captured.memory as { id: string; content_ref: Record<string, unknown> };
    await backupOwnerStorage(root, "memory", join(directory, "memory-archive"));
    await restoreStorage(join(directory, "memory-archive"), join(directory, "memory-restored"));
    const restoredMemory = await openCapabilityService("memory", { CRAFT_DATA_DIR: join(directory, "memory-restored") });
    try {
      assert.equal((restoredMemory.service.memoryLedgerGet({ memory_id: memoryRecord.id, scope_kind: "session", scope_id: "fixture", session_host: "codex" }).memory as { content: string }).content, "I prefer focused checks for routine engineering changes.");
    } finally { restoredMemory.close(); }
    const experience = await openCapabilityService("experience", { CRAFT_DATA_DIR: root });
    let definition;
    try { definition = new ProcedureDefinitionStore(experience.store).write({ schema_version: "craft.procedure.v1", procedure_id: "foreign", procedure_version: 1, kind: "graph", scope: "global", trigger: "Fixture", preconditions: [], allowed_effects: ["read_only"], acceptance_ref: "fixture", failure_disposition: "stop", scenario_signature: {}, evidence_ids: [], proposal_ref: { id: "fixture", version: 1 }, definition: {} }, "Foreign graph"); }
    finally { experience.close(); }
    knowledge = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: root });
    knowledge.store.create("fixture", "foreign", { content_ref: memoryRecord.content_ref, definition_ref: definition });
    knowledge.store.create("fixture", "foreign-no-scope", { definition_ref: { ...definition, scope: undefined } });
    const archive = await backupOwnerStorage(root, "knowledge", join(directory, "knowledge-archive"));
    assert.equal(archive.external_references?.length, 3);
    assert.deepEqual(new Set(archive.external_references!.map(ref => ref.owner)), new Set(["memory", "experience"]));
    assert(!archive.entries.some(entry => entry.path.startsWith("memory/") || entry.path.startsWith("experience/") || entry.path.startsWith("sessions/")));
    const restored = await restoreStorage(join(directory, "knowledge-archive"), join(directory, "knowledge-restored"));
    assert(restored.relocation!.revalidation_required.some(ref => ref.id === "foreign"));
    const reopened = await openCapabilityService("knowledge", { CRAFT_DATA_DIR: join(directory, "knowledge-restored") });
    try {
      assert.deepEqual(reopened.store.get("fixture", "foreign").content_ref, memoryRecord.content_ref);
      assert.deepEqual(reopened.store.get("fixture", "foreign").definition_ref, definition);
    } finally { reopened.close(); }
  } finally { knowledge?.close(); memory.close(); rmSync(directory, { recursive: true, force: true }); }
});
