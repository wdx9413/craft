import type { CraftStore, JsonObject } from "./store.ts";

const KINDS = ["memory_ledger", "knowledge_source", "knowledge_claim", "knowledge_document", "experience_procedure", "experience_release", "scope_alias"];
export type ContextReadRef = { kind: string; id: string; version: number };

/** Store revisions are immutable: an ACL, status or content change must publish a new revision. */
export class ContextAccessChangedError extends Error {
  constructor() { super("Context authorization or material state changed during recall; reopen Context"); this.name = "ContextAccessChangedError"; }
}

export function assertContextReadCurrent(store: CraftStore, receipt: JsonObject | null | undefined): void {
  const refs = (receipt?.read_refs ?? []) as ContextReadRef[];
  if (!refs.length) return;
  // All bounded batches share one publication point, including standalone SDK reads.
  // Never retain this short lock across retrieval/provider awaits.
  store.transaction(() => {
    for (let offset = 0; offset < refs.length; offset += 250) {
      const part = refs.slice(offset, offset + 250);
      const changed = store.database.prepare(`WITH pinned(kind,id,version) AS (VALUES ${part.map(() => "(?,?,?)").join(",")}) SELECT 1 FROM pinned p WHERE COALESCE((SELECT MAX(r.version) FROM records r WHERE r.kind=p.kind AND r.id=p.id),0)<>p.version LIMIT 1`).get(...part.flatMap(ref => [ref.kind, ref.id, ref.version]));
      if (changed) throw new ContextAccessChangedError();
    }
  });
}

/** Read only revision headers; never hydrate unrelated bodies or hold a write lock across awaits. */
export class ContextReadGuard {
  readonly store: CraftStore;
  private readonly initial = new Map<string, number>();
  private readonly tracked = new Map<string, ContextReadRef>();
  constructor(store: CraftStore, refs?: readonly ContextReadRef[], scopes?: readonly { kind: string; id: string }[], sourceIds: readonly string[] = []) {
    this.store = store;
    if (refs !== undefined) {
      for (const ref of refs) this.initial.set(`${ref.kind}:${ref.id}`, ref.version);
      return;
    }
    const scopeSql = `EXISTS (SELECT 1 FROM json_each(?) s WHERE
      json_extract(payload_json,'$.scope')=CASE WHEN json_extract(s.value,'$.kind')='global' THEN 'global' ELSE json_extract(s.value,'$.kind')||':'||json_extract(s.value,'$.id') END
      OR (json_extract(payload_json,'$.scope.kind')=json_extract(s.value,'$.kind') AND json_extract(payload_json,'$.scope.id')=json_extract(s.value,'$.id')))`;
    const rows = scopes?.length ? store.database.prepare(`WITH relevant AS (
      SELECT kind,id,payload_json FROM records WHERE kind IN ('memory_ledger','knowledge_claim','experience_procedure') AND (${scopeSql})
    ), wanted(kind,id) AS (
      SELECT kind,id FROM relevant
      UNION SELECT 'knowledge_source',json_extract(payload_json,'$.source_id') FROM relevant
      UNION SELECT 'knowledge_document',json_extract(payload_json,'$.document_id') FROM relevant
      UNION SELECT 'experience_release',id FROM relevant WHERE kind='experience_procedure'
      UNION SELECT kind,id FROM records WHERE kind='scope_alias' AND (${scopeSql})
      UNION SELECT 'knowledge_source',value FROM json_each(?)
    ) SELECT r.kind,r.id,MAX(r.version) version FROM records r JOIN wanted w ON w.kind=r.kind AND w.id=r.id GROUP BY r.kind,r.id`).all(JSON.stringify(scopes), JSON.stringify(scopes), JSON.stringify(sourceIds))
      : store.database.prepare(`SELECT kind,id,MAX(version) version FROM records WHERE kind IN (${KINDS.map(() => "?").join(",")}) GROUP BY kind,id`).all(...KINDS);
    for (const row of rows) this.initial.set(`${row.kind}:${row.id}`, Number(row.version));
  }
  track(kind: string, id: string, expectedVersion?: number): void {
    const key = `${kind}:${id}`, version = this.initial.get(key) ?? 0;
    if (expectedVersion !== undefined && expectedVersion !== version || (this.store.find(kind, id, undefined, false)?.version ?? 0) !== version) throw new ContextAccessChangedError();
    this.tracked.set(key, { kind, id, version });
  }
  contribution(member: string, item: JsonObject): void {
    const kind = member === "knowledge" ? "knowledge_claim" : "experience_procedure";
    const id = item.claim_id ?? item.procedure_id;
    if (typeof id !== "string") return; // External providers retain their own authority contract.
    this.track(kind, id);
    const record = this.store.find(kind, id, undefined, false);
    if (!record) return;
    if (typeof record.source_id === "string") this.track("knowledge_source", record.source_id);
    if (typeof record.document_id === "string") this.track("knowledge_document", record.document_id);
    if (member === "experience") this.track("experience_release", id);
  }
  refs(): ContextReadRef[] { return [...this.tracked.values()].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)); }
  assertCurrent(): void { assertContextReadCurrent(this.store, { read_refs: this.refs() }); }
}
