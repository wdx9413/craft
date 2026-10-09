import type { JsonObject } from "../../craft-common-store-local/src/store.ts";

export function temporalMemorySelect<T extends JsonObject>(items: readonly T[], now: Date, history: boolean): { selected: T[]; excluded: JsonObject[] } {
  if (!Number.isFinite(now.valueOf())) throw new Error("Memory Context now must be a valid timestamp");
  const groups = new Map<string, T[]>(); const excluded: JsonObject[] = [];
  for (const item of items) {
    if (!history && item.status !== "active") { excluded.push({ memory_id: item.id, reason: "not_current" }); continue; }
    if (item.valid_until !== null && item.valid_until !== undefined) {
      if (typeof item.valid_until !== "string" || !Number.isFinite(Date.parse(item.valid_until))) { excluded.push({ memory_id: item.id, reason: "invalid_valid_until" }); continue; }
      if (!history && Date.parse(item.valid_until) < now.valueOf()) { excluded.push({ memory_id: item.id, reason: "expired" }); continue; }
    }
    const effective = item.effective_from ?? item.updated_at;
    if (effective !== null && effective !== undefined) {
      if (typeof effective !== "string" || !Number.isFinite(Date.parse(effective))) { excluded.push({ memory_id: item.id, reason: "invalid_effective_from" }); continue; }
      if (!history && Date.parse(effective) > now.valueOf()) { excluded.push({ memory_id: item.id, reason: "not_yet_effective" }); continue; }
    }
    const key = typeof item.topic === "string" && item.topic ? item.topic : `entry:${item.id}`;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const selected: T[] = [];
  for (const [topic, group] of groups) {
    const current = group.sort((left, right) => Date.parse(String(right.effective_from ?? right.updated_at ?? "1970-01-01T00:00:00Z")) - Date.parse(String(left.effective_from ?? left.updated_at ?? "1970-01-01T00:00:00Z")) || Number(right.version) - Number(left.version));
    if (!history && new Set(current.map(item => item.content_digest)).size > 1) {
      excluded.push(...current.map((item) => ({ memory_id: item.id, topic, reason: "temporal_conflict_abstain" })));
    } else selected.push(...(history ? current : current.slice(0, 1)));
  }
  return { selected, excluded };
}
