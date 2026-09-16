import { access, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { resolve } from "node:path";
import { atomicPrivateJson, craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";

export type ModelProtocol = "openai-compatible" | "anthropic";

export interface CraftModelConfig {
  id: string;
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  supportsTools: boolean;
}

export interface CraftSettings {
  schemaVersion: 1;
  locale: "zh-CN" | "en-US";
  theme: "system" | "light" | "dark";
  dataRoot: string;
  workbench: { port: number; openOnStart: boolean };
  runtime: { defaultTier: "small" | "medium" | "large"; maxSteps: number; maxTokens: number };
  models: CraftModelConfig[];
  privacy: { telemetry: boolean };
  updatedAt: string;
}

export type CraftSettingsPatch = Partial<Pick<CraftSettings, "locale" | "theme" | "dataRoot">> & {
  workbench?: Partial<CraftSettings["workbench"]>;
  runtime?: Partial<CraftSettings["runtime"]>;
  models?: CraftModelConfig[];
  privacy?: Partial<CraftSettings["privacy"]>;
};

function number(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function text(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function httpUrl(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  const raw = text(value, name, fallback);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${name} must be a valid HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must be http or https`);
  return raw.replace(/\/+$/u, "");
}

function normalizeModels(value: unknown): CraftModelConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("models must be an array");
  const seen = new Set<string>();
  return value.map(function (item, index) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`models[${index}] must be an object`);
    const entry = item as Record<string, unknown>;
    const id = text(entry.id, `models[${index}].id`, `model-${index}`);
    if (seen.has(id)) throw new Error(`Duplicate model id: ${id}`);
    seen.add(id);
    const protocol = text(entry.protocol, `models[${index}].protocol`, "openai-compatible");
    if (protocol !== "openai-compatible" && protocol !== "anthropic") throw new Error(`models[${index}].protocol must be openai-compatible or anthropic`);
    const supportsTools = entry.supportsTools === undefined ? true : Boolean(entry.supportsTools);
    return {
      id,
      name: text(entry.name, `models[${index}].name`, id),
      protocol: protocol as ModelProtocol,
      baseUrl: httpUrl(entry.baseUrl, `models[${index}].baseUrl`, "https://api.openai.com/v1"),
      model: text(entry.model, `models[${index}].model`, "gpt-4o-mini"),
      apiKeyEnv: text(entry.apiKeyEnv, `models[${index}].apiKeyEnv`, "CRAFT_API_KEY"),
      supportsTools,
    };
  });
}

export function defaultSettings(paths = craftPaths()): CraftSettings {
  // Dark is the shipped default for the Studio shell; users can switch to the
  // all-white light theme from the title bar or Settings → 界面与运行时.
  return { schemaVersion: 1, locale: "zh-CN", theme: "dark", dataRoot: paths.root,
    workbench: { port: 4173, openOnStart: true }, runtime: { defaultTier: "medium", maxSteps: 32, maxTokens: 12000 },
    models: [], privacy: { telemetry: false }, updatedAt: new Date(0).toISOString() };
}

export function normalizeSettings(value: unknown, paths = craftPaths()): CraftSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const workbench = input.workbench && typeof input.workbench === "object" && !Array.isArray(input.workbench) ? input.workbench as Record<string, unknown> : {};
  const runtime = input.runtime && typeof input.runtime === "object" && !Array.isArray(input.runtime) ? input.runtime as Record<string, unknown> : {};
  const privacy = input.privacy && typeof input.privacy === "object" && !Array.isArray(input.privacy) ? input.privacy as Record<string, unknown> : {};
  const dataRoot = resolve(text(input.dataRoot, "dataRoot", paths.root));
  const locale = text(input.locale, "locale", "zh-CN");
  if (locale !== "zh-CN" && locale !== "en-US") throw new Error("locale must be zh-CN or en-US");
  const theme = text(input.theme, "theme", "system");
  if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error("theme must be system, light, or dark");
  const defaultTier = text(runtime.defaultTier, "runtime.defaultTier", "medium");
  if (defaultTier !== "small" && defaultTier !== "medium" && defaultTier !== "large") throw new Error("runtime.defaultTier must be small, medium, or large");
  const updatedAt = text(input.updatedAt, "updatedAt", new Date(0).toISOString());
  if (Number.isNaN(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
  return { schemaVersion: 1, locale: locale as CraftSettings["locale"], theme: theme as CraftSettings["theme"], dataRoot,
    workbench: { port: number(workbench.port, "workbench.port", 4173, 0, 65535), openOnStart: boolean(workbench.openOnStart, "workbench.openOnStart", true) },
    runtime: { defaultTier: defaultTier as CraftSettings["runtime"]["defaultTier"], maxSteps: number(runtime.maxSteps, "runtime.maxSteps", 32, 1, 10000), maxTokens: number(runtime.maxTokens, "runtime.maxTokens", 12000, 1, 100000000) },
    models: normalizeModels(input.models),
    privacy: { telemetry: boolean(privacy.telemetry, "privacy.telemetry", false) }, updatedAt };
}

export async function loadSettings(paths = craftPaths()): Promise<CraftSettings> {
  await ensureLayout(paths);
  try { await access(paths.settingsFile); return normalizeSettings(JSON.parse(await readFile(paths.settingsFile, "utf8")), paths); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return defaultSettings(paths);
    const settings = defaultSettings(paths); await atomicPrivateJson(paths.settingsFile, settings); return settings;
  }
}

export async function saveSettings(patch: CraftSettingsPatch, paths = craftPaths(), now = new Date()): Promise<CraftSettings> {
  const current = await loadSettings(paths);
  const next = normalizeSettings({ ...current, ...patch,
    workbench: { ...current.workbench, ...(patch.workbench ?? {}) }, runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
    models: patch.models !== undefined ? patch.models : current.models,
    privacy: { ...current.privacy, ...(patch.privacy ?? {}) }, updatedAt: now.toISOString() }, paths);
  await atomicPrivateJson(paths.settingsFile, next); return next;
}

export async function resetSettings(paths = craftPaths(), now = new Date()): Promise<CraftSettings> {
  const next = { ...defaultSettings(paths), updatedAt: now.toISOString() }; await atomicPrivateJson(paths.settingsFile, next); return next;
}

function syncWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path);
}

export function loadSettingsSync(paths = craftPaths()): CraftSettings {
  if (!existsSync(paths.settingsFile)) { const settings = defaultSettings(paths); syncWrite(paths.settingsFile, settings); return settings; }
  try { return normalizeSettings(JSON.parse(readFileSync(paths.settingsFile, "utf8")), paths); }
  catch { return defaultSettings(paths); }
}

export function saveSettingsSync(patch: CraftSettingsPatch, paths = craftPaths(), now = new Date()): CraftSettings {
  const current = loadSettingsSync(paths); const next = normalizeSettings({ ...current, ...patch,
    workbench: { ...current.workbench, ...(patch.workbench ?? {}) }, runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
    models: patch.models !== undefined ? patch.models : current.models,
    privacy: { ...current.privacy, ...(patch.privacy ?? {}) }, updatedAt: now.toISOString() }, paths); syncWrite(paths.settingsFile, next); return next;
}

export function resetSettingsSync(paths = craftPaths(), now = new Date()): CraftSettings {
  const next = { ...defaultSettings(paths), updatedAt: now.toISOString() }; syncWrite(paths.settingsFile, next); return next;
}

export function publicSettings(settings: CraftSettings, paths = craftPaths()): Record<string, unknown> {
  return { ...settings, settingsFile: paths.settingsFile, dataRoot: settings.dataRoot, restartRequiredForDataRoot: settings.dataRoot !== paths.root,
    secretsStored: false, note: "Credentials remain in environment variables or host stores; settings.json never contains API keys." };
}
