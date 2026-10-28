import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";

const GATE_KIND = "experience_procedure_gate";
const FAILED_PENALTY = 0.2;
const MAX_FAILURES = 5;
const MIN_PENALTY = 0.25;

/**
 * Soft demotion for a Procedure with failed gates.
 *
 * A failed gate never changes the Procedure here; it only lowers its ranking
 * weight. A Procedure that is no longer routeable is already excluded upstream,
 * so this matters when a newer version failed while an active release remains.
 */
export function experienceGatePenaltyFromGates(gates: readonly JsonObject[], procedureIds: readonly string[]): Map<string, number> {
  const wanted = new Set(procedureIds);
  const result = new Map<string, number>();
  if (wanted.size === 0) return result;
  const failures = new Map<string, number>();
  for (const gate of gates) {
    if (gate.passed !== false) continue;
    const id = String(gate.procedure_id);
    if (!wanted.has(id)) continue;
    failures.set(id, (failures.get(id) ?? 0) + 1);
  }
  for (const id of wanted) {
    const count = failures.get(id) ?? 0;
    result.set(id, Number(Math.max(MIN_PENALTY, 1 - FAILED_PENALTY * Math.min(count, MAX_FAILURES)).toFixed(6)));
  }
  return result;
}

export function experienceGatePenalty(store: CraftStore, procedureIds: readonly string[]): Map<string, number> {
  const wanted = new Set(procedureIds);
  if (wanted.size === 0) return new Map();
  return experienceGatePenaltyFromGates(store.list(GATE_KIND, 10_000,
    (value) => value.passed === false && wanted.has(String(value.procedure_id)), false), procedureIds);
}
