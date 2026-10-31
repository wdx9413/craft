/**
 * Durable structured definitions for Experience Procedures.
 *
 * Workflow and Graph are machine-readable assets, so Markdown can only be their
 * review view. Prompt Procedures remain Markdown-native and do not use this store.
 */
import { linkSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";
import type { CraftPaths } from "../../common/craft-common-store-local/src/paths.ts";
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { experienceDataDirectory } from "../../core/project-experience-directory.ts";

export type ProcedureKind = "workflow" | "graph";

export interface ProcedureDefinitionRef {
  format: "json";
  procedure_id: string;
  procedure_version: number;
  kind: ProcedureKind;
  scope?: string;
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

export function experienceGraphDirectory(paths: CraftPaths, id: string, legacy = false, baseDirectory = paths.experienceDir): string {
  const portable = /^[a-z0-9][a-z0-9_-]{0,95}$/u.test(id) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/iu.test(id);
  return join(baseDirectory, "graph", !legacy && portable ? id : `${slug(id)}--${stableDigest(id).slice(-12)}`);
}

/** Check every managed component, including the leaf; local data never follows links. */
export function checkedExperiencePath(paths: CraftPaths, path: string, create = false, baseDirectory = paths.experienceDir): string {
  const root = resolve(baseDirectory), target = resolve(path), part = relative(root, target);
  if (!part || part.split(/[\\/]+/).includes("..") || isAbsolute(part)) throw new Error("Experience path is outside the managed directory");
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
  readonly store: CraftStore;
  readonly paths: CraftPaths;
  constructor(store: CraftStore) { this.store = store; this.paths = store.paths; }

  private scopeDirectory(scope: string, create = false): string {
    return experienceDataDirectory(this.store, scope, create);
  }

  write(value: ProcedureDefinition, title: string, orphaned?: (path: string) => boolean): ProcedureDefinitionRef {
    const checked = definition(value);
    const canonical = JSON.stringify(checked, null, 2);
    const digest = stableDigest(checked);
    const baseDirectory = this.scopeDirectory(checked.scope, true);
    const path = checkedExperiencePath(this.paths, join(experienceGraphDirectory(this.paths, checked.procedure_id, false, baseDirectory), "versions", `${String(checked.procedure_version).padStart(6, "0")}.json`), true, baseDirectory);
    let publish = false;
    try {
      this.read({ format: "json", procedure_id: checked.procedure_id, procedure_version: checked.procedure_version, kind: checked.kind, scope: checked.scope, path, digest });
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
    return { format: "json", procedure_id: checked.procedure_id, procedure_version: checked.procedure_version, kind: checked.kind, scope: checked.scope, path, digest };
  }

  read(ref: ProcedureDefinitionRef): ProcedureDefinition {
    const path = resolve(ref.path), legacyRoot = resolve(this.paths.experienceProcedureDir);
    const baseDirectory = ref.scope === undefined ? this.paths.experienceDir : this.scopeDirectory(ref.scope, false);
    const filename = `${String(ref.procedure_version).padStart(6, "0")}.json`;
    const canonical = join(experienceGraphDirectory(this.paths, ref.procedure_id, false, baseDirectory), "versions", filename);
    const previous = join(experienceGraphDirectory(this.paths, ref.procedure_id, true, baseDirectory), "versions", filename);
    const globalCanonical = join(experienceGraphDirectory(this.paths, ref.procedure_id), "versions", filename);
    const globalPrevious = join(experienceGraphDirectory(this.paths, ref.procedure_id, true), "versions", filename);
    const legacyFile = (path.startsWith(`${legacyRoot}/`) || path.startsWith(`${legacyRoot}\\`)) && path.endsWith(`.v${ref.procedure_version}.json`);
    const globalLegacy = baseDirectory !== this.paths.experienceDir && (path === globalCanonical || path === globalPrevious || legacyFile);
    if (path !== canonical && path !== previous && !globalLegacy && !(baseDirectory === this.paths.experienceDir && legacyFile)) throw new Error("Procedure definition path is outside the managed directory");
    checkedExperiencePath(this.paths, path, false, globalLegacy ? this.paths.experienceDir : baseDirectory);
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Procedure definition is invalid");
    const value = definition(parsed);
    if (value.schema_version !== "craft.procedure.v1" || value.procedure_id !== ref.procedure_id || value.procedure_version !== ref.procedure_version || value.kind !== ref.kind
      || ref.scope !== undefined && value.scope !== ref.scope) throw new Error("Procedure definition metadata drifted");
    if (stableDigest(value) !== ref.digest) throw new Error("Procedure definition digest drifted");
    return value;
  }

  /** Incremental local maintenance; no model calls and no work during initialization. */
  maintain(limit = 5): JsonObject {
    const state = this.store.find("experience_asset_migration", "definition-locations");
    const page = this.store.experienceDefinitionMigrationPage(String(state?.after_id ?? ""), Number(state?.after_version ?? 0), limit);
    if (!page.length) {
      if (state && state.after_id !== "") this.store.save("experience_asset_migration", "definition-locations", { ...state, after_id: "", after_version: 0 });
      return { processed: 0, migrated: 0, status: "idle" };
    }
    let migrated = 0, failed = 0;
    for (const record of page) {
      const failureId = stableDigest([record.id, record.version]);
      const prior = this.store.find("experience_asset_migration_failure", failureId);
      try {
        if (record.definition_ref != null) {
          if (!procedureDefinitionRef(record.definition_ref)) throw new Error("Invalid definition reference");
          const expected = record.definition_ref, next = this.migrate(expected);
          if (expected.path !== next.path || expected.scope !== next.scope) {
            this.store.relocateExperienceDefinition(String(record.id), Number(record.version), { ...expected }, { ...next });
            migrated++;
          }
        }
      } catch {
        // Keep error bodies and paths out of diagnostic records; retry on a later scan.
        this.store.save("experience_asset_migration_failure", failureId, { ...prior, scope: record.scope,
          procedure_id: record.id, procedure_version: record.version, status: "retry_pending",
          reason: "definition_migration_failed", attempts: Number(prior?.attempts ?? 0) + 1 });
        failed++;
        continue;
      }
      if (prior?.status === "retry_pending") this.store.save("experience_asset_migration_failure", failureId, { ...prior, status: "resolved" });
    }
    const last = page[page.length - 1]!;
    this.store.save("experience_asset_migration", "definition-locations", { ...state, scope: "global", after_id: last.id, after_version: last.version });
    return { processed: page.length, migrated, ...(failed ? { failed } : {}), status: "progress" };
  }

  /** Copy a checked legacy revision; old references and active invocations stay valid. */
  migrate(ref: ProcedureDefinitionRef): ProcedureDefinitionRef {
    const value = this.read(ref);
    const baseDirectory = this.scopeDirectory(value.scope, true);
    const path = checkedExperiencePath(this.paths, join(experienceGraphDirectory(this.paths, value.procedure_id, false, baseDirectory),
      "versions", `${String(value.procedure_version).padStart(6, "0")}.json`), true, baseDirectory);
    const target: ProcedureDefinitionRef = { ...ref, scope: value.scope, path };
    if (resolve(ref.path) === path) return target;
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    try {
      try { linkSync(temporary, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      this.read(target);
    } finally { unlinkSync(temporary); }
    return target;
  }
}

export function procedureDefinitionRef(value: unknown): value is ProcedureDefinitionRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.format === "json" && typeof item.procedure_id === "string" && Number.isSafeInteger(item.procedure_version)
    && (item.kind === "workflow" || item.kind === "graph") && (item.scope === undefined || typeof item.scope === "string")
    && typeof item.path === "string" && typeof item.digest === "string";
}
