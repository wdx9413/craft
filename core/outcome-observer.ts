import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

const KINDS = new Set(["program", "workspace", "human", "external"]);
const VERDICTS = new Set(["passed", "failed", "blocked", "inconclusive"]);



function ids(value: unknown): string[] { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error("evidence_ids must be an array"); const result = value.map((item) => text(item, "evidence_ids")); if (new Set(result).size !== result.length) throw new Error("evidence_ids must be unique"); return result.sort(); }

/** Independent, content-free observation; it is evidence for assessment, never an auto-promotion decision. */
export class OutcomeObserverKernel {
  readonly store: CraftStore;
  readonly trace: TraceKernel;
  constructor(store: CraftStore, trace: TraceKernel) { this.store = store; this.trace = trace; }

  observe(args: JsonObject): JsonObject {
    const trace = this.store.get("trace", text(args.trace_id, "trace_id")); const hostId = text(args.host_id, "host_id"); const observerId = text(args.observer_id, "observer_id");
    if (observerId === hostId) throw new Error("Outcome Observer must be independent from the Host");
    const kind = text(args.observer_kind, "observer_kind"); if (!KINDS.has(kind)) throw new Error("Outcome Observer kind is unsupported");
    const verdict = text(args.verdict, "verdict"); if (!VERDICTS.has(verdict)) throw new Error("Outcome Observer verdict is unsupported");
    const environment = text(args.environment_fingerprint, "environment_fingerprint"); if (trace.environment_fingerprint !== environment) throw new Error("Outcome Observer environment does not match Trace");
    const evidenceIds = ids(args.evidence_ids); if (verdict === "passed" && !evidenceIds.length) throw new Error("Passed Outcome Observation requires Evidence");
    for (const evidenceId of evidenceIds) if (!new Set(["confirmed", "bounded"]).has(String(this.store.get("evidence", evidenceId).confidence))) throw new Error("Outcome Observation Evidence must be confirmed or bounded");
    const identity = { trace_id: trace.id, host_id: hostId, observer_id: observerId, observer_kind: kind, environment_fingerprint: environment, verdict, state_snapshot_ref: text(args.state_snapshot_ref, "state_snapshot_ref"), evidence_ids: evidenceIds };
    const observationId = String(args.observation_id ?? `outcome_observation_${randomUUID().replaceAll("-", "")}`); const observationDigest = digestJson(identity); const existing = this.store.find("outcome_observation", observationId);
    if (existing) { if (existing.observation_digest !== observationDigest) throw new Error("Outcome Observation idempotency conflict"); return { observation: existing, trace_event: this.store.get("trace_event", String(existing.trace_event_id)), idempotent: true }; }
    const traceEvent = this.trace.observe({ trace_id: trace.id, event_id: `outcome_observer:${observationId}`, actor: observerId, source: `outcome_observer:${kind}`, trust: kind === "human" ? "human" : "observed", state_after: { ref: identity.state_snapshot_ref }, output_refs: evidenceIds, summary: `${kind}:${verdict}`, data: { observation_id: observationId, observer_kind: kind, verdict, environment_fingerprint: environment } }).event as JsonObject;
    const observation = this.store.create("outcome_observation", observationId, { ...identity, observation_digest: observationDigest, trace_event_id: traceEvent.id, trace_event_version: traceEvent.version, promotion_eligible: false, raw_content_stored: false });
    return { observation, trace_event: traceEvent, idempotent: false };
  }

  get(args: JsonObject): JsonObject { const observation = this.store.get("outcome_observation", text(args.observation_id, "observation_id")); return { observation, trace_event: this.store.get("trace_event", String(observation.trace_event_id)) }; }
}
