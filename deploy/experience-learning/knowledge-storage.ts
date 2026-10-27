import { lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicPrivateJson, craftPaths, dataRoot } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import type { KnowledgeLearningClient } from "./knowledge-sync.ts";

const SCHEMA = "craft.knowledge-storage-cursor.v1";
const CURSOR = /^[A-Za-z0-9_-]{1,4096}$/u;

/** One background-owned page; frontend initialization never drains legacy Knowledge. */
export async function runKnowledgeStorageReconcileOnce(client: KnowledgeLearningClient, stateFile = join(craftPaths(dataRoot()).knowledgeDir, "storage-migration-state.json")): Promise<JsonObject> {
  let cursor: string | null = null;
  try {
    const parent = lstatSync(dirname(stateFile));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Knowledge storage state directory must be regular");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try {
    const stat = lstatSync(stateFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) throw new Error("Knowledge storage state file is invalid");
    const state = JSON.parse(readFileSync(stateFile, "utf8")) as JsonObject;
    if (state.schema !== SCHEMA || state.cursor !== null && (typeof state.cursor !== "string" || !CURSOR.test(state.cursor))) throw new Error("Knowledge storage state is invalid");
    cursor = state.cursor as string | null;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const result = await client.call("craft_knowledge_storage_reconcile", { max_records: 500, summary_only: true, ...(cursor ? { cursor } : {}) });
  const summaryOnly = result.summary_only === true;
  const hasBlockedReasons = result.blocked_reasons !== null && typeof result.blocked_reasons === "object" && !Array.isArray(result.blocked_reasons);
  const blockedCount = Number(summaryOnly ? result.blocked_count : Array.isArray(result.blocked) ? result.blocked.length : -1);
  const blockedReasons = summaryOnly && hasBlockedReasons
    ? Object.values(result.blocked_reasons as JsonObject).map(Number) : [];
  if (!["partial", "completed"].includes(String(result.status)) || !Array.isArray(result.blocked) || typeof result.has_more !== "boolean"
    || !Number.isSafeInteger(result.examined) || Number(result.examined) < 0 || Number(result.examined) > 500
    || !Number.isSafeInteger(result.migrated) || Number(result.migrated) < 0 || Number(result.migrated) > Number(result.examined)
    || !Number.isSafeInteger(result.skipped) || Number(result.skipped) < 0 || Number(result.skipped) > Number(result.examined)
    || result.phase !== undefined && !["records", "content"].includes(String(result.phase))
    || result.retired_content !== undefined && (!Number.isSafeInteger(result.retired_content) || Number(result.retired_content) < 0 || Number(result.retired_content) > Number(result.examined))
    || !Number.isSafeInteger(blockedCount) || blockedCount < 0 || blockedCount > Number(result.examined)
    || summaryOnly && (!hasBlockedReasons || result.blocked.length !== 0 || !blockedReasons.every(count => Number.isSafeInteger(count) && count >= 0)
      || blockedReasons.reduce((sum, count) => sum + count, 0) !== blockedCount)
    || !summaryOnly && result.blocked.length !== blockedCount || result.dry_run === true
    || !result.has_more && result.next_cursor !== null
    || result.has_more && (typeof result.next_cursor !== "string" || !CURSOR.test(result.next_cursor) || result.next_cursor === cursor)) throw new Error("Knowledge storage migration returned an invalid page");
  const next = result.has_more ? result.next_cursor as string : null;
  if (next !== cursor) {
    try { const parent = lstatSync(dirname(stateFile)); if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Knowledge storage state directory must be regular"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await atomicPrivateJson(stateFile, { schema: SCHEMA, cursor: next, updated_at: new Date().toISOString() });
  }
  return { status: result.status, examined: result.examined, migrated: result.migrated, skipped: result.skipped,
    ...(result.phase !== undefined ? { phase: result.phase } : {}), ...(result.retired_content !== undefined ? { retired_content: result.retired_content } : {}),
    blocked_count: blockedCount, has_more: result.has_more, raw_content_stored: false };
}
