import { assertExecutionRootActive } from "./task-execution-fence.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { decimalSum } from "./control-plane.ts";
import { workRetryPolicy } from "./work-retry-policy.ts";

function positive(value: unknown, name: string, integer = false): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || (integer && (!Number.isSafeInteger(value) || value < 1000 || value > 86400000))) throw new Error(`${name} must be a positive ${integer ? "integer between 1000 and 86400000" : "finite number"}`);
  return value;
}
function balance(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Attempt budget ledger is corrupt");
  return value;
}
export function prepareAttemptBudget(store: CraftStore, args: JsonObject, launchId: string, now = Date.now()): { contract: JsonObject | null; maxBudgetUsd: unknown } {
  const totalTime = positive(args.total_timeout_ms, "total_timeout_ms", true), totalUsd = positive(args.total_budget_usd, "total_budget_usd");
  let contract: JsonObject | null;
  if (args.retry_of !== undefined) {
    const previous = store.get("work_launch", String(args.retry_of));
    const root = store.get("work_launch", String(workRetryPolicy(store, previous).root_launch_id));
    contract = (root.attempt_budget as JsonObject | undefined) ?? null;
    if (totalTime !== null || totalUsd !== null) throw new Error("Retry inherits its original total budget; new limits require a new plan");
    if (contract) {
      const snapshot = workAttemptBudget(store, previous, now)!;
      if (snapshot.exhausted || snapshot.unknown_reservations) throw new Error("Attempt budget is exhausted or unresolved; reconcile or replan before retry");
    }
  } else contract = totalTime === null && totalUsd === null ? null : { root_launch_id: launchId, total_timeout_ms: totalTime, total_budget_usd: totalUsd, deadline_at: totalTime === null ? null : new Date(now + totalTime).toISOString() };
  if (!contract) return { contract: null, maxBudgetUsd: args.max_budget_usd };
  if (contract.total_budget_usd !== null && args.host !== "internal") throw new Error("Cumulative USD limits require the internal Host with trusted pricing and quotes");
  const remaining = args.retry_of === undefined ? contract.total_budget_usd : workAttemptBudget(store, store.get("work_launch", String(args.retry_of)), now)!.remaining_usd;
  return { contract, maxBudgetUsd: remaining === null ? args.max_budget_usd : Math.min(Number(remaining), args.max_budget_usd == null ? Number(remaining) : Number(args.max_budget_usd)) };
}
export function workAttemptBudget(store: CraftStore, launch: JsonObject, now = Date.now()): JsonObject | null {
  const policy = workRetryPolicy(store, launch), root = store.get("work_launch", String(policy.root_launch_id));
  const contract = root.attempt_budget as JsonObject | undefined;
  if (!contract) return null;
  const totalUsd = positive(contract.total_budget_usd, "stored total_budget_usd"), totalTime = positive(contract.total_timeout_ms, "stored total_timeout_ms", true);
  const deadline = contract.deadline_at === null ? null : Date.parse(String(contract.deadline_at));
  if (contract.total_budget_usd === undefined || contract.total_timeout_ms === undefined || contract.root_launch_id !== root.id || (totalTime !== null && (deadline === null || !Number.isFinite(deadline))) || (totalTime === null && deadline !== null)) throw new Error("Attempt budget contract is corrupt");
  let spent = 0, reserved = 0, unknown = 0, current = root;
  const visited = new Set<string>();
  if (totalUsd !== null) while (true) {
    if (visited.has(String(current.id)) || visited.size >= 1000 || current.task_id !== root.task_id) throw new Error("Attempt budget descendants are corrupt");
    visited.add(String(current.id));
    if (current.host !== "internal") throw new Error("Cumulative USD ancestry contains an unsupported Host");
    const account = store.find("budget_account", `internal_budget_${current.dispatch_id}`);
    if (account) {
      if (account.owner_type !== "internal_dispatch" || account.owner_id !== current.dispatch_id) throw new Error("Attempt budget ledger ownership is corrupt");
      const used = balance((account.used as JsonObject).usd), held = balance((account.reserved as JsonObject).usd);
      spent = decimalSum(spent, used); reserved = decimalSum(reserved, held);
      unknown += store.list("budget_reservation", Number.MAX_SAFE_INTEGER, item => item.budget_id === account.id && item.status === "reserved").length;
    } else {
      const dispatch = store.get("internal_dispatch", String(current.dispatch_id));
      if (Number(dispatch.turns_started ?? 0) > 0) throw new Error("Attempt budget ledger is missing after model admission");
    }
    const children = store.list("work_launch", 2, item => item.retry_of === current.id);
    if (children.length > 1) throw new Error("Attempt budget has competing successors");
    if (!children.length) break;
    current = children[0]!;
  }
  const remainingUsd = totalUsd === null ? null : decimalSum(totalUsd, -spent, -reserved);
  const remainingMs = deadline === null ? null : Math.max(0, deadline - now);
  return { ...contract, spent_usd: totalUsd === null ? null : spent, reserved_usd: totalUsd === null ? null : reserved, remaining_usd: remainingUsd, unknown_reservations: unknown, remaining_ms: remainingMs, exhausted: (remainingUsd !== null && remainingUsd <= 0) || remainingMs === 0 };
}
export function assertAttemptBudget(store: CraftStore, launch: JsonObject, now = Date.now()): JsonObject | null {
  assertExecutionRootActive(store, launch);
  const budget = workAttemptBudget(store, launch, now);
  if (budget && (budget.exhausted || budget.unknown_reservations)) throw new Error("Attempt budget is exhausted or unresolved; reconcile or replan before dispatch");
  return budget;
}

/** Bind direct driver calls to their shared launch contract as well as Host Run calls. */
export function attemptBudgetSignal(store: CraftStore, dispatch: JsonObject, signal?: AbortSignal): AbortSignal | undefined {
  const launches = store.list("work_launch", 2, item => item.dispatch_id === dispatch.id);
  if (!launches.length) return signal;
  if (launches.length !== 1) throw new Error("Dispatch has ambiguous attempt budget ownership");
  const budget = assertAttemptBudget(store, launches[0]!);
  if (!budget || budget.deadline_at === null) return signal;
  const deadline = AbortSignal.timeout(Math.max(0, Date.parse(String(budget.deadline_at)) - Date.now()));
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}
