import assert from "node:assert/strict";
import { linkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { KnowledgeClaimGovernance } from "../capability/craft-knowledge/claim-governance.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, withContextLockBudget, type JsonObject } from "../core/infrastructure/store.ts";
import { projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";
import { stableDigest } from "../core/digest.ts";
import { codexTaskGoalDigest } from "../core/codex-task-prose.ts";
import { applySessionEvidencePage, repairSessionEvidencePage } from "../capability/craft-knowledge/session-evidence-repair.ts";
import { preflightSessionEvidencePage } from "../core/session-evidence-repair-preflight.ts";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const input = (): JsonObject => ({ scope: "project:demo", task_id: "task-1", source_session_id: "session-1", turn_id: "turn-1",
  source_ref: sha("a"), task_goal: "修复 Knowledge 证据链。", task_result: "定向验证通过。", sanitized: true,
  verification_artifacts: [{ runner: "javascript", command_digest: sha("b"), result_digest: sha("c"), call_digest: sha("d"),
    exit_code: 0, summary_kind: "tests_passed", content_stored: false }] });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-session-evidence-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project:demo", alias_kind: "path", alias: root });
  return { root, store, service };
}

test("session evidence repair backs up within project scope and appends an idempotent correction", async () => {
  const f = await fixture();
  try {
    const created = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    assert.equal((created.metadata as JsonObject).task_goal_digest, codexTaskGoalDigest(input().task_goal));
    const old = f.store.save("evidence", String(created.id), { ...created, confidence: "confirmed" });
    assert.equal(repairSessionEvidencePage(f.store).affected, 1);
    const originalList = f.store.list.bind(f.store);
    f.store.list = (kind, ...args) => kind === "scope_alias" ? [] : originalList(kind, ...args);
    assert.equal(repairSessionEvidencePage(f.store).blocked, 1);
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }), /project root/u);
    f.store.list = (kind, ...args) => { if (kind === "scope_alias") throw new Error("unavailable"); return originalList(kind, ...args); };
    assert.equal(repairSessionEvidencePage(f.store).blocked, 1);
    f.store.list = originalList;
    assert.equal(f.store.get("evidence", String(created.id)).version, old.version);
    const applied = applySessionEvidencePage(f.store), result = applied.result as JsonObject;
    assert.equal(applied.status, "completed");
    assert.equal(result.affected, 1); assert.equal(result.repaired, 1);
    const current = f.store.get("evidence", String(created.id));
    assert.equal(current.version, Number(old.version) + 1); assert.equal(current.confidence, "unverified");
    assert.equal(current.recorded_confidence, undefined);
    const directory = join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "backups");
    const files = await readdir(directory); assert.equal(files.length, 1);
    const backup = JSON.parse(await readFile(join(directory, files[0]!), "utf8")) as JsonObject;
    assert.deepEqual(backup.record, old, "backup preserves the complete original version for recovery");
    assert.equal((backup.record as JsonObject).confidence, "confirmed");
    assert.equal((backup.record as JsonObject).identity_digest, old.identity_digest);
    assert.equal(current.repair_backup_digest, stableDigest(backup));
    assert.equal(f.store.get("evidence", String(created.id), Number(old.version)).recorded_confidence, "confirmed");
    assert.equal(repairSessionEvidencePage(f.store, { apply: true }).repaired, 0);
    assert.equal((await readdir(directory)).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session evidence repair fails closed on scope drift and concurrent change", async () => {
  const f = await fixture();
  try {
    const created = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(created.id), { ...created, confidence: "confirmed" });
    const originalGet = f.store.get.bind(f.store);
    f.store.get = (kind, id, version) => {
      const current = originalGet(kind, id, version);
      return kind === "evidence" && id === created.id ? { ...current, version: Number(current.version) + 1 } : current;
    };
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }), /changed during repair/u);
    f.store.get = originalGet;
    assert.equal(repairSessionEvidencePage(f.store, { apply: true }).repaired, 1, "verified backup is reused after an interrupted attempt");
    const current = f.store.get("evidence", String(created.id));
    const { recorded_confidence: _confidence, ...payload } = current;
    f.store.save("evidence", String(created.id), { ...payload, confidence: "confirmed", metadata: { ...(payload.metadata as JsonObject), project_scope_id: "project:other" } });
    assert.equal(repairSessionEvidencePage(f.store).blocked, 1);
    assert.equal(applySessionEvidencePage(f.store).status, "blocked");
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }), /scope or identity/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session evidence repair refuses unsafe and corrupted backups and propagates filesystem failures", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    const directory = join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "backups");
    await symlink(f.root, directory, "junction");
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }), /regular directory/u);
    await rm(directory);
    const failure = Object.assign(new Error("link failure"), { code: "EIO" });
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }, { link: () => { throw failure; }, unlink: unlinkSync }), /link failure/u);
    const unlinkFailure = Object.assign(new Error("unlink failure"), { code: "EIO" });
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }, { link: linkSync, unlink: () => { throw unlinkFailure; } }), /unlink failure/u);
    const files = await readdir(directory), target = files.find(name => name.endsWith(".json"))!;
    await writeFile(join(directory, target), "corrupted");
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }), /backup verification failed/u);
    assert.equal(f.store.get("evidence", String(evidence.id)).recorded_confidence, "confirmed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session evidence repair resumes at a stable page cursor", async () => {
  const f = await fixture();
  try {
    for (const task of ["first", "second", "third"]) {
      const evidence = f.service.knowledgeSessionEvidenceRecord({ ...input(), task_id: task }).evidence as JsonObject;
      f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    }
    let cursor: string | undefined, repaired = 0;
    do {
      const result = repairSessionEvidencePage(f.store, { cursor, limit: 1, apply: true });
      repaired += Number(result.repaired); cursor = result.next_cursor as string | undefined;
    } while (cursor);
    assert.equal(repaired, 3);
    assert.equal(repairSessionEvidencePage(f.store).affected, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("read-only preflight pages matching evidence without changing versions", async () => {
  const f = await fixture();
  try {
    for (const task of ["first", "second", "third"]) {
      const evidence = f.service.knowledgeSessionEvidenceRecord({ ...input(), task_id: task }).evidence as JsonObject;
      f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    }
    const before = f.store.list("evidence", 20).map(e => [e.id, e.version]);
    let cursor: string | undefined, affected = 0;
    do {
      const page = preflightSessionEvidencePage(f.store.paths, { cursor, limit: 1 });
      affected += page.affected; assert.equal(page.blocked, 0); cursor = page.next_cursor ?? undefined;
    } while (cursor);
    assert.equal(affected, 3);
    assert.deepEqual(f.store.list("evidence", 20).map(e => [e.id, e.version]), before);
    assert.throws(() => preflightSessionEvidencePage(f.store.paths, { limit: 0 }), /bounds/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("read-only preflight blocks invalid project pointers without opening an unrelated file", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    const db = f.store.database;
    const row = db.prepare("SELECT payload_json,version FROM records WHERE kind='evidence' AND id=? ORDER BY version DESC LIMIT 1").get(String(evidence.id)) as { payload_json: string; version: number };
    const pointer = (JSON.parse(row.payload_json) as JsonObject)._knowledge_partition as JsonObject;
    const update = db.prepare("UPDATE records SET payload_json=? WHERE kind='evidence' AND id=? AND version=?");
    for (const changed of [{ ...pointer, scope: { kind: "global", id: "global" } }, { ...pointer, scope: { kind: "project", id: "missing" } },
      { ...pointer, scope: null }, { ...pointer, file: join(f.root, "other.db") }, { ...pointer, record_id: "missing-record" }]) {
      update.run(JSON.stringify({ _knowledge_partition: changed }), String(evidence.id), row.version);
      assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 1);
    }
    update.run(JSON.stringify({ _knowledge_partition: { ...pointer, scope: { kind: "project", id: "project:demo" } } }), String(evidence.id), row.version);
    assert.equal(preflightSessionEvidencePage(f.store.paths).affected, 1);
    const linked = join(f.root, "database-link"); await symlink(String(pointer.file), linked);
    update.run(JSON.stringify({ _knowledge_partition: { ...pointer, file: linked } }), String(evidence.id), row.version);
    assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 1);
    update.run(row.payload_json, String(evidence.id), row.version);
    const part = new DatabaseSync(String(pointer.file));
    try {
      const original = part.prepare("SELECT payload_json FROM records WHERE kind='evidence' AND id=? AND version=?").get(String(evidence.id), row.version) as { payload_json: string };
      const replace = part.prepare("UPDATE records SET payload_json=? WHERE kind='evidence' AND id=? AND version=?");
      const payload = JSON.parse(original.payload_json) as JsonObject;
      replace.run(JSON.stringify({ ...payload, metadata: { ...(payload.metadata as JsonObject), scope: "project:other" } }), String(evidence.id), row.version);
      assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 1);
      replace.run(JSON.stringify({ ...payload, source_id: "missing-source" }), String(evidence.id), row.version);
      assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 1);
      replace.run("{", String(evidence.id), row.version);
      assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 1);
      replace.run(original.payload_json, String(evidence.id), row.version);
    } finally { part.close(); }
    for (const payload of [{ metadata: { provenance: "other" }, confidence: "confirmed" },
      { metadata: { provenance: "codex_session_program_verification" }, confidence: "confirmed" },
      { metadata: { provenance: "codex_session_program_verification", scope: "project:missing", project_scope_id: "project:missing" }, confidence: "confirmed" },
      { metadata: { provenance: "codex_session_program_verification", scope: "project:demo", project_scope_id: "project:demo" }, confidence: "unverified" }]) {
      update.run(JSON.stringify(payload), String(evidence.id), row.version);
      const result = preflightSessionEvidencePage(f.store.paths);
      assert.equal(result.affected, payload.confidence === "confirmed" && payload.metadata.provenance === "codex_session_program_verification" ? 1 : 0);
    }
    update.run(row.payload_json, String(evidence.id), row.version);
    assert.equal(preflightSessionEvidencePage(f.store.paths).affected, 1);
    const sourceRow = db.prepare("SELECT payload_json,version FROM records WHERE kind='knowledge_source' AND id=? ORDER BY version DESC LIMIT 1").get(String(evidence.source_id)) as { payload_json: string; version: number };
    const sourceHeader = JSON.parse(sourceRow.payload_json) as JsonObject;
    const sourcePointer = sourceHeader._knowledge_partition as JsonObject;
    db.prepare("UPDATE records SET payload_json=? WHERE kind='knowledge_source' AND id=? AND version=?")
      .run(JSON.stringify({ ...sourceHeader, _knowledge_partition: { ...sourcePointer, scope: { kind: "project", id: "project:demo" } } }), String(evidence.source_id), sourceRow.version);
    assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 0);
    db.prepare("UPDATE records SET payload_json=? WHERE kind='knowledge_source' AND id=? AND version=?")
      .run(JSON.stringify({ ...sourceHeader, _knowledge_partition: { ...sourcePointer, scope: { kind: "project", id: "project:other" } } }), String(evidence.source_id), sourceRow.version);
    const conflict = preflightSessionEvidencePage(f.store.paths); assert.equal(conflict.affected, 1); assert.equal(conflict.blocked, 1);
    db.prepare("UPDATE records SET payload_json=? WHERE kind='knowledge_source' AND id=? AND version=?")
      .run(sourceRow.payload_json, String(evidence.source_id), sourceRow.version);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("repair accepts equivalent historical project scope forms without mixing projects", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    const db = f.store.database;
    const source = db.prepare("SELECT payload_json,version FROM records WHERE kind='knowledge_source' AND id=? ORDER BY version DESC LIMIT 1").get(String(evidence.source_id)) as { payload_json: string; version: number };
    const header = JSON.parse(source.payload_json) as JsonObject, pointer = header._knowledge_partition as JsonObject;
    db.prepare("UPDATE records SET payload_json=? WHERE kind='knowledge_source' AND id=? AND version=?")
      .run(JSON.stringify({ ...header, _knowledge_partition: { ...pointer, scope: { kind: "project", id: "project:demo" } } }), String(evidence.source_id), source.version);
    assert.equal(preflightSessionEvidencePage(f.store.paths).blocked, 0);
    assert.equal(repairSessionEvidencePage(f.store, { apply: true }).repaired, 1);
    assert.equal(f.store.get("evidence", String(evidence.id)).confidence, "unverified");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session evidence repair reports readback mismatch after publication", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    const originalGet = f.store.get.bind(f.store);
    f.store.get = (kind, id, version) => {
      const current = originalGet(kind, id, version);
      return kind === "evidence" && current.repair_backup_digest ? { ...current, repair_backup_digest: "changed" } : current;
    };
    assert.throws(() => repairSessionEvidencePage(f.store, { apply: true }), /readback failed/u);
    f.store.get = originalGet;
    assert.equal(repairSessionEvidencePage(f.store, { apply: true }).repaired, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("session evidence repair bounds contention on the primary writer", async () => {
  const f = await fixture(), other = await new CraftStore(craftPaths(f.root)).open({ skipLegacyPartitionMigration: true });
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    f.store.database.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    try {
      assert.throws(() => withContextLockBudget(() => repairSessionEvidencePage(other, { apply: true })), /locked/u);
      assert(performance.now() - started < 2500, "repair must not wait for the normal 15 second timeout");
    } finally { f.store.database.exec("ROLLBACK"); }
    assert.equal(other.get("evidence", String(evidence.id)).recorded_confidence, "confirmed");
    assert.equal(repairSessionEvidencePage(other, { apply: true }).repaired, 1);
  } finally { other.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("repair command executes one isolated page and remains idempotent across processes", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    f.store.close();
    const args = ["--experimental-strip-types", "scripts/session-evidence-repair.ts", "--apply", `--data-root=${f.root}`, "--limit=1"];
    const inspection = spawnSync(process.execPath, args.filter(arg => arg !== "--apply"), { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(inspection.status, 0, inspection.stdout + inspection.stderr);
    assert.equal(JSON.parse(inspection.stdout).preflight.affected, 1);
    const first = spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const firstResult = JSON.parse(first.stdout) as JsonObject;
    assert.equal(firstResult.status, "completed"); assert.equal((firstResult.result as JsonObject).repaired, 1);
    const second = spawnSync(process.execPath, [...args, "--cursor="], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.equal((JSON.parse(second.stdout).result as JsonObject).repaired, 0);
    const check = await new CraftStore(craftPaths(f.root)).open({ skipLegacyPartitionMigration: true });
    try { const saved = check.get("evidence", String(evidence.id)); assert.equal(saved.confidence, "unverified"); assert.equal(typeof saved.repair_backup_digest, "string"); }
    finally { check.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("repair command rejects missing apply and refuses an ambiguous scope before writing", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed",
      metadata: { ...(evidence.metadata as JsonObject), project_scope_id: "project:other" } });
    f.store.close();
    const base = ["--experimental-strip-types", "scripts/session-evidence-repair.ts"];
    const invalid = spawnSync(process.execPath, [...base, "--bogus", `--data-root=${f.root}`], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(invalid.status, 0); assert.match(invalid.stderr, /Usage:/u);
    const invalidBounds = spawnSync(process.execPath, [...base, "--apply", "--limit=0"], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(invalidBounds.status, 0); assert.match(invalidBounds.stderr, /Invalid repair bounds/u);
    const blocked = spawnSync(process.execPath, [...base, "--apply", `--data-root=${f.root}`], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(blocked.status, 2, blocked.stderr);
    const output = JSON.parse(blocked.stdout) as JsonObject;
    assert.equal(output.status, "blocked"); assert.equal((output.preflight as JsonObject).blocked, 1);
    const check = await new CraftStore(craftPaths(f.root)).open({ skipLegacyPartitionMigration: true });
    try { assert.equal(check.get("evidence", String(evidence.id)).recorded_confidence, "confirmed"); }
    finally { check.close(); }
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("stores sanitized verification evidence as a project Knowledge fragment readable by semantic review", async () => {
  const f = await fixture();
  try {
    const saved = f.service.knowledgeSessionEvidenceRecord(input());
    const evidence = saved.evidence as JsonObject;
    assert.equal(evidence.record_origin, "caller_asserted", "input digests alone do not prove a real test execution");
    assert.equal(evidence.source_type, "program");
    assert.equal(evidence.confidence, "unverified");
    f.store.create("task", "readiness-task", {});
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: "readiness-task", effect: "read_only", evidence_ids: [evidence.id],
      platform: "test", host: "test", environment_digest: "test" }), /confirmed Evidence/u);
    assert.equal(evidence.source_id, saved.source_id);
    assert.equal(evidence.fragment_id, saved.fragment_id);
    assert.equal(saved.sanitized_content_stored, true);
    assert.equal(saved.raw_content_stored, false);
    const fragment = f.store.get("knowledge_fragment", String(saved.fragment_id));
    assert.equal(String((fragment.content_ref as JsonObject).path).startsWith(join(projectStorageDirectory(f.store.paths, f.root), "knowledge", "md") + sep), true);
    assert.equal((fragment.content_ref as JsonObject).scope, "project:demo");
    const claim = f.service.knowledgeClaimSave({ claim_id: "session-claim", kind: "fact", title: "已验证的修复",
      content: "定向验证通过。", scope: "project:demo", source_id: saved.source_id, evidence_ids: [evidence.id] }).claim as JsonObject;
    const packetResult = f.service.knowledgeSemanticReviewPacket({ claim_id: String(claim.id) });
    assert.equal(packetResult.status, "ready");
    assert.equal(packetResult.claim_status, claim.status);
    const packet = packetResult.packet as JsonObject;
    assert.equal("status" in (packet.claim as JsonObject), false, "lifecycle metadata is outside the canonical evidence packet");
    const fragments = packet.evidence_fragments as JsonObject[];
    assert.equal(fragments.length, 1);
    assert.match(String(fragments[0]!.qualification), /不能证明任务结果或实际效果/u);
    assert.match(String(fragments[0]!.content), /修复 Knowledge 证据链/u);
    assert.match(String(fragments[0]!.content), /定向验证通过/u);
    assert.match(String(fragments[0]!.content), /尚未独立核验任务结果或实际效果/u);
    assert.doesNotMatch(String(fragments[0]!.content), /已核验的 Codex 任务证据/u);
    assert.doesNotMatch(String(fragments[0]!.content), /pnpm test/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy evidence keeps its original identity on retry while its confidence is corrected", async () => {
 for (const interrupted of [false, true]) {
  const f = await fixture();
  try {
    f.service.knowledgeSessionEvidenceRecord({ ...input(), task_id: "bootstrap-source" });
    const a = input(), artifact = (a.verification_artifacts as JsonObject[])[0]!;
    const body = ["# 已核验的 Codex 任务证据", "", `- 项目范围：${a.scope}`, `- 来源会话：${a.source_session_id}`, `- 来源任务：${a.task_id}`,
      `- 来源回合：${a.turn_id}`, `- 来源摘要：${a.source_ref}`, "", "## 任务目标", a.task_goal, "", "## 任务结果", a.task_result, "",
      "## 自动化验证", `- 验证 1：${artifact.runner}；通过；命令摘要 ${artifact.command_digest}；结果摘要 ${artifact.result_digest}；调用摘要 ${artifact.call_digest}`, ""].join("\n");
    const identity = { schema: "craft.knowledge-session-evidence.v1", scope: a.scope, task_id: a.task_id, source_session_id: a.source_session_id,
      turn_id: a.turn_id, source_ref: a.source_ref, task_goal: a.task_goal, task_result: a.task_result,
      artifact_digest: stableDigest(a.verification_artifacts), body_digest: stableDigest(body) };
    const suffix = stableDigest(identity).slice(-24), evidenceId = `evidence_codex_session_verification_${suffix}`;
    const sourceId = `knowledge_source_codex_session_${stableDigest(a.scope).slice(-24)}`, fragmentId = `knowledge_fragment_codex_session_${suffix}`;
    if (interrupted) {
      const revisionId = `knowledge_source_revision_codex_session_${suffix}`;
      const revisionIdentity = { source_id: sourceId, source_version: f.store.get("knowledge_source", sourceId).version, source_revision_digest: stableDigest(body) };
      f.store.create("knowledge_source_revision", revisionId, { ...revisionIdentity, identity_digest: stableDigest(revisionIdentity),
        locator_digest: "unused", file_count: 1, status: "current", immutable: true });
    } else {
      f.store.create("evidence", evidenceId, { identity_digest: stableDigest({ ...identity, source_id: sourceId, fragment_id: fragmentId, evidence_id: evidenceId }),
        confidence: "confirmed", source_id: sourceId, fragment_id: fragmentId, metadata: { provenance: "codex_session_program_verification" } });
    }
    const result = f.service.knowledgeSessionEvidenceRecord(a);
    assert.equal((result.evidence as JsonObject).id, evidenceId);
    assert.equal((result.evidence as JsonObject).confidence, "unverified");
    assert.equal(result.fragment_id, fragmentId);
    const claim = f.service.knowledgeClaimSave({ claim_id: "legacy-packet", kind: "fact", content: "定向验证通过。",
      scope: a.scope, source_id: sourceId, evidence_ids: [evidenceId] }).claim as JsonObject;
    const packet = f.service.knowledgeSemanticReviewPacket({ claim_id: claim.id }).packet as JsonObject;
    const fragment = (packet.evidence_fragments as JsonObject[])[0]!;
    assert.match(String(fragment.content), /已核验的 Codex 任务证据/u);
    assert.match(String(fragment.qualification), /不能证明任务结果或实际效果/u);
    assert.equal((f.service.knowledgeSessionEvidenceRecord(a).evidence as JsonObject).id, evidenceId);
    assert.equal(f.store.list("evidence", 20).filter(item => item.id === evidenceId).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
 }
});

test("Knowledge claim governance exposes the session Evidence writer", async () => {
  const f = await fixture();
  try {
    const result = new KnowledgeClaimGovernance(f.store).knowledgeSessionEvidenceRecord(input());
    const evidence = result.evidence as JsonObject;
    assert.equal(evidence.source_type, "program");
    assert.equal(evidence.confidence, "unverified");
    assert.equal(result.raw_content_stored, false);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("retries are idempotent and persist evidence only in the exact project scope", async () => {
  const f = await fixture();
  try {
    const first = f.service.knowledgeSessionEvidenceRecord(input());
    const again = f.service.knowledgeSessionEvidenceRecord(input());
    assert.equal(again.evidence_id, undefined);
    assert.equal(again.evidence && (again.evidence as JsonObject).id, (first.evidence as JsonObject).id);
    assert.equal(again.source_id, first.source_id);
    assert.equal(again.fragment_id, first.fragment_id);
    assert.equal(f.store.list("knowledge_fragment", 20).filter(item => item.id === first.fragment_id).length, 1);
    assert.equal(f.store.list("evidence", 20).filter(item => item.id === (first.evidence as JsonObject).id).length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("an untagged legacy session Evidence remains ineligible after an idempotent retry", async () => {
  const f = await fixture();
  try {
    const saved = f.service.knowledgeSessionEvidenceRecord(input());
    const evidence = saved.evidence as JsonObject, { record_origin: _origin, ...legacy } = evidence;
    f.store.save("evidence", String(evidence.id), { ...legacy, confidence: "confirmed" });
    const id = String(evidence.id);
    const legacyVersion = Number(f.store.get("evidence", id).version);
    for (const projected of [f.store.get("evidence", id), f.store.findMany("evidence", [id])[0], f.store.list("evidence", 20).find(item => item.id === id),
      f.store.listByIdPage("evidence", "", 20).records.find(item => item.id === id)]) {
      assert.equal(projected?.confidence, "unverified"); assert.equal(projected?.recorded_confidence, "confirmed");
    }
    f.store.create("task", "legacy-readiness-task", {});
    assert.throws(() => f.service.runtimeReadinessAssess({ task_id: "legacy-readiness-task", effect: "read_only", evidence_ids: [id],
      platform: "test", host: "test", environment_digest: "test" }), /confirmed Evidence/u);
    const retried = f.service.knowledgeSessionEvidenceRecord(input());
    assert.equal((retried.evidence as JsonObject).record_origin, "caller_asserted");
    assert.equal((retried.evidence as JsonObject).confidence, "unverified");
    assert.equal((retried.evidence as JsonObject).recorded_confidence, undefined);
    assert.equal(f.store.get("evidence", id, legacyVersion).confidence, "unverified");
    assert.equal(f.store.get("evidence", id, legacyVersion).recorded_confidence, "confirmed");
    const claim = f.service.knowledgeClaimSave({ claim_id: "legacy-session-claim", kind: "fact", content: "定向验证通过。",
      scope: "project:demo", source_id: saved.source_id, evidence_ids: [evidence.id] }).claim as JsonObject;
    assert.throws(() => f.service.knowledgeClaimSupportRecord({ claim_id: claim.id, evidence_id: evidence.id, observation_key: "legacy-observation" }), /bounded or confirmed/u);
    const assessment = (f.service.knowledgeAutoReview({ scope_kind: "project", scope_id: "demo", claim_ids: [claim.id] }).assessments as JsonObject[])[0]!;
    assert.equal(assessment.independent_support, 0); assert.equal(assessment.promoted, false);
    assert((assessment.reasons as string[]).includes("credible_evidence_missing"));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("bounded legacy session Evidence is projected as unverified while unrelated Evidence is unchanged", async () => {
  const f = await fixture();
  try {
    const saved = f.service.knowledgeSessionEvidenceRecord(input()), evidence = saved.evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "bounded" });
    const projected = f.store.get("evidence", String(evidence.id));
    assert.equal(projected.confidence, "unverified"); assert.equal(projected.recorded_confidence, "bounded");
    const other = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "unrelated", metadata: { provenance: "other" } });
    assert.equal(f.store.get("evidence", String(other.id)).confidence, "confirmed");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("legacy confidence correction respects a concurrent correction and rejects identity drift", async () => {
  const f = await fixture();
  try {
    const evidence = f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject;
    f.store.save("evidence", String(evidence.id), { ...evidence, confidence: "confirmed" });
    const originalGet = f.store.get.bind(f.store);
    f.store.get = (kind, id, version) => {
      const current = originalGet(kind, id, version);
      return kind === "evidence" && id === evidence.id ? { ...current, identity_digest: "changed" } : current;
    };
    assert.throws(() => f.service.knowledgeSessionEvidenceRecord(input()), /changed during confidence correction/u);
    f.store.get = (kind, id, version) => {
      const current = originalGet(kind, id, version);
      if (kind !== "evidence" || id !== evidence.id) return current;
      const { recorded_confidence: _reported, ...corrected } = current;
      return { ...corrected, confidence: "unverified" };
    };
    assert.equal((f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject).confidence, "unverified");
    f.store.get = originalGet;
    assert.equal((f.service.knowledgeSessionEvidenceRecord(input()).evidence as JsonObject).confidence, "unverified");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("rejects missing verification, wrong scope, unsanitized text and malformed artifacts before writing", async () => {
  const f = await fixture();
  try {
    const invalid: JsonObject[] = [
      { ...input(), sanitized: false },
      { ...input(), task_id: undefined },
      { ...input(), task_id: "   " },
      { ...input(), task_id: "x".repeat(161) },
      { ...input(), task_id: "task\nid" },
      { ...input(), scope: "global" },
      { ...input(), source_ref: "not-a-digest" },
      { ...input(), task_goal: "token=abcdefgh12345678" },
      { ...input(), task_result: "https://example.invalid/secret" },
      { ...input(), task_goal: "contact me@example.com" },
      { ...input(), task_goal: "local /Users/alice/project" },
      { ...input(), task_goal: "host 192.168.1.2" },
      { ...input(), task_goal: "password: hidden" },
      { ...input(), observed_at: "not-a-time" },
      { ...input(), verification_artifacts: [] },
      { ...input(), verification_artifacts: new Array(9).fill((input().verification_artifacts as JsonObject[])[0]) },
      { ...input(), verification_artifacts: [null] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], runner: "shell" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], command_digest: "bad" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], result_digest: "bad" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], call_digest: "bad" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], exit_code: 1 }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], summary_kind: "other" }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], content_stored: true }] },
      { ...input(), verification_artifacts: [{ ...(input().verification_artifacts as JsonObject[])[0], raw_output: "private output" }] },
    ];
    for (const args of invalid) assert.throws(() => f.service.knowledgeSessionEvidenceRecord(args));
    assert.equal(f.store.list("evidence", 20).length, 0);
    assert.equal(f.store.list("knowledge_fragment", 20).length, 0);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("fails closed when the deterministic project source is disabled or an evidence identity is corrupted", async () => {
  const f = await fixture();
  try {
    const first = f.service.knowledgeSessionEvidenceRecord(input());
    const sourceId = String(first.source_id);
    const source = f.store.get("knowledge_source", sourceId);
    f.store.save("knowledge_source", sourceId, { ...source, status: "disabled" });
    assert.throws(() => f.service.knowledgeSessionEvidenceRecord({ ...input(), task_id: "task-2" }), /not active/u);
    const disabledSource = f.store.get("knowledge_source", sourceId);
    f.store.save("knowledge_source", sourceId, { ...disabledSource, status: "active" });
    const evidenceId = String((first.evidence as JsonObject).id);
    const evidence = f.store.get("evidence", evidenceId);
    f.store.save("evidence", evidenceId, { ...evidence, identity_digest: "corrupt" });
    assert.throws(() => f.service.knowledgeSessionEvidenceRecord(input()), /idempotency conflict/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
