import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { atomicPrivateJson, craftPaths, ensureLayout } from "./paths.js";
import {} from "./semantic.js";
const MODES = new Set(["agent", "supervisor", "provider"]);
const RUNTIMES = new Set([
    "direct-api", "codex-cli", "claude-code", "unconfigured",
]);
const HOSTS = new Set(["codex-cli", "claude-code", "generic-mcp"]);
async function exists(path) {
    try {
        await access(path, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function loadConfig(paths = craftPaths()) {
    if (!await exists(paths.configFile))
        return null;
    const parsed = JSON.parse(await readFile(paths.configFile, "utf8"));
    validateConfig(parsed);
    return parsed;
}
export async function initializeConfig(input, paths = craftPaths()) {
    validateInit(input);
    await ensureLayout(paths);
    const now = input.now || new Date().toISOString();
    const legacy = await exists(paths.legacyDatabaseFile);
    const runtimeKind = input.mode === "agent"
        ? input.runtimeKind || "unconfigured" : "unconfigured";
    const config = {
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
        ...(input.semanticSearch ? { semanticSearch: input.semanticSearch } : {}),
    };
    validateSemanticSearch(config.semanticSearch);
    await atomicPrivateJson(paths.configFile, config);
    return config;
}
export async function setMode(mode, paths = craftPaths(), now = new Date().toISOString()) {
    const current = await loadConfig(paths);
    if (!current)
        throw new Error("Craft is not initialized; run `craft init` first.");
    if (!MODES.has(mode))
        throw new Error(`Unsupported Craft mode: ${mode}`);
    const updated = { ...current, activeMode: mode, updatedAt: now };
    await atomicPrivateJson(paths.configFile, updated);
    return updated;
}
export async function configureSemanticSearch(semanticSearch, paths = craftPaths(), now = new Date().toISOString()) {
    const current = await loadConfig(paths);
    if (!current)
        throw new Error("Craft is not initialized; run `craft init` first.");
    validateSemanticSearch(semanticSearch);
    const updated = { ...current, updatedAt: now, ...(semanticSearch ? { semanticSearch } : {}) };
    if (!semanticSearch)
        delete updated.semanticSearch;
    await atomicPrivateJson(paths.configFile, updated);
    return updated;
}
function validateInit(input) {
    if (!MODES.has(input.mode))
        throw new Error(`Unsupported Craft mode: ${input.mode}`);
    const runtime = input.runtimeKind || "unconfigured";
    if (!RUNTIMES.has(runtime))
        throw new Error(`Unsupported runtime: ${runtime}`);
    if (input.mode === "agent" && runtime === "direct-api")
        validateProvider(input.provider);
    for (const host of input.supervisorHosts || []) {
        if (!HOSTS.has(host))
            throw new Error(`Unsupported supervisor host: ${host}`);
    }
}
function validateProvider(provider) {
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
        throw new Error("Direct API runtime requires provider configuration.");
    }
    const candidate = provider;
    if (!["openai-compatible", "anthropic"].includes(String(candidate.protocol))) {
        throw new Error(`Unsupported provider protocol: ${candidate.protocol}`);
    }
    if (typeof candidate.name !== "string" || !candidate.name.trim()
        || typeof candidate.model !== "string" || !candidate.model.trim()
        || typeof candidate.baseUrl !== "string") {
        throw new Error("Provider name and model must not be empty.");
    }
    validateProviderUrl(candidate.baseUrl);
    if (candidate.apiKeyEnv !== undefined && (typeof candidate.apiKeyEnv !== "string"
        || !/^[A-Z_][A-Z0-9_]*$/.test(candidate.apiKeyEnv))) {
        throw new Error("apiKeyEnv must be an uppercase environment-variable name.");
    }
}
function validateProviderUrl(value) {
    if (typeof value !== "string" || !value.trim())
        throw new Error("Provider base URL must not be empty.");
    let url;
    try {
        url = new URL(value);
    }
    catch {
        throw new Error("Provider base URL must be a valid HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
        || url.search || url.hash) {
        throw new Error("Provider base URL must be an HTTP(S) URL without credentials or query data.");
    }
}
function validateSemanticSearch(value) {
    if (value === undefined)
        return;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Semantic search must be an object.");
    const provider = value.provider;
    if (!provider || typeof provider !== "object" || Array.isArray(provider)) {
        throw new Error("Semantic search requires embedding provider configuration.");
    }
    const candidate = provider;
    if (candidate.protocol !== "openai-compatible")
        throw new Error("Semantic search supports openai-compatible embeddings only.");
    if (typeof candidate.name !== "string" || !candidate.name.trim() || typeof candidate.model !== "string" || !candidate.model.trim()) {
        throw new Error("Embedding provider name and model must not be empty.");
    }
    validateProviderUrl(candidate.baseUrl);
    if (candidate.apiKeyEnv !== undefined && (typeof candidate.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(candidate.apiKeyEnv))) {
        throw new Error("Embedding apiKeyEnv must be an uppercase environment-variable name.");
    }
    if (candidate.timeoutMs !== undefined && (!Number.isInteger(candidate.timeoutMs) || candidate.timeoutMs < 100 || candidate.timeoutMs > 30_000)) {
        throw new Error("Embedding timeoutMs must be an integer between 100 and 30000.");
    }
}
function validateConfig(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Craft config must be an object.");
    }
    const config = value;
    if (config.schemaVersion !== 1 || !config.activeMode || !MODES.has(config.activeMode)) {
        throw new Error("Unsupported or invalid Craft config schema.");
    }
    if (!config.runtime || !RUNTIMES.has(config.runtime.kind)) {
        throw new Error("Craft config has an invalid runtime.");
    }
    if (!config.storage?.database || !config.storage.capabilityIndex) {
        throw new Error("Craft config has invalid storage paths.");
    }
    if (typeof config.initializedAt !== "string" || typeof config.updatedAt !== "string"
        || typeof config.storage.database !== "string" || typeof config.storage.capabilityIndex !== "string") {
        throw new Error("Craft config has invalid string fields.");
    }
    if (config.runtime.kind === "direct-api")
        validateProvider(config.runtime.provider);
    if (["codex-cli", "claude-code"].includes(config.runtime.kind)
        && (typeof config.runtime.command !== "string" || !config.runtime.command.trim())) {
        throw new Error("CLI runtime requires a command.");
    }
    if (!config.supervisor || !Array.isArray(config.supervisor.hosts)
        || config.supervisor.hosts.some((host) => !HOSTS.has(host))) {
        throw new Error("Craft config has invalid supervisor hosts.");
    }
    validateSemanticSearch(config.semanticSearch);
}
//# sourceMappingURL=config.js.map