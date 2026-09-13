import type { JsonObject } from "./store.ts";

/**
 * Cross-model comparability.
 *
 * Craft's premise is that the mechanism should stay stable while the model
 * underneath it changes. That premise is testable, and this module is where it
 * becomes a gate: an asset is only "verified across models" when the invariants
 * it declares as core hold for every model it was tried on.
 *
 * The distinction the module exists to make: an invariant that holds everywhere
 * is a property of the mechanism, while one that holds for some models and not
 * others is a property of the model. The second kind is not a failure — it is
 * demoted to a model-sensitive hint, where it can no longer gate anything.
 */

export interface ModelTrial {
  model: string;
  asset_ref: string;
  verdict: "passed" | "failed";
  /** Invariants the trial actually observed holding. */
  observed_invariants: string[];
  tokens?: number;
}

export interface InvariantReport {
  invariant: string;
  held_by: string[];
  failed_by: string[];
  stable: boolean;
}

export interface IndependenceReport {
  models: string[];
  trials: number;
  per_invariant: InvariantReport[];
  /** Invariants that held everywhere. */
  core_stable: string[];
  /** Invariants that only held for some models, so they are hints, not gates. */
  model_sensitive: string[];
  /** Invariants no model ever satisfied. */
  unmet: string[];
  conclusion: "verified" | "inconclusive" | "rejected";
  reason: string;
}

function strings(value: unknown, name: string, allowEmpty = true): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  const entries = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${name} must contain non-empty strings`);
    return item.trim();
  });
  if (!allowEmpty && !entries.length) throw new Error(`${name} must not be empty`);
  if (new Set(entries).size !== entries.length) throw new Error(`${name} must not repeat an entry`);
  return entries;
}

export function defineTrials(entries: unknown): ModelTrial[] {
  if (!Array.isArray(entries)) throw new Error("Model trials must be an array");
  return entries.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Model trial ${index} must be an object`);
    const trial = entry as JsonObject;
    const model = trial.model;
    const assetRef = trial.asset_ref;
    if (typeof model !== "string" || !model.trim()) throw new Error(`Model trial ${index} needs a model`);
    if (typeof assetRef !== "string" || !assetRef.trim()) throw new Error(`Model trial ${index} needs an asset_ref`);
    const verdict = String(trial.verdict);
    if (!["passed", "failed"].includes(verdict)) throw new Error(`Model trial ${index} has an unsupported verdict`);
    const tokens = trial.tokens === undefined ? undefined : Number(trial.tokens);
    if (tokens !== undefined && (!Number.isInteger(tokens) || tokens < 0)) throw new Error(`Model trial ${index} tokens must be a non-negative integer`);
    return { model: model.trim(), asset_ref: assetRef.trim(), verdict: verdict as ModelTrial["verdict"],
      observed_invariants: strings(trial.observed_invariants, `Model trial ${index} observed_invariants`),
      ...(tokens === undefined ? {} : { tokens }) };
  });
}

/**
 * Compare trials of one subject across models.
 *
 * A single model cannot demonstrate independence, so that case returns
 * `inconclusive` rather than a pass — the honest answer is "not yet tested".
 * A subject with no declared invariant is also inconclusive, because there is
 * nothing whose stability could be established.
 */
export function compareAcrossModels(trials: readonly ModelTrial[], invariants: readonly string[]): IndependenceReport {
  const declared = strings(invariants, "invariants", false);
  if (!trials.length) throw new Error("Cross-model comparison needs at least one trial");
  const subject = trials[0].asset_ref;
  for (const trial of trials) {
    if (trial.asset_ref !== subject) throw new Error(`Model trials mix subjects: ${trial.asset_ref} and ${subject}`);
  }
  const models = [...new Set(trials.map((trial) => trial.model))].sort();

  const perInvariant: InvariantReport[] = declared.map((invariant) => {
    const held = trials.filter((trial) => trial.verdict === "passed" && trial.observed_invariants.includes(invariant));
    const failed = trials.filter((trial) => trial.verdict === "failed" || !trial.observed_invariants.includes(invariant));
    const heldModels = [...new Set(held.map((trial) => trial.model))].sort();
    const failedModels = [...new Set(failed.map((trial) => trial.model))].sort();
    const stable = failed.length === 0;
    return { invariant, held_by: heldModels, failed_by: failedModels, stable };
  });

  const coreStable = perInvariant.filter((report) => report.stable).map((report) => report.invariant);
  const unmet = perInvariant.filter((report) => report.held_by.length === 0).map((report) => report.invariant);
  // Held somewhere, failed elsewhere: a property of the model, so it stops gating.
  const modelSensitive = perInvariant.filter((report) => !report.stable && report.held_by.length > 0)
    .map((report) => report.invariant);

  let conclusion: IndependenceReport["conclusion"];
  let reason: string;
  if (models.length < 2) {
    conclusion = "inconclusive";
    reason = `only one model was tried (${models[0] as string}); independence cannot be established`;
  } else if (coreStable.length === 0) {
    conclusion = "rejected";
    reason = `no declared invariant held for every model; ${modelSensitive.length} behaved as model-sensitive`;
  } else if (unmet.length) {
    conclusion = "inconclusive";
    reason = `no model was observed satisfying: ${unmet.join(", ")}`;
  } else {
    conclusion = "verified";
    reason = `${coreStable.length} of ${declared.length} invariants held across ${models.length} models`;
  }
  return { models, trials: trials.length, per_invariant: perInvariant, core_stable: coreStable,
    model_sensitive: modelSensitive, unmet, conclusion, reason };
}
