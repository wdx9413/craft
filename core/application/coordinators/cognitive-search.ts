import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { KnowledgeIndex, diffKnowledgeBase, scanKnowledgeBase } from "../../knowledge-index.ts";
import type { ContextResolutionKernel } from "../../context-resolution.ts";
import type { KnowledgeRelationKernel } from "../../../capability/craft-knowledge/knowledge-relation.ts";
import { contentReference } from "../../../common/craft-common-store-local/src/content-store.ts";
import { knowledgeScenarioIsActive, listKnowledgeScenarios, proposeKnowledgeScenarioMigration, retireKnowledgeScenario } from "../../../capability/craft-knowledge/scenario-catalog.ts";
import { array, finiteInteger, object, text } from "../../validation.ts";

/** Owns local diagnostic projections and the loop's governed Memory read path. */
export class CognitiveSearchCoordinator {
  readonly store: CraftStore;
  readonly contextResolution: ContextResolutionKernel;
  readonly knowledgeRelations: KnowledgeRelationKernel;
  constructor(store: CraftStore, contextResolution: ContextResolutionKernel, knowledgeRelations: KnowledgeRelationKernel) {
    this.store = store; this.contextResolution = contextResolution; this.knowledgeRelations = knowledgeRelations;
  }

  private knowledgeIndex(): KnowledgeIndex { return new KnowledgeIndex(this.store.paths.knowledgeIndex ?? `${this.store.paths.root}/knowledge-index.sqlite`); }
  knowledgeIndexSync(args: JsonObject): JsonObject {
    const root = text(args.project_root, "project_root");
    const index = this.knowledgeIndex();
    try {
      const current = scanKnowledgeBase(root, { limit: args.limit === undefined ? undefined : finiteInteger(args.limit, "limit", 1, 1, 2000) });
      const previous = index.catalog();
      const plan = diffKnowledgeBase(previous, current);
      const result = index.apply(plan, root);
      return { ...result, plan: { added: plan.added.length, changed: plan.changed.length, removed: plan.removed.length } };
    } finally { index.close(); }
  }
  knowledgeSearch(args: JsonObject): JsonObject {
    const query = text(args.query, "query");
    const scope = args.scope === undefined
      ? args.scope_kind !== undefined && args.scope_id !== undefined ? `${text(args.scope_kind, "scope_kind")}:${text(args.scope_id, "scope_id")}` : null
      : text(args.scope, "scope");
    const scenarioKey = args.scenario_key === undefined ? null : text(args.scenario_key, "scenario_key");
    if (scenarioKey !== null && !/^[a-z0-9][a-z0-9._/-]{0,95}$/u.test(scenarioKey)) throw new Error("scenario_key must be a bounded stable identifier");
    const scenarioParts = scope?.split(":") ?? [];
    const scenarioActive = scenarioKey === null || scenarioParts[0] === "project"
      && knowledgeScenarioIsActive(this.store.paths.knowledgeDir, scenarioParts.slice(1).join(":"), scenarioKey);
    const includeCandidates = args.include_candidates !== false;
    const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
    const governed = this.store.list("knowledge_claim", 10_000).flatMap((claim) => {
      if (claim.sensitivity === "restricted" && args.allow_restricted !== true) return [];
      if (claim.status !== "reviewed" && (!includeCandidates || claim.status !== "candidate")) return [];
      if (scope !== null && claim.scope !== "global" && claim.scope !== scope) return [];
      if (scenarioKey !== null && (!scenarioActive || claim.scenario_key !== scenarioKey && claim.coarse_scenario_key !== scenarioKey)) return [];
      if (claim.valid_until !== undefined && claim.valid_until !== null
        && (typeof claim.valid_until !== "string" || !Number.isFinite(Date.parse(claim.valid_until)) || Date.parse(claim.valid_until) < Date.now())) return [];
      if (claim.content_ref && !contentReference(claim.content_ref)) throw new Error("Knowledge content reference is invalid");
      const content = contentReference(claim.content_ref) ? this.store.contentStore.readCompatSync(claim.content_ref).body : String(claim.content ?? "");
      const score = terms.reduce((total, term) => total + Number(`${content} ${Array.isArray(claim.tags) ? claim.tags.join(" ") : ""}`.toLowerCase().includes(term)), 0);
      return score > 0 ? [{ kind: "governed_claim", claim_id: claim.id, claim_version: claim.version, status: claim.status,
        scope: claim.scope, content, content_digest: claim.content_digest, evidence_ids: claim.evidence_ids,
        score, relations: this.relationSummary(`claim:${String(claim.id)}`) }] : [];
    });
    const index = this.knowledgeIndex();
    try {
      const limit = args.limit === undefined ? 20 : finiteInteger(args.limit, "limit", 1, 1, 100);
      const indexed = scenarioKey === null ? index.search(query, { limit }).map((hit) => ({ ...hit, kind: "indexed_document", score: hit.rank, relations: this.relationSummary(hit.path) })) : [];
      const hits = [...governed, ...indexed]
        .sort((left, right) => Number(right.score) - Number(left.score) || JSON.stringify(left).localeCompare(JSON.stringify(right)))
        .slice(0, limit);
      return { hits, queried_governed_claims: true, include_candidates: includeCandidates,
        ...(scenarioKey !== null ? { scenario_filter: { scenario_key: scenarioKey, status: scenarioActive ? "active" : "inactive_or_unclassified" } } : {}) };
    }
    finally { index.close(); }
  }

  knowledgeScenarioList(args: JsonObject): JsonObject {
    const scope = text(args.scope ?? `${text(args.scope_kind, "scope_kind")}:${text(args.scope_id, "scope_id")}`, "scope");
    const [kind, ...parts] = scope.split(":");
    if (kind !== "project" || !parts.length) throw new Error("Knowledge scenario catalog requires an explicit project scope");
    return { scope, ...listKnowledgeScenarios(this.store.paths.knowledgeDir, parts.join(":")) };
  }

  knowledgeScenarioRetire(args: JsonObject): JsonObject {
    const scope = text(args.scope ?? `${text(args.scope_kind, "scope_kind")}:${text(args.scope_id, "scope_id")}`, "scope");
    const [kind, ...parts] = scope.split(":");
    if (kind !== "project" || !parts.length) throw new Error("Knowledge scenario retirement requires an explicit project scope");
    return retireKnowledgeScenario({ knowledge_dir: this.store.paths.knowledgeDir, project_id: parts.join(":"),
      scenario_key: text(args.scenario_key, "scenario_key"), expected_catalog_version: finiteInteger(args.expected_catalog_version, "expected_catalog_version", 0, 0),
      request_id: text(args.request_id, "request_id"), reason: text(args.reason, "reason") });
  }

  knowledgeScenarioMigrationPropose(args: JsonObject): JsonObject {
    const scope = text(args.scope ?? `${text(args.scope_kind, "scope_kind")}:${text(args.scope_id, "scope_id")}`, "scope");
    const [kind, ...parts] = scope.split(":");
    if (kind !== "project" || !parts.length) throw new Error("Knowledge scenario migration requires an explicit project scope");
    if (!Array.isArray(args.source_keys) || !Array.isArray(args.targets)) throw new Error("Knowledge scenario migration sources and targets must be arrays");
    return proposeKnowledgeScenarioMigration({ knowledge_dir: this.store.paths.knowledgeDir, project_id: parts.join(":"),
      mode: text(args.mode, "mode") as "merge" | "split", source_keys: args.source_keys as string[], targets: args.targets as Array<{ scenario_key: string; definition: unknown }>,
      expected_catalog_version: finiteInteger(args.expected_catalog_version, "expected_catalog_version", 0, 0),
      request_id: text(args.request_id, "request_id"), reason: text(args.reason, "reason") });
  }

  /**
   * Read memories for the current turn.
   *
   * This is the read half of the wiring gap: `memory_ledger` could be written
   * from the loop but never read, so an agent could record a lesson and never
   * benefit from it. It delegates to the governed resolver so every read still
   * produces a content-free receipt with per-memory reasons and an explicit
   * omitted count — the agent gains memory access without gaining a way around
   * the budget or the provenance trail.
   */
  async memorySearch(args: JsonObject): Promise<JsonObject> {
    if (args.scope_kind === undefined || args.scope_id === undefined) {
      return { memories: [], count: 0, omitted_count: 0, receipt_id: null, content_free_receipt: true,
        skipped: true, reason: "scope_unavailable" };
    }
    const resolution = await this.contextResolution.resolve({
      query: text(args.query, "query"),
      scope_kind: args.scope_kind,
      scope_id: text(args.scope_id, "scope_id"),
      max_items: args.max_items ?? 8,
      max_chars: args.max_chars ?? 4000
    });
    const items = (resolution.items as JsonObject[]) ?? [];
    const receipt = resolution.receipt as JsonObject | null;
    // The loop gets references and a bounded excerpt; raw restricted content is
    // never handed to the model, matching the knowledge path's discipline.
    return {
      memories: items.map((item) => ({
        memory_id: item.memory_id,
        memory_version: item.memory_version,
        content: item.content,
        sensitivity: item.sensitivity,
        reason: item.reason
      })),
      count: items.length,
      omitted_count: receipt?.omitted_count ?? 0,
      receipt_id: receipt?.id ?? null,
      content_free_receipt: true
    };
  }

  /** One-hop relation summary for a knowledge document, so a loop can decide whether to descend. */
  private relationSummary(path: string): JsonObject[] {
    const { relations } = this.knowledgeRelations.neighbors({ kind: "knowledge_document", id: path });
    return (relations as JsonObject[]).map((edge) => ({
      relation_id: edge.relation_id, relation: edge.relation, direction: edge.direction,
      other: edge.direction === "forward" ? edge.target : edge.source, confidence: edge.confidence,
    }));
  }

  /** Declare where a knowledge document belongs and, optionally, when it stops being trustworthy. */
  knowledgeScopeSet(args: JsonObject): JsonObject {
    const entries = array(args.entries, "entries").map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("knowledge scope entries must be objects");
      return object(item, "knowledge scope entry");
    });
    const index = this.knowledgeIndex();
    try { return { entries: index.setScope(entries as Parameters<KnowledgeIndex["setScope"]>[0]) }; }
    finally { index.close(); }
  }

  knowledgeScopeList(args: JsonObject): JsonObject {
    const index = this.knowledgeIndex();
    try {
      const scope = args.scope === undefined ? undefined : String(args.scope);
      return { entries: index.scopeCatalog(scope), expired: index.expired() };
    } finally { index.close(); }
  }

  /** Forget expired documents from the rebuildable projection. Markdown files are never touched. */
  knowledgeScopeForget(): JsonObject {
    const index = this.knowledgeIndex();
    try { return index.forgetExpired(); }
    finally { index.close(); }
  }

}
