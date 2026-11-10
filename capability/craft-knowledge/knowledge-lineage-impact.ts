import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { KnowledgeRelationKernel } from "./knowledge-relation.ts";

/**
 * Derived-claim impact analysis over the typed knowledge graph.
 *
 * Research on ontology-grounded agent memory (SparrowOntology's DERIVED_FROM
 * confidence degradation, PROV-O lineage) makes one requirement explicit: when
 * a foundational claim is refuted, a system must be able to enumerate every
 * derived claim whose support now needs re-evaluation. A flat fact store cannot
 * answer that; `KnowledgeRelationKernel.traverse` can walk the graph but does
 * not give `derives_from` its direction semantics or propagate confidence.
 *
 * Direction contract, matching `relate`: an edge
 *   `source --derives_from--> target`
 * means *source derives from target* (target is the more foundational claim).
 * So refuting a root propagates along edges whose `target` is the root, then
 * onward to anything that derives from those sources.
 *
 * This module is read-only and bounded: it composes the public `neighbors`
 * seam, never writes a record, clamps depth to the relation kernel's own 3-hop
 * ceiling, and visits each endpoint once so a cycle terminates. Confidence is
 * reported as a degradation *factor*, not invented as an absolute probability —
 * the stored relation confidence is passed through unchanged.
 */

const MAX_DEPTH = 3;
const MAX_NODES = 200;

export interface LineageImpactNode {
  node: JsonObject;
  depth: number;
  /** Product of the per-hop degradation factors from the root to this node. */
  confidence_factor: number;
  /** The `derives_from` edge that led to this node (null for the root). */
  via_relation_id: string | null;
  /** Stored relation confidence, carried through without interpretation. */
  relation_confidence: string | null;
  needs_reevaluation: boolean;
}

export interface LineageImpact {
  root: JsonObject;
  /** Whether the root has a live `contradicts` or `supersedes` challenge. */
  root_challenged: boolean;
  challenge_relation_ids: string[];
  impacted: LineageImpactNode[];
  truncated: boolean;
  /** True when at least one derived claim must be re-evaluated. */
  needs_reevaluation: boolean;
}

/** Multiply one hop's confidence factor; unverified support degrades fastest. */
function hopFactor(confidence: unknown): number {
  if (confidence === "confirmed") return 1;
  if (confidence === "bounded") return 0.8;
  return 0.5;
}

function sameNode(left: JsonObject, right: JsonObject): boolean {
  return left.kind === right.kind && left.id === right.id
    && (left.version ?? null) === (right.version ?? null);
}

function nodeKey(node: JsonObject): string {
  return `${String(node.kind)}:${String(node.id)}@${node.version === null || node.version === undefined ? "latest" : String(node.version)}`;
}

/**
 * `neighbors` returns endpoints that may carry `version: null`. Passing such a
 * node straight back into `neighbors` fails its integer validation, so every
 * node we re-submit is normalized to the shape `endpoint` accepts: a positive
 * version when one exists, otherwise no version field at all (latest).
 */
function cleanNode(node: JsonObject): JsonObject {
  const version = node.version;
  const clean: JsonObject = { kind: node.kind, id: node.id };
  if (typeof version === "number" && Number.isInteger(version) && version >= 1) clean.version = version;
  return clean;
}

export class KnowledgeLineageImpactKernel {
  readonly store: CraftStore;
  private readonly relations: KnowledgeRelationKernel;
  constructor(store: CraftStore) { this.store = store; this.relations = new KnowledgeRelationKernel(store); }

  /**
   * Report every claim derived (directly or transitively) from `root`, with a
   * confidence factor that degrades along the chain. When the root is itself
   * challenged by a live `contradicts`/`supersedes` edge, every derived claim
   * is flagged as needing re-evaluation; otherwise the report is still useful
   * as a lineage enumeration but does not claim an invalidation.
   */
  analyze(args: JsonObject): LineageImpact {
    const node = args.node ?? { kind: args.kind, id: args.id, version: args.version };
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new Error("node must be an object");
    const root = cleanNode(node as JsonObject);
    const asOf = typeof args.as_of === "string" ? args.as_of : undefined;
    const maxNodes = Number.isInteger(args.max_nodes) && Number(args.max_nodes) >= 1
      ? Math.min(Number(args.max_nodes), MAX_NODES) : MAX_NODES;
    const all = (this.relations.neighbors({ node: root, as_of: asOf, limit: 1000 }) as JsonObject).relations as JsonObject[];

    const challengeIds: string[] = [];
    for (const edge of all) {
      if (edge.relation !== "contradicts" && edge.relation !== "supersedes") continue;
      challengeIds.push(String(edge.relation_id));
    }
    challengeIds.sort();
    const rootChallenged = challengeIds.length > 0;

    const impacted: LineageImpactNode[] = [];
    const visited = new Set<string>([nodeKey(root)]);
    let frontier: LineageImpactNode[] = [{ node: root, depth: 0, confidence_factor: 1, via_relation_id: null, relation_confidence: null, needs_reevaluation: false }];
    let truncated = false;
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth += 1) {
      const next: LineageImpactNode[] = [];
      for (const current of frontier) {
        const neighbors = this.relations.neighbors({ node: cleanNode(current.node), direction: "both", relation: "derives_from", as_of: asOf, limit: 1000 }) as JsonObject;
        for (const edge of neighbors.relations as JsonObject[]) {
          // Only edges whose *target* is the current node propagate impact: the
          // source is a claim derived from it. An edge where the current node is
          // the source points at its own foundation and must not be followed.
          if (!sameNode(edge.target as JsonObject, current.node)) continue;
          const derived = edge.source as JsonObject;
          const key = nodeKey(derived);
          if (visited.has(key)) continue;
          if (impacted.length >= maxNodes) { truncated = true; break; }
          visited.add(key);
          const factor = current.confidence_factor * hopFactor(edge.confidence);
          const entry: LineageImpactNode = {
            node: derived,
            depth,
            confidence_factor: Number(factor.toFixed(4)),
            via_relation_id: String(edge.relation_id),
            relation_confidence: String(edge.confidence ?? "unverified"),
            needs_reevaluation: rootChallenged,
          };
          impacted.push(entry);
          next.push(entry);
        }
        if (truncated) break;
      }
      if (truncated) break;
      frontier = next;
    }
    return { root, root_challenged: rootChallenged, challenge_relation_ids: challengeIds,
      impacted, truncated, needs_reevaluation: rootChallenged && impacted.length > 0 };
  }
}

/** Wrap the kernel result in the JsonObject shape every service delegate returns. */
export function knowledgeLineageImpact(store: CraftStore, args: JsonObject): JsonObject {
  const result = new KnowledgeLineageImpactKernel(store).analyze(args);
  return result as unknown as JsonObject;
}
