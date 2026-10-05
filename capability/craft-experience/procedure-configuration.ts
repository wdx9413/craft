import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { object, text, noCredentialAssignment } from "../../common/craft-common-base/src/validation.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { validateProcedureComposition } from "./procedure-composition.ts";
import { validateGraphControl } from "./procedure-graph.ts";
import { ProcedureDefinitionStore } from "./procedure-definition.ts";

/** User-authored configuration is a candidate; it never invents execution observations. */
export class ProcedureConfiguration {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  save(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const id = text(args.procedure_id, "procedure_id"), scope = text(args.scope, "scope"), title = text(args.title, "title");
      const scopeRef = scopeFromKey(scope), current = this.store.find("experience_procedure", id);
      if (current && (current.scope !== scope || !scopeAllows(scopeEnvelope(current.scope_envelope, scopeRef), scopeAccess(args)))) throw new Error("Procedure configuration scope or audience denied");
      const definition = object(args.definition, "definition"), kind = text(args.procedure_kind, "procedure_kind");
      noCredentialAssignment(JSON.stringify({ title, definition }), "configuration");
      const contract = kind === "graph" ? validateGraphControl(definition.graph_control, definition.nodes, definition.edges) : validateProcedureComposition(kind, definition.composition, definition.steps);
      const effects = [...new Set(((kind === "graph" ? definition.nodes : definition.steps) as JsonObject[]).map(n => String(n.side_effect)))];
      const signature = { scenario_id: kind === "graph" ? contract.scenario_id : text(args.scenario_id, "scenario_id") };
      const digest = stableDigest({ definition, kind, scope, title, signature });
      if (current?.configuration_digest === digest) return { procedure: current, idempotent: true };
      if (current && args.expected_version !== current.version || !current && args.expected_version !== undefined) throw new Error("Procedure configuration version conflict");
      const contentVersion = Number(current?.content_version ?? (current?.definition_ref as JsonObject | undefined)?.procedure_version ?? 0) + 1;
      const design = this.store.save("procedure_configuration", id, { scope, title, definition_digest: stableDigest(definition), author: "user", status: "draft" });
      const envelope = scopeEnvelope(current?.scope_envelope ?? args.scope_envelope, scopeRef);
      if (!scopeAllows(envelope, scopeAccess(args))) throw new Error("Procedure configuration audience denied");
      const ref = new ProcedureDefinitionStore(this.store.paths).write({ schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: contentVersion, kind: kind as "workflow" | "graph", scope,
        trigger: title, preconditions: [], allowed_effects: effects, acceptance_ref: `configuration:${id}`, failure_disposition: "checkpoint_and_handoff", scenario_signature: signature, evidence_ids: [],
        proposal_ref: { id: String(design.id), version: Number(design.version) }, provenance: "user_configuration", definition }, title,
      path => !this.store.rawRecords("experience_procedure").some(record => (record.payload.definition_ref as JsonObject | undefined)?.path === path));
      const entrypoints = kind === "graph" ? (contract.entries as JsonObject[]).map(entry => ({ ...entry, routes: (contract.subscenarios as JsonObject[]).filter(s => s.entry_id === entry.id).map(s => ({ exit_id: s.exit_id, subscenario_id: s.id })) })) : contract.entries;
      const data = { scope, scope_envelope: envelope, title, description: title, procedure_kind: kind, scenario_id: signature.scenario_id, scenario_signature: signature, author: "user", definition_ref: ref, definition_digest: ref.digest,
        configuration_digest: digest, content_version: contentVersion, definition_revision: ref.digest, identity_digest: digest, content_digest: stableDigest(definition), entrypoints, exits: contract.exits,
        allowed_effects: effects, preconditions: [], trigger: title, failure_disposition: "checkpoint_and_handoff", acceptance_ref: `configuration:${id}`, evidence_ids: [],
        completed_gates: [], lifecycle: "candidate", routeable: false, publication_allowed: false, provenance: "user_configuration", source_configuration_version: design.version };
      const procedure = current ? this.store.updateIfVersion("experience_procedure", id, Number(args.expected_version), data) : this.store.create("experience_procedure", id, data);
      return { procedure, idempotent: false, execution_authorized: false };
    });
  }
}
