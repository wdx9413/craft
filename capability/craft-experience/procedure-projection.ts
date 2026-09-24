/**
 * The routeable Procedure store for Experience.
 *
 * Observations and diagnostic patterns remain evidence-only.  This small state
 * machine is the only path that turns a bounded evolution proposal into a
 * routeable Procedure. Workflow and Graph keep a structured JSON definition
 * as their authority; Markdown is only their human-review view. Prompt
 * Procedures remain Markdown-native. All three stay separate from Skill
 * installation and active Capability Workflows.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CraftStore, JsonObject } from "../../core/infrastructure/store.ts";
import { stableDigest, payload } from "../../core/digest.ts";
import { ProcedureDefinitionStore, procedureDefinitionRef, type ProcedureDefinition, type ProcedureKind } from "./procedure-definition.ts";
import { scopeEnvelope } from "../../core/scope-policy.ts";

const STAGES = ["shadow", "held_out", "signoff", "canary"] as const;
type Stage = typeof STAGES[number];
const KINDS = new Set(["workflow", "graph", "prompt"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = [...new Set(value.map((item) => text(item, name)))].sort();
  if (result.length < minimum) throw new Error(`${name} must contain at least ${minimum} unique values`);
  return result;
}
function yaml(value: unknown): string { return JSON.stringify(value); }
function scopeRef(value: string): { kind: string; id: string } {
  const [kind, ...rest] = value.split(":");
  return { kind: kind || "project", id: rest.join(":") || "unresolved" };
}

/**
 * Owns Craft-learned Procedure assets. It intentionally does not own installed
 * Capability Skills or Workflows: those stay in the Capability registry.
 */
export class ProcedureStore {
  readonly store: CraftStore;
  readonly definitions: ProcedureDefinitionStore;
  constructor(store: CraftStore) { this.store = store; this.definitions = new ProcedureDefinitionStore(store.paths); }

  /** Create a candidate Procedure from an existing bounded proposal record. */
  draft(args: JsonObject): JsonObject {
    const proposal = this.store.get("workflow_evolution_proposal", text(args.proposal_id, "proposal_id"));
    const request = this.store.get("workflow_evolution_request", String(proposal.request_id), Number(proposal.request_version));
    const procedureKind = text(args.procedure_kind ?? proposal.procedure_kind ?? "workflow", "procedure_kind");
    if (!KINDS.has(procedureKind)) throw new Error("Experience Procedure kind is unsupported");
    const scenarioSignature = args.scenario_signature ?? request.scenario_signature;
    if (!scenarioSignature || typeof scenarioSignature !== "object" || Array.isArray(scenarioSignature)) throw new Error("Experience Procedure requires Scenario Signature");
    const procedureScope = this.scope(request);
    const envelope = scopeEnvelope(args.scope_envelope ?? request.scope_envelope, scopeRef(procedureScope));
    const identity = {
      proposal_id: proposal.id, proposal_version: proposal.version, request_id: request.id, request_version: request.version,
      procedure_kind: procedureKind, scenario_signature: scenarioSignature,
      scope: procedureScope, scope_envelope: envelope,
      trigger: text(args.trigger ?? request.scenario_key, "trigger"), preconditions: strings(args.preconditions ?? [], "preconditions"),
      allowed_effects: strings(args.allowed_effects ?? ["read"], "allowed_effects", 1),
      acceptance_ref: text(args.acceptance_ref ?? request.output_contract_ref, "acceptance_ref"),
      failure_disposition: text(args.failure_disposition ?? "checkpoint_and_handoff", "failure_disposition"),
      evidence_ids: strings(args.evidence_ids ?? (request.observation_refs as JsonObject[]).flatMap((item) => item.evidence_ids as string[]), "evidence_ids", 1),
      title: text(args.title ?? proposal.name, "title"), description: text(args.description ?? proposal.description, "description"),
    };
    const id = String(args.procedure_id ?? `experience_procedure_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("experience_procedure", id);
    const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Experience Procedure idempotency conflict");
      return { procedure: existing, idempotent: true };
    }
    const body = this.markdown(identity);
    const definition = procedureKind === "prompt" ? null : this.definition(id, procedureKind as ProcedureKind, identity, proposal);
    const definitionRef = definition ? this.definitions.write(definition, String(identity.title)) : null;
    const ref = this.store.contentStore.writeSync({ kind: "experience", record_id: id, version: 1,
      scope: String(identity.scope), status: "candidate", sensitivity: "internal", source_id: `workflow-evolution:${String(proposal.id)}`,
      title: identity.title, body, folder: this.folder(procedureKind),
      frontmatter: {
        procedure_kind: procedureKind,
        trigger: String(identity.trigger),
        preconditions: JSON.stringify(identity.preconditions),
        allowed_effects: JSON.stringify(identity.allowed_effects),
        acceptance_ref: String(identity.acceptance_ref),
        failure_disposition: String(identity.failure_disposition),
        scenario_signature: JSON.stringify(identity.scenario_signature),
        evidence_refs: JSON.stringify(identity.evidence_ids),
        lifecycle: "candidate",
        procedure_digest: identityDigest,
        scope_envelope: JSON.stringify(envelope),
        definition_digest: definitionRef?.digest ?? "",
        revoked_by: "",
      } });
    return { procedure: this.store.create("experience_procedure", id, { ...identity, lifecycle: "candidate", content_ref: ref, content_digest: ref.digest, definition_ref: definitionRef, definition_digest: definitionRef?.digest ?? null, identity_digest: identityDigest, routeable: false, publication_allowed: false }), idempotent: false };
  }

  /** Persist one independently evidenced promotion gate. Gates are ordered and append-only. */
  gate(args: JsonObject): JsonObject {
    const procedure = this.store.get("experience_procedure", text(args.procedure_id, "procedure_id"));
    const stage = text(args.stage, "stage") as Stage; if (!(STAGES as readonly string[]).includes(stage)) throw new Error("Experience Procedure gate is unsupported");
    const expected = STAGES.indexOf(stage); const completed = Array.isArray(procedure.completed_gates) ? procedure.completed_gates.map(String) : [];
    if (stage !== "shadow" && !completed.includes(STAGES[expected - 1]!)) throw new Error("Experience Procedure gate order is invalid");
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); for (const evidenceId of evidenceIds) this.assertEvidence(evidenceId);
    const passed = args.passed === true;
    const identity = { procedure_id: procedure.id, procedure_version: procedure.version, stage, evidence_ids: evidenceIds, passed, verdict: text(args.verdict ?? (passed ? "passed" : "failed"), "verdict") };
    const id = String(args.gate_id ?? `experience_procedure_gate_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("experience_procedure_gate", id);
    if (existing) { if (existing.identity_digest !== stableDigest(identity)) throw new Error("Experience Procedure gate idempotency conflict"); return { gate: existing, procedure, idempotent: true }; }
    const gate = this.store.create("experience_procedure_gate", id, { ...identity, identity_digest: stableDigest(identity) });
    const next = passed ? [...new Set([...completed, stage])] : completed;
    const lifecycle = !passed ? (stage === "canary" ? "rolled_back" : "rejected") : stage === "canary" ? "routeable" : "candidate";
    const saved = this.store.save("experience_procedure", String(procedure.id), { ...payload(procedure), completed_gates: next, lifecycle, routeable: lifecycle === "routeable", rollback_gate_id: lifecycle === "rolled_back" ? gate.id : null });
    this.refreshMarkdown(saved);
    return { gate, procedure: saved, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { procedure: this.store.get("experience_procedure", text(args.procedure_id, "procedure_id")) }; }

  list(args: JsonObject = {}): JsonObject {
    const scope = args.scope === undefined ? null : text(args.scope, "scope");
    return { procedures: this.store.list("experience_procedure", Number(args.limit ?? 100), (item) => scope === null || item.scope === scope) };
  }

  /** Export only a routeable Procedure and keep it disabled until a Host installs it. */
  skillExport(args: JsonObject): JsonObject {
    const procedure = this.store.get("experience_procedure", text(args.procedure_id, "procedure_id"));
    if (procedure.lifecycle !== "routeable" || procedure.routeable !== true) throw new Error("Only routeable Experience Procedures can be exported as Skills");
    const exportId = String(args.export_id ?? `experience_skill_export_${stableDigest({ procedure_id: procedure.id, version: procedure.version }).slice(-20)}`);
    const existing = this.store.find("experience_skill_export", exportId); if (existing) return { export: existing, idempotent: true };
    const source = this.store.contentStore.readCompatSync(procedure.content_ref as never).body;
    const name = text(args.skill_name ?? String(procedure.id).replace(/^experience_procedure_/u, "craft-procedure-"), "skill_name");
    const markdown = `---\nname: ${yaml(name)}\ndescription: ${yaml(`Disabled Craft Procedure export: ${String(procedure.title)}`)}\ncraft_procedure_id: ${yaml(String(procedure.id))}\ncraft_procedure_version: ${Number(procedure.version)}\nenabled: false\n---\n\n# ${String(procedure.title)}\n\n${source}`;
    const directory = resolve(this.store.paths.experienceDir, "skills", exportId); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, "SKILL.md"); writeFileSync(path, markdown, { encoding: "utf8", mode: 0o600 });
    const definition = procedureDefinitionRef(procedure.definition_ref) ? this.definitions.read(procedure.definition_ref) : null;
    const definitionPath = definition ? join(directory, "PROCEDURE.json") : null;
    if (definitionPath) writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { export: this.store.create("experience_skill_export", exportId, { procedure_id: procedure.id, procedure_version: procedure.version, path, definition_path: definitionPath, content_digest: stableDigest(markdown), enabled: false, status: "draft" }), idempotent: false };
  }

  private scope(request: JsonObject): string {
    const observation = (request.observation_refs as JsonObject[])[0];
    const source = observation?.source as JsonObject | undefined;
    const scope = typeof source?.scope === "string" ? source.scope : null;
    return scope ?? "project:unresolved";
  }

  private folder(kind: string): "workflows" | "graphs" | "prompts" {
    if (kind === "workflow") return "workflows";
    if (kind === "graph") return "graphs";
    return "prompts";
  }

  private definition(id: string, kind: ProcedureKind, identity: JsonObject, proposal: JsonObject): ProcedureDefinition {
    const graph = proposal.graph as JsonObject | null;
    const definition = kind === "workflow"
      ? { inputs: proposal.inputs ?? [], steps: proposal.steps ?? [] }
      : { inputs: proposal.inputs ?? [], nodes: graph?.nodes ?? [], edges: graph?.edges ?? [], outputs: graph?.outputs ?? {}, checkpoint_policy: graph?.checkpoint_policy ?? { mode: "step" } };
    return {
      schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: 1, kind,
      scope: String(identity.scope), trigger: String(identity.trigger), preconditions: identity.preconditions as string[],
      allowed_effects: identity.allowed_effects as string[], acceptance_ref: String(identity.acceptance_ref),
      failure_disposition: String(identity.failure_disposition), scenario_signature: identity.scenario_signature as JsonObject,
      evidence_ids: identity.evidence_ids as string[], proposal_ref: { id: String(proposal.id), version: Number(proposal.version) }, definition,
    };
  }

  private markdown(value: JsonObject): string {
    return `# ${String(value.title)}\n\n## Trigger\n${String(value.trigger)}\n\n## Preconditions\n${(value.preconditions as string[]).map((item) => `- ${item}`).join("\n") || "- None"}\n\n## Allowed effects\n${(value.allowed_effects as string[]).map((item) => `- ${item}`).join("\n")}\n\n## Acceptance\n${String(value.acceptance_ref)}\n\n## Failure disposition\n${String(value.failure_disposition)}\n\n## Evidence\n${(value.evidence_ids as string[]).map((item) => `- ${item}`).join("\n")}\n\n${String(value.description)}`;
  }

  /** The Markdown review view stays human-inspectable after promotion. */
  private refreshMarkdown(procedure: JsonObject): void {
    const ref = procedure.content_ref as { kind?: string; record_id?: string; version?: number; path?: string } | undefined;
    const version = ref?.version;
    if (!ref || ref.kind !== "experience" || typeof ref.record_id !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || typeof ref.path !== "string") return;
    this.store.contentStore.rewriteSync({
      kind: "experience", record_id: ref.record_id, version, current_path: ref.path,
      scope: String(procedure.scope), status: String(procedure.lifecycle), sensitivity: "internal",
      source_id: `workflow-evolution:${String(procedure.proposal_id)}`, title: String(procedure.title), body: this.markdown(procedure),
      frontmatter: {
        procedure_kind: String(procedure.procedure_kind), trigger: String(procedure.trigger),
        preconditions: JSON.stringify(procedure.preconditions ?? []), allowed_effects: JSON.stringify(procedure.allowed_effects ?? []),
        acceptance_ref: String(procedure.acceptance_ref), failure_disposition: String(procedure.failure_disposition),
        scenario_signature: JSON.stringify(procedure.scenario_signature), evidence_refs: JSON.stringify(procedure.evidence_ids ?? []),
        lifecycle: String(procedure.lifecycle), procedure_digest: String(procedure.identity_digest),
        scope_envelope: JSON.stringify(procedure.scope_envelope ?? {}),
        definition_digest: procedure.definition_digest === null || procedure.definition_digest === undefined ? "" : String(procedure.definition_digest),
        revoked_by: procedure.rollback_gate_id === null || procedure.rollback_gate_id === undefined ? "" : String(procedure.rollback_gate_id),
      },
    });
  }

  private assertEvidence(id: string): void {
    const evidence = this.store.get("evidence", id);
    if (!["bounded", "confirmed"].includes(String(evidence.confidence))) throw new Error("Experience Procedure requires bounded or confirmed Evidence");
  }
}

/** @deprecated Internal compatibility name. Prefer `ProcedureStore`. */
export { ProcedureStore as ExperienceProcedureKernel };
