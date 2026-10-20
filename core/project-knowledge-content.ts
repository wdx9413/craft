import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "./digest.ts";
import { scopeFromKey } from "./scope-policy.ts";

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

/** Bind project-scoped Knowledge to the user data root while validating its registered project alias. */
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

  const aliases = store.list("scope_alias", 10_000, item => item.status === "active" && item.alias_kind === "path"
    && (item.scope as Record<string, unknown> | undefined)?.kind === "project"
    && (item.scope as Record<string, unknown> | undefined)?.id === id)
    .filter(item => typeof item.alias === "string" && isAbsolute(item.alias) && item.alias_digest === stableDigest(item.alias))
    .map(item => { try { return realpathSync(item.alias as string); } catch { return ""; } })
    .filter(Boolean);
  const roots = [...new Set(aliases)];
  const requested = options.project_root === undefined ? undefined : realpathSync(resolve(options.project_root));
  if (requested && !roots.includes(requested)) throw new Error("Project root is not registered for this Knowledge scope");

  const directory = join(store.paths.knowledgeDir, "projects", id.slice("project:".length), "md");
  const target = options.reference_path === undefined ? undefined : resolve(options.reference_path);
  if (target) {
    const path = relative(directory, target);
    if (path === "" || path === ".." || path.startsWith(`..${sep}`)) return null;
    return directory;
  }
  const matches = roots.filter(root => !requested || requested === root);
  if (matches.length > 1) throw new Error("Project root is ambiguous for this Knowledge scope");
  const root = matches[0];
  if (!root) return null;
  if (!lstatSync(root).isDirectory()) throw new Error("Project root must be a directory");

  for (const path of [store.paths.knowledgeDir, join(store.paths.knowledgeDir, "projects"), join(store.paths.knowledgeDir, "projects", id.slice("project:".length)), directory]) {
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
