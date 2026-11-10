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

export type WorkbenchContextAction = { id: string; title: string; contexts: string[]; target: "memory" | "knowledge" | "workflows" };
export type WorkbenchTheme = { id: string; title: string; tokens: Record<string, string> };

function boundedList(value: unknown, name: string, max: number): JsonObject[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must be an array of at most ${max}`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${name}[${index}] must be an object`);
    return item as JsonObject;
  });
}

export function normalizeWorkbenchContribution(manifest: JsonObject): { pages: WorkbenchPage[]; context_actions: WorkbenchContextAction[]; advanced_tools: JsonObject[]; themes: WorkbenchTheme[]; notes: string[] } {
  const contribution = manifest.workbench;
  if (contribution === undefined) return { pages: [], context_actions: [], advanced_tools: [], themes: [], notes: [] };
  if (!contribution || typeof contribution !== "object" || Array.isArray(contribution)) throw new Error("manifest.workbench must be an object");
  const workbench = contribution as JsonObject;
  if (Number(workbench.schemaVersion) !== 1) throw new Error("manifest.workbench.schemaVersion must be 1");
  const rawPages = workbench.pages;
  if (rawPages !== undefined && (!Array.isArray(rawPages) || rawPages.length > MAX_PAGES)) throw new Error(`manifest.workbench.pages must be an array of at most ${MAX_PAGES}`);
  const seen = new Set<string>();
  const notes: string[] = [];
  const pages: WorkbenchPage[] = (rawPages || []).map((raw, index) => {
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
  const contextActions = boundedList(workbench.contextActions, "manifest.workbench.contextActions", 32).map((action, index) => {
    const id = text(action.id, `contextActions[${index}].id`), title = text(action.title, `contextActions[${index}].title`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) throw new Error("workbench context action id is invalid");
    if (action.target !== "memory" && action.target !== "knowledge" && action.target !== "workflows") throw new Error("workbench context action target is not supported");
    const contexts = action.contexts === undefined ? ["project"] : Array.isArray(action.contexts) ? action.contexts.map((value) => text(value, "contextActions.contexts")) : (() => { throw new Error("contextActions.contexts must be an array"); })();
    if (!contexts.length || contexts.some((context) => !["project", "task"].includes(context))) throw new Error("workbench context action context is not supported");
    return { id, title, contexts, target: action.target as WorkbenchContextAction["target"] };
  });
  if (new Set(contextActions.map((item) => item.id)).size !== contextActions.length) throw new Error("workbench context action ids must be unique");
  const advancedTools = boundedList(workbench.advancedTools, "manifest.workbench.advancedTools", 32).map((tool, index) => {
    const id = text(tool.id, `advancedTools[${index}].id`), title = text(tool.title, `advancedTools[${index}].title`);
    // Manifest-only plugins cannot execute arbitrary code; only a later host
    // adapter can activate these declarations. Unknown tools remain inert.
    const supported = tool.tool === "craft_memory_search" || tool.tool === "craft_knowledge_search" || tool.tool === "craft_workflow_search";
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) throw new Error("workbench advanced tool id is invalid");
    return { id, title, tool: text(tool.tool, `advancedTools[${index}].tool`), supported };
  });
  if (new Set(advancedTools.map((item) => item.id)).size !== advancedTools.length) throw new Error("workbench advanced tool ids must be unique");
  // Plugins may tune decoration, but host-owned surface/text colors remain fixed
  // so a contributed theme cannot make the application or permission UI unreadable.
  const allowedTokens = new Set(["--accent", "--line"]);
  const themes = boundedList(workbench.themes, "manifest.workbench.themes", 16).map((theme, index) => {
    const id = text(theme.id, `themes[${index}].id`), title = text(theme.title, `themes[${index}].title`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) throw new Error("workbench theme id is invalid");
    if (!theme.tokens || typeof theme.tokens !== "object" || Array.isArray(theme.tokens)) throw new Error("workbench theme tokens must be an object");
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(theme.tokens as Record<string, unknown>)) {
      if (!allowedTokens.has(key) || typeof value !== "string" || !/^#[0-9a-f]{3,8}$/iu.test(value)) throw new Error("workbench theme token is unsupported");
      tokens[key] = value;
    }
    return { id, title, tokens };
  });
  if (new Set(themes.map((item) => item.id)).size !== themes.length) throw new Error("workbench theme ids must be unique");
  return { pages, context_actions: contextActions, advanced_tools: advancedTools, themes, notes };
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
