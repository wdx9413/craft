import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import { EvalCampaignKernel } from "./eval-campaign.ts";

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${name} must contain at least ${minimum} values`);
  const values = value.map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values.sort();
}
function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return result;
}
function instant(value: unknown, name: string): number {
  const result = value === undefined ? Date.now() : Date.parse(text(value, name));
  if (Number.isNaN(result)) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function payload(record: JsonObject): JsonObject {
  const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record;
  return rest;
}

/**
 * Operations layer for reviewed, redacted real-world evaluation cases. It only
 * schedules pinned Campaigns; a Host must still claim and run every slot.
 */
export class EvaluationOperationsKernel {
  readonly store: CraftStore;
  readonly campaigns: EvalCampaignKernel;
  constructor(store: CraftStore, campaigns: EvalCampaignKernel) { this.store = store; this.campaigns = campaigns; }

  programSave(args: JsonObject): JsonObject {
    const developmentCaseIds = strings(args.development_case_ids, "development_case_ids", 1);
    const heldOutCaseIds = strings(args.held_out_case_ids, "held_out_case_ids", 1);
    if (developmentCaseIds.some((id) => heldOutCaseIds.includes(id))) throw new Error("Evaluation Program case partitions must not overlap");
    this.validateCases(developmentCaseIds, "development"); this.validateCases(heldOutCaseIds, "held_out");
    const definition = {
      name: text(args.name, "name"), owner_ref: text(args.owner_ref, "owner_ref"), reviewer_ref: text(args.reviewer_ref, "reviewer_ref"),
      domain_terms: strings(args.domain_terms ?? [], "domain_terms", 0).slice(0, 12), development_case_ids: developmentCaseIds,
      held_out_case_ids: heldOutCaseIds, cadence_hours: integer(args.cadence_hours, "cadence_hours", 168, 1, 8_760),
      lifecycle: args.lifecycle === undefined ? "active" : text(args.lifecycle, "lifecycle"),
    };
    if (!new Set(["active", "paused"]).has(definition.lifecycle)) throw new Error("Evaluation Program lifecycle is unsupported");
    const programId = text(args.program_id, "program_id"); const existing = this.store.find("evaluation_program", programId); const definitionDigest = digest(definition);
    if (existing) {
      if (existing.definition_digest !== definitionDigest) throw new Error("Evaluation Program idempotency conflict");
      return { program: existing, idempotent: true };
    }
    return { program: this.store.create("evaluation_program", programId, { ...definition, definition_digest: definitionDigest, last_planned_at: null }), idempotent: false };
  }

  due(args: JsonObject): JsonObject {
    const program = this.store.get("evaluation_program", text(args.program_id, "program_id")); const now = instant(args.now, "now");
    if (program.lifecycle !== "active") return { program, due: false, reason: "program_paused" };
    const last = program.last_planned_at === null ? null : Date.parse(String(program.last_planned_at));
    const dueAt = last === null ? now : last + Number(program.cadence_hours) * 3_600_000;
    return { program, due: dueAt <= now, due_at: new Date(dueAt).toISOString(), reason: dueAt <= now ? "scheduled" : "cadence_not_elapsed" };
  }

  plan(args: JsonObject): JsonObject {
    const program = this.store.get("evaluation_program", text(args.program_id, "program_id")); const now = instant(args.now, "now");
    const due = this.due({ program_id: program.id, now: new Date(now).toISOString() });
    if (due.due !== true) throw new Error(`Evaluation Program is not due: ${String(due.reason)}`);
    const partition = args.partition === undefined ? "development" : text(args.partition, "partition");
    if (!new Set(["development", "held_out"]).has(partition)) throw new Error("Evaluation Program partition is unsupported");
    if (partition === "held_out" && text(args.independent_approval_ref, "independent_approval_ref") === program.owner_ref) throw new Error("Held-out planning requires an independent approval reference");
    const baselineHarness = text(args.baseline_harness, "baseline_harness"); const candidateHarness = text(args.candidate_harness, "candidate_harness");
    if (baselineHarness === candidateHarness) throw new Error("Evaluation Program requires distinct baseline and candidate Harnesses");
    const caseIds = partition === "development" ? program.development_case_ids as string[] : program.held_out_case_ids as string[];
    const environment = object(args.environment, "environment"); const budget = object(args.budget, "budget");
    const trials = integer(args.trials_per_case, "trials_per_case", 2, 1, 20); const environmentDigest = digest(environment); const budgetDigest = digest(budget);
    const campaign = partition === "held_out" ? this.campaigns.create({ campaign_id: String(args.campaign_id ?? `evaluation_program_campaign_${program.id}_${partition}_${now}`),
      case_ids: caseIds, baseline_harness: baselineHarness, candidate_harness: candidateHarness, trials_per_case: trials,
      acceptance_ref: text(args.acceptance_ref, "acceptance_ref"), environment, budget }).campaign as JsonObject : null;
    // Planning updates operational fields such as last_planned_at.  Bind a run to
    // the immutable definition rather than that mutable record version, so a
    // retry of the same plan remains idempotent.
    const runIdentity = { program_id: program.id, program_definition_digest: program.definition_digest, partition, case_ids: caseIds, baseline_harness: baselineHarness,
      candidate_harness: candidateHarness, trials_per_case: trials, campaign_id: campaign?.id ?? null, campaign_version: campaign?.version ?? null,
      environment_digest: campaign?.environment_digest ?? environmentDigest, budget_digest: campaign?.budget_digest ?? budgetDigest };
    const runId = String(args.program_run_id ?? `evaluation_program_run_${program.id}_${digest(runIdentity).slice(-16)}`); const existing = this.store.find("evaluation_program_run", runId); const runDigest = digest(runIdentity);
    if (existing) {
      if (existing.run_digest !== runDigest) throw new Error("Evaluation Program Run idempotency conflict");
      return { program, campaign, run: existing, idempotent: true };
    }
    const run = this.store.create("evaluation_program_run", runId, { ...runIdentity, run_digest: runDigest, planned_by: text(args.planned_by, "planned_by"),
      independent_approval_ref: args.independent_approval_ref ?? null, planned_at: new Date(now).toISOString(), status: partition === "held_out" ? "planned" : "development_ready", raw_business_content_stored: false });
    const saved = this.store.save("evaluation_program", String(program.id), { ...payload(program), last_planned_at: new Date(now).toISOString(), last_program_run_id: run.id });
    return { program: saved, campaign, run, next_action: campaign ? "create_campaign_runner_and_claim_one_host_slot" : "prepare_development_trials_with_explicit_host", idempotent: false };
  }

  report(args: JsonObject): JsonObject {
    const program = this.store.get("evaluation_program", text(args.program_id, "program_id"));
    const runs = this.store.list("evaluation_program_run", 1_000, (item) => item.program_id === program.id)
      .sort((left, right) => String(right.planned_at).localeCompare(String(left.planned_at)));
    const campaigns = runs.filter((run) => run.campaign_id !== null).map((run) => this.store.get("eval_campaign", String(run.campaign_id), Number(run.campaign_version)));
    return { program, runs, campaigns, due: this.due({ program_id: program.id }) };
  }

  private validateCases(ids: string[], partition: string): void {
    for (const id of ids) {
      const item = this.store.get("delivery_evaluation_case", id);
      if (item.partition !== partition || item.sanitized !== true) throw new Error(`Evaluation Program requires sanitized ${partition} Cases`);
      if (partition === "held_out" && !item.approved_by) throw new Error("Held-out Evaluation Case is missing independent approval");
    }
  }
}
