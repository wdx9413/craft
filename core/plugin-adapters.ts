import type { JsonObject } from "./infrastructure/store.ts";

/**
 * Host plugins describe the same two things in different shapes: MCP servers and
 * commands (plus skills). This module is the format layer — it never touches the
 * store — so Claude, Codex and DSH manifests normalize into one description that
 * the Craft runtime adapter layer can register.
 */
export type PluginSourceFormat = "claude" | "codex" | "dsh" | "craft" | "generic";
export type PluginAdapterKind = "mcp" | "command";

/** 多宿主插件只解析一次；优先 Codex 清单，其次 Claude、DSH、Pi、Craft。 */
export const PLUGIN_HOST_PRIORITY = ["codex", "claude", "dsh", "pi", "craft", "generic"] as const;
export type PluginHost = typeof PLUGIN_HOST_PRIORITY[number];

export function pluginHostOrder(hosts: readonly string[]): PluginHost[] {
  const declared = new Set(hosts.map((host) => String(host).trim().toLowerCase()));
  return PLUGIN_HOST_PRIORITY.filter((host) => declared.has(host));
}

export function preferredPluginHost(hosts: readonly string[]): PluginHost | null {
  return pluginHostOrder(hosts)[0] ?? null;
}

export interface PluginAdapterDraft {
  adapter_id: string;
  kind: PluginAdapterKind;
  entry: string;
  transport: string;
  platforms: string[];
  capabilities: string[];
  permissions: string[];
  effects: string[];
  metadata: JsonObject;
}

export interface PluginSkillDraft { skill_id: string; name: string; description: string; content: string; }

export interface NormalizedPlugin {
  source_format: PluginSourceFormat;
  adapters: PluginAdapterDraft[];
  skills: PluginSkillDraft[];
  notes: string[];
  requires_plugin_root: boolean;
  /** 从宿主扩展位提取出的标准 workbench 块；未声明时为 null。 */
  workbench: JsonObject | null;
}

/**
 * 不同宿主的 Workbench/UI 扩展位置不同：
 * - Craft/DSH 直接写 `workbench`
 * - Claude 常见 `ui` / `panels`
 * - Codex 常见 `interface` / `extensions.openai.ui`
 * 适配层把它们收敛成同一个标准块，交给 `normalizeWorkbenchContribution` 校验。
 */
const WORKBENCH_EXTENSION_PATHS: ReadonlyArray<readonly string[]> = [
  ["workbench"],
  ["ui"],
  ["panels"],
  ["interface"],
  ["extensions", "openai", "ui"],
  ["extensions", "ui"],
];

export function extractWorkbenchContribution(manifest: JsonObject): JsonObject | null {
  for (const path of WORKBENCH_EXTENSION_PATHS) {
    let cursor: unknown = manifest;
    for (const segment of path) cursor = asObject(cursor)?.[segment];
    const candidate = asObject(cursor);
    if (!candidate) continue;
    // 只接受声明了 schemaVersion 的块，避免把任意宿主 UI 配置误当作页面协议。
    if (candidate.schemaVersion === 1) return candidate;
  }
  return null;
}

const ROOT_TOKENS = ["${CLAUDE_PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}", "${DSH_PLUGIN_ROOT}", "${PLUGIN_ROOT}"];
const PLATFORMS: Record<string, string> = { windows: "win32", win: "win32", mac: "darwin", macos: "darwin", osx: "darwin", linux: "linux", freebsd: "freebsd", any: "any" };
const ACTIVE_PLATFORMS = new Set(["win32", "darwin", "linux", "freebsd", "any"]);

export function pluginSlug(value: string, fallback = "plugin"): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48) || fallback;
}

export function pluginSourceFormat(hosts: readonly string[]): PluginSourceFormat {
  const preferred = preferredPluginHost(hosts);
  if (preferred === "claude" || preferred === "codex" || preferred === "dsh") return preferred;
  return preferred === "craft" ? "craft" : "generic";
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function normalizedPlatforms(value: unknown): string[] {
  const declared = strings(value).map((item) => PLATFORMS[item.toLowerCase()] ?? item.toLowerCase()).filter((item) => ACTIVE_PLATFORMS.has(item));
  return declared.length ? [...new Set(declared)] : ["any"];
}
function normalizedEffects(value: unknown): string[] {
  const allowed = new Set(["read", "read_only", "local_write", "external_write", "destructive"]);
  const declared = strings(value).filter((item) => allowed.has(item));
  return declared.length ? [...new Set(declared)] : ["read_only"];
}
function containsRootToken(value: unknown): boolean {
  if (typeof value === "string") return ROOT_TOKENS.some((token) => value.includes(token));
  if (Array.isArray(value)) return value.some(containsRootToken);
  const object = asObject(value);
  return object ? Object.values(object).some(containsRootToken) : false;
}
function substituteRoot(value: unknown, pluginRoot: string | null): unknown {
  if (typeof value === "string") return pluginRoot ? ROOT_TOKENS.reduce((next, token) => next.split(token).join(pluginRoot), value) : value;
  if (Array.isArray(value)) return value.map((item) => substituteRoot(item, pluginRoot));
  const object = asObject(value);
  return object ? Object.fromEntries(Object.entries(object).map(([key, item]) => [key, substituteRoot(item, pluginRoot)])) : value;
}

/** A manifest can target Craft when it declares any tool surface Craft knows how to host. */
export function isCraftCompatibleManifest(manifest: JsonObject): boolean {
  return asObject(manifest.mcpServers) !== null
    || typeof manifest.mcpServers === "string"
    || Array.isArray(manifest.commands)
    || Array.isArray(manifest.skills)
    || typeof manifest.entry === "string"
    || typeof manifest.command === "string";
}

export function normalizePluginManifest(manifest: JsonObject, hosts: readonly string[], pluginRoot: string | null = null): NormalizedPlugin {
  const sourceFormat = pluginSourceFormat(hosts);
  const name = text(manifest.name) || "plugin";
  const base = pluginSlug(name);
  const platforms = normalizedPlatforms(manifest.platforms);
  const effects = normalizedEffects(manifest.effects);
  const adapters: PluginAdapterDraft[] = [];
  const skills: PluginSkillDraft[] = [];
  const notes: string[] = [];
  let requiresPluginRoot = false;

  const resolve = (value: unknown): unknown => {
    if (containsRootToken(value) && !pluginRoot) requiresPluginRoot = true;
    return substituteRoot(value, pluginRoot);
  };

  const mcpServers = manifest.mcpServers;
  if (typeof mcpServers === "string") {
    notes.push(`mcpServers 指向 ${mcpServers}；只上传 manifest 时无法展开，请连同插件目录安装`);
  } else {
    const servers = asObject(mcpServers) ?? {};
    for (const [serverName, rawServer] of Object.entries(servers)) {
      const server = asObject(rawServer);
      if (!server) continue;
      const command = text(resolve(server.command));
      const url = text(resolve(server.url));
      const entry = url || command;
      if (!entry) { notes.push(`MCP 服务 ${serverName} 缺少 command 或 url`); continue; }
      const args = resolve(Array.isArray(server.args) ? server.args : []) as unknown[];
      const env = resolve(asObject(server.env) ?? {}) as JsonObject;
      const headers = resolve(asObject(server.headers) ?? {}) as JsonObject;
      adapters.push({
        adapter_id: `${sourceFormat}.${base}.${pluginSlug(serverName, "server")}`,
        kind: "mcp", entry, transport: url || server.type === "http" ? "http" : "stdio",
        platforms, capabilities: ["tool"], permissions: strings(manifest.permissions), effects,
        metadata: { source: `${sourceFormat}-plugin-manifest`, server: serverName, command: command || null,
          args, env, url: url || null, headers, plugin_root: pluginRoot },
      });
    }
  }

  if (Array.isArray(manifest.commands)) {
    for (const raw of manifest.commands) {
      const command = asObject(raw);
      if (!command) continue;
      const commandName = text(command.name) || `command-${adapters.length + skills.length + 1}`;
      const entry = text(resolve(command.entry ?? command.command));
      if (entry) {
        adapters.push({
          adapter_id: `${sourceFormat}.${base}.${pluginSlug(commandName, "command")}`,
          kind: "command", entry, transport: "local", platforms, capabilities: strings(command.capabilities).length ? strings(command.capabilities) : ["command"],
          permissions: strings(manifest.permissions), effects: normalizedEffects(command.effects ?? effects),
          metadata: { source: `${sourceFormat}-plugin-manifest`, command: commandName, args: resolve(Array.isArray(command.args) ? command.args : []), description: text(command.description), plugin_root: pluginRoot },
        });
        continue;
      }
      const content = text(command.content);
      if (content) skills.push({ skill_id: `${base}.${pluginSlug(commandName, "skill")}`, name: commandName, description: text(command.description), content });
    }
  }

  if (Array.isArray(manifest.skills)) {
    for (const raw of manifest.skills) {
      const skill = asObject(raw);
      if (!skill) continue;
      const skillName = text(skill.name) || `skill-${skills.length + 1}`;
      const content = text(skill.content);
      if (!content) { notes.push(`技能 ${skillName} 没有内联内容，需要插件目录中的 SKILL.md`); continue; }
      skills.push({ skill_id: `${base}.${pluginSlug(skillName, "skill")}`, name: skillName, description: text(skill.description), content });
    }
  } else if (typeof manifest.skills === "string") {
    notes.push(`skills 指向 ${manifest.skills}；只上传 manifest 时无法读取 SKILL.md`);
  }

  // A single-entry tool plugin (the DSH CLI/command shape) still maps when no
  // mcpServers/commands were declared.
  if (!adapters.length && !skills.length) {
    const kind = text(manifest.kind);
    const entry = text(resolve(manifest.entry ?? manifest.command));
    if (entry && (kind === "mcp" || kind === "command" || !kind)) {
      adapters.push({
        adapter_id: `${sourceFormat}.${base}`, kind: kind === "command" ? "command" : "mcp", entry,
        transport: text(manifest.transport) || "stdio", platforms, capabilities: strings(manifest.capabilities).length ? strings(manifest.capabilities) : ["tool"],
        permissions: strings(manifest.permissions), effects,
        metadata: { source: `${sourceFormat}-plugin-manifest`, command: text(manifest.command) || null, args: resolve(Array.isArray(manifest.args) ? manifest.args : []), plugin_root: pluginRoot },
      });
    }
  }

  return { source_format: sourceFormat, adapters, skills, notes, requires_plugin_root: requiresPluginRoot,
    workbench: extractWorkbenchContribution(manifest) };
}
