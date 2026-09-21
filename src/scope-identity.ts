/**
 * Stable identities for data that must survive a checkout moving to another
 * machine.  A filesystem path is useful as a local alias, but never as the
 * project identity carried by a Context receipt or an export bundle.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
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

/** Resolve Git identity without changing the repository or consulting a network. */
export function projectIdentityFromRoot(root: string, userNamedId?: string): JsonObject {
  const localPath = resolve(root);
  let canonicalPath = localPath;
  try { canonicalPath = realpathSync(localPath); } catch { /* a caller may be preparing a new workspace */ }
  let remote: string | null = null;
  try { remote = execFileSync("git", ["-C", canonicalPath, "config", "--get", "remote.origin.url"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { /* not a Git checkout */ }
  const basis = remote ? `git:${normalizeRemote(remote)}` : userNamedId ? `named:${userNamedId.trim()}` : `local:${hash(canonicalPath)}`;
  return {
    canonical_scope: { kind: "project", id: `project:${hash(basis)}` },
    project_kind: remote ? "git_remote" : userNamedId ? "user_named" : "local_fingerprint",
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
    const existing = this.store.find("project_identity", projectId);
    const saved = existing ?? this.store.create("project_identity", projectId, { ...identity, identity_digest: stableDigest({ canonical, project_kind: identity.project_kind, remote_digest: identity.remote_digest }) });
    const alias = this.bindAlias({ scope_kind: "project", scope_id: projectId, alias_kind: "path", alias: identity.local_path_alias });
    return { identity: saved, alias: alias.alias, idempotent: Boolean(existing) && alias.idempotent === true };
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
    return { alias: this.store.create("scope_alias", id, { ...identity, identity_digest: stableDigest(identity), status: "active" }), idempotent: false };
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
    // A scope stack is a read order, not an ownership tree.  Work-local scopes
    // form one lane; the explicitly named personal lane is appended separately
    // below.  Team/organization scopes are never discovered by scanning data.
    if (["task", "session", "team", "organization", "user", "global"].includes(scope.kind)) attempted.push(scope);
    if (scope.kind === "project" || scope.kind === "workspace" || scope.kind === "task" || scope.kind === "session") {
      const project = scope.kind === "project" ? scope : this.projectFromArgs(args);
      if (project) {
        const candidates = this.store.list("scope_alias", 10_000, (item) => item.status === "active" && String(item.alias) === project.id);
        const direct = this.store.find("project_identity", project.id);
        const canonical = direct ? direct.canonical_scope as ScopeRef : candidates[0]?.scope as ScopeRef | undefined;
        if (canonical) {
          attempted.push(canonical); aliases.push(...candidates);
          // Read legacy/path aliases only as bounded project aliases for this
          // canonical identity. This is migration compatibility, not a scan of
          // every project scope.
          const reverseAliases = this.store.list("scope_alias", 10_000, (item) => item.status === "active" && canonicalJson(item.scope) === canonicalJson(canonical));
          aliases.push(...reverseAliases);
          for (const alias of reverseAliases) attempted.push({ kind: "project", id: String(alias.alias) });
        } else attempted.push(project);
      }
    }
    if (scope.kind !== "session" && typeof args.session_scope_id === "string" && args.session_scope_id.trim()) {
      // Only a task may inherit a session.  A project request cannot silently
      // read arbitrary transient notes from a session supplied by another Host.
      if (scope.kind === "task") attempted.splice(1, 0, { kind: "session", id: args.session_scope_id.trim() });
      else excluded.push({ scope: { kind: "session", id: args.session_scope_id.trim() }, reason: "session_scope_requires_task_request" });
    }
    for (const kind of ["team", "organization"] as const) {
      const key = `${kind}_scope_id`;
      if (scope.kind === kind) continue;
      if (typeof args[key] === "string" && args[key].trim()) attempted.push({ kind, id: args[key].trim() });
      else excluded.push({ scope: { kind, id: null }, reason: `${key}_not_supplied` });
    }
    // A project/task turn may inherit one *explicitly named* user scope.  It
    // never guesses a user id and never scans user records, which keeps the
    // task → project → user order useful without creating a global fallback.
    if (scope.kind !== "user" && typeof args.user_scope_id === "string" && args.user_scope_id.trim()) {
      attempted.push({ kind: "user", id: args.user_scope_id.trim() });
    } else if (scope.kind !== "user") excluded.push({ scope: { kind: "user", id: null }, reason: "explicit_user_scope_not_supplied" });
    if (args.include_global === true) attempted.push({ kind: "global", id: "global" });
    else excluded.push({ scope: { kind: "global", id: "global" }, reason: "explicit_global_not_requested" });
    const unique = attempted.filter((item, index, list) => list.findIndex((other) => other.kind === item.kind && other.id === item.id) === index);
    return { canonical_scope: unique.find((item) => item.kind === scope.kind) ?? scope, matched_aliases: aliases, attempted_scopes: unique, excluded_scopes: excluded };
  }

  private projectFromArgs(args: JsonObject): ScopeRef | null {
    if (typeof args.project_scope_id === "string" && args.project_scope_id.trim()) return { kind: "project", id: args.project_scope_id.trim() };
    if (typeof args.project_root !== "string" || !args.project_root.trim()) return null;
    const identity = projectIdentityFromRoot(args.project_root, typeof args.project_id === "string" ? args.project_id : undefined);
    return identity.canonical_scope as ScopeRef;
  }
}
