/** Project identities bind the canonical real project root; relocation requires migration. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { sessionStorageScopeId } from "../common/craft-common-store-local/src/paths.ts";
import { canonicalJson, payload, stableDigest } from "./digest.ts";
import type { ScopeRef } from "./validation.ts";

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

  resolveProject(args: JsonObject): JsonObject {
    const root = typeof args.project_root === "string" && args.project_root.trim() ? args.project_root : typeof args.cwd === "string" ? args.cwd : null;
    if (!root) throw new Error("project_root or cwd is required for project identity");
    const identity = projectIdentityFromRoot(root, typeof args.project_id === "string" ? args.project_id : undefined);
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
      if (hasLegacyBinding()) throw new Error("PROJECT_IDENTITY_MIGRATION_REQUIRED: existing project data uses a different identity for this root");
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
      if (hasLegacyBinding()) throw new Error("PROJECT_IDENTITY_MIGRATION_REQUIRED: existing project data uses a different identity for this root");
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
