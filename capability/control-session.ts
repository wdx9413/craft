import { randomUUID } from "node:crypto";
import { type CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { payload, stableDigest } from "../core/digest.ts";

export type ControlScope = { task_id: string; activation_id: string; target_id: string };
/** Supplied by the trusted Host, never by tool-call arguments. Includes current Policy and permission state. */
export type ControlGrant = ControlScope & {
  project_id: string; host_id: string; activation_version: number; policy_digest: string; capability_digest: string;
  target_identity: string; operations: string[]; allowed_origins: string[]; expires_at: number; max_actions: number; timeout_ms: number;
};
export type ControlObservation = { identity: string; state_digest: string; origin: string; element_refs: string[]; user_takeover: boolean };
export type ControlAction = { operation: string; element_ref?: string; value?: string; url?: string };
export type ControlAdapter = {
  observe(target: string, signal: AbortSignal): Promise<ControlObservation>;
  execute(target: string, action: Readonly<ControlAction>, signal: AbortSignal): Promise<{ receipt_digest: string }>;
};
export type ControlAuthority = { resolve(scope: ControlScope): ControlGrant; principal: string };
const OPERATIONS = new Set(["navigate", "fill", "click", "submit", "scroll", "wait", "set_value", "invoke", "select", "toggle"]);

/**
 * Content-free Session ledger and single-use approval. It does not install a Host or grant effects.
 * Approval is deliberately absent from the client Interface: only the Host control plane holds it.
 * The Host authority must resolve real Task/Activation/Policy records, not caller declarations.
 */
export function createControlSession(store: CraftStore, authority: ControlAuthority, adapter: ControlAdapter, now = Date.now) {
  const pending = new Map<string, { session_id: string; request: Readonly<ControlAction> }>();
  const inFlight = new Map<string, AbortController>();
  const id = (kind: string) => `${kind}_${randomUUID()}`;
  const save = (record: JsonObject, next: JsonObject) => store.updateIfVersion("control_session", String(record.id), Number(record.version), { ...payload(record), ...next });
  function discard(sessionId: string): void {
    for (const [actionId, entry] of pending) if (entry.session_id === sessionId) pending.delete(actionId);
  }

  function active(sessionId: string, expected = "active"): JsonObject {
    const session = store.get("control_session", sessionId);
    if (session.status !== expected) throw new Error("Session requires handoff or reconciliation");
    let grant: ControlGrant;
    try { grant = authority.resolve(session.scope as ControlScope); }
    catch {
      discard(sessionId); save(session, { status: "handoff", reason: "authority_unavailable" });
      throw new Error("Control authority unavailable");
    }
    if (stableDigest(grant) !== session.grant_digest || grant.expires_at <= now()) {
      discard(sessionId);
      save(session, { status: "handoff", reason: "authority_expired_or_changed" });
      throw new Error("Control authority expired or changed");
    }
    return session;
  }
  function observeValid(session: JsonObject, observation: ControlObservation): void {
    const grant = session.grant as ControlGrant;
    if (observation.identity !== grant.target_identity || !observation.state_digest || observation.user_takeover
      || !grant.allowed_origins.includes(observation.origin)) throw new Error("Target changed, unauthorized origin or user takeover required");
  }
  function actionRecord(actionId: string): JsonObject { return store.get("control_action", actionId); }
  function approvalPacket(actionId: string): JsonObject {
    const action = actionRecord(actionId), session = active(String(action.session_id));
    const request = pending.get(actionId)?.request;
    if (!request) throw new Error("Approval packet unavailable after Host restart or cancellation");
    if (action.status !== "awaiting_approval" || session.observation_id !== action.observation_id) throw new Error("Approval request is stale or already decided");
    const binding = { action_id: action.id, action_digest: action.action_digest, session_id: session.id,
      observation_id: action.observation_id, grant_digest: session.grant_digest };
    return Object.freeze({ ...binding, packet_digest: stableDigest({ ...binding, action: request }), action: Object.freeze(structuredClone(request)) });
  }
  function updateAction(action: JsonObject, next: JsonObject): JsonObject {
    return store.updateIfVersion("control_action", String(action.id), Number(action.version), { ...payload(action), ...next });
  }
  async function bounded<T>(session: JsonObject, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    inFlight.set(String(session.id), controller);
    let timer: ReturnType<typeof setTimeout>;
    let rejectAbort: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new Error("Control operation cancelled or timed out"));
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
      const grant = session.grant as ControlGrant;
      timer = setTimeout(() => controller.abort(), Math.min(grant.timeout_ms, Math.max(1, grant.expires_at - now())));
    });
    try { return await Promise.race([Promise.resolve().then(() => operation(controller.signal)), stopped]); }
    finally { clearTimeout(timer!); controller.signal.removeEventListener("abort", rejectAbort!); inFlight.delete(String(session.id)); }
  }

  const client = {
    open(scope: ControlScope): JsonObject {
      const grant = authority.resolve(scope);
      if (stableDigest({ task_id: grant.task_id, activation_id: grant.activation_id, target_id: grant.target_id }) !== stableDigest(scope)
        || Object.keys(grant).some((key) => !["task_id", "activation_id", "target_id", "project_id", "host_id", "activation_version", "policy_digest", "capability_digest", "target_identity", "operations", "allowed_origins", "expires_at", "max_actions", "timeout_ms"].includes(key))
        || !grant.host_id || !grant.project_id || !grant.target_identity || !grant.policy_digest || !grant.capability_digest
        || !Number.isInteger(grant.activation_version) || grant.activation_version < 1
        || !Number.isInteger(grant.max_actions) || grant.max_actions < 1 || grant.max_actions > 100
        || !Number.isInteger(grant.timeout_ms) || grant.timeout_ms < 1 || grant.timeout_ms > 60_000
        || !Number.isFinite(grant.expires_at) || grant.expires_at <= now()
        || !grant.operations.length || grant.operations.some((operation) => !OPERATIONS.has(operation))
        || !grant.allowed_origins.length) throw new Error("Invalid Host control grant");
      return store.create("control_session", id("control_session"), { scope: structuredClone(scope), grant: structuredClone(grant),
        grant_digest: stableDigest(grant), status: "active", used_actions: 0, raw_content_stored: false });
    },
    async observe(sessionId: string): Promise<JsonObject> {
      const session = save(active(sessionId), { status: "observing" });
      try {
        const observation = await bounded(session, (signal) => adapter.observe(String((session.scope as ControlScope).target_id), signal));
        const current = active(sessionId, "observing");
        observeValid(current, observation);
        const record = store.create("control_observation", id("control_observation"), { session_id: session.id,
          identity_digest: stableDigest(observation.identity), state_digest: observation.state_digest, origin: observation.origin,
          element_refs: [...observation.element_refs], observation_digest: stableDigest(observation), raw_content_stored: false });
        save(current, { status: "active", observation_id: record.id });
        return record;
      } catch {
        discard(sessionId);
        save(store.get("control_session", sessionId), { status: "handoff", reason: "observation_failed" });
        throw new Error("Observation failed or user takeover required");
      }
    },
    prepare(sessionId: string, observationId: string, action: ControlAction): JsonObject {
      const session = active(sessionId), grant = session.grant as ControlGrant;
      const observation = store.get("control_observation", observationId);
      if (observation.session_id !== session.id || session.observation_id !== observationId) throw new Error("Observation is stale or belongs to another Session");
      if (!grant.operations.includes(action.operation) || !OPERATIONS.has(action.operation)
        || Object.keys(action).some((key) => !["operation", "element_ref", "value", "url"].includes(key))) throw new Error("Operation or parameters are not allowed");
      if (pending.size >= 100) throw new Error("Prepared control action capacity exhausted");
      if (action.operation === "navigate") {
        const url = new URL(String(action.url));
        if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || !grant.allowed_origins.includes(url.origin)) throw new Error("Navigation is outside the authorized origins");
      } else if (!(observation.element_refs as string[]).includes(String(action.element_ref))) throw new Error("Element reference is stale or unknown");
      const record = store.create("control_action", id("control_action"), { session_id: session.id, observation_id: observationId,
        action_digest: stableDigest(action), status: "awaiting_approval", raw_content_stored: false });
      pending.set(String(record.id), { session_id: sessionId, request: Object.freeze(structuredClone(action)) });
      return record;
    },
    async execute(actionId: string): Promise<JsonObject> {
      let action = actionRecord(actionId);
      let session = active(String(action.session_id));
      if (action.status !== "approved") throw new Error("Action lacks single-use Host approval or already dispatched");
      const request = pending.get(actionId)?.request;
      if (!request || stableDigest(request) !== action.action_digest) throw new Error("Action must be prepared again after Host restart");
      if (Number(session.used_actions) >= (session.grant as ControlGrant).max_actions) {
        discard(String(session.id));
        save(session, { status: "handoff", reason: "budget_exhausted" }); throw new Error("Control action budget exhausted");
      }
      // CAS reservation precedes all asynchronous work. A competing Host cannot execute this Session.
      session = save(session, { status: "executing", used_actions: Number(session.used_actions) + 1 });
      action = updateAction(action, { status: "checking" });
      let dispatched = false;
      try {
        const target = String((session.scope as ControlScope).target_id);
        const before = await bounded(session, (signal) => adapter.observe(target, signal));
        observeValid(session, before);
        const reference = store.get("control_observation", String(action.observation_id));
        if (session.observation_id !== reference.id || stableDigest(before) !== reference.observation_digest) throw new Error("Observation changed before execution");
        const grant = authority.resolve(session.scope as ControlScope);
        if (stableDigest(grant) !== session.grant_digest || grant.expires_at <= now()) throw new Error("Control authority changed before execution");
        if (store.get("control_session", String(session.id)).status !== "executing") throw new Error("Session was cancelled before execution");
        action = updateAction(action, { status: "effect_unknown" });
        dispatched = true; // Persist uncertainty before calling the external Adapter.
        const receipt = await bounded(session, (signal) => adapter.execute(target, request, signal));
        if (!receipt.receipt_digest) throw new Error("Adapter did not produce a receipt");
        const after = await bounded(session, (signal) => adapter.observe(target, signal)); // Independent of the execute result.
        observeValid(session, after);
        const current = store.get("control_session", String(session.id));
        if (current.status !== "executing" || stableDigest(authority.resolve(session.scope as ControlScope)) !== session.grant_digest
          || (session.grant as ControlGrant).expires_at <= now()) throw new Error("Session cancelled or permission revoked during execution");
        action = updateAction(action, { status: "observed", receipt_digest: receipt.receipt_digest, terminal_observation_digest: stableDigest(after),
          outcome_accepted: false });
        save(current, { status: "active", observation_id: null });
      } catch {
        discard(String(session.id));
        action = updateAction(actionRecord(actionId), { status: dispatched ? "effect_unknown" : "handoff" });
        const current = store.get("control_session", String(session.id));
        save(current, { status: "handoff", reason: dispatched ? "reconcile_required" : "preflight_failed" });
      } finally { pending.delete(actionId); }
      return action;
    },
    close(sessionId: string): JsonObject {
      const session = store.get("control_session", sessionId);
      inFlight.get(sessionId)?.abort();
      discard(sessionId);
      return save(session, { status: "closed" });
    },
  };
  return { client, approvalPacket,
    approve(actionId: string, principal: string, packetDigest: string): JsonObject {
      if (principal !== authority.principal || !principal) throw new Error("Approval requires the authenticated Host principal");
      const packet = approvalPacket(actionId);
      if (packet.packet_digest !== packetDigest) throw new Error("Approval packet digest changed or was forged");
      const action = actionRecord(actionId), session = active(String(action.session_id));
      return updateAction(action, { status: "approved", approval_principal_digest: stableDigest(principal), grant_digest: session.grant_digest });
    },
  };
}
