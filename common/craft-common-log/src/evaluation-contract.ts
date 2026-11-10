import type { JsonObject, CraftStore } from "../../craft-common-store-local/src/store.ts";
import { digestJson } from "../../craft-common-base/src/digest.ts";

export const EVALUATION_STAGES = ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified", "business_eligible", "routeable"] as const;
export type EvaluationStage = typeof EVALUATION_STAGES[number];

export interface EvaluationContractInput {
  capability_id: string;
  capability_version: number;
  input_contract: string;
  output_contract: string;
  scope?: JsonObject;
  effect?: string;
  fixture_id?: string;
  host_compatibility?: string[];
  budget?: JsonObject;
}

function stageIndex(stage: EvaluationStage): number { return EVALUATION_STAGES.indexOf(stage); }

export class EvaluationContractKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  define(input: EvaluationContractInput & { contract_id?: string }): JsonObject {
    if (!input.capability_id.trim() || !Number.isInteger(input.capability_version) || input.capability_version < 1 || !input.input_contract.trim() || !input.output_contract.trim()) throw new Error("Evaluation Contract requires capability and IO contracts");
    const id = input.contract_id ?? `evaluation_contract_${digestJson({ capability_id: input.capability_id, version: input.capability_version }).slice(-16)}`;
    const existing = this.store.find("evaluation_contract", id);
    const { contract_id: _ignored, ...contractInput } = input;
    const payload = { ...contractInput, status: "defined", reported_stage: null, verified_stage: null,
      stage_history: [] as JsonObject[], contract_digest: digestJson(contractInput) };
    if (existing) {
      if (existing.contract_digest !== payload.contract_digest) throw new Error("Evaluation Contract idempotency conflict");
      return { contract: existing, idempotent: true };
    }
    return { contract: this.store.create("evaluation_contract", id, payload), idempotent: false };
  }

  record(input: { contract_id: string; stage: EvaluationStage; evidence?: string[]; metrics?: JsonObject; }): JsonObject {
    const current = this.store.get("evaluation_contract", input.contract_id);
    if (!EVALUATION_STAGES.includes(input.stage)) throw new Error(`Unsupported evaluation stage: ${input.stage}`);
    const reported = (current.reported_stage ?? (current.status === "defined" ? null : current.status)) as EvaluationStage | null;
    const previous = reported === null ? -1 : stageIndex(reported);
    if (stageIndex(input.stage) > previous + 1) throw new Error("Evaluation Contract stages must advance one gate at a time");
    const evidence = input.evidence;
    if (stageIndex(input.stage) < previous && (!Array.isArray(evidence) || evidence.length === 0)) throw new Error("Evaluation Contract stages cannot move backwards without a bound assessment");
    if (!Array.isArray(evidence) || !evidence.length || evidence.some(id => typeof id !== "string" || !id.trim()) || new Set(evidence).size !== evidence.length) {
      throw new Error("Evaluation Contract stage requires distinct evidence references");
    }
    const verified = evidence.some(id => {
      const assessment = this.store.find("verification_assessment", id);
      if (!assessment || assessment.verdict !== "eligible") return false;
      const plan = this.store.find("verification_plan", String(assessment.verification_id));
      if (!plan || plan.change_ref !== `${input.contract_id}:${input.stage}`) return false;
      if (input.stage === "host_verified" && plan.requires_real_host !== true) return false;
      if (input.stage === "routeable" && plan.candidate_change !== true) return false;
      return true;
    });
    const priorVerified = current.verified_stage === null || current.verified_stage === undefined ? -1 : stageIndex(current.verified_stage as EvaluationStage);
    const trusted = verified && stageIndex(input.stage) <= priorVerified + 1;
    if (stageIndex(input.stage) < previous && !trusted) throw new Error("Evaluation Contract stages cannot move backwards without a bound assessment");
    const history = [...((current.stage_history as JsonObject[] | undefined) ?? [])];
    const entry = { stage: input.stage, evidence, metrics: input.metrics ?? {}, verification: trusted ? "trusted" : "reported" };
    const recordedIndex = history.findIndex(item => item.stage === input.stage);
    if (recordedIndex < 0) history.push(entry);
    else history[recordedIndex] = entry;
    const reportedStage = stageIndex(input.stage) > previous ? input.stage : reported;
    const verifiedStage = trusted && stageIndex(input.stage) > priorVerified ? input.stage : current.verified_stage ?? null;
    return this.store.save("evaluation_contract", input.contract_id, { ...current,
      status: verifiedStage ?? "defined", reported_stage: reportedStage,
      verified_stage: verifiedStage,
      stage_history: history, latest_metrics: input.metrics ?? current.latest_metrics ?? {} });
  }

  get(contractId: string): JsonObject {
    const contract = this.store.get("evaluation_contract", contractId);
    return { contract, stages: EVALUATION_STAGES, routeable: contract.verified_stage === "routeable" };
  }
}
