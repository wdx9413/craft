import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { retrievalTerms } from "../../common/craft-common-base/src/retrieval-terms.ts";
import { text } from "../../common/craft-common-base/src/validation.ts";

/** Matching suggests a named Entry/Subscenario/Exit; the planner still checks all contracts. */
export function matchGraphRoutes(definition: JsonObject, query: string, inputKeys: string[] = []): JsonObject {
  const wanted = retrievalTerms(text(query, "query")), control = definition.graph_control as JsonObject;
  const entries = control.entries as JsonObject[], keys = new Set(inputKeys);
  const routes = (control.subscenarios as JsonObject[]).map(scenario => {
    const entry = entries.find(entry => entry.id === scenario.entry_id)!;
    const missing = (entry.required_inputs as string[]).filter(key => !keys.has(key));
    const score = wanted.reduce((sum, term) => sum + Number(JSON.stringify([scenario, entry.title]).toLowerCase().includes(term)), 0);
    return { subscenario_id: scenario.id, entry_id: entry.id, exit_id: scenario.exit_id, score, missing_inputs: missing, preconditions: entry.preconditions, ready_to_plan: missing.length === 0 };
  }).filter(route => route.score > 0).sort((a, b) => Number(b.ready_to_plan) - Number(a.ready_to_plan) || b.score - a.score || String(a.subscenario_id).localeCompare(String(b.subscenario_id)));
  return { routes: routes.slice(0, 20), omitted_count: Math.max(0, routes.length - 20), lexical_hint: true, execution_authorized: false };
}
