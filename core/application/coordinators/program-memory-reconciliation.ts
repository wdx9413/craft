import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { stableDigest, payload } from "../../digest.ts";

function prose(value: unknown): boolean { return typeof value === "string" && !!value.trim() && value.length <= 320; }
function proseList(value: unknown, required = false): boolean {
  return Array.isArray(value) && value.length <= 32 && (!required || value.length > 0) && value.every(prose);
}
function canonicalPractice(design: JsonObject): JsonObject | null {
  const practice = (design.budget as JsonObject | undefined)?.program_memory_practice as JsonObject | undefined;
  if (!practice || practice.schema !== "craft.program-memory-practice.v1" || !prose(practice.scenario_key)
    || !practice.scenario_definition || !prose(practice.statement) || !prose(practice.task_goal)
    || !proseList(practice.steps, true) || !proseList(practice.preconditions) || !proseList(practice.inputs)
    || !proseList(practice.outputs, true) || !proseList(practice.acceptance, true)
    || !["coding", "office", "travel", "creation", "research", "general"].includes(String(practice.domain))) return null;
  return practice;
}

/** Bind different task diagnostics only through one frozen semantic practice and the classified scene. */
export function reconcileProgramMemory(context: CraftService, scope: JsonObject, designBindings: JsonObject = {}): JsonObject {
  const diagnostics = (context.selfEvolution.listProgramMemory({ scope }).items as JsonObject[])
    .filter(candidate => candidate.status === "diagnostic" && candidate.evaluation_design_id == null);
  const experience = context.ownerServices.get("experience") ?? (context.capabilityOwned ? null : context);
  const evaluation = context.ownerServices.get("eval") ?? (context.capabilityOwned ? null : context);
  if (!experience || !evaluation) return { processed: 0, reason: "semantic_binding_owner_unavailable", outcomes: [] };
  let scenes: JsonObject[];
  try { scenes = experience.experienceScenarioList({ scope: scope.id }).scenarios as JsonObject[]; }
  catch { return { processed: 0, reason: "waiting_scenario_classification", outcomes: [] }; }
  const designs = evaluation.store.list("evaluation_contract", 1_000, item => item.effect === "program_memory_design"
    && stableDigest(item.scope) === stableDigest(scope), false).flatMap(design => {
      const practice = canonicalPractice(design);
      return practice ? [{ design, practice }] : [];
    });
  const outcomes: JsonObject[] = [];
  const groups = new Map<string, { design: JsonObject; practice: JsonObject; scenario: string; observations: Set<string>; sources: JsonObject[] }>();
  for (const diagnostic of diagnostics) {
    for (const observationId of Array.isArray(diagnostic.evidence_ids) ? diagnostic.evidence_ids : []) {
      if (typeof observationId !== "string") continue;
      const observation = experience.store.find("workflow_evolution_observation", observationId);
      const signature = observation?.scenario_signature as JsonObject | undefined;
      if (!observation || signature?.schema !== "craft.scenario-signature.v1" || typeof signature.scenario_key !== "string"
        || (signature.project as JsonObject | undefined)?.id !== scope.id) {
        outcomes.push({ diagnostic_id: diagnostic.id, reason: "waiting_scenario_classification" }); continue;
      }
      const fineKey = signature.scenario_key;
      const scene = scenes.find(item => item.scenario_key === signature.scenario_key && item.tier === "fine"
        && (item.lifecycle === "active" || item.lifecycle === "candidate"));
      const matching = scene ? designs.filter(item => (designBindings[fineKey] === undefined || designBindings[fineKey] === item.design.id)
        && item.practice.scenario_key === signature.scenario_key
        && stableDigest(item.practice.scenario_definition) === stableDigest(scene.definition)) : [];
      if (matching.length !== 1) { outcomes.push({ diagnostic_id: diagnostic.id,
        reason: matching.length ? "ambiguous_canonical_practice" : "waiting_canonical_practice" }); continue; }
      const { design, practice } = matching[0]!;
      const key = stableDigest({ design: design.contract_digest, signature });
      const group = groups.get(key) ?? { design, practice, scenario: String(observation.scenario_key), observations: new Set<string>(), sources: [] };
      group.observations.add(observationId);
      if (!group.sources.some(source => source.id === diagnostic.id)) group.sources.push(diagnostic);
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    const candidate = context.selfEvolution.captureProgramMemory({ scope, statement: group.practice.statement, steps: group.practice.steps,
      domain: group.practice.domain, scenario_key: group.scenario, evaluation_contract_id: group.design.id,
      evidence_ids: [...group.observations], source_refs: group.sources.map(source => ({ kind: "program_memory_candidate", id: source.id,
        version: source.version, digest: source.digest })) });
    for (const source of group.sources) if (source.canonical_candidate_id !== candidate.id)
      context.store.save("program_memory_candidate", String(source.id), { ...payload(source), canonical_candidate_id: candidate.id,
        canonical_design_digest: group.design.contract_digest });
    outcomes.push({ candidate_id: candidate.id, independent_evidence_count: candidate.independent_evidence_count,
      diagnostic_sources: group.sources.length, reason: "canonical_practice_bound" });
  }
  return { processed: groups.size, outcomes };
}
