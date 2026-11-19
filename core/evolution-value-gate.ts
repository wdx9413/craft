/**
 * Compatibility entry for the shared Evolution Value Gate.
 *
 * The gate is a side-effect-free contract and now lives in
 * `craft-common-ontology`, so the kernel and the Context capability can both
 * call it without depending on each other. This file keeps the kernel import
 * path stable for existing callers.
 */
export { EVOLUTION_VALUE_ACTIONS, evaluateEvolutionValue } from "craft-common-ontology";
export type { EvolutionValueAction, EvolutionValueDecision, EvolutionValueInput } from "craft-common-ontology";
