/**
 * Durable structured definitions for Experience Procedures.
 *
 * Workflow and Graph are machine-readable assets, so Markdown can only be their
 * review view. Prompt Procedures remain Markdown-native and do not use this store.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stableDigest } from "../../core/digest.ts";
import type { CraftPaths } from "../../core/infrastructure/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

export type ProcedureKind = "workflow" | "graph";

export interface ProcedureDefinitionRef {
  format: "json";
  procedure_id: string;
  procedure_version: number;
  kind: ProcedureKind;
  path: string;
  digest: string;
}

export interface ProcedureDefinition extends JsonObject {
  schema_version: "craft.procedure.v1";
  procedure_id: string;
  procedure_version: number;
  kind: ProcedureKind;
  scope: string;
  trigger: string;
  preconditions: string[];
  allowed_effects: string[];
  acceptance_ref: string;
  failure_disposition: string;
  scenario_signature: JsonObject;
  evidence_ids: string[];
  proposal_ref: { id: string; version: number };
  definition: JsonObject;
}

function slug(value: string): string {
  const result = value.normalize("NFKC").replace(/[\\/]/gu, " ").replace(/[^\p{L}\p{N}._ -]/gu, " ")
    .trim().replace(/\s+/gu, "-").replace(/-+/gu, "-").slice(0, 96);
  return result || "untitled";
}

function refPath(paths: CraftPaths, kind: ProcedureKind, id: string, version: number, title: string): string {
  const suffix = stableDigest(id).slice(-12);
  return join(paths.experienceProcedureDir, kind === "workflow" ? "workflows" : "graphs", `${slug(title)}--${suffix}.v${version}.json`);
}

function definition(value: unknown): ProcedureDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Procedure definition is invalid");
  const item = value as Partial<ProcedureDefinition>;
  if (item.schema_version !== "craft.procedure.v1" || typeof item.procedure_id !== "string" || !item.procedure_id.trim()
    || typeof item.procedure_version !== "number" || !Number.isSafeInteger(item.procedure_version) || item.procedure_version < 1 || (item.kind !== "workflow" && item.kind !== "graph")
    || typeof item.scope !== "string" || typeof item.trigger !== "string" || !Array.isArray(item.preconditions)
    || !Array.isArray(item.allowed_effects) || typeof item.acceptance_ref !== "string" || typeof item.failure_disposition !== "string"
    || !item.scenario_signature || typeof item.scenario_signature !== "object" || Array.isArray(item.scenario_signature)
    || !Array.isArray(item.evidence_ids) || !item.proposal_ref || typeof item.proposal_ref !== "object"
    || typeof item.proposal_ref.id !== "string" || !Number.isSafeInteger(item.proposal_ref.version)
    || !item.definition || typeof item.definition !== "object" || Array.isArray(item.definition)) throw new Error("Procedure definition is invalid");
  return item as ProcedureDefinition;
}

/** Local, append-only JSON files. The database stores only the checked reference. */
export class ProcedureDefinitionStore {
  readonly paths: CraftPaths;
  constructor(paths: CraftPaths) { this.paths = paths; }

  write(value: ProcedureDefinition, title: string): ProcedureDefinitionRef {
    const checked = definition(value);
    const canonical = JSON.stringify(checked, null, 2);
    const digest = stableDigest(checked);
    const path = refPath(this.paths, checked.kind, checked.procedure_id, checked.procedure_version, title);
    mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
    try {
      const existing = this.read({ format: "json", procedure_id: checked.procedure_id, procedure_version: checked.procedure_version, kind: checked.kind, path, digest });
      if (stableDigest(existing) !== digest) throw new Error("Procedure definition version already exists with different content");
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/iu.test(error.message)) throw error;
      const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporary, `${canonical}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    }
    return { format: "json", procedure_id: checked.procedure_id, procedure_version: checked.procedure_version, kind: checked.kind, path, digest };
  }

  read(ref: ProcedureDefinitionRef): ProcedureDefinition {
    const root = resolve(this.paths.experienceProcedureDir);
    const path = resolve(ref.path);
    if (!(path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) || !path.endsWith(`.v${ref.procedure_version}.json`)) throw new Error("Procedure definition path is outside the managed directory");
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Procedure definition is invalid");
    const value = definition(parsed);
    if (value.schema_version !== "craft.procedure.v1" || value.procedure_id !== ref.procedure_id || value.procedure_version !== ref.procedure_version || value.kind !== ref.kind) throw new Error("Procedure definition metadata drifted");
    if (stableDigest(value) !== ref.digest) throw new Error("Procedure definition digest drifted");
    return value;
  }
}

export function procedureDefinitionRef(value: unknown): value is ProcedureDefinitionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.format === "json" && typeof item.procedure_id === "string" && Number.isSafeInteger(item.procedure_version)
    && (item.kind === "workflow" || item.kind === "graph") && typeof item.path === "string" && typeof item.digest === "string";
}
