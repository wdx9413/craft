import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CraftStore, type JsonObject } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { stableDigest } from "../../core/digest.ts";
import { object, text } from "../../core/validation.ts";

/** Reuse the actual campaign/receipt grader for all ablations, never grade reported scores. */
export function prepareAblations(service: CraftService, manifest: JsonObject): JsonObject {
  const environment = object(manifest.environment, "environment");
  for (const key of ["host", "model", "repository_revision"]) text(environment[key], key);
  const budget = object(manifest.budget, "budget");
  const harnesses = object(manifest.harnesses, "harnesses");
  const caseIds = manifest.case_ids;
  if (!Array.isArray(caseIds) || caseIds.length < 20 || caseIds.length > 100 || new Set(caseIds).size !== caseIds.length) throw new Error("Ablation requires 20..100 distinct independently approved cases");
  const arms = ["knowledge", "memory", "experience", "codebase", "all"];
  const baseline = text(harnesses.none, "baseline harness");
  const named = arms.map(arm => text(harnesses[arm], `${arm} harness`));
  if (new Set([baseline, ...named]).size !== 6) throw new Error("Ablation harness identities must be distinct");
  for (const id of caseIds) {
    const item = service.store.get("delivery_evaluation_case", text(id, "case_id"));
    if (item.partition !== "held_out" || item.sanitized !== true || typeof item.approved_by !== "string" || !item.approved_by.trim()) throw new Error("Ablation requires independently approved held-out cases");
  }
  const campaigns = service.store.transaction(() => arms.map((arm, index) => service.evalCampaignCreate({
    campaign_id: `component_ablation_${stableDigest([manifest, arm]).slice(-24)}`, case_ids: caseIds,
    baseline_harness: baseline, candidate_harness: named[index], environment, budget,
    acceptance_ref: manifest.acceptance_ref, trials_per_case: manifest.trials_per_case ?? 3,
  }).campaign as JsonObject));
  return { manifest_digest: stableDigest(manifest), campaigns: campaigns.map((campaign, index) => ({ arm: arms[index], campaign_id: campaign.id })),
    case_count: caseIds.length, trials_per_case: manifest.trials_per_case ?? 3, status: "awaiting_actual_host_runs", model_effect_proven: false,
    next_action: "Bind actual Task runs to campaign slots, then advance and report each campaign. Missing runs remain unmeasured." };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new Error("Usage: node scripts/eval/component-ablation.ts DATA_DIR manifest.json");
  const store = await new CraftStore(craftPaths(resolve(process.argv[2]))).open();
  try { process.stdout.write(JSON.stringify(prepareAblations(new CraftService(store), JSON.parse(readFileSync(process.argv[3], "utf8"))), null, 2) + "\n"); }
  finally { store.close(); }
}
