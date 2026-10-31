/** Project identities bind the canonical real project root; relocation requires migration. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { canonicalJson, payload, stableDigest } from "./digest.ts";
import type { ScopeRef } from "./validation.ts";
import { projectDataInventory } from "./project-data-inventory.ts";
import { projectDataMigration } from "./project-data-migration.ts";

export type ScopeAliasKind = "path" | "legacy" | "git_remote" | "user_named";
export type ScopeResolution = {
  readonly canonical_scope: ScopeRef;
  readonly matched_aliases: readonly JsonObject[];
  readonly attempted_scopes: readonly ScopeRef[];
  readonly excluded_scopes: readonly JsonObject[];
};

function hash(value: string): string { return createHash("sha256").update(value).digest("hex").slice(0, 24); }
function normalizeRemote(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const ssh = /^git@([^:]+):(.+)$/u.exec(trimmed);
  const url = /^https?:\/\/([^/]+)\/(.+)$/u.exec(trimmed);
  return (ssh ? `${ssh[1]}/${ssh[2]}` : url ? `${url[1]}/${url[2]}` : trimmed).toLowerCase();
}

/** Resolve a real project root without changing the repository or consulting a network. */
export function projectIdentityFromRoot(root: string, userNamedId?: string): JsonObject {
  const localPath = resolve(root);
  let canonicalPath = realpathSync(localPath);
  if (!statSync(canonicalPath).isDirectory()) throw new Error("project_root must be a directory");
  const gitOptions = { encoding: "utf8" as const, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"], timeout: 2_000, env: { ...process.env, LC_ALL: "C" } };
  try { canonicalPath = realpathSync(execFileSync("git", ["-C", canonicalPath, "rev-parse", "--show-toplevel"], gitOptions).trim()); }
  catch (error) {
    const failure = error as NodeJS.ErrnoException & { status?: number; stderr?: string };
    if (failure.status !== 128 || !failure.stderr?.includes("not a git repository")) throw new Error("PROJECT_ROOT_DISCOVERY_FAILED", { cause: error });
    // A non-Git directory is itself the explicitly supplied project root.
  }
  let remote: string | null = null;
  try { remote = execFileSync("git", ["-C", canonicalPath, "config", "--get", "remote.origin.url"], gitOptions).trim() || null; }
  catch (error) {
    if ((error as { status?: number }).status !== 1) throw new Error("PROJECT_REMOTE_DISCOVERY_FAILED", { cause: error });
  }
  const canonicalId = `project:${createHash("sha256").update(canonicalPath).digest("hex")}`;
  if (userNamedId !== undefined && userNamedId.trim() !== canonicalId) throw new Error("project_id conflicts with the canonical project root identity");
  return {
    canonical_scope: { kind: "project", id: canonicalId },
    project_kind: "local_fingerprint",
    remote_digest: remote ? stableDigest(normalizeRemote(remote)) : null,
    local_path_alias: canonicalPath,
  };
}

/**
 * The registry is intentionally tiny and record based so plugins use it through
 * MCP/SDK contracts rather than importing Craft's private storage code.
 */
export class ScopeIdentityKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  private migrateRegistry(identity: JsonObject, args: JsonObject): JsonObject {
    const root = identity.local_path_alias as string;
    if (args.action === "plan_registry_migration") {
      const diagnosis = this.diagnoseProject(identity);
      return { ...diagnosis, plan_digest: stableDigest(diagnosis), data_migrated: false };
    }
    if (typeof args.expected_digest !== "string" || !args.expected_digest) throw new Error("expected_digest from plan_registry_migration is required");
    return this.store.transaction(() => {
      const id = `project_registry_migration_${hash(String(args.expected_digest))}`;
      const previous = this.store.find("project_registry_migration", id);
      if (previous) {
        if (previous.state !== "applied" || previous.project_root !== root || previous.legacy_scope_id !== args.legacy_scope_id) throw new Error("registry migration is not reusable; run preflight again");
        for (const ref of previous.after as JsonObject[]) if (this.store.find(String(ref.kind), String(ref.id))?.version !== ref.version) throw new Error("registry changed after migration; run preflight again");
        const resolved = this.resolveProject({ project_root: root });
        return { migration: previous, identity: resolved.identity, registry_migrated: true, data_migrated: false, idempotent: true };
      }
      const diagnosis = this.diagnoseProject(identity);
      if (diagnosis.status !== "migration_required" || diagnosis.truncated === true || stableDigest(diagnosis) !== args.expected_digest) throw new Error("Registry migration plan changed or is ambiguous; run preflight again");
      const legacyId = (diagnosis.legacy_scope_ids as string[])[0];
      if (args.legacy_scope_id !== legacyId) throw new Error("legacy_scope_id must match the single preflight identity");
      const before: Array<{ kind: string; record: JsonObject }> = [];
      for (const ref of diagnosis.alias_refs as JsonObject[]) {
        const record = this.store.get("scope_alias", String(ref.id));
        if ((record.scope as JsonObject)?.id === legacyId) before.push({ kind: "scope_alias", record });
      }
      for (const ref of diagnosis.identity_refs as JsonObject[]) if (ref.id === legacyId) before.push({ kind: "project_identity", record: this.store.get("project_identity", String(ref.id)) });
      this.store.create("project_registry_migration", id, { project_root: root, canonical_scope: identity.canonical_scope, legacy_scope_id: legacyId, before, state: "prepared", data_migrated: false });
      for (const item of before) {
        const update = item.kind === "scope_alias" ? { status: "inactive" } : { local_path_alias: null, archived_local_path_alias: item.record.local_path_alias, status: "registry_archived" };
        this.store.updateIfVersion(item.kind, String(item.record.id), Number(item.record.version), { ...item.record, ...update, registry_migration_id: id });
      }
      const canonical = identity.canonical_scope as JsonObject;
      const existed = this.store.find("project_identity", String(canonical.id));
      const aliasExisted = new Set(["path", "legacy"].map(aliasKind => {
        const alias = aliasKind === "path" ? root : legacyId;
        const key = `scope_alias_${hash(canonicalJson({ scopeKind: "project", scopeId: canonical.id, aliasKind, alias }))}`;
        return this.store.find("scope_alias", key)?.id;
      }).filter(Boolean));
      const resolved = this.resolveProject({ project_root: root });
      // Keep the historical scope as a documented, excluded alias. No business data is exposed.
      const binding = this.bindAlias({ scope_kind: "project", scope_id: canonical.id, alias_kind: "legacy", alias: legacyId });
      const refs = [...before.map(item => ({ kind: item.kind, id: item.record.id })),
        ...(!existed ? [{ kind: "project_identity", id: canonical.id }] : []),
        ...[resolved.alias as JsonObject, binding.alias as JsonObject].filter(row => !before.some(item => item.record.id === row.id)).map(row => ({ kind: "scope_alias", id: row.id }))];
      const after = refs.map(ref => ({ ...ref, version: this.store.get(ref.kind, String(ref.id)).version }));
      const migration = this.store.save("project_registry_migration", id, { ...this.store.get("project_registry_migration", id), state: "applied", after, created: refs.filter(ref => !before.some(item => item.kind === ref.kind && item.record.id === ref.id) && (ref.kind !== "scope_alias" || !aliasExisted.has(ref.id))) });
      return { migration, identity: resolved.identity, registry_migrated: true, data_migrated: false };
    });
  }

  private restoreRegistry(identity: JsonObject, args: JsonObject): JsonObject {
    if (typeof args.migration_id !== "string") throw new Error("migration_id is required");
    return this.store.transaction(() => {
      const migration = this.store.get("project_registry_migration", String(args.migration_id));
      if (migration.project_root !== identity.local_path_alias) throw new Error("registry migration belongs to a different project root");
      if (migration.state === "restored") return { migration, idempotent: true, data_migrated: false };
      if (migration.state !== "applied") throw new Error("registry migration is not applied");
      for (const ref of migration.after as JsonObject[]) if (this.store.find(String(ref.kind), String(ref.id))?.version !== ref.version) throw new Error("registry changed after migration; restore refused");
      const canonicalId = String((migration.canonical_scope as JsonObject).id);
      const normalizedId = canonicalId.replace(/^project:/u, "");
      const uses = this.store.database.prepare(`SELECT DISTINCT kind,id FROM records WHERE kind NOT IN ('scope_alias','project_identity','project_registry_migration') AND (
        instr(payload_json,?)>0 OR (json_extract(payload_json,'$.scope.kind')='project' AND json_extract(payload_json,'$.scope.id')=?)
        OR (json_extract(payload_json,'$.scope_kind')='project' AND json_extract(payload_json,'$.scope_id')=?)
        OR json_extract(payload_json,'$.project_scope_id')=? OR json_extract(payload_json,'$.project_id')=?)`).iterate(canonicalId, normalizedId, normalizedId, normalizedId, normalizedId);
      for (const raw of uses) {
        const ref = raw as { kind: string; id: string };
        if (ref.kind === "project_data_migration") {
          const receipt = this.store.get(ref.kind, ref.id);
          if (receipt.state === "restored") {
            projectDataMigration(this.store, identity, { action: "restore_data_migration", migration_id: receipt.registry_migration_id, expected_digest: receipt.plan_digest });
            continue;
          }
        }
        throw new Error("canonical identity has been used; restore requires a data migration plan");
      }
      for (const ref of migration.created as JsonObject[]) this.store.remove(String(ref.kind), String(ref.id));
      for (const item of migration.before as Array<{ kind: string; record: JsonObject }>) this.store.save(item.kind, String(item.record.id), item.record);
      const restored = this.store.save("project_registry_migration", String(migration.id), { ...migration, state: "restored" });
      return { migration: restored, registry_restored: true, data_migrated: false };
    });
  }

  /** Inventory only: never reassign aliases or make legacy data visible. */
  diagnoseProject(identity: JsonObject): JsonObject {
    const canonical = identity.canonical_scope as ScopeRef;
    const matchesPath = (path: unknown): boolean => {
      if (typeof path !== "string") return false;
      try { return realpathSync(path) === identity.local_path_alias; } catch { return false; }
    };
    return this.store.readSnapshot(() => {
      const aliases = this.store.list("scope_alias", 101, row => row.status === "active" && row.alias_kind === "path" && matchesPath(row.alias), false);
      const identities = this.store.list("project_identity", 101, row => matchesPath(row.local_path_alias), false);
      const legacyScopes = [...new Set([
        ...aliases.map(row => String((row.scope as JsonObject | undefined)?.id ?? "")),
        ...identities.map(row => String(row.id)),
      ].filter(id => id && id !== canonical.id))].sort();
      const truncated = aliases.length > 100 || identities.length > 100;
      return {
        truncated,
        status: truncated ? "inventory_incomplete" : legacyScopes.length > 1 ? "ambiguous" : legacyScopes.length ? "migration_required" : "current",
        canonical_scope: canonical, project_root: identity.local_path_alias,
        legacy_scope_ids: legacyScopes,
        alias_refs: aliases.slice(0, 100).map(row => ({ id: row.id, version: row.version, scope: row.scope })),
        identity_refs: identities.slice(0, 100).map(row => ({ id: row.id, version: row.version })),
        migration_performed: false,
        recovery: legacyScopes.length ? "Back up the data directory and inventory legacy scoped records before migrating. Alias binding alone does not migrate data." : null,
      };
    });
  }

  resolveProject(args: JsonObject): JsonObject {
    const root = typeof args.project_root === "string" && args.project_root.trim() ? args.project_root : typeof args.cwd === "string" ? args.cwd : null;
    if (!root) throw new Error("project_root or cwd is required for project identity");
    const identity = projectIdentityFromRoot(root, typeof args.project_id === "string" ? args.project_id : undefined);
    if (["plan_data_migration", "apply_data_migration", "restore_data_migration"].includes(String(args.action))) return projectDataMigration(this.store, identity, args);
    if (args.action === "inventory_project_data") return projectDataInventory(this.store, identity, args);
    if (args.action === "restore_registry") return this.restoreRegistry(identity, args);
    if (args.action === "plan_registry_migration" || args.action === "apply_registry_migration") return this.migrateRegistry(identity, args);
    if (args.action === "diagnose") return this.diagnoseProject(identity);
    if (args.action !== undefined && args.action !== "resolve") throw new Error("Unknown project identity action");
    const canonical = identity.canonical_scope as ScopeRef;
    const projectId = canonical.id;
    const hasLegacyBinding = () => this.store.list("scope_alias", 1, item => {
      if (item.status !== "active" || item.alias_kind !== "path" || typeof item.alias !== "string"
        || (item.scope as JsonObject | undefined)?.id === projectId) return false;
      try { return realpathSync(item.alias) === identity.local_path_alias; } catch { return false; }
    }, false).length > 0 || this.store.list("project_identity", 1, item => {
      if (item.id === projectId || typeof item.local_path_alias !== "string") return false;
      try { return realpathSync(item.local_path_alias) === identity.local_path_alias; } catch { return false; }
    }, false).length > 0;
    const assertCurrentIdentity = (record: JsonObject): void => {
      const storedScope = record.canonical_scope as JsonObject | undefined;
      let storedPath: string;
      try { storedPath = typeof record.local_path_alias === "string" ? realpathSync(record.local_path_alias) : ""; }
      catch { throw new Error("PROJECT_IDENTITY_INVALID: registered project path is unavailable"); }
      if (storedScope?.kind !== "project" || storedScope.id !== projectId || storedPath !== identity.local_path_alias
        || record.identity_digest !== stableDigest({ canonical: storedScope, project_kind: record.project_kind, remote_digest: record.remote_digest })) {
        throw new Error("PROJECT_IDENTITY_INVALID: registered project identity does not match its root");
      }
    };
    const existingBinding = this.store.readSnapshot(() => {
      if (hasLegacyBinding()) throw Object.assign(new Error("PROJECT_IDENTITY_MIGRATION_REQUIRED: existing project data uses a different identity for this root; call craft_scope_identity_resolve_project with action=diagnose to inspect conflicting identities"), { code: "PROJECT_IDENTITY_MIGRATION_REQUIRED" });
      const existing = this.store.find("project_identity", projectId);
      if (!existing) return null;
      assertCurrentIdentity(existing);
      const aliasKey = { scopeKind: "project", scopeId: projectId, aliasKind: "path", alias: identity.local_path_alias };
      const alias = this.store.find("scope_alias", `scope_alias_${hash(canonicalJson(aliasKey))}`);
      if (!alias) return null;
      const aliasIdentity = { scope: { kind: "project", id: projectId }, alias_kind: "path", alias: identity.local_path_alias, alias_digest: stableDigest(identity.local_path_alias) };
      if (alias.status !== "active" || alias.identity_digest !== stableDigest(aliasIdentity)) throw new Error("PROJECT_IDENTITY_INVALID: registered project alias is inactive or invalid");
      return { identity: existing, alias, idempotent: true };
    });
    if (existingBinding) return existingBinding;
    return this.store.transaction(() => {
      const current = this.store.find("project_identity", projectId);
      if (hasLegacyBinding()) throw Object.assign(new Error("PROJECT_IDENTITY_MIGRATION_REQUIRED: existing project data uses a different identity for this root; call craft_scope_identity_resolve_project with action=diagnose to inspect conflicting identities"), { code: "PROJECT_IDENTITY_MIGRATION_REQUIRED" });
      if (current) assertCurrentIdentity(current);
      const saved = current ?? this.store.create("project_identity", projectId, { ...identity, identity_digest: stableDigest({ canonical, project_kind: identity.project_kind, remote_digest: identity.remote_digest }) });
      const alias = this.bindAlias({ scope_kind: "project", scope_id: projectId, alias_kind: "path", alias: identity.local_path_alias });
      return { identity: saved, alias: alias.alias, idempotent: Boolean(current) && alias.idempotent === true };
    });
  }

  bindAlias(args: JsonObject): JsonObject {
    const scopeKind = String(args.scope_kind ?? ""); const scopeId = String(args.scope_id ?? ""); const aliasKind = String(args.alias_kind ?? ""); const alias = String(args.alias ?? "").trim();
    if (scopeKind !== "project" || !scopeId || !alias || !new Set<ScopeAliasKind>(["path", "legacy", "git_remote", "user_named"]).has(aliasKind as ScopeAliasKind)) throw new Error("Scope Alias is invalid");
    const id = `scope_alias_${hash(canonicalJson({ scopeKind, scopeId, aliasKind, alias }))}`;
    const identity = { scope: { kind: scopeKind, id: scopeId }, alias_kind: aliasKind, alias, alias_digest: stableDigest(alias) };
    const existing = this.store.find("scope_alias", id);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Scope Alias idempotency conflict");
      return { alias: existing, idempotent: true };
    }
    return this.store.transaction(() => {
      const current = this.store.find("scope_alias", id);
      if (current) {
        if (current.identity_digest !== stableDigest(identity)) throw new Error("Scope Alias idempotency conflict");
        return { alias: current, idempotent: true };
      }
      return { alias: this.store.create("scope_alias", id, { ...identity, identity_digest: stableDigest(identity), status: "active" }), idempotent: false };
    });
  }

  /** Bind known historical scope ids without destroying their source records. */
  migrateAlias(args: JsonObject): JsonObject {
    const legacyId = String(args.legacy_scope_id ?? "").trim();
    if (!legacyId) throw new Error("legacy_scope_id is required");
    const resolved = this.resolveProject(args);
    const canonical = (resolved.identity as JsonObject).canonical_scope as JsonObject;
    const binding = this.bindAlias({ scope_kind: "project", scope_id: canonical.id, alias_kind: "legacy", alias: legacyId });
    return { ...resolved, binding: binding.alias, migration_performed: false, legacy_records_preserved: true };
  }

  resolveStack(scope: ScopeRef, args: JsonObject = {}): ScopeResolution {
    const attempted: ScopeRef[] = []; const aliases: JsonObject[] = []; const excluded: JsonObject[] = [];
    const host = typeof args.session_host === "string" ? args.session_host : undefined;
    const requested = scope.kind === "session" && host ? { ...scope, id: sessionStorageScopeId(host, scope.id) } : scope;
    // A scope stack is a read order, not an ownership tree.  Work-local scopes
    // form one lane; the explicitly named personal lane is appended separately
    // below.  Team/organization scopes are never discovered by scanning data.
    if (["task", "session", "team", "organization", "user", "global", "workspace"].includes(requested.kind)) attempted.push(requested);
    if (requested.kind === "project" || requested.kind === "workspace" || requested.kind === "task" || requested.kind === "session") {
      const project = requested.kind === "project" ? requested : this.projectFromArgs(args);
      if (project) {
        const candidates = this.store.list("scope_alias", 10_000, (item) => item.status === "active" && String(item.alias) === project.id);
        const direct = this.store.find("project_identity", project.id);
        if (!direct && new Set(candidates.map(item => canonicalJson(item.scope))).size > 1) throw new Error("PROJECT_SCOPE_AMBIGUOUS: alias maps to multiple projects");
        const canonical = direct ? direct.canonical_scope as ScopeRef : (candidates[0]?.scope as ScopeRef | undefined) ?? project;
        if (canonical && typeof args.project_root === "string" && args.project_root.trim()) {
          const expected = projectIdentityFromRoot(args.project_root, typeof args.project_id === "string" ? args.project_id : undefined).canonical_scope as ScopeRef;
          if (canonical.id !== expected.id) throw new Error("PROJECT_SCOPE_CONFLICT: project scope does not match project root");
        }
        if (requested.kind === "project" && typeof args.project_scope_id === "string" && args.project_scope_id.trim() && args.project_scope_id.trim() !== canonical?.id) {
          throw new Error("PROJECT_SCOPE_CONFLICT: project scopes do not match");
        }
        if (canonical) {
          attempted.push(canonical); aliases.push(...candidates);
          // Path-based identities cannot inherit records merely because an old
          // scope was registered as an alias. Data migration must prove ownership.
          const reverseAliases = this.store.list("scope_alias", 10_000, (item) => item.status === "active" && canonicalJson(item.scope) === canonicalJson(canonical));
          aliases.push(...reverseAliases);
          for (const alias of reverseAliases) {
            if (/^project:[a-f0-9]{64}$/u.test(canonical.id) && String(alias.alias) !== canonical.id) {
              excluded.push({ scope: { kind: "project", id: String(alias.alias) }, reason: "project_scope_migration_required" });
            } else attempted.push({ kind: "project", id: String(alias.alias) });
          }
        } else attempted.push(project);
      }
    }
    if (requested.kind !== "session" && typeof args.session_scope_id === "string" && args.session_scope_id.trim()) {
      // Only a task may inherit another session. A project request cannot silently
      // read arbitrary transient notes from a session supplied by another Host.
      // The current Host may explicitly include its own session when both
      // session identifiers match; Hook memory then remains useful until archive.
      const sessionScopeId = host ? sessionStorageScopeId(host, args.session_scope_id.trim()) : args.session_scope_id.trim();
      if (requested.kind === "task") attempted.splice(1, 0, { kind: "session", id: sessionScopeId });
      else if (typeof args.session_id === "string" && args.session_id.trim() === args.session_scope_id.trim()) attempted.push({ kind: "session", id: sessionScopeId });
      else excluded.push({ scope: { kind: "session", id: sessionScopeId }, reason: "session_scope_requires_task_request" });
    }
    for (const kind of ["team", "organization"] as const) {
      const key = `${kind}_scope_id`;
      if (requested.kind === kind) continue;
      if (typeof args[key] === "string" && args[key].trim()) attempted.push({ kind, id: args[key].trim() });
      else excluded.push({ scope: { kind, id: null }, reason: `${key}_not_supplied` });
    }
    // A project/task turn may inherit one *explicitly named* user scope.  It
    // never guesses a user id and never scans user records, which keeps the
    // task → project → user order useful without creating a global fallback.
    if (requested.kind !== "user" && typeof args.user_scope_id === "string" && args.user_scope_id.trim()) {
      attempted.push({ kind: "user", id: args.user_scope_id.trim() });
    } else if (requested.kind !== "user") excluded.push({ scope: { kind: "user", id: null }, reason: "explicit_user_scope_not_supplied" });
    if (args.include_global === true) attempted.push({ kind: "global", id: "global" });
    else excluded.push({ scope: { kind: "global", id: "global" }, reason: "explicit_global_not_requested" });
    const unique = attempted.filter((item, index, list) => list.findIndex((other) => other.kind === item.kind && other.id === item.id) === index);
    return { canonical_scope: unique.find((item) => item.kind === requested.kind) ?? requested, matched_aliases: aliases, attempted_scopes: unique, excluded_scopes: excluded };
  }

  private projectFromArgs(args: JsonObject): ScopeRef | null {
    if (typeof args.project_scope_id === "string" && args.project_scope_id.trim()) return { kind: "project", id: args.project_scope_id.trim() };
    if (typeof args.project_root !== "string" || !args.project_root.trim()) return null;
    const identity = projectIdentityFromRoot(args.project_root, typeof args.project_id === "string" ? args.project_id : undefined);
    return identity.canonical_scope as ScopeRef;
  }
}
