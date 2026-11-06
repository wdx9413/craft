import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "./digest.ts";
import { scopeFromKey } from "./scope-policy.ts";
import { canonicalCandidatePath, ensureProjectStorageDirectory, existingProjectStorageDirectory, projectStorageDirectory } from "../common/craft-common-store-local/src/paths.ts";

export interface ProjectKnowledgeDirectoryOptions {
  readonly project_root?: string;
  readonly reference_path?: string;
  readonly create?: boolean;
}

/** Infer a project root only from a trusted Source locator with a known project layout. */
export function projectRootForKnowledgeSource(source: JsonObject): string | null {
  if (typeof source.locator !== "string") return null;
  if (source.kind === "readme" || source.kind === "project_note") {
    const path = resolve(source.locator);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile() || source.kind === "readme" && basename(path) !== "README.md") return null;
      return dirname(path);
    } catch { return null; }
  }
  if (source.kind === "serena") return resolve(source.locator, "..", "..");
  return null;
}

/** Bind project-scoped Knowledge to the registered project's capability directory. */
export function bindProjectKnowledgeContentDirectory(store: CraftStore): void {
  store.contentStore.setProjectKnowledgeDirectoryResolver((scope, options) =>
    projectKnowledgeContentDirectory(store, scope, options));
}

export function projectKnowledgeContentDirectory(store: CraftStore, scope: string,
  options: ProjectKnowledgeDirectoryOptions = {}): string | null {
  let parsed: ReturnType<typeof scopeFromKey>;
  try { parsed = scopeFromKey(scope); } catch { return null; }
  if (parsed.kind !== "project") return null;
  const id = parsed.id.startsWith("project:") ? parsed.id : `project:${parsed.id}`;
  if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(id)) return null;

  let unavailable = false;
  const aliases = store.list("scope_alias", 10_000, item => item.status === "active" && item.alias_kind === "path"
    && (item.scope as Record<string, unknown> | undefined)?.kind === "project"
    && (item.scope as Record<string, unknown> | undefined)?.id === id)
    .filter(item => typeof item.alias === "string" && isAbsolute(item.alias) && item.alias_digest === stableDigest(item.alias))
    .map(item => { try { return realpathSync(item.alias as string); } catch { unavailable = true; return ""; } })
    .filter(Boolean);
  const identity = store.find("project_identity", id);
  const canonical = identity?.canonical_scope as Record<string, unknown> | undefined;
  if (identity && canonical?.kind === "project" && canonical.id === id
    && identity.identity_digest === stableDigest({ canonical, project_kind: identity.project_kind, remote_digest: identity.remote_digest })
    && typeof identity.local_path_alias === "string" && isAbsolute(identity.local_path_alias)) {
    try { aliases.push(realpathSync(identity.local_path_alias)); } catch { unavailable = true; }
  }
  const roots = [...new Set(aliases)];
  const requested = options.project_root === undefined ? undefined : realpathSync(resolve(options.project_root));
  if (requested && !roots.includes(requested)) throw new Error("Project root is not registered for this Knowledge scope");
  if (roots.length > 1 || roots.length > 0 && unavailable) throw new Error("Project root is ambiguous for this Knowledge scope");

  const target = options.reference_path === undefined ? undefined : canonicalCandidatePath(options.reference_path);
  const root = roots[0];
  if (!root) return null;
  if (!lstatSync(root).isDirectory()) throw new Error("Project root must be a directory");
  const projectDirectory = projectStorageDirectory(store.paths, root);
  const directory = join(projectDirectory, "knowledge", "md");
  if (target) {
    const inside = (base: string) => { const part = relative(canonicalCandidatePath(base), target); return part !== "" && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
    const legacy = join(root, ".craft_data", "knowledge", "md");
    if (inside(legacy) && options.create !== true) return legacy;
    if (!inside(directory) && !inside(legacy)) return null;
  }
  if (options.create) ensureProjectStorageDirectory(store.paths, root);
  else existingProjectStorageDirectory(store.paths, root);
  for (const path of [join(projectDirectory, "knowledge"), directory]) {
    const exists = existsSync(path);
    if (!exists && options.create) mkdirSync(path, { recursive: true, mode: 0o700 });
    if (!exists && !options.create) continue;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project Knowledge content path must use regular directories");
  }
  return directory;
}

export function knowledgeDirectoryForScope(store: CraftStore, scope: string, options: ProjectKnowledgeDirectoryOptions = {}): string {
  const parsed = scopeFromKey(scope);
  const directory = projectKnowledgeContentDirectory(store, scope, { ...options, create: true })
    ?? (options.reference_path ? projectKnowledgeContentDirectory(store, scope, { project_root: options.project_root, create: true }) : null);
  if (parsed.kind === "project" && !directory) throw new Error("Project Knowledge scope has no registered project root");
  return directory ? dirname(directory) : store.paths.knowledgeDir;
}
