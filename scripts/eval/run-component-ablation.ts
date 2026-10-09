import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { prepareAblations } from "./component-ablation.ts";
import { digestJson } from "../../core/digest.ts";
import { object, text } from "../../core/validation.ts";
import { ContextHostEvaluation } from "../../core/context-host-evaluation.ts";

export type AblationHost = { preflight(environment?: JsonObject, budget?: JsonObject): Promise<JsonObject>; execute(dispatch: JsonObject, environment: JsonObject, budget: JsonObject): Promise<string>; observeContext?(taskRunId: string): Promise<JsonObject> };

/** One actual TaskRun per issued slot. Interrupted/unbound dispatches require explicit reconciliation. */
export async function runAblations(service: CraftService, manifest: JsonObject, host: AblationHost): Promise<JsonObject> {
  const environment = object(manifest.environment, "environment"), budget = object(manifest.budget, "budget");
  const preflight = await host.preflight(environment, budget);
  if (preflight.ready !== true) return { preflight, status: "blocked", model_effect_proven: false };
  for (const field of ["data_snapshot_digest", "tool_schema_digest", "model_fingerprint", "host_fingerprint"]) text(environment[field], field);
  if (preflight.environment_digest !== digestJson(environment) || preflight.budget_digest !== digestJson(budget)) return { preflight, status: "blocked", reason: "observed_environment_or_budget_mismatch", model_effect_proven: false };
  const hostEvaluation = new ContextHostEvaluation(service.store);
  const contract = manifest.context_host_contract === undefined ? null : hostEvaluation.registerHost(object(manifest.context_host_contract, "context_host_contract"));
  if (contract && !host.observeContext) throw new Error("Host contract requires actual Context observation adapter");
  const emissions: JsonObject[] = [];
  const pending = service.store.list("context_host_observation_pending", 100, item => item.status === "pending");
  if (pending.length) return { preflight, status: "reconciliation_required", pending_context_run_ids: pending.map(item => item.id), model_effect_proven: false };
  const prepared = prepareAblations(service, manifest), results: JsonObject[] = [];
  for (const entry of prepared.campaigns as JsonObject[]) {
    const runner = service.campaignRunners.create({ campaign_id: entry.campaign_id, evaluator_ref: text(manifest.acceptance_ref, "acceptance_ref") }).runner as JsonObject;
    const outstanding = (service.campaignRunners.get({ runner_id: runner.id }).dispatches as JsonObject[]).filter(dispatch => dispatch.status === "issued");
    if (outstanding.length) return { preflight, results, status: "reconciliation_required", dispatch_ids: outstanding.map(dispatch => dispatch.id), model_effect_proven: false };
    while (true) {
      const claimed = service.campaignRunners.claim({ runner_id: runner.id }), dispatch = claimed.dispatch as JsonObject | null;
      if (!dispatch) break;
      try {
        const runId = await host.execute(dispatch, object(manifest.environment, "environment"), object(manifest.budget, "budget"));
        service.campaignRunners.bind({ dispatch_id: dispatch.id, task_run_id: text(runId, "task_run_id") });
        if (contract) {
          service.store.create("context_host_observation_pending", runId, { status: "pending", contract_id: contract.id, dispatch_id: dispatch.id });
          emissions.push(hostEvaluation.recordEmission({ ...await host.observeContext!(runId), contract_id: contract.id, task_run_id: runId }));
        }
      } catch {
        return { preflight, results, status: "reconciliation_required", dispatch_ids: [dispatch.id], model_effect_proven: false };
      }
    }
    const slots = (service.evalCampaignGet({ campaign_id: entry.campaign_id }).slots as JsonObject[]);
    const missingOutcomes = slots.filter(slot => {
      const run = service.store.get("task_run", String(slot.task_run_id));
      return !run.launch_id || service.store.list("work_delivery", 1, delivery => delivery.launch_id === run.launch_id).length === 0;
    });
    if (missingOutcomes.length) return { preflight, results, status: "awaiting_actual_outcomes", campaign_id: entry.campaign_id, missing_slot_ids: missingOutcomes.map(slot => slot.id), model_effect_proven: false };
    const advanced = service.campaignRunners.advance({ runner_id: runner.id });
    results.push({ arm: entry.arm, campaign_id: entry.campaign_id, status: (advanced.campaign as JsonObject).status, report: service.evalCampaignReport({ campaign_id: entry.campaign_id }) });
  }
  return { preflight, results, context_emissions: emissions, status: "graded", model_effect_proven: false, promotion_automatic: false };
}

/** Explicit argv adapter; stdout contains only a TaskRun ID, never self-reported scores. */
export function commandAblationHost(configuration: JsonObject): AblationHost {
  const argv = configuration.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(value => typeof value !== "string" || !value)) throw new Error("Host argv required");
  const timeout = Number(configuration.timeout_ms ?? 600_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3_600_000) throw new Error("Host timeout invalid");
  const run = (input: JsonObject, timeoutMs: number) => {
    const output = spawnSync(String(argv[0]), argv.slice(1) as string[], { input: JSON.stringify(input), encoding: "utf8", timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    if (output.error || output.status !== 0) throw new Error("Host adapter failed; reconcile issued dispatch before retry");
    return object(JSON.parse(output.stdout), "Host response");
  };
  return { async preflight(environment = {}, budget = {}) { try { return run({ action: "preflight", environment, budget }, Math.min(timeout, 10_000)); } catch { return { ready: false, reason: "host_preflight_failed" }; } },
    async execute(dispatch, environment, budget) { return text(run({ action: "execute", dispatch, environment, budget }, timeout).task_run_id, "task_run_id"); },
    ...(configuration.observe_context === true ? { async observeContext(taskRunId: string) { return run({ action: "observe_context", task_run_id: taskRunId }, Math.min(timeout, 10_000)); } } : {}) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: node scripts/eval/run-component-ablation.ts DATA_DIR manifest.json");
  const manifest = JSON.parse(readFileSync(process.argv[3], "utf8")) as JsonObject;
  const store = await new CraftStore(craftPaths(resolve(process.argv[2]))).open();
  try { process.stdout.write(JSON.stringify(await runAblations(new CraftService(store), manifest, commandAblationHost(object(manifest.host_adapter, "host_adapter"))), null, 2) + "\n"); }
  finally { store.close(); }
}
