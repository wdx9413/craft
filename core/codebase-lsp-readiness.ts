import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { languageIdForFile, readTrustedLspConfig, type TrustedLspAdapter } from "../capability/craft-codebase/lsp-config.ts";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

const MAX_FILES = 50_000;

const DEFAULT_SERVERS: Readonly<Record<string, { command: string; args: string[] }>> = {
  typescript: { command: "typescript-language-server", args: ["--stdio"] }, typescriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  javascript: { command: "typescript-language-server", args: ["--stdio"] }, javascriptreact: { command: "typescript-language-server", args: ["--stdio"] },
  python: { command: "pyright-langserver", args: ["--stdio"] }, go: { command: "gopls", args: ["serve"] },
  java: { command: "jdtls", args: [] }, rust: { command: "rust-analyzer", args: [] },
  cpp: { command: "clangd", args: [] }, c: { command: "clangd", args: [] },
};

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error(`${field} must contain at most ${MAX_FILES} paths`);
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").map(item => item.trim().replaceAll("\\", "/"));
}

function adapterFor(adapters: readonly TrustedLspAdapter[], language: string): TrustedLspAdapter | undefined {
  return adapters.find(adapter => adapter.language === language || adapter.language.startsWith(`${language}-`));
}

function languageOf(path: string): string | undefined { return languageIdForFile(path); }

/** Read-only language-server readiness. It never starts a server or changes the Codebase index. */
export function codebaseLspReadiness(store: CraftStore, args: JsonObject = {}): JsonObject {
  const config = readTrustedLspConfig(store.paths.configDir);
  const files = stringList(args.files, "files");
  const requested = Array.isArray(args.languages) ? args.languages.filter((value): value is string => typeof value === "string" && value.trim() !== "") : [];
  const languages = [...new Set([...files.map(languageOf).filter((value): value is string => value !== undefined), ...requested])].sort();
  const adapters = languages.map(language => {
    const trusted = adapterFor(config.adapters, language);
    const expected = Object.hasOwn(DEFAULT_SERVERS, language) ? DEFAULT_SERVERS[language] : undefined;
    const found = trusted !== undefined;
    return { language, status: found ? "trusted_adapter_configured" : expected ? "server_not_configured" : "unsupported_language",
      configured: found, adapter: found ? { command: trusted.command, args: trusted.args, analyzer_version: trusted.analyzer_version } : null,
      suggested_command: found || !expected ? null : expected.command,
      suggested_config: found || !expected ? null : { language, command: expected.command, args: expected.args,
        note: "set command to the language server's absolute executable path", command_must_be_absolute: true,
        analyzer_version: "1", relations: ["definitions", "references", "calls", "implementations", "type_definitions", "type_hierarchy"] },
      files: files.filter(path => languageOf(path) === language).length,
      starts_server: false, install_performed: false };
  });
  const configured = adapters.filter(item => item.configured && item.adapter !== null).map(item => (item.adapter as JsonObject));
  const unavailable = config.diagnostics.filter(item => item.status !== "active");
  return {
    config: { path: config.path, digest: config.digest, exists: existsSync(config.path), adapters: config.adapters.length },
    files: { requested: files.length, languages },
    languages: adapters,
    summary: { configured_languages: configured.length, requested_languages: languages.length,
      ready: languages.length > 0 && adapters.every(item => item.configured), diagnostics: unavailable.length },
    security: { user_managed_config_only: true, repository_can_register_executables: false, starts_language_server: false,
      absolute_command_required: true, config_file: "codebase-lsp.json" },
    config_diagnostics: config.diagnostics,
    content_free: true,
    execution_context: false,
  };
}

/** The trusted adapter accepts only absolute executable paths; a suggestion is not a valid command. */
export function lspCommandIsAbsolute(command: unknown): boolean { return typeof command === "string" && isAbsolute(command); }
