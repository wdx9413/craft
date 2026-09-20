import type { JsonObject, CraftStore } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

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
    const payload = { ...contractInput, status: "mechanism_passed" as EvaluationStage, stage_history: [{ stage: "mechanism_passed", evidence: "contract_definition" }], contract_digest: digestJson(contractInput) };
    if (existing) {
      if (existing.contract_digest !== payload.contract_digest) throw new Error("Evaluation Contract idempotency conflict");
      return { contract: existing, idempotent: true };
    }
    return { contract: this.store.create("evaluation_contract", id, payload), idempotent: false };
  }

  record(input: { contract_id: string; stage: EvaluationStage; evidence?: string[]; metrics?: JsonObject; }): JsonObject {
    const current = this.store.get("evaluation_contract", input.contract_id);
    if (!EVALUATION_STAGES.includes(input.stage)) throw new Error(`Unsupported evaluation stage: ${input.stage}`);
    if (stageIndex(input.stage) < stageIndex(current.status as EvaluationStage)) throw new Error("Evaluation Contract stages cannot move backwards");
    if (stageIndex(input.stage) > stageIndex(current.status as EvaluationStage) + 1) throw new Error("Evaluation Contract stages must advance one gate at a time");
    const history = [...((current.stage_history as JsonObject[] | undefined) ?? [])];
    if (history.at(-1)?.stage !== input.stage) history.push({ stage: input.stage, evidence: input.evidence ?? [], metrics: input.metrics ?? {} });
    return this.store.save("evaluation_contract", input.contract_id, { ...current, status: input.stage, stage_history: history, latest_metrics: input.metrics ?? current.latest_metrics ?? {} });
  }

  get(contractId: string): JsonObject { return { contract: this.store.get("evaluation_contract", contractId), stages: EVALUATION_STAGES }; }
}
