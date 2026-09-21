import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { payload, stableDigest } from "../../digest.ts";

type Disposition = "ready" | "blocked" | "needs_human";
type ForgeAction = "worktree" | "draft_pr" | "merge";

const ACTIONS = new Set<ForgeAction>(["worktree", "draft_pr", "merge"]);
const HIGH_RISK_LABELS = new Set(["security", "compliance", "production", "destructive"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const values = [...new Set(value.map((item) => text(item, name)))].sort();
  if (values.length < minimum) throw new Error(`${name} must contain at least ${minimum} item`);
  return values;
}

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

function issueDisposition(issue: JsonObject, repositoryReady: boolean): { disposition: Disposition; reasons: string[] } {
  const labels = strings(issue.labels ?? [], "issue.labels").map((item) => item.toLowerCase());
  const dependencies = Array.isArray(issue.dependencies) ? issue.dependencies.map((item) => object(item, "issue.dependencies")) : [];
  if (String(issue.state ?? "open") !== "open") return { disposition: "blocked", reasons: ["issue_not_open"] };
  if (!repositoryReady) return { disposition: "blocked", reasons: ["repository_not_ready"] };
  if (issue.requires_human === true || String(issue.risk ?? "low") !== "low" || labels.some((label) => HIGH_RISK_LABELS.has(label))) {
    return { disposition: "needs_human", reasons: ["risk_or_human_review"] };
  }
  if (dependencies.some((dependency) => dependency.resolved !== true)) return { disposition: "blocked", reasons: ["dependency_unresolved"] };
  if (issue.acceptance_defined !== true) return { disposition: "needs_human", reasons: ["acceptance_missing"] };
  return { disposition: "ready", reasons: [] };
}

/**
 * Read-only ticket classification and the hand-off to an externally owned Forge
 * adapter.  It deliberately has no network client and cannot create a worktree,
 * PR or merge by itself.  Experience proposes the Procedure; this coordinator
 * only proves whether a bounded dispatch is ready and records the authority a
 * separately configured Host/Forge Adapter must still consume.
 */
export class ForgeDispatchCoordinator {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  scan(args: JsonObject): JsonObject {
    const repository = text(args.repository, "repository");
    const sourceRef = text(args.source_ref, "source_ref");
    const scope = text(args.scope, "scope");
    const state = object(args.repository_state ?? {}, "repository_state");
    const repositoryReady = state.clean === true && state.default_branch_protected === true;
    const sourceIssues = Array.isArray(args.issues) ? args.issues : (() => { throw new Error("issues must be an array"); })();
    const entries = sourceIssues.map((value) => {
      const issue = object(value, "issues"); const ticketId = text(issue.ticket_id, "issue.ticket_id");
      const classified = issueDisposition(issue, repositoryReady);
      return { ticket_id: ticketId, disposition: classified.disposition, reasons: classified.reasons,
        labels: strings(issue.labels ?? [], "issue.labels"), risk: String(issue.risk ?? "low"),
        dependencies: Array.isArray(issue.dependencies) ? issue.dependencies.map((item) => object(item, "issue.dependencies")) : [],
        acceptance_defined: issue.acceptance_defined === true, issue_digest: stableDigest(issue) };
    }).sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
    if (new Set(entries.map((entry) => entry.ticket_id)).size !== entries.length) throw new Error("issues must have unique ticket_id values");
    const identity = { repository, scope, source_ref: sourceRef, repository_state: state, issue_digests: entries.map((entry) => ({ ticket_id: entry.ticket_id, digest: entry.issue_digest })) };
    const ledgerId = String(args.ledger_id ?? `ticket_dispatch_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("ticket_dispatch_ledger", ledgerId);
    const digest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== digest) throw new Error("Ticket Dispatch ledger idempotency conflict");
      return { ledger: existing, idempotent: true };
    }
    const counts = Object.fromEntries((["ready", "blocked", "needs_human"] as const).map((kind) => [kind, entries.filter((entry) => entry.disposition === kind).length]));
    return { ledger: this.store.create("ticket_dispatch_ledger", ledgerId, { ...identity, identity_digest: digest, entries, counts,
      read_only: true, raw_issue_content_stored: false, scanned_at: new Date().toISOString() }), idempotent: false };
  }

  evaluate(args: JsonObject): JsonObject {
    const ledger = this.store.get("ticket_dispatch_ledger", text(args.ledger_id, "ledger_id"));
    const cases = Array.isArray(args.cases) ? args.cases.map((item) => object(item, "cases")) : (() => { throw new Error("cases must be an array"); })();
    if (!cases.length) throw new Error("cases must contain at least 1 item");
    const entries = new Map((ledger.entries as JsonObject[]).map((entry) => [String(entry.ticket_id), entry]));
    const rows = cases.map((item) => {
      const ticketId = text(item.ticket_id, "case.ticket_id"); const expected = text(item.expected, "case.expected");
      if (!["ready", "blocked", "needs_human"].includes(expected)) throw new Error("case.expected is unsupported");
      const actual = entries.get(ticketId); if (!actual) throw new Error(`Ticket Dispatch case is absent from ledger: ${ticketId}`);
      return { ticket_id: ticketId, expected, actual: actual.disposition, passed: actual.disposition === expected };
    });
    const accuracy = rows.filter((row) => row.passed).length / rows.length;
    const minimumAccuracy = args.minimum_accuracy === undefined ? 1 : Number(args.minimum_accuracy);
    if (!Number.isFinite(minimumAccuracy) || minimumAccuracy <= 0 || minimumAccuracy > 1) throw new Error("minimum_accuracy must be in (0, 1]");
    const identity = { ledger_id: ledger.id, ledger_version: ledger.version, cases: rows.map((row) => ({ ticket_id: row.ticket_id, expected: row.expected })), minimum_accuracy: minimumAccuracy };
    const evaluationId = String(args.evaluation_id ?? `ticket_dispatch_eval_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("ticket_dispatch_evaluation", evaluationId);
    const digest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== digest) throw new Error("Ticket Dispatch evaluation idempotency conflict");
      return { evaluation: existing, idempotent: true };
    }
    return { evaluation: this.store.create("ticket_dispatch_evaluation", evaluationId, { ...identity, identity_digest: digest, rows, accuracy,
      status: accuracy >= minimumAccuracy ? "eligible" : "rejected", evaluated_at: new Date().toISOString(), evaluator: "deterministic" }), idempotent: false };
  }

  policySave(args: JsonObject): JsonObject {
    const kit = this.store.get("domain_kit", text(args.domain_kit_id, "domain_kit_id"), Number(args.domain_kit_version));
    const operations = strings(args.operations, "operations", 1) as ForgeAction[];
    if (operations.some((operation) => !ACTIONS.has(operation))) throw new Error("Forge Policy operation is unsupported");
    const identity = { scope: text(args.scope, "scope"), repositories: strings(args.repositories, "repositories", 1), branches: strings(args.branches, "branches", 1),
      operations, domain_kit_id: kit.id, domain_kit_version: kit.version,
      auto_merge_enabled: bool(args.auto_merge_enabled, "auto_merge_enabled", false), require_ci_green: bool(args.require_ci_green, "require_ci_green", true),
      require_protected_branch: bool(args.require_protected_branch, "require_protected_branch", true) };
    if (identity.auto_merge_enabled && !operations.includes("merge")) throw new Error("auto_merge_enabled requires merge operation");
    const policyId = String(args.policy_id ?? `forge_policy_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("forge_policy", policyId); const digest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== digest) throw new Error("Forge Policy idempotency conflict"); return { policy: existing, idempotent: true }; }
    return { policy: this.store.create("forge_policy", policyId, { ...identity, identity_digest: digest, status: "active", created_at: new Date().toISOString() }), idempotent: false };
  }

  actionPrepare(args: JsonObject): JsonObject {
    const action = text(args.action, "action") as ForgeAction; if (!ACTIONS.has(action)) throw new Error("Forge action is unsupported");
    const policy = this.store.get("forge_policy", text(args.policy_id, "policy_id"));
    const ledger = this.store.get("ticket_dispatch_ledger", text(args.ledger_id, "ledger_id"));
    const evaluation = this.store.get("ticket_dispatch_evaluation", text(args.evaluation_id, "evaluation_id"));
    const procedure = this.store.get("experience_procedure", text(args.procedure_id, "procedure_id"));
    const application = this.store.get("domain_kit_application", text(args.kit_application_id, "kit_application_id"));
    const taskId = text(args.task_id, "task_id"); const branch = text(args.branch, "branch");
    const ticketId = text(args.ticket_id, "ticket_id"); const entry = (ledger.entries as JsonObject[]).find((item) => item.ticket_id === ticketId);
    const repositories = strings(policy.repositories, "policy.repositories", 1);
    const operations = strings(policy.operations, "policy.operations", 1);
    const branches = strings(policy.branches, "policy.branches", 1);
    if (policy.status !== "active" || !repositories.includes(String(ledger.repository)) || !branches.includes(branch) || !operations.includes(action)) throw new Error("Forge action is outside the active project policy");
    if (application.status !== "active" || application.kit_id !== policy.domain_kit_id || Number(application.kit_version) !== Number(policy.domain_kit_version)) throw new Error("Forge action requires the policy Domain Kit application");
    if (typeof application.launch_id !== "string") throw new Error("Forge action requires a Domain Kit application bound to a Work Launch");
    const launch = this.store.get("work_launch", application.launch_id);
    if (launch.task_id !== taskId) throw new Error("Forge action Task does not match the Domain Kit application");
    if (evaluation.status !== "eligible" || evaluation.ledger_id !== ledger.id || Number(evaluation.ledger_version) !== Number(ledger.version)) throw new Error("Forge action requires an eligible same-ledger evaluation");
    if (!entry || entry.disposition !== "ready") throw new Error("Forge action requires a ready ticket");
    if (procedure.lifecycle !== "routeable" || procedure.routeable !== true) throw new Error("Forge action requires a routeable Experience Procedure");
    const approvalRef = text(args.approval_ref, "approval_ref");
    if (action === "merge") {
      if (policy.auto_merge_enabled !== true || policy.require_ci_green !== true || policy.require_protected_branch !== true
        || (ledger.repository_state as JsonObject).ci_green !== true || (ledger.repository_state as JsonObject).default_branch_protected !== true) {
        throw new Error("Forge merge requires an explicitly enabled policy, green CI and protected branch");
      }
    }
    const identity = { action, policy_id: policy.id, policy_version: policy.version, ledger_id: ledger.id, ledger_version: ledger.version,
      evaluation_id: evaluation.id, evaluation_version: evaluation.version, ticket_id: ticketId, branch, procedure_id: procedure.id, procedure_version: procedure.version,
      kit_application_id: application.id, kit_application_version: application.version, task_id: taskId, approval_ref: approvalRef };
    const actionId = String(args.forge_action_id ?? `forge_action_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("forge_action", actionId); const digest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== digest) throw new Error("Forge action idempotency conflict"); return { action: existing, idempotent: true }; }
    return { action: this.store.create("forge_action", actionId, { ...identity, identity_digest: digest,
      effect: action === "worktree" ? "local_write" : action === "draft_pr" ? "external_write" : "destructive",
      status: "prepared_for_adapter", execution_authority: false, adapter_dispatch: "unavailable", raw_ticket_content_stored: false,
      next_action: "configured_host_or_forge_adapter_must_revalidate_and_consume_authority", prepared_at: new Date().toISOString() }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { action: this.store.get("forge_action", text(args.forge_action_id, "forge_action_id")) }; }
}
