import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CraftStore } from "../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../common/craft-common-base/src/digest.ts";
import { scopeFromKey } from "../common/craft-common-base/src/scope-policy.ts";

/** Resolve Experience data only inside the registered project's .craft_data tree. */
export function projectExperienceDirectory(store: CraftStore, scopeId: string, requestedRoot?: string, create = false,
  aliasDigest?: string): string {
  if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scopeId)) throw new Error("Experience project scope is invalid");
  const aliases = store.list("scope_alias", 10_000, item => item.status === "active" && item.alias_kind === "path"
    && (item.scope as Record<string, unknown> | undefined)?.kind === "project"
    && (item.scope as Record<string, unknown> | undefined)?.id === scopeId)
    .filter(item => typeof item.alias === "string" && isAbsolute(item.alias) && item.alias_digest === stableDigest(item.alias)
      && (!aliasDigest || item.alias_digest === aliasDigest))
    .map(item => { try { return realpathSync(item.alias as string); } catch { return ""; } }).filter(Boolean);
  const roots = [...new Set(aliases)];
  const root = requestedRoot === undefined ? (roots.length === 1 ? roots[0] : undefined) : realpathSync(resolve(requestedRoot));
  if (!root || !roots.includes(root)) throw new Error(roots.length > 1 ? "Experience project root is ambiguous" : "Experience project root is not registered");
  if (!lstatSync(root).isDirectory()) throw new Error("Experience project root must be a directory");
  const metadata = join(root, ".craft_data"), directory = join(metadata, "experience");
  if (create) {
    if (!existsSync(metadata)) mkdirSync(metadata, { mode: 0o700 });
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  }
  for (const path of [metadata, directory]) {
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Experience project data path must contain regular directories");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) break;
    }
  }
  return directory;
}

/** Resolve the Experience capability root for one explicit global or project scope. */
export function experienceDataDirectory(store: CraftStore, scope: string, create = false): string {
  let parsed: ReturnType<typeof scopeFromKey>;
  try { parsed = scopeFromKey(scope); }
  catch { return store.paths.experienceDir; } // Preserve old malformed, non-routable references in the global capability store.
  if (parsed.kind !== "project") return store.paths.experienceDir;
  return projectExperienceDirectory(store, `project:${parsed.id}`, undefined, create);
}

/** Resolve project Experience Markdown while retaining old global paths for reads. */
export function projectExperienceContentDirectory(store: CraftStore, scope: string, options: {
  project_root?: string; reference_path?: string; create?: boolean;
} = {}): string | null {
  let parsed: ReturnType<typeof scopeFromKey>;
  try { parsed = scopeFromKey(scope); } catch { return null; }
  if (parsed.kind !== "project") return null;
  const scopeId = parsed.id.startsWith("project:") ? parsed.id : `project:${parsed.id}`;
  if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scopeId)) return null;
  const roots = [...new Set(store.list("scope_alias", 10_000, item => item.status === "active" && item.alias_kind === "path"
    && (item.scope as Record<string, unknown> | undefined)?.kind === "project"
    && (item.scope as Record<string, unknown> | undefined)?.id === scopeId)
    .filter(item => typeof item.alias === "string" && isAbsolute(item.alias) && item.alias_digest === stableDigest(item.alias))
    .map(item => { try { return realpathSync(item.alias as string); } catch { return ""; } }).filter(Boolean))];
  const requested = options.project_root === undefined ? undefined : realpathSync(resolve(options.project_root));
  if (requested && !roots.includes(requested)) throw new Error("Project root is not registered for this Experience scope");
  let matches = requested ? roots.filter(root => root === requested) : roots;
  if (options.reference_path !== undefined) {
    const target = resolve(options.reference_path), global = resolve(store.paths.experienceContentDir);
    if (target === global || target.startsWith(`${global}${sep}`)) return null;
    matches = matches.filter(root => {
      const base = join(root, ".craft_data", "experience", "md"), part = relative(base, target);
      return part !== "" && part !== ".." && !part.startsWith(`..${sep}`);
    });
    if (!matches.length) return null;
  }
  if (matches.length > 1) throw new Error("Experience project root is ambiguous");
  const root = matches[0];
  if (!root) return null;
  const experience = projectExperienceDirectory(store, scopeId, root, options.create === true);
  const directory = join(experience, "md");
  if (options.create && !existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Experience content path must use a regular directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!options.create) return null;
  }
  return directory;
}

export function bindProjectExperienceContentDirectory(store: CraftStore): void {
  store.contentStore.setProjectExperienceDirectoryResolver((scope, options) => projectExperienceContentDirectory(store, scope, options));
}

export function projectPathAliasDigest(store: CraftStore, scopeId: string, requestedRoot?: string): string {
  if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scopeId)) throw new Error("Project data scope is invalid");
  const aliases = store.list("scope_alias", 10_000, item => item.status === "active" && item.alias_kind === "path"
    && (item.scope as Record<string, unknown> | undefined)?.kind === "project"
    && (item.scope as Record<string, unknown> | undefined)?.id === scopeId)
    .filter(item => typeof item.alias === "string" && isAbsolute(item.alias) && item.alias_digest === stableDigest(item.alias))
    .map(item => ({ digest: String(item.alias_digest), root: (() => { try { return realpathSync(String(item.alias)); } catch { return ""; } })() }))
    .filter(item => item.root && /^sha256:[a-f0-9]{64}$/u.test(item.digest));
  const requested = requestedRoot === undefined ? undefined : realpathSync(resolve(requestedRoot));
  const matches = aliases.filter(item => requested ? item.root === requested : true);
  const unique = [...new Map(matches.map(item => [item.root, item])).values()];
  if (unique.length !== 1) throw new Error(unique.length ? "Project root is ambiguous for this scope" : "Project root is not registered for this scope");
  return unique[0]!.digest;
}
