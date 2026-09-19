import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "../../src/infrastructure/store.ts";
import { text } from "../../src/validation.ts";
import { stableDigest, payload } from "../../src/digest.ts";

/**
 * Typed relations between addressable knowledge objects.
 *
 * The Wiki layer already has `knowledge_relation`, but it is hard-wired to
 * `knowledge_claim` endpoints and stores only `{from_claim_id, to_claim_id}`. A
 * shared context plane needs to relate *anything* addressable — a claim, a
 * memory, a knowledge document, an evidence record — because "this note
 * supersedes that one" crosses object kinds. So this kernel generalises the
 * endpoints to `{kind, id, version}` while keeping the same idea.
 *
 * Two deliberate bounds, matching the rest of the repository:
 *
 * 1. Traversal is bounded. `max_depth` is capped at 3 and cycles are detected
 *    by a visited set; an unbounded walk over a graph an agent can author is a
 *    denial-of-service waiting to happen.
 * 2. Invalidation is soft. `retract` sets `valid_to` instead of deleting, so
 *    "what did we believe in March?" stays answerable. This is why queries take
 *    an optional `as_of` — the same edge can be live in one snapshot and dead in
 *    another.
 */

const RELATION_KINDS = new Set(["derives_from", "supersedes", "contradicts", "supports", "refines", "references"]);
const ENDPOINT_KINDS = new Set(["knowledge_claim", "memory_ledger", "knowledge_document", "knowledge_chunk", "evidence", "capability", "wiki_page"]);
const CONFIDENCES = new Set(["confirmed", "bounded", "unverified"]);
const MAX_DEPTH_LIMIT = 3;
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function integer(value: unknown, name: string, minimum: number, maximum: number): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}
function strings(value: unknown, name: string, required = false): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return [...result].sort();
}

function noSecret(value: string, name: string): string { if (SECRET.test(value)) throw new Error(`${name} must not contain credentials or secrets`); return value; }
function instant(value: unknown, name: string): string { const result = new Date(text(value, name)); if (Number.isNaN(result.valueOf())) throw new Error(`${name} must be an ISO timestamp`); return result.toISOString(); }
function endpoint(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const record = value as JsonObject; const kind = text(record.kind, `${name}.kind`);
  if (!ENDPOINT_KINDS.has(kind)) throw new Error(`${name}.kind is unsupported`);
  return { kind, id: text(record.id, `${name}.id`), version: record.version === undefined ? null : integer(record.version, `${name}.version`, 1, Number.MAX_SAFE_INTEGER) };
}
/** Live at `at`: started before, and (if it ever ends) not yet ended. */
function liveAt(record: JsonObject, at: number): boolean {
  if (Date.parse(String(record.valid_from)) > at) return false;
  return record.valid_to === null || Date.parse(String(record.valid_to)) > at;
}
const NODE_KEY = (kind: string, id: string, version: number | null): string => `${kind}:${id}@${version ?? "latest"}`;

export class KnowledgeRelationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /** Open questions are cheap and read-only; they never resolve an endpoint record. */
  neighbors(args: JsonObject): JsonObject {
    const root = endpoint(args.node ?? { kind: args.kind, id: args.id, version: args.version }, "node");
    return { node: root, relations: this.edges({ node: root, direction: args.direction, relation: args.relation, as_of: args.as_of, limit: args.limit }) };
  }

  relate(args: JsonObject): JsonObject {
    const source = endpoint(args.source, "source"); const target = endpoint(args.target, "target");
    if (source.kind === target.kind && source.id === target.id) throw new Error("Relation endpoints must differ");
    const relation = text(args.relation, "relation"); if (!RELATION_KINDS.has(relation)) throw new Error("Knowledge relation is unsupported");
    const confidence = text(args.confidence ?? "bounded", "confidence"); if (!CONFIDENCES.has(confidence)) throw new Error("Relation confidence is unsupported");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids"); evidenceIds.forEach((item) => this.store.get("evidence", item));
    if (confidence === "confirmed" && !evidenceIds.length) throw new Error("Confirmed Knowledge Relation requires Evidence");
    const validFrom = instant(args.valid_from ?? new Date().toISOString(), "valid_from");
    // Idempotency keys on what the caller *stated*, not on the clock we defaulted.
    // Hashing the defaulted `valid_from` would make every replay a fresh edge and
    // defeat the check exactly when a retrying client needs it.
    const identity = { source, target, relation, evidence_ids: evidenceIds, confidence };
    const relationId = String(args.relation_id ?? `knowledge_relation_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("knowledge_relation", relationId);
    if (existing) { if (existing.identity_digest !== stableDigest(identity)) throw new Error("Knowledge Relation idempotency conflict"); return { relation: existing, idempotent: true }; }
    return { relation: this.store.create("knowledge_relation", relationId, {
      ...identity, valid_from: validFrom, identity_digest: stableDigest(identity), valid_to: null,
      rationale_digest: args.rationale === undefined ? null : stableDigest(noSecret(text(args.rationale, "rationale"), "rationale")) }), idempotent: false };
  }

  /** Soft invalidation: the edge stops being live, the record survives. */
  retract(args: JsonObject): JsonObject {
    const existing = this.store.get("knowledge_relation", text(args.relation_id, "relation_id"));
    // "Retract now" must never land at or before the edge's own start, or a
    // same-millisecond relate+retract would be rejected as a malformed window.
    const floor = Date.parse(String(existing.valid_from)) + 1;
    const validTo = args.valid_to === undefined && args.now === undefined
      ? new Date(Math.max(Date.now(), floor)).toISOString()
      : instant(args.valid_to ?? args.now, "valid_to");
    if (Date.parse(validTo) <= Date.parse(String(existing.valid_from))) throw new Error("Knowledge Relation valid_to must be after valid_from");
    return { relation: this.store.save("knowledge_relation", String(existing.id), { ...payload(existing), valid_to: validTo,
      retract_reason_digest: stableDigest(noSecret(text(args.reason, "reason"), "reason")) }) };
  }

  get(args: JsonObject): JsonObject {
    return { relation: this.store.get("knowledge_relation", text(args.relation_id, "relation_id"), args.version === undefined ? undefined : integer(args.version, "version", 1, Number.MAX_SAFE_INTEGER)) };
  }

  /**
   * Bounded multi-hop walk.
   *
   * Depth is clamped to `MAX_DEPTH_LIMIT` rather than trusted, and the visited
   * set is keyed by endpoint identity so a cycle (A supports B, B supports A)
   * terminates instead of expanding forever. Nodes already visited are returned
   * as part of the path but not re-expanded — that is what keeps the result a
   * tree rather than an explosion.
   */
  traverse(args: JsonObject): JsonObject {
    const root = endpoint(args.node ?? { kind: args.kind, id: args.id, version: args.version }, "node");
    const maxDepth = integer(args.max_depth ?? 2, "max_depth", 1, MAX_DEPTH_LIMIT);
    const direction = args.direction === "inverse" ? "inverse" : args.direction === "both" ? "both" : "forward";
    const relation = args.relation === undefined ? null : text(args.relation, "relation");
    if (relation !== null && !RELATION_KINDS.has(relation)) throw new Error("Knowledge relation is unsupported");
    const asOf = args.as_of === undefined ? Date.now() : Date.parse(instant(args.as_of, "as_of"));
    const limit = integer(args.limit ?? 100, "limit", 1, 1_000);
    const nodes: JsonObject[] = [{ node: root, depth: 0, path: [NODE_KEY(String(root.kind), String(root.id), root.version as number | null)] }];
    const edges: JsonObject[] = []; const visited = new Set<string>([NODE_KEY(String(root.kind), String(root.id), root.version as number | null)]);
    let frontier: JsonObject[] = [root]; let truncated = false;
    for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
      const next: JsonObject[] = [];
      for (const node of frontier) {
        for (const edge of this.edges({ node, direction, relation, as_of: asOf === undefined ? null : new Date(asOf).toISOString(), limit: limit })) {
          edges.push({ ...edge, depth });
          const other = String(edge.direction) === "forward" ? edge.target as JsonObject : edge.source as JsonObject;
          const key = NODE_KEY(String(other.kind), String(other.id), other.version as number | null);
          if (visited.has(key)) continue;
          if (nodes.length >= limit) { truncated = true; break; }
          visited.add(key); nodes.push({ node: other, depth, path: [...(nodes.find((item) => item.node === node)?.path as string[] ?? [String(key)]), key] }); next.push(other);
        }
        if (truncated) break;
      }
      if (truncated) break;
      frontier = next;
    }
    return { root, max_depth: maxDepth, nodes, edges, truncated };
  }

  /**
   * One live hop from `node`.
   *
   * Only records that actually resolve to a stored endpoint are returned, so a
   * dangling edge cannot make a caller act on an object that does not exist.
   * Results span both directions and are labelled, which is what lets a caller
   * read "this note is superseded by X" out of a plain `neighbors` call.
   */
  private edges(args: { node: JsonObject; direction?: unknown; relation?: unknown; as_of?: unknown; limit?: unknown }): JsonObject[] {
    const node = args.node as JsonObject; const kind = String(node.kind); const id = String(node.id);
    const direction = args.direction === "inverse" ? "inverse" : args.direction === "forward" ? "forward" : "both";
    const relation = args.relation === undefined || args.relation === null ? null : text(args.relation, "relation");
    if (relation !== null && !RELATION_KINDS.has(relation)) throw new Error("Knowledge relation is unsupported");
    const at = args.as_of === undefined || args.as_of === null ? Date.now() : Date.parse(instant(args.as_of, "as_of"));
    const limit = args.limit === undefined ? 50 : integer(args.limit, "limit", 1, 1_000);
    const matched = this.store.list("knowledge_relation", 10_000, (item) => liveAt(item, at) && (relation === null || item.relation === relation)
      && ((item.source as JsonObject).kind === kind && (item.source as JsonObject).id === id || (item.target as JsonObject).kind === kind && (item.target as JsonObject).id === id))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const resolved: JsonObject[] = [];
    for (const record of matched) {
      const source = record.source as JsonObject; const target = record.target as JsonObject;
      const forward = source.kind === kind && source.id === id;
      if (direction === "forward" && !forward) continue;
      if (direction === "inverse" && forward) continue;
      const other = forward ? target : source;
      const endpointRecord = this.store.find(String(other.kind), String(other.id), other.version === null || other.version === undefined ? undefined : Number(other.version));
      if (!endpointRecord) continue;
      resolved.push({ relation_id: record.id, relation: record.relation, direction: forward ? "forward" : "inverse",
        source, target, confidence: record.confidence, valid_from: record.valid_from, valid_to: record.valid_to });
      if (resolved.length >= limit) break;
    }
    return resolved;
  }
}
