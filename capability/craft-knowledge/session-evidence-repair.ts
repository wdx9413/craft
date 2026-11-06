import { linkSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { withContextLockBudget, type CraftStore, type JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../core/digest.ts";
import { knowledgeDirectoryForScope, projectKnowledgeContentDirectory } from "../../core/project-knowledge-content.ts";

/** Repair a bounded page. The original immutable version remains readable. */
export function repairSessionEvidencePage(store: CraftStore, options: { cursor?: string; limit?: number; apply?: boolean } = {},
  io: { link: typeof linkSync; unlink: typeof unlinkSync } = { link: linkSync, unlink: unlinkSync }): JsonObject {
  const page = store.listByIdPage("evidence", options.cursor ?? "", options.limit ?? 100);
  let affected = 0, repaired = 0, blocked = 0;
  for (const record of page.records) {
    const meta = record.metadata as JsonObject | undefined;
    if (meta?.provenance !== "codex_session_program_verification" || !["confirmed", "bounded"].includes(String(record.recorded_confidence))) continue;
    affected++;
    if (typeof meta?.scope !== "string" || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(meta.scope)
      || meta.project_scope_id !== meta.scope || typeof record.identity_digest !== "string") {
      if (options.apply) throw new Error("Session Evidence scope or identity is unavailable");
      blocked++; continue;
    }
    let rootAvailable = false;
    try { rootAvailable = projectKnowledgeContentDirectory(store, meta.scope, { create: false }) !== null; } catch { /* invalid or ambiguous root */ }
    if (!rootAvailable) {
      if (options.apply) throw new Error("Session Evidence project root is unavailable or ambiguous");
      blocked++; continue;
    }
    if (!options.apply) continue;
    const { recorded_confidence: originalConfidence, ...snapshot } = record;
    const backup = { schema: "craft.session-evidence-repair-backup.v1", record: { ...snapshot, confidence: originalConfidence } };
    const bytes = `${JSON.stringify(backup)}\n`, digest = stableDigest(backup);
    const directory = join(knowledgeDirectoryForScope(store, meta.scope), "backups");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Knowledge backup directory must be a regular directory");
    const target = join(directory, `session-evidence-${digest.slice(-32)}.json`), temporary = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      try { io.link(temporary, target); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } finally { try { io.unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
    const backupStat = lstatSync(target);
    if (backupStat.isSymbolicLink() || !backupStat.isFile() || readFileSync(target, "utf8") !== bytes) throw new Error("Session Evidence backup verification failed");
    store.transaction(() => {
      const current = store.get("evidence", String(record.id));
      if (current.version !== record.version || current.identity_digest !== record.identity_digest
        || current.recorded_confidence !== originalConfidence || stableDigest(current.metadata) !== stableDigest(record.metadata)) {
        throw new Error("Session Evidence changed during repair");
      }
      const { recorded_confidence: _recordedConfidence, ...payload } = current;
      store.save("evidence", String(record.id), { ...payload, confidence: "unverified", record_origin: "caller_asserted",
        claim: "调用方提供的脱敏 Codex 任务摘要和测试结果，尚未独立核验。", repair_backup_digest: digest });
    });
    const verified = store.get("evidence", String(record.id));
    if (verified.version !== Number(record.version) + 1 || verified.confidence !== "unverified"
      || verified.recorded_confidence !== undefined || verified.repair_backup_digest !== digest) {
      throw new Error("Session Evidence correction readback failed");
    }
    repaired++;
  }
  return { scanned: page.records.length, affected, repaired, blocked, next_cursor: page.next_cursor, has_more: page.has_more, dry_run: options.apply !== true };
}

/** Recheck the current page immediately before applying; a blocked page never starts writes. */
export function applySessionEvidencePage(store: CraftStore, options: { cursor?: string; limit?: number } = {}): JsonObject {
  const preflight = repairSessionEvidencePage(store, options);
  if (Number(preflight.blocked)) return { status: "blocked", preflight };
  const result = withContextLockBudget(() => repairSessionEvidencePage(store, { ...options, apply: true }));
  return { status: "completed", preflight, result };
}
