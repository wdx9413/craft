import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

/**
 * Pilot sessions are a projection over ordinary Tasks: they record the
 * conversation intake, the chosen concurrency limit, and the route (executor
 * template) chosen for each task. They never create a second Task store and
 * never grant execution authority. Intent splitting and supervision belong to
 * the Pilot model layer; this records what happened so a person can inspect and
 * reassign before a task starts.
 */
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function concurrency(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENCY) throw new Error(`concurrency must be an integer between 1 and ${MAX_CONCURRENCY}`);
  return parsed;
}

function confidence(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error("confidence must be a number between 0 and 1");
  return parsed;
}

export class PilotKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  openSession(args: JsonObject): JsonObject {
    const rawInput = nonEmpty(args.input, "input");
    const workspaceId = args.workspace_id === undefined || args.workspace_id === null ? null : nonEmpty(args.workspace_id, "workspace_id");
    if (workspaceId !== null) this.store.get("workspace", workspaceId);
    const id = String(args.session_id ?? `pilot_session_${createHash("sha256").update(digestJson({ rawInput, workspaceId })).digest("hex").slice(0, 20)}`);
    const existing = this.store.find("pilot_session", id);
    if (existing) return { session: existing, idempotent: true };
    return { session: this.store.create("pilot_session", id, {
      workspace_id: workspaceId, input_digest: digestJson(rawInput), input_chars: rawInput.length,
      concurrency_limit: concurrency(args.concurrency), status: "open", content_stored: false,
    }), idempotent: false };
  }

  getSession(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const session = this.store.get("pilot_session", sessionId);
    const routes = this.store.list("pilot_route", 1_000, (item) => item.session_id === sessionId);
    return { session, routes };
  }

  closeSession(args: JsonObject): JsonObject {
    const session = this.store.get("pilot_session", nonEmpty(args.session_id, "session_id"));
    return { session: this.store.save("pilot_session", String(session.id), { ...payload(session), status: "closed", closed_at: new Date().toISOString() }) };
  }

  /** Record the executor template chosen for a task in a session. */
  routeTask(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    this.store.get("pilot_session", sessionId);
    const taskId = nonEmpty(args.task_id, "task_id");
    this.store.get("task", taskId);
    const executor = nonEmpty(args.executor_template, "executor_template");
    const reason = nonEmpty(args.reason, "reason");
    const conf = confidence(args.confidence);
    const id = String(args.route_id ?? `pilot_route_${createHash("sha256").update(digestJson({ sessionId, taskId })).digest("hex").slice(0, 20)}`);
    const existing = this.store.find("pilot_route", id);
    if (existing) return { route: existing, idempotent: true };
    const entry = { executor_template: executor, reason, confidence: conf, at: new Date().toISOString() };
    return { route: this.store.create("pilot_route", id, { session_id: sessionId, task_id: taskId,
      executor_template: executor, reason, confidence: conf, status: "assigned", queue_state: "queued", history: [entry] }), idempotent: false };
  }

  /** Reassign a task's executor before it starts, preserving every prior route. */
  reassign(args: JsonObject): JsonObject {
    const routeId = nonEmpty(args.route_id, "route_id");
    const executor = nonEmpty(args.executor_template, "executor_template");
    const reason = nonEmpty(args.reason, "reason");
    const conf = confidence(args.confidence);
    return this.store.transaction(() => {
      const route = this.store.get("pilot_route", routeId);
      if (route.status !== "assigned") throw new Error("only an assigned route can be reassigned");
      const history = Array.isArray(route.history) ? [...(route.history as JsonObject[])] : [];
      history.push({ executor_template: executor, reason, confidence: conf, at: new Date().toISOString() });
      return { route: this.store.save("pilot_route", routeId, { ...payload(route), executor_template: executor,
        reason, confidence: conf, status: "assigned", reassignment_count: history.length - 1, history }) };
    });
  }

  /** Mark a route as started so it can no longer be reassigned without a new task. */
  start(args: JsonObject): JsonObject {
    const route = this.store.get("pilot_route", nonEmpty(args.route_id, "route_id"));
    if (route.status !== "assigned") throw new Error("only an assigned route can start");
    return { route: this.store.save("pilot_route", String(route.id), { ...payload(route), status: "started", queue_state: "running",
      started_at: new Date().toISOString() }) };
  }

  /**
   * Admit queued routes up to the session's concurrency limit, oldest first.
   * Returns which routes became runnable; a caller dispatches exactly those.
   * Nothing is dropped — routes past the limit stay "queued".
   */
  schedule(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const session = this.store.get("pilot_session", sessionId);
    const limit = Number(session.concurrency_limit) || DEFAULT_CONCURRENCY;
    const routes = this.store.list("pilot_route", 1_000, (item) => item.session_id === sessionId);
    const running = routes.filter((item) => item.queue_state === "running");
    const queued = routes.filter((item) => item.queue_state === "queued")
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const admitted: JsonObject[] = [];
    return this.store.transaction(() => {
      for (const route of queued) {
        if (running.length + admitted.length >= limit) break;
        admitted.push(this.store.save("pilot_route", String(route.id), { ...payload(route), queue_state: "running",
          started_at: new Date().toISOString() }));
      }
      return { admitted, running: running.length + admitted.length, queued: queued.length - admitted.length,
        limit };
    });
  }

  /** Release a running route's slot when its task finishes (any terminal state). */
  finish(args: JsonObject): JsonObject {
    const route = this.store.get("pilot_route", nonEmpty(args.route_id, "route_id"));
    if (route.queue_state !== "running") throw new Error("only a running route can finish");
    return { route: this.store.save("pilot_route", String(route.id), { ...payload(route), queue_state: "finished",
      finished_at: new Date().toISOString() }) };
  }

  /** Snapshot the queue for a session: running, queued and finished counts plus the limit. */
  queue(args: JsonObject): JsonObject {
    const sessionId = nonEmpty(args.session_id, "session_id");
    const session = this.store.get("pilot_session", sessionId);
    const routes = this.store.list("pilot_route", 1_000, (item) => item.session_id === sessionId);
    const bucket = (state: string) => routes.filter((item) => item.queue_state === state);
    return { session, limit: Number(session.concurrency_limit) || DEFAULT_CONCURRENCY,
      running: bucket("running"), queued: bucket("queued"), finished: bucket("finished") };
  }

  /**
   * Supervise one step boundary. Deterministic rules are a hard gate (pause or
   * block); the supervision model only contributes advice. A model suggestion can
   * never pass or block on its own — the verdict comes solely from the rules.
   */
  supervise(args: JsonObject): JsonObject {
    const routeId = nonEmpty(args.route_id, "route_id");
    const route = this.store.get("pilot_route", routeId);
    const profileId = nonEmpty(args.supervisor_profile_id, "supervisor_profile_id");
    const profile = this.store.get("supervisor_profile", profileId);
    const signals = objectArg(args.signals, "signals");
    const rules = Array.isArray(profile.deterministic_rules) ? profile.deterministic_rules as JsonObject[] : [];
    const triggered = rules.filter((rule) => truthySignal(signals, String(rule.condition)));
    const block = triggered.find((rule) => rule.action === "block");
    const pause = triggered.find((rule) => rule.action === "pause");
    // Model advice is captured but explicitly stripped of authority.
    const advice = args.model_advice === undefined || args.model_advice === null ? null : nonEmpty(args.model_advice, "model_advice");
    const verdict = block ? "block" : pause ? "pause" : "pass";
    const saved = this.store.save("pilot_route", routeId, { ...payload(route),
      supervision: { profile_id: profileId, profile_version: profile.version, verdict,
        triggered_rule_ids: triggered.map((rule) => rule.id), model_advice: advice, model_has_authority: false, at: new Date().toISOString() } });
    return { route: saved, verdict, triggered_rule_ids: triggered.map((rule) => rule.id), model_advice: advice, model_has_authority: false };
  }
}

// A rule condition is a single signal name; it passes the hard gate when that
// signal is truthy. Kept deliberately small so "the model said so" can never be
// a condition.
function truthySignal(signals: JsonObject, condition: string): boolean {
  const key = condition.trim();
  if (!key) return false;
  const value = signals[key];
  return value === true || (typeof value === "string" && value.trim() !== "" && value !== "false");
}

function objectArg(value: unknown, name: string): JsonObject {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
