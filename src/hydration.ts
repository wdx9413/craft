import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim();
}
function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return result;
}
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result;
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`); return result;
}
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest;
}
function fingerprint(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function reference(record: JsonObject): JsonObject { return { id: record.id, version: record.version }; }

export class HydrationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  capture(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    if (!new Set(["active", "paused"]).has(String(task.status))) throw new Error("Only an active or paused task can be dehydrated");
    const workspace = args.workspace_id === undefined ? null : this.store.get("workspace", text(args.workspace_id, "workspace_id"));
    const wait = args.wait_id === undefined ? null : this.store.get("durable_wait", text(args.wait_id, "wait_id"));
    const run = args.runtime_run_id === undefined ? null : this.store.get("runtime_run", text(args.runtime_run_id, "runtime_run_id"));
    if (!workspace && !wait && !run) throw new Error("A dehydration snapshot requires workspace, wait, or runtime state");
    for (const item of [wait, run]) if (item && item.task_id !== task.id) throw new Error("Snapshot runtime state must belong to the task");
    if (wait?.workspace_id && workspace?.id !== wait.workspace_id) throw new Error("Snapshot workspace does not match the durable wait");
    const budgetIds = strings(args.budget_ids, "budget_ids"); const recoveryIds = strings(args.recovery_item_ids, "recovery_item_ids");
    const budgets = budgetIds.map((id) => this.store.get("budget_account", id));
    if (budgets.some((budget) => budget.status !== "active" || (budget.owner_id !== task.id && budget.owner_id !== run?.id))) {
      throw new Error("Snapshot budgets must be active and owned by the task or runtime run");
    }
    const recovery = recoveryIds.map((id) => this.store.get("recovery_item", id));
    if (recovery.some((item) => item.task_id !== task.id || !new Set(["open", "leased"]).has(String(item.status)))) {
      throw new Error("Snapshot recovery items must be active and belong to the task");
    }
    const now = instant(args.now, "now"); const ttl = integer(args.ttl_seconds, "ttl_seconds", 604800, 60, 2592000);
    const state = { task: reference(task), workspace: workspace ? { ...reference(workspace), state_revision: workspace.state_revision,
      latest_checkpoint_id: workspace.latest_checkpoint_id ?? null } : null,
    wait: wait ? { ...reference(wait), status: wait.status, policy_fingerprint: wait.policy_fingerprint ?? null } : null,
    runtime_run: run ? { ...reference(run), status: run.status, policy_fingerprint: run.policy_fingerprint ?? null,
      environment_fingerprint: run.environment_fingerprint ?? null } : null,
    budgets: budgets.map((item) => ({ ...reference(item), status: item.status })), recovery_items: recovery.map(reference) };
    const snapshotId = String(args.snapshot_id ?? `dehydration_${randomUUID().replaceAll("-", "")}`); const stateFingerprint = fingerprint(state);
    const existing = this.store.find("dehydration_snapshot", snapshotId);
    if (existing) {
      if (existing.state_fingerprint !== stateFingerprint) throw new Error("Dehydration snapshot idempotency conflict");
      return { snapshot: existing, idempotent: true };
    }
    const snapshot = this.store.create("dehydration_snapshot", snapshotId, { task_id: task.id, state,
      state_fingerprint: stateFingerprint, status: "frozen", captured_at: new Date(now).toISOString(),
      expires_at: new Date(now + ttl * 1000).toISOString(), raw_context_stored: false, credentials_stored: false });
    return { snapshot, idempotent: false };
  }

  inspect(args: JsonObject): JsonObject {
    const snapshot = this.store.get("dehydration_snapshot", text(args.snapshot_id, "snapshot_id"));
    const state = snapshot.state as JsonObject; const issues: JsonObject[] = []; const waitRef = state.wait as JsonObject | null;
    const taskRef = state.task as JsonObject; const task = this.store.find("task", String(taskRef.id));
    if (!task) issues.push({ component: "task", issue: "missing" });
    else if (Number(task.version) !== Number(taskRef.version)) issues.push({ component: "task", issue: "version_changed", current_version: task.version });
    const workspaceRef = state.workspace as JsonObject | null;
    if (workspaceRef) {
      const workspace = this.store.find("workspace", String(workspaceRef.id));
      if (!workspace) issues.push({ component: "workspace", issue: "missing" });
      else if (workspace.state_revision !== workspaceRef.state_revision) issues.push({ component: "workspace", issue: "state_revision_changed", current_revision: workspace.state_revision });
    }
    const runRef = state.runtime_run as JsonObject | null;
    if (runRef) {
      const run = this.store.find("runtime_run", String(runRef.id));
      if (!run) issues.push({ component: "runtime_run", issue: "missing" });
      else if (Number(run.version) !== Number(runRef.version)) issues.push({ component: "runtime_run", issue: "version_changed", current_version: run.version });
    }
    let waitStatus: string | null = null;
    if (waitRef) {
      const wait = this.store.find("durable_wait", String(waitRef.id)); waitStatus = wait ? String(wait.status) : "missing";
      if (!wait) issues.push({ component: "wait", issue: "missing" });
      else if (!new Set(["waiting", "resumed", "needs_replan"]).has(waitStatus)) issues.push({ component: "wait", issue: "terminal", status: waitStatus });
    }
    for (const budgetRef of state.budgets as JsonObject[]) {
      const budget = this.store.find("budget_account", String(budgetRef.id));
      if (!budget || budget.status !== "active") issues.push({ component: "budget", id: budgetRef.id, issue: budget ? "not_active" : "missing" });
    }
    const readiness = issues.length ? "needs_replan" : waitStatus === "waiting" ? "still_waiting" : "ready";
    return { snapshot, readiness, wait_status: waitStatus, issues };
  }

  claim(args: JsonObject): JsonObject {
    const snapshot = this.store.get("dehydration_snapshot", text(args.snapshot_id, "snapshot_id"));
    const expected = text(args.state_fingerprint, "state_fingerprint"); if (expected !== snapshot.state_fingerprint) throw new Error("Hydration state fingerprint mismatch");
    const now = instant(args.now, "now"); if (now > Date.parse(String(snapshot.expires_at))) throw new Error("Dehydration snapshot expired");
    const hostId = text(args.host_id, "host_id");
    if (snapshot.status === "hydrating") {
      if (snapshot.claimed_by === hostId && snapshot.claim_key === args.claim_key) return { snapshot, inspection: this.inspect(args), idempotent: true };
      throw new Error("Dehydration snapshot is already claimed");
    }
    if (snapshot.status !== "frozen") throw new Error("Dehydration snapshot is not claimable");
    const inspection = this.inspect(args); if (inspection.readiness === "still_waiting") return { snapshot, inspection, idempotent: true };
    const claimKey = text(args.claim_key, "claim_key"); const leaseId = `hydration_lease_${randomUUID().replaceAll("-", "")}`;
    const saved = this.store.updateIfVersion("dehydration_snapshot", String(snapshot.id), Number(snapshot.version), { ...payload(snapshot),
      status: "hydrating", lease_id: leaseId, claimed_by: hostId, claim_key: claimKey,
      lease_expires_at: new Date(now + integer(args.lease_ttl_seconds, "lease_ttl_seconds", 300, 30, 3600) * 1000).toISOString(),
      hydration_mode: inspection.readiness === "ready" ? "resume" : "replan" });
    return { snapshot: saved, inspection, dispatch: { snapshot_id: saved.id, lease_id: leaseId,
      mode: saved.hydration_mode, state: saved.state, raw_context_stored: false, credentials_stored: false }, idempotent: false };
  }

  report(args: JsonObject): JsonObject {
    const snapshot = this.store.get("dehydration_snapshot", text(args.snapshot_id, "snapshot_id"));
    if (snapshot.status !== "hydrating" || snapshot.lease_id !== args.lease_id || snapshot.claimed_by !== args.host_id) throw new Error("Hydration lease does not match");
    const now = instant(args.now, "now"); if (now > Date.parse(String(snapshot.lease_expires_at))) throw new Error("Hydration lease expired");
    const outcome = text(args.outcome, "outcome"); if (!new Set(["completed", "abandoned"]).has(outcome)) throw new Error("Hydration outcome is unsupported");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids");
    if (outcome === "completed" && !evidenceIds.length) throw new Error("Completed hydration requires Evidence");
    for (const evidenceId of evidenceIds) this.store.get("evidence", evidenceId);
    const saved = this.store.save("dehydration_snapshot", String(snapshot.id), { ...payload(snapshot),
      status: outcome === "completed" ? "hydrated" : "frozen", hydration_summary: text(args.summary, "summary"),
      hydration_evidence_ids: evidenceIds, hydrated_at: outcome === "completed" ? new Date(now).toISOString() : null,
      lease_id: null, claimed_by: null, claim_key: null, lease_expires_at: null });
    return { snapshot: saved };
  }

  recover(args: JsonObject): JsonObject {
    const now = instant(args.now, "now"); const limit = integer(args.limit, "limit", 100, 1, 1000); const recovered: JsonObject[] = [];
    for (const snapshot of this.store.list("dehydration_snapshot", 10_000, (item) => item.status === "hydrating" &&
      Date.parse(String(item.lease_expires_at)) <= now).slice(0, limit)) recovered.push(this.store.updateIfVersion("dehydration_snapshot",
        String(snapshot.id), Number(snapshot.version), { ...payload(snapshot), status: "frozen", lease_id: null,
          claimed_by: null, claim_key: null, lease_expires_at: null, last_recovered_at: new Date(now).toISOString() }));
    return { recovered, count: recovered.length };
  }
}
