import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";

/** A missing field is legacy only when the bounded complete history also lacks it. */
export function legacyFieldAbsent(store: CraftStore, kind: string, record: JsonObject, field: string): boolean {
  if (typeof record.id !== "string" || !record.id || !Number.isSafeInteger(record.version) || Number(record.version) < 1) return false;
  if (record.version === 1) return true;
  if (Number(record.version) > 102) return false;
  const history = store.history(kind, record.id, Number(record.version), 101);
  return history.length === Number(record.version) - 1 && history.every(item => item[field] === undefined);
}
