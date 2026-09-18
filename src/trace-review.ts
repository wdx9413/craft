import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const REVIEW_STATUSES = new Set(["passed", "needs_attention", "inconclusive"]);
const ROOT_CAUSES = new Set(["none", "host", "tool", "policy", "environment", "state_drift", "model", "unknown"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function refs(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must be unique`);
  return result.sort();
}

/**
 * Turns an immutable Trace into a small, content-free diagnostic verdict.
 * It never changes the Trace and never treats a model's completion message as
 * proof of success.
 */
export class TraceReviewKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  review(args: JsonObject): JsonObject {
    const trace = this.store.get("trace", text(args.trace_id, "trace_id"));
    const events = this.store.list("trace_event", Number.MAX_SAFE_INTEGER, (item) => item.trace_id === trace.id)
      .sort((left, right) => Number(left.sequence) - Number(right.sequence));
    const failed = events.find((event) => event.status === "failed"
      || (event.error_class !== undefined && event.error_class !== null && String(event.error_class).length > 0));
    const missingObservation = events.some((event) => String(event.event_kind ?? "").includes("completed")
      && event.state_after === null && Array.isArray(event.output_refs) && event.output_refs.length === 0);
    const status = !["completed", "failed", "cancelled", "blocked"].includes(String(trace.status)) ? "inconclusive"
      : failed ? "needs_attention" : missingObservation ? "inconclusive" : "passed";
    const cause = failed ? this.rootCause(failed) : "none";
    const versions = {
      model: trace.model_fingerprint ?? null,
      environment: trace.environment_fingerprint ?? null,
      capability: trace.capability_fingerprint ?? null,
      policy: trace.policy_fingerprint ?? null,
    };
    const reviewId = String(args.review_id ?? `trace_review_${trace.id}_${digest({ status, cause, versions }).slice(-16)}`);
    const identity = { trace_id: trace.id, trace_version: trace.version, status, root_cause: cause,
      first_error_event_id: failed?.id ?? null, event_count: events.length, versions,
      evidence_ids: refs(args.evidence_ids, "evidence_ids"), summary_digest: digest(text(args.summary ?? `Trace review ${status}`, "summary")) };
    const identityDigest = digest(identity); const existing = this.store.find("trace_review", reviewId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Trace review idempotency conflict");
      return { review: existing, idempotent: true };
    }
    return { review: this.store.create("trace_review", reviewId, { ...identity, identity_digest: identityDigest, raw_content_stored: false }), idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const review = this.store.get("trace_review", text(args.review_id, "review_id"));
    return { review, trace: this.store.get("trace", String(review.trace_id)) };
  }

  list(args: JsonObject = {}): JsonObject {
    const status = args.status === undefined ? null : text(args.status, "status");
    if (status !== null && !REVIEW_STATUSES.has(status)) throw new Error("Trace review status is unsupported");
    return { reviews: this.store.list("trace_review", Number(args.limit ?? 100), (item) => status === null || item.status === status) };
  }

  private rootCause(event: JsonObject): string {
    const candidate = String(event.error_class ?? "unknown").toLowerCase();
    for (const cause of ROOT_CAUSES) if (candidate.includes(cause)) return cause;
    return "unknown";
  }
}
