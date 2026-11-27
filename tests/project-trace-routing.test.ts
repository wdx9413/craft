import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { stableDigest } from "../core/digest.ts";
import { LocalSupervisor } from "../core/supervisor.ts";
import { TraceShardStore } from "craft-common-store-local/trace-shards";
import { RecordFileStore } from "craft-common-store-local/record-files";
import { CraftService } from "../core/service.ts";
import { codexSessionTaskBatch, readCodexSessionTaskExcerpt, runCodexSessionCollectionOnce } from "../core/codex-session-archive.ts";
import { applyProjectTraceMigration, previewProjectTraceMigration } from "../core/trace-project-migration.ts";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths, projectStorageDirectory } from "../core/infrastructure/paths.ts";
import { TraceKernel } from "../core/trace-kernel.ts";
import { LocalTraceArchiveStore } from "../core/trace-archive-store.ts";

test("project Trace starts, appends, and reads in its registered project while global Trace stays global", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-project-trace-"));
  const project = join(root, "project"); mkdirSync(project);
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "project-alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: "project-test" } });
    const trace = new TraceKernel(store);
    const originalFind = store.find.bind(store); let reads = 0;
    store.find = ((kind: string, id: string, ...args: unknown[]) => kind === "trace" && id === "concurrent-conflict"
      ? (++reads === 1 ? null : { id, identity_digest: "other" }) : originalFind(kind, id, ...(args as [number?, boolean?]))) as typeof store.find;
    try { assert.throws(() => trace.start({ trace_id: "concurrent-conflict", task_id: "task" }), /idempotency conflict/u); }
    finally { store.find = originalFind; }
    assert.throws(() => trace.start({ trace_id: "bad", task_id: "task", project_scope_id: "project-test", project_root: root }), /does not match/u);
    assert.throws(() => trace.start({ trace_id: "bad-missing-scope", task_id: "task", project_root: project }), /project_scope_id/u);
    assert.throws(() => trace.start({ trace_id: "bad-task", task_id: "", project_scope_id: "project-test", project_root: project }), /task_id/u);
    assert.equal(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='trace_project_owners'").get(), undefined);
    assert.throws(() => trace.start({ trace_id: "bad-metadata", task_id: "task", project_scope_id: "project-test", project_root: project, metadata: "not-an-object" }), /metadata/u);
    assert.equal(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='trace_project_owners'").get(), undefined);
    assert.throws(() => store.bindProjectTrace("", "project-test", project), /binding is invalid/u);
    assert.throws(() => store.bindProjectTrace("bad-relative", "project-test", "relative"), /binding is invalid/u);
    assert.equal(store.projectTraceRegisteredRoot("missing"), null);
    assert.equal(store.projectTraceSourceDigest("missing"), null);
    trace.start({ trace_id: "registered-root", task_id: "task", project_scope_id: "project-test" });
    assert.equal((trace.get({ trace_id: "registered-root" }).trace as { id: string }).id, "registered-root");
    trace.start({ trace_id: "project-trace", task_id: "task", project_scope_id: "project-test", project_root: project });
    trace.append({ trace_id: "project-trace", event_id: "project-event", event_kind: "action" });
    assert.equal((trace.get({ trace_id: "project-trace" }).trace as { id: string }).id, "project-trace");
    assert.equal(store.get("trace_event", "project-event").trace_id, "project-trace");
    const indexed = store.database.prepare("SELECT trace_id FROM trace_project_children WHERE kind=? AND id=?").get("trace_event", "project-event") as { trace_id: string };
    assert.equal(indexed.trace_id, "project-trace");
    store.database.prepare("UPDATE trace_project_children SET trace_id=? WHERE kind=? AND id=?").run("other-missing-trace", "trace_event", "project-event");
    assert.equal(store.get("trace_event", "project-event").trace_id, "project-trace");
    store.database.prepare("UPDATE trace_project_children SET trace_id=? WHERE kind=? AND id=?").run("project-trace", "trace_event", "project-event");
    const other = join(root, "other"); mkdirSync(other);
    store.create("scope_alias", "other-alias", { status: "active", alias_kind: "path", alias: other, scope: { kind: "project", id: "project-other" } });
    trace.start({ trace_id: "other-trace", task_id: "other-task", project_scope_id: "project-other", project_root: other });
    assert.throws(() => store.bindProjectTrace("project-trace", "project-other", other), /owner cannot change/u);
    store.database.prepare("UPDATE trace_project_owners SET root=? WHERE trace_id=?").run(realpathSync(other), "project-trace");
    assert.throws(() => store.bindProjectTrace("project-trace", "project-test", project), /owner cannot change/u);
    store.database.prepare("UPDATE trace_project_owners SET root=? WHERE trace_id=?").run(realpathSync(project), "project-trace");
    assert.equal(store.findMetadata("trace", "project-trace")?.id, "project-trace");
    assert.equal(store.findMetadata("trace_event", "project-event")?.id, "project-event");
    const internalRoute = store as unknown as { traceStore: (id: string) => TraceShardStore };
    const originalRoute = internalRoute.traceStore.bind(store), projectShard = originalRoute("project-trace"); let routeReads = 0;
    internalRoute.traceStore = id => id === "moving-trace" ? (++routeReads === 1 ? store.traceShards : projectShard) : originalRoute(id);
    try { assert.equal(store.traceTransaction("moving-trace", () => "rerouted"), "rerouted"); }
    finally { internalRoute.traceStore = originalRoute; }
    const alias = store.get("scope_alias", "project-alias");
    store.save("scope_alias", "project-alias", { ...alias, status: "revoked" });
    assert.throws(() => trace.get({ trace_id: "project-trace" }), /owner is unavailable or ambiguous/u);
    store.save("scope_alias", "project-alias", { ...store.get("scope_alias", "project-alias"), status: "active" });
    assert.throws(() => trace.append({ trace_id: "other-trace", event_id: "project-event", event_kind: "action" }), /conflict/u);
    assert.throws(() => store.create("trace_event", "project-event", { trace_id: "other-trace", event_kind: "action" }), /already bound/u);
    assert.throws(() => store.traceTransaction("project-trace", () => {
      store.create("trace_event", "rolled-back-event", { trace_id: "project-trace", event_kind: "action" });
      throw new Error("injected shard rollback");
    }), /injected shard rollback/u);
    assert.equal(store.find("trace_event", "rolled-back-event"), null);
    const internal = store as unknown as { indexProjectTraceChild: (kind: string, id: string, payload: Record<string, unknown>) => void };
    const originalIndex = internal.indexProjectTraceChild;
    internal.indexProjectTraceChild = () => { throw new Error("injected index failure"); };
    assert.throws(() => store.create("trace_event", "direct-failure", { trace_id: "other-trace", event_kind: "action" }), /injected index failure/u);
    internal.indexProjectTraceChild = originalIndex;
    assert.equal(store.find("trace_event", "direct-failure"), null);
    store.create("trace_event", "direct-failure", { trace_id: "other-trace", event_kind: "action" });
    assert.equal(store.get("trace_event", "direct-failure").trace_id, "other-trace");
    store.database.exec(`CREATE TRIGGER race_trace_owner AFTER DELETE ON trace_project_children WHEN OLD.id='rolled-back-event'
      BEGIN INSERT INTO trace_project_children(kind,id,trace_id) VALUES(OLD.kind,OLD.id,'registered-root'); END`);
    assert.throws(() => trace.append({ trace_id: "other-trace", event_id: "rolled-back-event", event_kind: "action" }), /already bound/u);
    store.database.exec("DROP TRIGGER race_trace_owner");
    trace.append({ trace_id: "other-trace", event_id: "rolled-back-event", event_kind: "action" });
    assert.equal(store.get("trace_event", "rolled-back-event").trace_id, "other-trace");

    assert.equal(store.events("trace:project-trace").length > 0, true);
    assert.equal(existsSync(join(projectStorageDirectory(paths, project), "trace", "v1")), true);
    assert.equal(store.list("trace", 100).some(item => item.id === "project-trace"), true);
    assert.equal(store.history("trace", "project-trace", 999, 100).length >= 1, true);
    assert.equal(store.count("trace"), 3);
    assert.equal(store.countMany(["trace", "trace_event"]).trace, 3);
    store.traceShards.create("trace", "project-trace", { task_id: "duplicate", status: "running" });
    assert.throws(() => store.list("trace", 100), /ambiguous across owners/u);
    store.traceShards.remove("project-trace", [], [], []);
    store.create("telemetry_event", "project-telemetry", { trace_id: "project-trace", status: "observed" });
    trace.finalize({ trace_id: "project-trace", status: "completed", summary: "done" });
    const terminal = store.get("trace", "project-trace");
    const archive = new LocalTraceArchiveStore(join(projectStorageDirectory(paths, project), "trace")).write({ trace_id: "project-trace", trace_version: Number(terminal.version), archived_at: "2099-01-01T00:00:00.000Z", trace: terminal,
      events: store.listTraceChildren("trace_event", "project-trace"), feedback: [], telemetry_events: store.listTraceChildren("telemetry_event", "project-trace") });
    store.create("trace_archive", "project-trace", { trace_id: "project-trace", trace_version: terminal.version, task_id: terminal.task_id, status: terminal.status,
      archive_backend_id: "local", archive_storage: archive.storage, archive_locator: archive.locator, archive_uri: archive.uri, archive_format: archive.format, content_digest: archive.content_digest, bytes: archive.bytes });
    assert.equal(trace.retentionSweep({ now: "2100-01-01T00:00:00.000Z", max_days: 1 }).deleted, 1);
    const restored = trace.get({ trace_id: "project-trace" });
    assert.equal(restored.archived, true);
    assert.equal((restored.telemetry_events as unknown[]).length, 1);
    assert.equal(existsSync(join(projectStorageDirectory(paths, project), "trace", "trace-archive")), true);
    store.create("telemetry_event", "other-telemetry", { trace_id: "other-trace", status: "observed" });
    trace.finalize({ trace_id: "other-trace", status: "completed", summary: "done" });
    assert.equal(trace.retentionSweep({ now: "2100-01-01T00:00:00.000Z", max_days: 1 }).deleted, 1);
    assert.equal((trace.get({ trace_id: "other-trace" }).telemetry_events as unknown[]).length, 1);
    trace.start({ trace_id: "telemetry-trace", task_id: "task", telemetry_only: true });
    assert.equal((trace.get({ trace_id: "telemetry-trace" }).trace as { telemetry_only?: boolean }).telemetry_only, true);
    trace.start({ trace_id: "global-trace", task_id: "task" });
    assert.throws(() => trace.start({ trace_id: "global-trace", task_id: "different-task", project_scope_id: "project-test", project_root: project }), /idempotency conflict/u);
    assert.equal(store.database.prepare("SELECT 1 FROM trace_project_owners WHERE trace_id=?").get("global-trace"), undefined);
    assert.equal((trace.get({ trace_id: "global-trace" }).trace as { id: string }).id, "global-trace");
    assert.equal(trace.start({ trace_id: "global-trace", task_id: "task", project_scope_id: "project-test", project_root: project }).idempotent, true);
    assert.equal(store.traceShards.find("trace", "global-trace")?.id, "global-trace");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});


test("legacy Trace without a reverified Host task remains pending without mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-preflight-"));
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open();
  try {
    const { previewProjectTraceMigration } = await import("../core/trace-project-migration.ts");
    await assert.rejects(previewProjectTraceMigration(store, ""), /bounded string/u);
    const trace = new TraceKernel(store);
    trace.start({ trace_id: "legacy-other", task_id: "unattributed" });
    assert.equal((await previewProjectTraceMigration(store, "legacy-other")).reason, "source_task_not_identifiable");
    trace.start({ trace_id: "legacy-task", task_id: "knowledge:task-unavailable" });
    const badSource = async () => ({ status: "ready", task_id: "forged", project_scope_id: "project:test", source_ref: `sha256:${"a".repeat(64)}` });
    assert.equal((await previewProjectTraceMigration(store, "legacy-task", {}, badSource)).reason, "host_source_identity_unverified");
    assert.equal((await previewProjectTraceMigration(store, "legacy-task", { CRAFT_DATA_DIR: join(root, "missing") })).status, "pending");
    assert.equal(store.traceShards.find("trace", "legacy-task")?.id, "legacy-task");
    assert.equal(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name='trace_project_owners'").get(), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("legacy learning Trace preflight rechecks a real Host task source", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-host-proof-"));
  const project = join(root, "project"), codex = join(root, "codex"), sessions = join(codex, "sessions");
  mkdirSync(project); mkdirSync(sessions, { recursive: true }); execFileSync("git", ["init", "--quiet", project]);
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open();
  const supervisor = new LocalSupervisor(new CraftService(store), paths);
  const env = { ...process.env, CRAFT_DATA_DIR: paths.root, CODEX_HOME: codex };
  try {
    await supervisor.start();
    const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload });
    for (let index = 0; index < 12; index++) {
      const turn = `turn-${index}`;
      const records = [line("session_meta", { session_id: `session-${index}`, cwd: project }),
        line("event_msg", { type: "task_started", turn_id: turn, started_at: "2026-10-20T00:00:00.000Z" }),
        line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: `请检查项目测试行为并修复存在的问题，任务编号 ${index}` }] }),
        line("event_msg", { type: "item_completed", turn_id: turn, item: { type: "CommandExecution", id: "test", command: "pnpm test", aggregated_output: "Tests 1 passed (1)", exit_code: 0, status: "completed" } }),
        line("response_item", { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "已完成项目测试检查，修复了发现的问题并验证测试通过。" }] }),
        line("event_msg", { type: "task_complete", turn_id: turn, completed_at: "2026-10-20T00:01:00.000Z" })];
      writeFileSync(join(sessions, `session-${index}.jsonl`), records.join("\n") + "\n");
    }
    await runCodexSessionCollectionOnce({}, env);
    const batch = await codexSessionTaskBatch("candidate_generation", {}, env);
    const task = (batch.tasks as Array<Record<string, unknown>>)[0]; assert.ok(task);
    store.create("scope_alias", "project-alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: task.project_scope_id } });
    const proofKernel = new TraceKernel(store);
    for (const [index, field] of ["actor", "source", "operation", "reference", "digest", "purpose"].entries()) {
      const input = `sha256:${String(index + 1).repeat(64)}`, purpose = field === "purpose" ? "knowledge_held_out_label" : "knowledge_session_candidate_generation";
      const id = `trace_${stableDigest({ purpose, task_id: task.task_id, input_digest: input }).slice(-32)}`;
      proofKernel.start({ trace_id: id, task_id: `knowledge:${task.task_id}`, operation_id: task.task_id });
      proofKernel.append({ trace_id: id, event_kind: "model.request", actor: field === "actor" ? "untrusted" : purpose === "knowledge_held_out_label" ? "knowledge-session-evaluation-worker" : "knowledge-session-candidate-worker",
        source: field === "source" ? "untrusted" : "codex-cli-learning-transport", operation_id: field === "operation" ? "other" : task.task_id,
        input_refs: field === "reference" ? [] : [input], data: { purpose, input_digest: input, source_ref: field === "digest" ? "sha256:wrong" : task.source_ref, content_stored: false } });
      assert.equal((await previewProjectTraceMigration(store, id, env)).reason, "trace_source_binding_unverified");
    }
    const inputDigest = `sha256:${"a".repeat(64)}`, purpose = "knowledge_session_candidate_generation";
    const legacyTraceId = `trace_${stableDigest({ purpose, task_id: task.task_id, input_digest: inputDigest }).slice(-32)}`;
    const hostTrace = new TraceKernel(store);
    hostTrace.start({ trace_id: legacyTraceId, task_id: `knowledge:${task.task_id}`, operation_id: task.task_id });
    const raw = await readCodexSessionTaskExcerpt(task.task_id, { expected_partition: "candidate_generation" }, env);
    assert.equal(raw.status, "ready", JSON.stringify(raw));
    assert.equal((await previewProjectTraceMigration(store, legacyTraceId, env)).reason, "trace_source_binding_unverified");
    hostTrace.append({ trace_id: legacyTraceId, event_kind: "model.request", actor: "knowledge-session-candidate-worker", source: "codex-cli-learning-transport", operation_id: task.task_id,
      input_refs: [inputDigest], data: { purpose, input_digest: inputDigest, source_ref: task.source_ref, content_stored: false } });
    const alias = store.get("scope_alias", "project-alias");
    store.save("scope_alias", "project-alias", { ...alias, status: "revoked" });
    assert.equal((await previewProjectTraceMigration(store, legacyTraceId, env)).reason, "project_root_unavailable");
    store.save("scope_alias", "project-alias", { ...store.get("scope_alias", "project-alias"), status: "active" });
    const sourceDigest = store.projectTraceSourceDigest.bind(store);
    store.projectTraceSourceDigest = () => null;
    assert.equal((await previewProjectTraceMigration(store, legacyTraceId, env)).reason, "trace_snapshot_unavailable");
    store.projectTraceSourceDigest = sourceDigest;
    const preview = await previewProjectTraceMigration(store, legacyTraceId, env);
    assert.equal(preview.status, "ready", JSON.stringify(preview)); assert.equal(preview.project_scope_id, task.project_scope_id);
    assert.equal(preview.raw_content_stored, false);
    assert.equal(JSON.stringify(preview).includes("核实项目测试行为"), false);
    await assert.rejects(store.migrateProjectTrace(legacyTraceId, String(preview.manifest_digest)), /verifier is unavailable/u);
    const kernel = new TraceKernel(store);
    kernel.append({ trace_id: legacyTraceId, event_id: "legacy-event", event_kind: "action" });
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(preview.manifest_digest), env), /changed; preview again/u);
    const current = await previewProjectTraceMigration(store, legacyTraceId, env);
    const resolveRoot = store.projectTraceRegisteredRoot.bind(store); let resolutions = 0;
    store.projectTraceRegisteredRoot = scope => ++resolutions === 1 ? resolveRoot(scope) : null;
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /Project root changed/u);
    store.projectTraceRegisteredRoot = resolveRoot;
    assert.equal(store.projectTraceMigrationReceipt("missing"), null);
    assert.equal((store as unknown as { migrateVerifiedProjectTrace?: unknown }).migrateVerifiedProjectTrace, undefined);
    const sourceFiles = Array.from({ length: 12 }, (_, index) => join(sessions, `session-${index}.jsonl`));
    const originals = sourceFiles.map(path => readFileSync(path, "utf8"));
    sourceFiles.forEach((path, index) => writeFileSync(path, originals[index]!.replace("项目测试", "项目复测")));
    assert.equal((await applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env)).status, "pending");
    assert.equal(store.traceShards.find("trace", legacyTraceId)?.id, legacyTraceId);
    sourceFiles.forEach((path, index) => writeFileSync(path, originals[index]!));
    const backupDir = join(projectStorageDirectory(paths, project), "trace", "migration-backups");
    mkdirSync(backupDir, { recursive: true });
    const backupPath = join(backupDir, `${String(current.source_snapshot_digest).slice(7)}.json`), outside = join(root, "outside");
    writeFileSync(outside, "preserve"); symlinkSync(outside, backupPath);
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env));
    assert.equal(readFileSync(outside, "utf8"), "preserve"); unlinkSync(backupPath);
    const originalMkdir = fs.mkdirSync;
    fs.mkdirSync = ((path, ...args) => { if (String(path) === backupDir) throw Object.assign(new Error("injected permission failure"), { code: "EACCES" }); return originalMkdir(path, ...args); }) as typeof fs.mkdirSync;
    syncBuiltinESMExports();
    try { await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /permission failure/u); }
    finally { fs.mkdirSync = originalMkdir; syncBuiltinESMExports(); }
    assert.equal(store.traceShards.find("trace", legacyTraceId)?.id, legacyTraceId);
    writeFileSync(backupPath, "conflicting backup");
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env));
    assert.equal(readFileSync(backupPath, "utf8"), "conflicting backup"); unlinkSync(backupPath);
    const originalExport = TraceShardStore.prototype.exportTrace;
    TraceShardStore.prototype.exportTrace = function (id) { return this.directory.startsWith(realpathSync(project)) ? { records: [], events: [] } : originalExport.call(this, id); };
    try { await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /readback mismatch/u); }
    finally { TraceShardStore.prototype.exportTrace = originalExport; }
    assert.equal(store.traceShards.find("trace", legacyTraceId)?.id, legacyTraceId);
    const remove = store.traceShards.remove.bind(store.traceShards);
    store.traceShards.remove = () => { throw new Error("injected interruption"); };
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /injected interruption/u);
    store.traceShards.remove = remove;
    const migrated = await applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env);
    assert.equal(store.projectTraceMigrationReceipt("missing"), null);

    assert.equal(migrated.status, "migrated"); assert.equal(existsSync(String(migrated.backup_path)), true);
    assert.equal(store.traceShards.find("trace", legacyTraceId), null);
    assert.equal((kernel.get({ trace_id: legacyTraceId }).events as unknown[]).length, 2);
    assert.equal((await applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env)).idempotent, true);
    store.database.prepare("UPDATE trace_project_migrations SET project_id=? WHERE trace_id=?").run("project:wrong", legacyTraceId);
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /requires reconciliation/u);
    store.database.prepare("UPDATE trace_project_migrations SET project_id=? WHERE trace_id=?").run(String(task.project_scope_id), legacyTraceId);
    store.database.prepare("UPDATE trace_project_migrations SET backup_path=? WHERE trace_id=?").run(project, legacyTraceId);
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /backup must be a regular file/u);
    store.database.prepare("UPDATE trace_project_migrations SET backup_path=? WHERE trace_id=?").run(String(migrated.backup_path), legacyTraceId);
    const internal = store as unknown as { traceStore: (id: string) => { exportTrace: (id: string) => { records: unknown[]; events: unknown[] } } };
    const target = internal.traceStore(legacyTraceId), exportTrace = target.exportTrace.bind(target);
    target.exportTrace = () => ({ records: [], events: [] });
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /target requires reconciliation/u);
    target.exportTrace = exportTrace;
    writeFileSync(String(migrated.backup_path), "tampered");
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env), /backup requires reconciliation/u);
    unlinkSync(String(migrated.backup_path));
    symlinkSync(join(root, "outside"), String(migrated.backup_path));
    await assert.rejects(applyProjectTraceMigration(store, legacyTraceId, String(current.manifest_digest), env));
  } finally { await supervisor.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("file-backed Trace migration retains and reports cold references for reconciliation", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-cold-"));
  const project = join(root, "project"); mkdirSync(project);
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open({ fileRecords: true });
  try {
    store.create("scope_alias", "alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: "project-test" } });
    const kernel = new TraceKernel(store);
    kernel.start({ trace_id: "cold-trace", task_id: "knowledge:task" });
    kernel.append({ trace_id: "cold-trace", event_kind: "action", summary: "retained" });
    const digest = store.projectTraceSourceDigest("cold-trace"); assert.ok(digest);
    let verifiedDigest = digest;
    store.configureProjectTraceMigrationVerifier(async () => ({ status: "ready", trace_id: "cold-trace", project_scope_id: "project-test", project_root: project, source_snapshot_digest: verifiedDigest }));
    const migrated = await store.migrateProjectTrace("cold-trace", "test-manifest");
    assert.equal(migrated.cold_cleanup_status, "pending_reference_reconciliation");
    assert.ok(Number(migrated.cold_files) > 0);
    const backup = JSON.parse(readFileSync(String(migrated.backup_path), "utf8"));
    assert.ok(backup.cold_refs.length > 0);
    for (const ref of backup.cold_refs) assert.equal(existsSync(join(paths.root, ref.path)), true);
    assert.equal((await store.migrateProjectTrace("cold-trace", "test-manifest")).cold_cleanup_status, "pending_reference_reconciliation");
    const invalidBackup = JSON.stringify({ cold_refs: null });
    writeFileSync(String(migrated.backup_path), invalidBackup);
    verifiedDigest = `sha256:${createHash("sha256").update(invalidBackup).digest("hex")}`;
    store.database.prepare("UPDATE trace_project_migrations SET digest=? WHERE trace_id=?").run(verifiedDigest, "cold-trace");
    await assert.rejects(store.migrateProjectTrace("cold-trace", "test-manifest"), /backup requires reconciliation/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Trace migration CLI validates offline apply and reports pending for unknown source", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-cli-"));
  try {
    const script = join(process.cwd(), "scripts", "trace-project-migration-preview.ts");
    const env = { ...process.env, CRAFT_DATA_DIR: root };
    assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, "--trace-id=missing", "--apply"], { env, stdio: "pipe" }));
    const output = execFileSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, "--trace-id=missing"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(JSON.parse(output).status, "pending");
    const applyOutput = execFileSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, "--trace-id=missing", "--apply", "--offline", `--manifest=sha256:${"0".repeat(64)}`], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(JSON.parse(applyOutput).status, "pending");
    assert.throws(() => execFileSync(process.execPath, ["--experimental-strip-types", script, `--data-root=${root}`, "--trace-id=missing", "--offline"], { env, stdio: "pipe" }));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migration owner fails closed on invalid verifier output and missing sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-verifier-"));
  const project = join(root, "project"); mkdirSync(project);
  try {
    for (const [index, response, message] of [
      [0, { status: "ready", trace_id: "wrong", project_scope_id: "project-test", project_root: project, source_snapshot_digest: "sha256:test" }, /verification is invalid/u],
      [3, { status: "ready", trace_id: "trace", project_root: project, source_snapshot_digest: "sha256:test" }, /verification is invalid/u],
      [4, { status: "ready", trace_id: "trace", project_scope_id: "project-test", source_snapshot_digest: "sha256:test" }, /verification is invalid/u],
      [5, { status: "ready", trace_id: "trace", project_scope_id: "project-test", project_root: project }, /verification is invalid/u],
      [1, { status: "ready", trace_id: "trace", project_scope_id: "project-test", project_root: root, source_snapshot_digest: "sha256:test" }, /root changed/u],
      [2, { status: "ready", trace_id: "trace", project_scope_id: "project-test", project_root: project, source_snapshot_digest: "sha256:test" }, /source unavailable/u],
      [6, { status: "ready", trace_id: "trace", project_scope_id: "project-test", project_root: project, source_snapshot_digest: "sha256:test" }, /source changed/u],
    ] as const) {
      const store = await new CraftStore(craftPaths(join(root, `data-${index}`))).open();
      try {
        store.create("scope_alias", "alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: "project-test" } });
        if (index === 6) new TraceKernel(store).start({ trace_id: "trace", task_id: "task" });
        store.configureProjectTraceMigrationVerifier(async () => response);
        assert.throws(() => store.configureProjectTraceMigrationVerifier(async () => response), /already configured/u);
        await assert.rejects(store.migrateProjectTrace("trace", "manifest"), message);
      } finally { store.close(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("Trace cold-reference inventory retains conflicting file identities and missing shards", () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-reference-"));
  const files = new RecordFileStore(root, join(root, "runtime")), shard = new TraceShardStore(root);
  shard.configureRecordFiles(files);
  try {
    assert.deepEqual(shard.exportTrace("missing"), { records: [], events: [] });
    shard.create("trace", "trace", { task_id: "task" });
    shard.appendEvent("trace", "action", {});
    const original = files.referencedFiles.bind(files);
    files.referencedFiles = () => [{ path: "same", digest: "a" }, { path: "same", digest: "b" }, { path: "same" }];
    try {
      assert.deepEqual(shard.traceColdReferences("trace"), [{ path: "same" }, { path: "same", digest: "a" }, { path: "same", digest: "b" }]);
      files.referencedFiles = () => [{ path: "same" }, { path: "same", digest: "b" }, { path: "same", digest: "a" }];
      assert.deepEqual(shard.traceColdReferences("trace"), [{ path: "same" }, { path: "same", digest: "a" }, { path: "same", digest: "b" }]);
    } finally { files.referencedFiles = original; }
  } finally { shard.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Trace migration rejects a symlinked backup directory before writing outside the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-backup-link-"));
  const project = join(root, "project"), outside = join(root, "outside"); mkdirSync(project); mkdirSync(outside);
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: "project-test" } });
    new TraceKernel(store).start({ trace_id: "legacy", task_id: "knowledge:task" });
    const digest = store.projectTraceSourceDigest("legacy"); assert.ok(digest);
    const directory = projectStorageDirectory(paths, project); mkdirSync(directory);
    symlinkSync(outside, join(directory, "trace"));
    store.configureProjectTraceMigrationVerifier(async () => ({ status: "ready", trace_id: "legacy", project_scope_id: "project-test", project_root: project, source_snapshot_digest: digest }));
    await assert.rejects(store.migrateProjectTrace("legacy", "manifest"), /backup directory is unsafe/u);
    assert.equal(existsSync(join(outside, "migration-backups")), false);
    assert.equal(store.traceShards.find("trace", "legacy")?.id, "legacy");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Trace migration refuses a global archived Trace without deleting its live source", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-archived-source-"));
  const project = join(root, "project"); mkdirSync(project);
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open();
  try {
    store.create("scope_alias", "alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: "project-test" } });
    new TraceKernel(store).start({ trace_id: "legacy", task_id: "knowledge:task" });
    store.traceShards.create("trace_archive", "legacy", { trace_id: "legacy" });
    assert.equal(store.projectTraceSourceDigest("legacy"), null);
    store.configureProjectTraceMigrationVerifier(async () => ({ status: "ready", trace_id: "legacy", project_scope_id: "project-test", project_root: project, source_snapshot_digest: "sha256:test" }));
    await assert.rejects(store.migrateProjectTrace("legacy", "manifest"), /source requires reconciliation/u);
    assert.equal(store.traceShards.find("trace", "legacy")?.id, "legacy");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("Trace migration rejects conflicting published owner or receipt without deleting source", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-owner-conflict-"));
  const project = join(root, "project"), other = join(root, "other"); mkdirSync(project); mkdirSync(other);
  try {
    for (const variant of ["owner", "receipt"]) {
      const paths = craftPaths(join(root, `data-${variant}`)), store = await new CraftStore(paths).open();
      try {
        store.create("scope_alias", "alias", { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: "project-test" } });
        store.create("scope_alias", "other", { status: "active", alias_kind: "path", alias: other, scope: { kind: "project", id: "project-other" } });
        new TraceKernel(store).start({ trace_id: "legacy", task_id: "knowledge:task" });
        const digest = store.projectTraceSourceDigest("legacy"); assert.ok(digest);
        store.database.exec("CREATE TABLE trace_project_owners(trace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, root TEXT NOT NULL)");
        if (variant === "owner") store.database.prepare("INSERT INTO trace_project_owners VALUES(?,?,?)").run("legacy", "project-other", realpathSync(other));
        else {
          store.database.exec("CREATE TABLE trace_project_migrations(trace_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, root TEXT NOT NULL, digest TEXT NOT NULL, backup_path TEXT NOT NULL)");
          store.database.prepare("INSERT INTO trace_project_migrations VALUES(?,?,?,?,?)").run("legacy", "project-test", realpathSync(project), "sha256:wrong", "wrong");
        }
        store.configureProjectTraceMigrationVerifier(async () => ({ status: "ready", trace_id: "legacy", project_scope_id: "project-test", project_root: project, source_snapshot_digest: digest }));
        await assert.rejects(store.migrateProjectTrace("legacy", "manifest"), variant === "owner" ? /owner cannot change/u : /receipt conflict/u);
        assert.equal(store.traceShards.find("trace", "legacy")?.id, "legacy");
      } finally { store.close(); rmSync(join(project, ".craft_data"), { recursive: true, force: true }); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a missing index cannot hide an ambiguous child across project Trace shards", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-trace-child-conflict-"));
  const paths = craftPaths(join(root, "data")), store = await new CraftStore(paths).open();
  try {
    const kernel = new TraceKernel(store);
    for (const name of ["one", "two"]) {
      const project = join(root, name); mkdirSync(project);
      store.create("scope_alias", `alias-${name}`, { status: "active", alias_kind: "path", alias: project, scope: { kind: "project", id: name } });
      kernel.start({ trace_id: `trace-${name}`, task_id: name, project_scope_id: name, project_root: project });
    }
    kernel.append({ trace_id: "trace-one", event_id: "duplicate-child", event_kind: "action" });
    const internal = store as unknown as { traceStore: (id: string) => TraceShardStore };
    internal.traceStore("trace-two").create("trace_event", "duplicate-child", { trace_id: "trace-two", event_kind: "action" });
    store.database.prepare("DELETE FROM trace_project_children WHERE kind=? AND id=?").run("trace_event", "duplicate-child");
    assert.throws(() => store.find("trace_event", "duplicate-child"), /ambiguous across project owners/u);
    assert.throws(() => store.findMetadata("trace_event", "duplicate-child"), /ambiguous across project owners/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
