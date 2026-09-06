import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicPrivateJson, craftPaths, ensureLayout, type CraftPaths } from "./paths.ts";

export type CraftMode = "agent" | "supervisor" | "provider";
export type RuntimeKind = "direct-api" | "codex-cli" | "claude-code" | "unconfigured";

export interface DirectProvider {
  protocol: "openai-compatible" | "anthropic";
  name: string;
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
}

export interface CraftConfig {
  schemaVersion: 1;
  activeMode: CraftMode;
  initializedAt: string;
  updatedAt: string;
  runtime: {
    kind: RuntimeKind;
    command?: string;
    provider?: DirectProvider;
  };
  supervisor: { hosts: Array<"codex-cli" | "claude-code" | "generic-mcp"> };
  storage: {
    database: string;
    capabilityIndex: string;
    legacyDatabase?: string;
  };
}

export interface InitInput {
  mode: CraftMode;
  runtimeKind?: RuntimeKind;
  provider?: DirectProvider;
  supervisorHosts?: CraftConfig["supervisor"]["hosts"];
  now?: string;
}

const MODES = new Set<CraftMode>(["agent", "supervisor", "provider"]);
const RUNTIMES = new Set<RuntimeKind>([
  "direct-api", "codex-cli", "claude-code", "unconfigured",
]);
const HOSTS = new Set(["codex-cli", "claude-code", "generic-mcp"]);

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(paths = craftPaths()): Promise<CraftConfig | null> {
  if (!await exists(paths.configFile)) return null;
  const parsed: unknown = JSON.parse(await readFile(paths.configFile, "utf8"));
  validateConfig(parsed);
  return parsed;
}

export async function initializeConfig(
  input: InitInput, paths: CraftPaths = craftPaths(),
): Promise<CraftConfig> {
  validateInit(input);
  await ensureLayout(paths);
  const now = input.now || new Date().toISOString();
  const legacy = await exists(paths.legacyDatabaseFile);
  const runtimeKind = input.mode === "agent"
    ? input.runtimeKind || "unconfigured" : "unconfigured";
  const config: CraftConfig = {
    schemaVersion: 1,
    activeMode: input.mode,
    initializedAt: now,
    updatedAt: now,
    runtime: {
      kind: runtimeKind,
      ...(runtimeKind === "codex-cli" ? { command: "codex" } : {}),
      ...(runtimeKind === "claude-code" ? { command: "claude" } : {}),
      ...(runtimeKind === "direct-api" ? { provider: input.provider } : {}),
    },
    supervisor: { hosts: input.mode === "supervisor" ? input.supervisorHosts || [] : [] },
    storage: {
      database: paths.databaseFile,
      capabilityIndex: paths.indexFile,
      ...(legacy ? { legacyDatabase: paths.legacyDatabaseFile } : {}),
    },
  };
  await atomicPrivateJson(paths.configFile, config);
  return config;
}

export async function setMode(
  mode: CraftMode, paths: CraftPaths = craftPaths(), now = new Date().toISOString(),
): Promise<CraftConfig> {
  const current = await loadConfig(paths);
  if (!current) throw new Error("Craft is not initialized; run `craft init` first.");
  if (!MODES.has(mode)) throw new Error(`Unsupported Craft mode: ${mode}`);
  const updated = { ...current, activeMode: mode, updatedAt: now };
  await atomicPrivateJson(paths.configFile, updated);
  return updated;
}

function validateInit(input: InitInput): void {
  if (!MODES.has(input.mode)) throw new Error(`Unsupported Craft mode: ${input.mode}`);
  const runtime = input.runtimeKind || "unconfigured";
  if (!RUNTIMES.has(runtime)) throw new Error(`Unsupported runtime: ${runtime}`);
  if (input.mode === "agent" && runtime === "direct-api") validateProvider(input.provider);
  for (const host of input.supervisorHosts || []) {
    if (!HOSTS.has(host)) throw new Error(`Unsupported supervisor host: ${host}`);
  }
}

function validateProvider(provider: DirectProvider | undefined): asserts provider is DirectProvider {
  if (!provider) throw new Error("Direct API runtime requires provider configuration.");
  if (!["openai-compatible", "anthropic"].includes(provider.protocol)) {
    throw new Error(`Unsupported provider protocol: ${provider.protocol}`);
  }
  if (!provider.name.trim() || !provider.model.trim()) {
    throw new Error("Provider name and model must not be empty.");
  }
  const url = new URL(provider.baseUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash) {
    throw new Error("Provider base URL must be an HTTP(S) URL without credentials or query data.");
  }
  if (provider.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(provider.apiKeyEnv)) {
    throw new Error("apiKeyEnv must be an uppercase environment-variable name.");
  }
}

function validateConfig(value: unknown): asserts value is CraftConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Craft config must be an object.");
  }
  const config = value as Partial<CraftConfig>;
  if (config.schemaVersion !== 1 || !config.activeMode || !MODES.has(config.activeMode)) {
    throw new Error("Unsupported or invalid Craft config schema.");
  }
  if (!config.runtime || !RUNTIMES.has(config.runtime.kind)) {
    throw new Error("Craft config has an invalid runtime.");
  }
  if (!config.storage?.database || !config.storage.capabilityIndex) {
    throw new Error("Craft config has invalid storage paths.");
  }
}
