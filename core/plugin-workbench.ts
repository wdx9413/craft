import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { JsonObject } from "./infrastructure/store.ts";

/**
 * Workbench contribution protocol (first milestone).
 *
 * A plugin may declare declarative pages in its manifest. Declarative pages are
 * data: a fixed component whitelist plus actions bound to whitelisted API paths.
 * There is no arbitrary HTML, CSS or JavaScript. Sandboxed pages are a later
 * milestone and are returned only as an entry declaration here.
 */
export const WORKBENCH_PAGE_COMPONENTS = new Set([
  "tabs", "section", "rows", "form", "actions", "status", "artifactList", "emptyState", "notice",
]);

// Actions may only reach read-side product APIs; writes stay behind the normal
// approval surfaces, never a plugin page action.
const ACTION_API_PREFIXES = ["/api/workbench/", "/api/memory", "/api/knowledge", "/api/experience",
  "/api/objects", "/api/insights", "/api/claims", "/api/workspaces"];

const MAX_PAGES = 32;
const MAX_SCHEMA_BYTES = 256 * 1024;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function contained(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

export type WorkbenchPage = {
  id: string; title: string; icon?: string; kind: "declarative" | "sandboxed";
  schema?: string; requires?: string[];
};

export function normalizeWorkbenchContribution(manifest: JsonObject): { pages: WorkbenchPage[]; notes: string[] } {
  const contribution = manifest.workbench;
  if (contribution === undefined) return { pages: [], notes: [] };
  if (!contribution || typeof contribution !== "object" || Array.isArray(contribution)) throw new Error("manifest.workbench must be an object");
  const workbench = contribution as JsonObject;
  if (Number(workbench.schemaVersion) !== 1) throw new Error("manifest.workbench.schemaVersion must be 1");
  const rawPages = workbench.pages;
  if (rawPages === undefined) return { pages: [], notes: [] };
  if (!Array.isArray(rawPages) || rawPages.length > MAX_PAGES) throw new Error(`manifest.workbench.pages must be an array of at most ${MAX_PAGES}`);
  const seen = new Set<string>();
  const notes: string[] = [];
  const pages: WorkbenchPage[] = rawPages.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`workbench.pages[${index}] must be an object`);
    const page = raw as JsonObject;
    const id = text(page.id, `workbench.pages[${index}].id`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) throw new Error("workbench page id is invalid");
    if (seen.has(id)) throw new Error("workbench page ids must be unique");
    seen.add(id);
    const title = text(page.title, `workbench.pages[${index}].title`);
    const kind = page.kind === undefined ? "declarative" : text(page.kind, `workbench.pages[${index}].kind`);
    if (kind !== "declarative" && kind !== "sandboxed") throw new Error("workbench page kind must be declarative or sandboxed");
    const requires = page.requires === undefined ? [] : (Array.isArray(page.requires) ? page.requires.map((item) => text(item, "workbench.pages.requires")) : (() => { throw new Error("workbench.pages.requires must be an array"); })());
    if (kind === "declarative") {
      const schema = text(page.schema, `workbench.pages[${index}].schema`);
      if (isAbsolute(schema) || schema.split(/[\\/]+/).includes("..")) throw new Error("workbench page schema must be a relative path inside the plugin");
      return { id, title, kind, schema, requires };
    }
    notes.push(`page ${id} is sandboxed; it is not rendered in this milestone`);
    return { id, title, kind, requires };
  });
  return { pages, notes };
}

/** Validate a declarative page document against the fixed component and action whitelist. */
export function validateDeclarativePage(schema: unknown): JsonObject {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("declarative page schema must be an object");
  const root = schema as JsonObject;
  const visit = (node: unknown, depth: number): void => {
    if (depth > 24) throw new Error("declarative page nests too deeply");
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    const component = node as JsonObject;
    if (component.type !== undefined) {
      const type = text(component.type, "component.type");
      if (!WORKBENCH_PAGE_COMPONENTS.has(type)) throw new Error(`component type is not allowed: ${type}`);
      if (type === "actions" && component.actions !== undefined) {
        if (!Array.isArray(component.actions)) throw new Error("actions must be an array");
        for (const raw of component.actions) {
          const action = raw as JsonObject;
          const api = text(action && action.api, "action.api");
          if (!api.startsWith("/api/") || !ACTION_API_PREFIXES.some((prefix) => api.startsWith(prefix))) {
            throw new Error(`action api is not whitelisted: ${api}`);
          }
        }
      }
    }
    for (const value of Object.values(component)) visit(value, depth + 1);
  };
  visit(root, 0);
  return root;
}

/** Read and validate a declarative page schema from inside the plugin directory. */
export function readDeclarativePage(pluginRoot: string | null, schemaPath: string): JsonObject {
  if (!pluginRoot) throw new Error("plugin root is unknown; page schema cannot be resolved");
  const base = realpathSync(pluginRoot);
  const target = resolve(base, schemaPath);
  if (!contained(base, target)) throw new Error("page schema must resolve inside the plugin directory");
  if (!existsSync(target)) throw new Error("page schema file was not found");
  const real = realpathSync(target);
  if (!contained(base, real)) throw new Error("page schema must resolve inside the plugin directory");
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error("page schema must be a file");
  if (stat.size > MAX_SCHEMA_BYTES) throw new Error("page schema exceeds 256 KiB");
  const parsed: unknown = JSON.parse(readFileSync(real, "utf8"));
  return validateDeclarativePage(parsed);
}
