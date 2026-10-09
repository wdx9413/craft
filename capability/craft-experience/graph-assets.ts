import { matchGraphRoutes } from "./graph-matching.ts";
import { activeProcedure, selectedProcedure } from "./procedure-release.ts";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import { object, text } from "../../common/craft-common-base/src/validation.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey } from "../../common/craft-common-base/src/scope-policy.ts";
import { checkedExperiencePath, experienceGraphDirectory, ProcedureDefinitionStore, procedureDefinitionRef } from "./procedure-definition.ts";
import { ProcedureConfiguration, validateExperienceConfiguration } from "./procedure-configuration.ts";
import { experienceGraphTemplate } from "./procedure-templates.ts";
import { syncGraphVersionManifest } from "./graph-version-manifest.ts";

const rows = (value: unknown): JsonObject[] => Array.isArray(value) ? value as JsonObject[] : [];
const templateId = "internet-product-engineering";
const schema: JsonObject = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["title", "procedure_kind", "definition"], properties: {
  title: { type: "string", minLength: 1 }, procedure_kind: { enum: ["graph", "workflow"] },
  scenario_id: { type: "string", minLength: 1 },
  definition: { type: "object", properties: { relations: { type: "array", maxItems: 100, items: { type: "object", required: ["id", "kind", "from", "to", "evidence_ids"], properties: {
    id: { type: "string", minLength: 1 }, kind: { enum: ["depends_on", "supports", "contradicts"] }, from: { type: "string" }, to: { type: "string" }, evidence_ids: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
  } } } } },
}, oneOf: [
  { properties: { procedure_kind: { const: "graph" }, definition: { required: ["nodes", "edges", "graph_control"], properties: {
    nodes: { type: "array", minItems: 1, maxItems: 100 }, edges: { type: "array", minItems: 1, maxItems: 100 },
    graph_control: { type: "object", required: ["scenario_id", "title", "entries", "exits", "subscenarios"] },
  } } } },
  { required: ["scenario_id"], properties: { procedure_kind: { const: "workflow" }, definition: { required: ["steps", "composition"], properties: {
    steps: { type: "array" }, composition: { type: "object", required: ["entries", "exits"] },
  } } } },
], description: "Authoring shape; Runtime also checks node/edge contracts, reachability, effects and bounded transitions. Scope and CAS are checked at save/submit; relation edges never execute." };

/** One authoring loop over the existing configuration, content versions and promotion gates. */
export class ExperienceGraphAssets {
  readonly store: CraftStore;
  readonly definitions: ProcedureDefinitionStore;
  constructor(store: CraftStore) { this.store = store; this.definitions = new ProcedureDefinitionStore(store.paths); }

  private allowed(record: JsonObject, args: JsonObject): boolean {
    return record.scope === text(args.scope, "scope") && scopeAllows(scopeEnvelope(record.scope_envelope, scopeFromKey(String(record.scope))), scopeAccess(args));
  }
  private authorize(record: JsonObject, args: JsonObject): void {
    if (!this.allowed(record, args)) throw new Error("Experience graph scope or audience denied");
  }
  private path(id: string, create = false): string {
    const path = checkedExperiencePath(this.store.paths, join(experienceGraphDirectory(this.store.paths, id), "draft.json"));
    const previous = join(experienceGraphDirectory(this.store.paths, id, true), "draft.json");
    const selected = !existsSync(path) && existsSync(checkedExperiencePath(this.store.paths, previous)) ? previous : path;
    return checkedExperiencePath(this.store.paths, selected, create);
  }
  private draft(id: string, args: JsonObject): JsonObject {
    const current = this.store.find("experience_procedure", id); if (current) this.authorize(current, args);
    const path = this.path(id);
    if (statSync(path).size > 1_000_000) throw new Error("Graph draft exceeds 1000000 bytes");
    const draft = object(JSON.parse(readFileSync(path, "utf8")), "draft");
    if (draft.schema_version !== "craft.experience.graph-draft.v1" || draft.graph_id !== id) throw new Error("Graph draft metadata drifted");
    this.authorize(draft, args);
    return { draft, path, draft_digest: stableDigest(draft), ...syncGraphVersionManifest(this.store, id), execution_authorized: false };
  }
  private current(args: JsonObject): JsonObject {
    const current = this.store.get("experience_procedure", text(args.graph_id, "graph_id")); this.authorize(current, args);
    if (!procedureDefinitionRef(current.definition_ref)) throw new Error("Graph requires a checked JSON definition");
    return current;
  }
  private input(args: JsonObject): JsonObject {
    if (args.json !== undefined && args.configuration !== undefined) throw new Error("Choose JSON or configuration, not both");
    if (args.json !== undefined) {
      const raw = text(args.json, "json"); if (Buffer.byteLength(raw) > 1_000_000) throw new Error("Graph JSON exceeds 1000000 bytes");
      return object(JSON.parse(raw), "configuration");
    }
    return args.configuration === undefined ? args : object(args.configuration, "configuration");
  }
  private preview(current: JsonObject | null, config: JsonObject): JsonObject {
    const { definition, kind } = validateExperienceConfiguration(config);
    const prior = current && procedureDefinitionRef(current.definition_ref) ? this.definitions.read(current.definition_ref).definition : {};
    const fields = [...new Set([...Object.keys(prior), ...Object.keys(definition)])].sort().filter(key => stableDigest(prior[key] ?? null) !== stableDigest(definition[key] ?? null));
    const changed = (key: string) => {
      const before = rows(prior[key]), after = rows(definition[key]);
      return [...new Set([...before, ...after].map(row => String(row.id)))].sort().filter(id => stableDigest(before.find(row => row.id === id) ?? null) !== stableDigest(after.find(row => row.id === id) ?? null));
    };
    const nodes = changed(kind === "graph" ? "nodes" : "steps"), edges = changed("edges");
    const scenarios = [...rows((prior.graph_control as JsonObject | undefined)?.subscenarios), ...rows((definition.graph_control as JsonObject | undefined)?.subscenarios)];
    const affected = [...new Set(scenarios.filter(s => fields.some(key => !["nodes", "edges"].includes(key))
      || (s.allowed_nodes as string[]).some(id => nodes.includes(id)) || (s.allowed_edges as string[]).some(id => edges.includes(id))).map(s => s.id))];
    const metadataChanged = current !== null && (current.title !== config.title || current.procedure_kind !== kind);
    return { valid: true, definition_digest: stableDigest(definition), changed_fields: fields, changed_nodes: nodes, changed_edges: edges,
      affected_subscenarios: metadataChanged ? [...new Set(scenarios.map(s => s.id))] : affected, metadata_changed: metadataChanged,
      gates_to_revalidate: fields.length || metadataChanged ? ["shadow", "held_out", "signoff", "canary"] : [],
      relation_execution: false, execution_authorized: false };
  }

  inspect(args: JsonObject): JsonObject {
    const action = text(args.action, "action");
    if (action === "template") return { templates: [{ id: templateId, title: "互联网产研", read_only: true }], schema,
      configuration: { title: "互联网产研", procedure_kind: "graph", definition: experienceGraphTemplate(String(args.template_id ?? templateId)) }, execution_authorized: false };
    if (action === "validate") {
      try { return this.preview(null, this.input(args)); }
      catch (error) { return { valid: false, errors: [{ message: String((error as Error).message) }], execution_authorized: false }; }
    }
    if (action === "list") {
      const limit = Number(args.limit ?? 30); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Graph list limit requires 1..100");
      text(args.scope, "scope");
      const items = this.store.list("experience_procedure", limit + 1, p => procedureDefinitionRef(p.definition_ref) && this.allowed(p, args)
        && (args.scenario_id === undefined || p.scenario_id === args.scenario_id || (p.scenario_signature as JsonObject | undefined)?.scenario_id === args.scenario_id));
      const drafts = this.store.list("experience_graph_draft", limit + 1, p => this.allowed(p, args) && (args.scenario_id === undefined || p.scenario_id === args.scenario_id));
      return { graphs: items.slice(0, limit).map(p => ({ graph_id: p.id, title: p.title, scenario_id: p.scenario_id ?? (p.scenario_signature as JsonObject | undefined)?.scenario_id ?? null,
        record_version: p.version, content_version: (p.definition_ref as JsonObject).procedure_version, definition_digest: p.definition_digest, lifecycle: p.lifecycle,
        eligible_version: activeProcedure(this.store, String(p.id))?.version ?? null, definition_ref: p.definition_ref,
        draft_path: this.path(String(p.id)), draft_exists: existsSync(this.path(String(p.id))), provenance: p.provenance ?? "learned", template_id: p.template_id ?? null, ...syncGraphVersionManifest(this.store, String(p.id)) })),
        drafts: drafts.slice(0, limit).map(p => ({ graph_id: p.id, title: p.title, scenario_id: p.scenario_id, path: this.path(String(p.id)), saved_draft_digest: p.draft_digest })),
        has_more: items.length > limit || drafts.length > limit, execution_authorized: false };
    }
    const id = text(args.graph_id, "graph_id");
    if (action === "draft") return this.draft(id, args);
    if (action === "diff") {
      const current = this.store.find("experience_procedure", id) ? this.current(args) : null;
      text(args.scope, "scope");
      const configuration = args.configuration !== undefined || args.json !== undefined ? this.input(args) : (this.draft(id, args).draft as JsonObject);
      return this.preview(current, configuration);
    }
    const current = this.current(args);
    if (action === "match") {
      const selected = selectedProcedure(this.store, id, args.release_channel);
      if (!selected || !procedureDefinitionRef(selected.definition_ref)) throw new Error("Graph release unavailable");
      this.authorize(selected, args);
      if (args.input_keys !== undefined && (!Array.isArray(args.input_keys) || args.input_keys.some(key => typeof key !== "string"))) throw new Error("input_keys must be strings");
      return { ...matchGraphRoutes(this.definitions.read(selected.definition_ref).definition, text(args.query, "query"), args.input_keys as string[] | undefined), procedure_version: selected.version, definition_digest: selected.definition_digest };
    }
    if (action !== "read") throw new Error("Unknown Experience graph inspection action");
    const selected = args.version === undefined ? current : this.store.get("experience_procedure", id, Number(args.version)); this.authorize(selected, args);
    if (!procedureDefinitionRef(selected.definition_ref)) throw new Error("Graph requires a checked JSON definition");
    return { graph: selected, definition: this.definitions.read(selected.definition_ref), historical: selected.version !== current.version, ...syncGraphVersionManifest(this.store, id), execution_authorized: false };
  }

  edit(args: JsonObject): JsonObject {
    const result = this.store.transaction(() => {
      const action = text(args.action, "action"), id = text(args.graph_id, "graph_id"), scope = text(args.scope, "scope");
      const current = this.store.find("experience_procedure", id); if (current) this.authorize(current, args);
      if (action === "migrate") {
        if (!current) throw new Error("Unknown Experience graph");
        if (args.expected_version !== current.version) throw new Error("Graph migration version conflict");
        const records = this.store.history("experience_procedure", id, Number(args.before_version ?? Number.MAX_SAFE_INTEGER), 101);
        const selected = records.slice(0, 100); selected.forEach(record => this.authorize(record, args));
        const refs = selected.filter(r => procedureDefinitionRef(r.definition_ref)).map(r => this.definitions.migrate(r.definition_ref as never));
        return { graph_id: id, migrated_refs: refs, legacy_files_preserved: true, has_more: records.length > 100,
          next_before_version: records.length > 100 ? selected[99]!.version : null, execution_authorized: false };
      }
      if (action === "submit") {
        const read = this.draft(id, args), draft = read.draft as JsonObject;
        if (args.expected_draft_digest !== read.draft_digest) throw new Error("Graph draft digest conflict; inspect the current draft");
        if (current && draft.base_record_version === current.version && draft.base_definition_digest !== current.definition_digest) throw new Error("Graph draft base definition digest conflict");
        const result = new ProcedureConfiguration(this.store).save({ ...draft, ...scopeAccess(args), principal_ids: args.principal_ids, cognitive_purpose: args.cognitive_purpose,
          procedure_id: id, scope, expected_version: draft.base_record_version ?? undefined });
        return { ...result, graph_id: id, draft_digest: read.draft_digest, execution_authorized: false };
      }
      if (action !== "save") throw new Error("Unknown Experience graph editing action");
      if (current ? args.expected_version !== current.version : args.expected_version !== undefined) throw new Error("Graph draft base version conflict");
      const path = this.path(id, true);
      if (existsSync(path) ? args.expected_draft_digest !== this.draft(id, args).draft_digest : args.expected_draft_digest !== undefined) throw new Error("Graph draft digest conflict; inspect the current draft");
      if (args.template_id !== undefined && (args.json !== undefined || args.configuration !== undefined)) throw new Error("Choose template or configuration, not both");
      const config = args.template_id === undefined ? this.input(args) : { title: "互联网产研", procedure_kind: "graph", definition: experienceGraphTemplate(text(args.template_id, "template_id")) };
      const checked = validateExperienceConfiguration(config), title = text(config.title, "title");
      const scenarioId = checked.kind === "graph" ? checked.contract.scenario_id : config.scenario_id;
      const envelope = scopeEnvelope(current?.scope_envelope ?? args.scope_envelope, scopeFromKey(scope));
      if (!scopeAllows(envelope, scopeAccess(args))) throw new Error("Experience graph audience denied");
      const draft = { schema_version: "craft.experience.graph-draft.v1", graph_id: id, scope, scope_envelope: envelope, title, procedure_kind: config.procedure_kind,
        scenario_id: scenarioId, definition: config.definition, template_id: current?.template_id ?? args.template_id ?? null,
        base_record_version: current?.version ?? null, base_definition_digest: current?.definition_digest ?? null };
      const preview = this.preview(current, draft);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try { writeFileSync(temporary, `${JSON.stringify(draft, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" }); renameSync(temporary, path); }
      finally { if (existsSync(temporary)) unlinkSync(temporary); }
      const digest = stableDigest(draft);
      this.store.save("experience_graph_draft", id, { scope, scope_envelope: envelope, title, scenario_id: scenarioId, path, draft_digest: digest });
      return { graph_id: id, path, draft_digest: digest, preview, execution_authorized: false };
    });
    return { ...result, ...syncGraphVersionManifest(this.store, String(args.graph_id)) };
  }
}
