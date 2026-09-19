import { createHash } from "node:crypto";
import type { JsonObject } from "../../src/infrastructure/store.ts";
import { text } from "../../src/validation.ts";
import { digestJson } from "../../src/digest.ts";

/**
 * v0.12.35 memory / knowledge / self-evolution wiring.
 *
 * The assessment that prompted this work said Craft's substrate is complete but
 * nothing flows into the agent loop. Verification found that partly right and
 * partly wrong, and the corrections matter:
 *
 *  - WRONG: "`cli.ts` hardcodes empty context refs". `resolveStandaloneContext`
 *    (cli.ts:245) already calls contextResolutionResolve, searches knowledge and
 *    emits memory_refs. The quoted empty array was an older revision.
 *  - WRONG: "knowledge search has no BM25, only LIKE". `knowledge-index.ts:266`
 *    uses LIKE as a *candidate prefilter* and then reranks with Bm25Index
 *    (line 270) — the same index added in v0.12.34.
 *  - RIGHT: the internal loop exposes 7 read-only tools and none of them touch
 *    memory; `memory_search` / `memory_propose` did not exist anywhere.
 *  - RIGHT: `memory_ledger` had no decay, weighting or access tracking.
 *  - RIGHT: two memory systems coexist bound only by a `reference_only` record.
 *
 * So the real gap is narrower and more precise than "wiring is all cut": the
 * memory *read* path is cut. This module supplies the missing pieces.
 */

// ---------------------------------------------------------------------------
// A3: decay and access weighting
// ---------------------------------------------------------------------------

/**
 * Ranking weight for a memory, from recency, usefulness and confidence.
 *
 * `resolve()` scored memories with a plain count of query terms found via
 * `includes()`. That has no notion of *when* a memory was last useful, so a
 * stale preference competes on equal terms with yesterday's correction — and the
 * more memories accumulate, the worse retrieval gets.
 *
 * The model is deliberately simple and fully deterministic:
 *
 *   weight = importance × recency × (1 + min(accesses, CAP) × ACCESS_BONUS)
 *
 * Recency uses exponential half-life decay rather than a hard cutoff, so a
 * memory fades instead of vanishing — a hard TTL would make "forgotten" equal
 * "deleted", which is exactly the conflation `KnowledgeIndex.forgetExpired`
 * was careful to avoid for knowledge documents.
 */
export interface DecayInput {
  /** ISO instant the memory was last confirmed true. */
  confirmed_at: string;
  /** Instant to evaluate at; passed in so results are reproducible. */
  now: string;
  /** Times this memory has been returned in a resolution that succeeded. */
  accesses?: number;
  /** Source trust: verified memories decay more slowly than bounded ones. */
  trust?: "verified" | "bounded";
}

/** Days after which an untouched memory's recency factor halves. */
const HALF_LIFE_DAYS = 90;
/** Accesses beyond this stop increasing the weight. */
const ACCESS_CAP = 10;
const ACCESS_BONUS = 0.15;
/** A memory never decays below this, so "old" never means "gone". */
const DECAY_FLOOR = 0.01;
const TRUST_FACTOR: Readonly<Record<string, number>> = { verified: 1, bounded: 0.85 };

export function memoryDecayWeight(input: JsonObject): number {
  const confirmedAt = Date.parse(text(input.confirmed_at, "confirmed_at"));
  const now = Date.parse(text(input.now, "now"));
  if (Number.isNaN(confirmedAt)) throw new Error("confirmed_at must be an ISO timestamp");
  if (Number.isNaN(now)) throw new Error("now must be an ISO timestamp");
  const accesses = Number(input.accesses ?? 0);
  if (!Number.isInteger(accesses) || accesses < 0) throw new Error("accesses must be a non-negative integer");
  const trust = (input.trust ?? "bounded") as string;
  if (!(trust in TRUST_FACTOR)) throw new Error("trust must be verified or bounded");

  // A future timestamp is a data error, not a bonus; clamp to "now" so a bad
  // clock cannot inflate a memory above every legitimate one.
  const ageDays = Math.max(0, (now - confirmedAt) / 86_400_000);
  const recency = 2 ** (-ageDays / HALF_LIFE_DAYS);
  const usage = 1 + Math.min(accesses, ACCESS_CAP) * ACCESS_BONUS;
  // A pure exponential underflows to exactly 0 after ~26 years, which would make
  // "very old" indistinguishable from "deleted". A floor keeps a memory worth
  // ranking (and therefore worth surfacing in a receipt) forever, so an ancient
  // memory loses to a recent one without ever becoming unrecoverable.
  const weighted = Math.max(recency * usage * (TRUST_FACTOR[trust] as number), DECAY_FLOOR);
  return Number(weighted.toFixed(6));
}

/**
 * Applies decay to a ranking, keeping the input order deterministic.
 *
 * The base score comes from whatever retrieval produced the candidates (keyword
 * overlap or a vector adapter); decay modulates it rather than replacing it, so
 * a strong lexical match still wins over a weak but recent memory.
 */
export function rankWithDecay(
  candidates: Array<{ id: string; base_score: number; decay: number }>,
): Array<{ id: string; score: number; base_score: number; decay: number }> {
  return candidates
    .map((candidate) => ({
      id: candidate.id,
      base_score: candidate.base_score,
      decay: candidate.decay,
      score: Number((candidate.base_score * candidate.decay).toFixed(6)),
    }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------------------
// A4: automatic capture policy
// ---------------------------------------------------------------------------

/**
 * Whether a turn should produce a memory *candidate* without being asked.
 *
 * The existing gate required `policy.memory_capture === "candidate"` AND a
 * `durable_value` signal, so by default nothing was ever proposed. The
 * governance around candidates (explicit approval before anything becomes
 * durable) is good and is preserved untouched here — this only changes *when a
 * candidate is created*. Approval stays mandatory; only the proposal threshold
 * moves, which turns "the human approves everything" into "the human vetoes
 * what matters".
 */
export interface CapturePolicy {
  /** Signals the turn reported. */
  signals: string[];
  /** Whether the turn ended in success. */
  succeeded: boolean;
  /** Corrections the user made during the turn. */
  corrections?: number;
  /** Retries the turn needed. */
  retries?: number;
  /** Whether the turn's outcome was novel for this project. */
  novel?: boolean;
}

/** Signals that always justify a candidate on their own. */
const STRONG_SIGNALS = ["durable_value", "user_correction", "decision_made"];
const AUTOMATIC_KEYS = new Set(["durable_value", "needs_execution"]);

export function shouldProposeMemory(input: JsonObject): { propose: boolean; reasons: string[]; policy: string } {
  const signals = Array.isArray(input.signals) ? (input.signals as unknown[]).map((item) => text(item, "signal")) : [];
  const succeeded = input.succeeded === true;
  const corrections = Number(input.corrections ?? 0);
  const retries = Number(input.retries ?? 0);
  if (!Number.isInteger(corrections) || corrections < 0) throw new Error("corrections must be a non-negative integer");
  if (!Number.isInteger(retries) || retries < 0) throw new Error("retries must be a non-negative integer");
  const novel = input.novel === true;
  const mode = String(input.mode ?? "review_by_exception");
  if (!["strict", "review_by_exception"].includes(mode)) throw new Error("memory capture mode is unsupported");

  // Strict mode preserves the historical behaviour exactly, so a project that
  // wants full manual approval keeps it.
  if (mode === "strict") {
    const propose = signals.includes("durable_value");
    return { propose, reasons: propose ? ["durable_value"] : [], policy: "strict" };
  }

  const reasons: string[] = [];
  for (const signal of signals) {
    if (STRONG_SIGNALS.includes(signal)) reasons.push(signal);
    else if (AUTOMATIC_KEYS.has(signal)) reasons.push(`${signal}_automatic`);
  }
  if (corrections > 0) reasons.push(`corrections_${corrections}`);
  if (retries > 0) reasons.push(`retries_${retries}`);
  // A clean success with nothing notable carries no lesson worth a candidate.
  if (!reasons.length && novel) reasons.push("novel_situation");
  const unique = [...new Set(reasons)].sort();
  return { propose: unique.length > 0, reasons: unique, policy: "review_by_exception" };
}

// ---------------------------------------------------------------------------
// B4: reconciling the two memory systems
// ---------------------------------------------------------------------------

/**
 * Decides whether a legacy memory can be promoted into the ledger.
 *
 * Craft has `memory_item` / `episodic_memory` / `semantic_memory` on one side and
 * the governed `memory_ledger` on the other. `compatBind` links them but records
 * `mode: "reference_only", migration_performed: false`, so the two stay separate
 * forever and a legacy memory can never gain provenance.
 *
 * This does not invent an automatic migration — silently promoting ungoverned
 * memories into a governed store would be exactly the wrong move. It produces a
 * *candidate promotion* that carries a digest of the source and requires the
 * same approval as any other candidate, so the two systems can converge without
 * weakening the ledger's guarantees.
 */
export function planLegacyPromotion(input: JsonObject): JsonObject {
  const legacyKind = text(input.legacy_kind, "legacy_kind");
  if (!["memory_item", "episodic_memory", "semantic_memory"].includes(legacyKind)) throw new Error("Legacy Memory kind is unsupported");
  const legacyId = text(input.legacy_id, "legacy_id");
  const content = text(input.content, "content");
  const scope = String(input.scope ?? "user");
  if (!["user", "project", "workspace", "task"].includes(scope)) throw new Error("Legacy Memory scope is unsupported");
  const legacyVersion = Number(input.legacy_version ?? 1);
  if (!Number.isInteger(legacyVersion) || legacyVersion < 1) throw new Error("legacy_version must be a positive integer");

  // Legacy kinds map onto ledger kinds. A preference stays a preference; an
  // episode is an experience, not a fact, so it must not be promoted as one.
  const kind = legacyKind === "memory_item" ? String(input.kind ?? "fact") : legacyKind === "episodic_memory" ? "experience" : "fact";
  if (!["fact", "preference", "decision", "experience"].includes(kind)) throw new Error("Promoted Memory kind is unsupported");

  return {
    promotion_id: `promotion_${digestJson({ legacyKind, legacyId, legacyVersion, scope, kind }).slice(7, 31)}`,
    legacy_kind: legacyKind,
    legacy_id: legacyId,
    legacy_version: legacyVersion,
    kind,
    scope,
    content_digest: digestJson(content),
    // A promotion is a candidate like any other: it needs a source and approval
    // before it can appear in resolutions.
    requires_source: true,
    requires_approval: true,
    // Episodic content is raw experience and is the likeliest to hold secrets.
    sensitivity: legacyKind === "episodic_memory" ? "restricted" : "internal",
    migration_performed: false,
    downgrade_policy: "reference_only_until_approved",
  };
}

// ---------------------------------------------------------------------------
// A2: vector retrieval wiring
// ---------------------------------------------------------------------------

/**
 * Combines keyword and vector rankings for memory retrieval.
 *
 * `resolve()` chose its mode with `adapter?.status === "eligible" ? strategy :
 * "keyword"` but then scored candidates by substring overlap either way — the
 * vector branch only changed the `reason` string. This makes the eligible-vector
 * case actually use embeddings, and keeps the keyword path as the fallback
 * rather than the only real implementation.
 *
 * Fusion is reciprocal-rank, matching `catalog.searchHybrid` and `fuseRankings`,
 * so a document found by only one method is not discarded and neither method has
 * to be trusted alone.
 */
export interface VectorCandidate {
  id: string;
  /** Cosine similarity from the adapter, or null when only keyword matched. */
  similarity: number | null;
  /** Keyword overlap score. */
  keyword_score: number;
}

export function hybridMemoryScores(
  candidates: VectorCandidate[],
  options: { vectorEligible: boolean; k?: number } = { vectorEligible: false },
): Array<{ id: string; score: number; retrieval_mode: "vector+keyword" | "keyword" }> {
  const k = options.k ?? 60;
  if (!Number.isFinite(k) || k <= 0) throw new Error("Fusion k must be a positive number");
  if (!options.vectorEligible) {
    // Without an eligible adapter this is the historical behaviour: keyword
    // overlap decides, and the mode is reported honestly.
    return candidates
      .map((candidate) => ({ id: candidate.id, score: candidate.keyword_score, retrieval_mode: "keyword" as const }))
      .filter((candidate) => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  }

  const byKeyword = [...candidates].sort((left, right) => right.keyword_score - left.keyword_score || left.id.localeCompare(right.id));
  const byVector = [...candidates]
    .filter((candidate) => candidate.similarity !== null)
    .sort((left, right) => (right.similarity as number) - (left.similarity as number) || left.id.localeCompare(right.id));
  const scores = new Map<string, number>();
  for (const [index, candidate] of byKeyword.entries()) {
    if (candidate.keyword_score > 0) scores.set(candidate.id, (scores.get(candidate.id) ?? 0) + 1 / (k + index + 1));
  }
  for (const [index, candidate] of byVector.entries()) {
    scores.set(candidate.id, (scores.get(candidate.id) ?? 0) + 1 / (k + index + 1));
  }
  return [...scores]
    .map(([id, score]) => ({ id, score: Number(score.toFixed(8)), retrieval_mode: "vector+keyword" as const }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------------------
// Evidence that memory changed an outcome
// ---------------------------------------------------------------------------

/**
 * Records that a resolved memory was actually used in a turn that succeeded.
 *
 * The assessment's sharpest point was that Craft's records prove the agent was
 * *governed* but none prove it *got better because it remembered*. Every
 * existing artifact is a control: approvals, receipts, authorizations. Without a
 * link from "this memory was in context" to "this turn succeeded", decay has no
 * signal to learn from and the decay work above would be guesswork.
 *
 * This closes that loop: it is the access signal `memoryDecayWeight` consumes.
 */
export function memoryUsageEvidence(input: JsonObject): JsonObject {
  const memoryIds = Array.isArray(input.memory_ids) ? (input.memory_ids as unknown[]).map((item) => text(item, "memory_id")) : [];
  if (!memoryIds.length) throw new Error("memory_ids must not be empty");
  if (new Set(memoryIds).size !== memoryIds.length) throw new Error("memory_ids must be unique");
  const outcome = text(input.outcome, "outcome");
  if (!["succeeded", "failed", "abandoned"].includes(outcome)) throw new Error("outcome is unsupported");
  const turnId = text(input.turn_id, "turn_id");
  const receiptId = input.receipt_id === undefined ? null : text(input.receipt_id, "receipt_id");
  // Only a success is evidence that the memory helped. Counting a failure as
  // usage would reward memories that were present when things went wrong.
  const used = outcome === "succeeded";
  return {
    evidence_id: `memory_usage_${digestJson({ turnId, memoryIds, outcome }).slice(7, 31)}`,
    turn_id: turnId,
    receipt_id: receiptId,
    outcome,
    memory_ids: memoryIds,
    counted_as_use: used,
    // One record per memory, so the access counter is derivable by summing.
    access_deltas: memoryIds.map((memoryId) => ({ memory_id: memoryId, delta: used ? 1 : 0 })),
    content_free: true,
  };
}
