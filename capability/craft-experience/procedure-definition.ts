/**
 * Durable structured definitions for Experience Procedures.
 *
 * Workflow and Graph are machine-readable assets, so Markdown can only be their
 * review view. Prompt Procedures remain Markdown-native and do not use this store.
 */
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { CraftPaths } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

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
  provenance?: "user_configuration";
  definition: JsonObject;
}

function slug(value: string): string {
  const result = value.normalize("NFKC").replace(/[\\/]/gu, " ").replace(/[^\p{L}\p{N}._ -]/gu, " ")
    .trim().replace(/\s+/gu, "-").replace(/-+/gu, "-").slice(0, 96);
  return result || "untitled";
}

export function experienceGraphDirectory(paths: CraftPaths, id: string, legacy = false): string {
  const portable = /^[a-z0-9][a-z0-9_-]{0,95}$/u.test(id) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id);
  return join(paths.experienceDir, "graph", !legacy && portable ? id : `${slug(id)}--${stableDigest(id).slice(-12)}`);
}

/** Check every managed component, including the leaf; local data never follows links. */
export function checkedExperiencePath(paths: CraftPaths, path: string, create = false): string {
  const root = resolve(paths.experienceDir), target = resolve(path), part = relative(root, target);
  if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Experience path is outside the managed directory");
  let current = root;
  for (const segment of ["", ...part.split(/[\\/]/u)]) {
    current = segment ? join(current, segment) : current;
    try { if (lstatSync(current).isSymbolicLink()) throw new Error("Experience path must not be a symbolic link"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (create && current !== target) mkdirSync(current, { mode: 0o700 });
    }
  }
  return target;
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

  write(value: ProcedureDefinition, title: string, orphaned?: (path: string) => boolean): ProcedureDefinitionRef {
    const checked = definition(value);
    const canonical = JSON.stringify(checked, null, 2);
    const digest = stableDigest(checked);
    const path = checkedExperiencePath(this.paths, join(experienceGraphDirectory(this.paths, checked.procedure_id), "versions", `${String(checked.procedure_version).padStart(6, "0")}.json`), true);
    let publish = false;
    try {
      this.read({ format: "json", procedure_id: checked.procedure_id, procedure_version: checked.procedure_version, kind: checked.kind, path, digest });
    } catch (error) {
      if (!(error instanceof Error) || !/ENOENT|no such file/iu.test(error.message) && !(error.message === "Procedure definition digest drifted" && orphaned?.(path))) throw error;
      publish = true;
    }
    if (publish) {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${canonical}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        renameSync(temporary, path);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* rename may already have consumed it */ }
        throw error;
      }
    }
    return { format: "json", procedure_id: checked.procedure_id, procedure_version: checked.procedure_version, kind: checked.kind, path, digest };
  }

  read(ref: ProcedureDefinitionRef): ProcedureDefinition {
    const path = resolve(ref.path), legacyRoot = resolve(this.paths.experienceProcedureDir);
    const filename = `${String(ref.procedure_version).padStart(6, "0")}.json`;
    const canonical = join(experienceGraphDirectory(this.paths, ref.procedure_id), "versions", filename);
    const previous = join(experienceGraphDirectory(this.paths, ref.procedure_id, true), "versions", filename);
    if (path !== canonical && path !== previous && (!(path.startsWith(`${legacyRoot}/`) || path.startsWith(`${legacyRoot}\\`)) || !path.endsWith(`.v${ref.procedure_version}.json`))) throw new Error("Procedure definition path is outside the managed directory");
    checkedExperiencePath(this.paths, path);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Procedure definition is invalid");
    const value = definition(parsed);
    if (value.schema_version !== "craft.procedure.v1" || value.procedure_id !== ref.procedure_id || value.procedure_version !== ref.procedure_version || value.kind !== ref.kind) throw new Error("Procedure definition metadata drifted");
    if (stableDigest(value) !== ref.digest) throw new Error("Procedure definition digest drifted");
    return value;
  }

  /** Copy a checked legacy revision; old references and active invocations stay valid. */
  migrate(ref: ProcedureDefinitionRef): ProcedureDefinitionRef {
    const value = this.read(ref); return this.write(value, value.trigger);
  }
}

export function procedureDefinitionRef(value: unknown): value is ProcedureDefinitionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.format === "json" && typeof item.procedure_id === "string" && Number.isSafeInteger(item.procedure_version)
    && (item.kind === "workflow" || item.kind === "graph") && typeof item.path === "string" && typeof item.digest === "string";
}
