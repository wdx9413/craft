import { digestJson } from "./digest.ts";
import { compact, compactWithPromotion } from "./compaction.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { estimateTokens } from "./token-budget.ts";

/**
 * A durable context projection, so "omitted" means "restorable" across calls.
 *
 * The defect this closes was a promise the tool could not keep. `craft_context_project` said
 * *"omitted segments are named and can be restored"* and returned `omitted: [ids]` — but
 * `craft_context_restore` took the **original segments again as an argument**. The whole point of
 * omitting a segment is that the caller no longer holds it: a Host that dropped a long transcript
 * tail to fit a window cannot re-supply it later, which is precisely the turn that needs it back.
 * Measured before the fix: `restore({segment_id})` with no segments threw
 * `Context segment s2 does not exist`, and the `context_segment` collection held nothing.
 *
 * So a projection is now **stored**, and its id is the only thing a later call needs:
 *
 * | collection | key | what it holds |
 * |---|---|---|
 * | `context_session` | `{session}` | the segments: role, content, weight, cost, in order |
 * | `context_projection` | `{session}` | the kept and omitted ids, the budget, the cost — no content |
 *
 * Two deliberate properties:
 *
 *  - **A session is required to persist.** No session id means no store, and the caller gets the old
 *    stateless answer plus `restored_from: "arguments"` saying so. The two paths are distinguishable
 *    rather than silently different — a restore that quietly worked from the arguments would hide
 *    the fact that nothing was recoverable.
 *  - **The projection record is content-free.** It holds ids and costs; the segments live in their
 *    own record, so "what was this session's projection" can be answered without pulling the
 *    transcript back.
 *
 * The segments are one record per session rather than one per segment, and that is a consequence
 * worth stating: the store has no `delete`, so per-segment rows would accumulate every segment a
 * session ever held and the stale ones could only be hidden, not removed. Replacement is a versioned
 * `save` instead, which the store already does correctly.
 */
export class ContextProjectionKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /** Persist one session's segments, replacing whatever the session held before. */
  private save(sessionId: string, segments: readonly { id: string; role: string; content: string; weight: number }[]): void {
    const id = `context_session_${sessionId}`;
    const payload = {
      session_id: sessionId,
      segments: segments.map((segment, ordinal) => ({ ...segment, tokens: estimateTokens(segment.content), ordinal })),
      segment_count: segments.length,
      segment_digest: digestJson(segments.map((segment) => ({ id: segment.id, content: segment.content }))),
    };
    const found = this.store.find("context_session", id);
    if (found) this.store.save("context_session", id, payload);
    else this.store.create("context_session", id, payload);
  }

  /** The stored segments of one session, in their original order. */
  private load(sessionId: string): { id: string; role: string; content: string; weight: number }[] {
    const record = this.store.find("context_session", `context_session_${sessionId}`);
    if (!record) return [];
    return (record.segments as JsonObject[]).map((item) => ({
      id: String(item.id), role: String(item.role), content: String(item.content), weight: Number(item.weight),
    }));
  }

  /** Parse the inline `segments` argument, the stateless path the tool has always accepted. */
  private parse(value: unknown): { id: string; role: string; content: string; weight: number }[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw new Error("segments must be an array");
    return value.map((raw) => {
      const item = object(raw, "segment");
      return {
        id: text(item.id, "segment.id"),
        role: text(item.role, "segment.role"),
        content: text(item.content, "segment.content"),
        weight: item.weight === undefined ? 1 : Number(item.weight),
      };
    });
  }

  private record(sessionId: string, maxTokens: number, outcome: ReturnType<typeof compact>, segments: readonly { id: string }[]): void {
    const id = `context_projection_${sessionId}`;
    const identity = { session_id: sessionId, max_tokens: maxTokens, kept: [...outcome.kept], omitted: [...outcome.elided], tokens: outcome.tokens, complete: outcome.complete, segment_count: segments.length };
    const identityDigest = digestJson(identity);
    const found = this.store.find("context_projection", id);
    if (found?.identity_digest === identityDigest) return;
    const payload = { ...identity, identity_digest: identityDigest, content_free: true };
    if (found) this.store.save("context_projection", id, payload);
    else this.store.create("context_projection", id, payload);
  }

  /**
   * Project one session into a budget, and remember both the segments and the result.
   *
   * Supplying `segments` plus a `session_id` is what makes a later `restore` possible. Supplying
   * neither leaves the call stateless, which stays supported because a one-shot projection is a real
   * use and because removing it would break every existing caller for no gain.
   */
  project(args: JsonObject): JsonObject {
    const maxTokens = Number(args.max_tokens);
    if (!Number.isInteger(maxTokens) || maxTokens < 1) throw new Error("Context projection cap must be a positive integer");
    const supplied = this.parse(args.segments);
    const sessionId = args.session_id === undefined ? null : text(args.session_id, "session_id");
    if (sessionId !== null && supplied.length) this.save(sessionId, supplied);
    const segments = sessionId === null ? supplied : this.load(sessionId);
    const outcome = compact({ segments, max_tokens: maxTokens, estimate: estimateTokens });
    if (sessionId !== null) this.record(sessionId, maxTokens, outcome, segments);
    const kept = new Set(outcome.kept);
    return {
      ...(sessionId === null ? {} : { session_id: sessionId }),
      segments: segments.filter((segment) => kept.has(segment.id)),
      omitted: [...outcome.elided],
      tokens: outcome.tokens,
      complete: outcome.complete,
      original_tokens: segments.reduce((sum, segment) => sum + estimateTokens(segment.content), 0),
      // The point of the object: nothing was destroyed to produce this view.
      original_segments: segments.length,
    };
  }

  /**
   * Bring one omitted segment back into the projection.
   *
   * With a `session_id` the segments come from the store, which is the case this exists for: the
   * caller knows the segment's id and nothing else. Without one, the inline `segments` argument is
   * still honoured and the answer says which path was taken.
   */
  restore(args: JsonObject): JsonObject {
    const segmentId = text(args.segment_id, "segment_id");
    const maxTokens = args.max_tokens === undefined ? null : Number(args.max_tokens);
    if (maxTokens !== null && (!Number.isInteger(maxTokens) || maxTokens < 1)) throw new Error("Context projection cap must be a positive integer");
    const sessionId = args.session_id === undefined ? null : text(args.session_id, "session_id");
    const supplied = this.parse(args.segments);
    const stored = sessionId === null ? [] : this.load(sessionId);
    // A session that holds nothing is not the same as no session: the first is a caller error, the
    // second is the stateless path. Conflating them would make a typo in a session id look like an
    // undocumented argument form.
    const segments = sessionId === null ? supplied : stored;
    const restoredFrom = sessionId === null ? "arguments" : "session";
    if (sessionId !== null && !stored.length) throw new Error(`Context session ${sessionId} holds no segments`);
    // Existence first. Deriving `already` from the stored `omitted` list alone made a segment that the
    // session does not hold at all look present — because it is not in `omitted` either — and the
    // restore then returned a projection without it, silently. A missing segment is an error, and it
    // has to be checked before anything asks whether it is present.
    const target = segments.find((segment) => segment.id === segmentId);
    if (!target) throw new Error(`Context segment ${segmentId} does not exist`);
    // "Already present" is a fact about the session's **stored** projection, not about what would fit
    // at the budget this call happens to pass. Computing it from a fresh projection made a restore
    // into a larger budget report `already_present: true` for a segment the previous call had
    // omitted — the opposite of the truth, and it skipped the promotion that was the point.
    const storedProjection = sessionId === null ? null : this.store.find("context_projection", `context_projection_${sessionId}`);
    // The cap defaults to the current projection's own budget, so `restore` without a max_tokens
    // asks "put it back where it was" rather than silently using a different budget.
    const budget = maxTokens ?? Math.max(estimateTokens(target.content), Number(storedProjection?.tokens ?? 0));
    // Whether it fits at *this* budget decides whether promotion is needed. Using the stored
    // projection for that decision was wrong in the other direction: a segment already in the view at
    // 120 tokens is not present at a budget of 1, and taking the shortcut there returned a projection
    // without it — silently, which is exactly what a restore must never do.
    const fitsAtBudget = compact({ segments, max_tokens: budget, estimate: estimateTokens }).kept.includes(segmentId);
    // `already_present` is a different question and keeps its different answer: was it in the
    // projection the session already had?
    const already = storedProjection === null ? fitsAtBudget : !(storedProjection.omitted as string[]).includes(segmentId);
    const outcome = fitsAtBudget ? compact({ segments, max_tokens: budget, estimate: estimateTokens })
      : compactWithPromotion({ segments, max_tokens: budget, estimate: estimateTokens }, segmentId);
    if (sessionId !== null) this.record(sessionId, budget, outcome, segments);
    const kept = new Set(outcome.kept);
    return {
      ...(sessionId === null ? {} : { session_id: sessionId }),
      restored_from: restoredFrom,
      restored: segmentId,
      already_present: already,
      segments: segments.filter((segment) => kept.has(segment.id)),
      omitted: [...outcome.elided],
      tokens: outcome.tokens,
      complete: outcome.complete,
    };
  }

  /**
   * Read the stored projection without re-projecting.
   *
   * A read of the *view*, not of the transcript: the segments stay in their own records, so asking
   * what a session's projection was does not pull the content back.
   */
  get(args: JsonObject): JsonObject {
    const sessionId = text(args.session_id, "session_id");
    const record = this.store.find("context_session", `context_session_${sessionId}`);
    return {
      // `find`, not `get`: a session that was never projected is a question with the answer
      // "nothing", not an error. `get` throws on a missing record, which turned a read into a failure.
      projection: this.store.find("context_projection", `context_projection_${sessionId}`) ?? null,
      segment_count: record ? Number(record.segment_count) : 0,
    };
  }
}
