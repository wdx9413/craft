import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

const STAGES = new Set(["light", "review", "deep"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]/iu;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/**
 * Bounded, proposal-only maintenance for Memory and Knowledge. The kernel can
 * inspect and score records but never silently promotes or deletes them.
 */
export class MemoryMaintenanceKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  signal(args: JsonObject): JsonObject {
    const memoryId = text(args.memory_id, "memory_id");
    this.store.get("episodic_memory", memoryId);
    const kind = text(args.kind ?? "recalled", "kind");
    const value = Number(args.value ?? 1);
    if (!Number.isFinite(value) || value < 0) throw new Error("value must be a non-negative number");
    const signalId = String(args.signal_id ?? `memory_usage_${memoryId}_${kind}`);
    const identity = { memory_id: memoryId, kind, value };
    const existing = this.store.find("memory_usage_signal", signalId);
    if (existing) {
      if (existing.identity_digest !== digest(identity)) throw new Error("Memory usage signal idempotency conflict");
      return { signal: existing, idempotent: true };
    }
    return { signal: this.store.create("memory_usage_signal", signalId, { ...identity, identity_digest: digest(identity) }), idempotent: false };
  }

  run(args: JsonObject = {}): JsonObject {
    const stage = text(args.stage ?? "light", "stage");
    if (!STAGES.has(stage)) throw new Error("Memory maintenance stage is unsupported");
    const now = args.now === undefined ? new Date().toISOString() : text(args.now, "now");
    if (Number.isNaN(Date.parse(now))) throw new Error("now must be an ISO timestamp");
    const candidates = this.store.list("episodic_memory", 10_000);
    const semantic = this.store.list("semantic_memory", 10_000, (item) => item.status === "active");
    const findings: JsonObject[] = [];
    const seen = new Set<string>();
    for (const memory of candidates) {
      if (seen.has(String(memory.content_digest))) findings.push({ kind: "duplicate", memory_id: memory.id });
      seen.add(String(memory.content_digest));
      if (memory.content_ref === undefined) findings.push({ kind: "missing_content_ref", memory_id: memory.id });
      const source = String(memory.source ?? "");
      if (SECRET.test(source)) findings.push({ kind: "sensitive_source", memory_id: memory.id });
    }
    if (stage !== "light") {
      for (const memory of semantic) {
        const related = candidates.filter((candidate) => (memory.memory_ids as string[] | undefined)?.includes(String(candidate.id)));
        if (!related.length) findings.push({ kind: "orphaned_semantic", memory_id: memory.id });
      }
    }
    const maintenanceId = String(args.maintenance_id ?? `memory_maintenance_${randomUUID().replaceAll("-", "")}`);
    const identity = { stage, now, memory_ids: candidates.map((item) => item.id).sort(), semantic_ids: semantic.map((item) => item.id).sort(), finding_digest: digest(findings) };
    const existing = this.store.find("memory_maintenance_run", maintenanceId);
    if (existing) {
      if (existing.identity_digest !== digest(identity)) throw new Error("Memory maintenance idempotency conflict");
      return { run: existing, findings, idempotent: true };
    }
    const proposal = stage === "deep" && findings.length > 0
      ? this.store.create("memory_maintenance_candidate", `${maintenanceId}:candidate`, { source_ids: candidates.map((item) => item.id), finding_digest: digest(findings), status: "candidate", publication_allowed: false, raw_content_stored: false })
      : null;
    const run = this.store.create("memory_maintenance_run", maintenanceId, { ...identity, identity_digest: digest(identity), finding_count: findings.length, candidate_id: proposal?.id ?? null, status: "completed", raw_content_stored: false });
    return { run, findings, candidate: proposal, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    const run = this.store.get("memory_maintenance_run", text(args.maintenance_id, "maintenance_id"));
    return { run, candidate: run.candidate_id ? this.store.get("memory_maintenance_candidate", String(run.candidate_id)) : null };
  }

  /**
   * Consume terminal Trace records in small, resumable batches.  The cycle only
   * creates content-free learning observations; it never turns a trace into an
   * active Memory, Skill or Workflow.  A later governed review can use the
   * observation ids as evidence for the existing candidate gates.
   */
  cycle(args: JsonObject = {}): JsonObject {
    const cursor = args.cursor === undefined ? 0 : Number(args.cursor);
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(cursor) || cursor < 0) throw new Error("cursor must be a non-negative integer");
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
    const traces = this.store.list("trace", 10_000, (item) => new Set(["completed", "failed", "cancelled", "blocked"]).has(String(item.status)))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const batch = traces.slice(cursor, cursor + limit);
    const observations = batch.map((trace) => {
      const observationId = `learning_observation_${trace.id}_${trace.version}`;
      const identity = { trace_id: trace.id, trace_version: trace.version, status: trace.status, model_fingerprint: trace.model_fingerprint ?? null, environment_fingerprint: trace.environment_fingerprint ?? null };
      const existing = this.store.find("learning_observation", observationId);
      if (existing) return existing;
      return this.store.create("learning_observation", observationId, { ...identity, source_digest: digest(identity), content_free: true, lifecycle: "diagnostic_only" });
    });
    const nextCursor = cursor + batch.length;
    const cycleIdentity = { cursor, limit, trace_ids: batch.map((trace) => trace.id), observation_ids: observations.map((item) => item.id) };
    const cycleId = String(args.cycle_id ?? `memory_learning_cycle_${digest(cycleIdentity).slice(-16)}`);
    const existing = this.store.find("memory_learning_cycle", cycleId);
    if (existing) {
      if (existing.identity_digest !== digest(cycleIdentity)) throw new Error("Memory learning cycle idempotency conflict");
      return { cycle: existing, observations, next_cursor: nextCursor, exhausted: nextCursor >= traces.length, idempotent: true };
    }
    const cycle = this.store.create("memory_learning_cycle", cycleId, { ...cycleIdentity, identity_digest: digest(cycleIdentity), status: "completed", exhausted: nextCursor >= traces.length, raw_content_stored: false });
    return { cycle, observations, next_cursor: nextCursor, exhausted: nextCursor >= traces.length, idempotent: false };
  }
}
