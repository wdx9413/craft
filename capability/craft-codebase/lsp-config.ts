import { existsSync, lstatSync, readFileSync, realpathSync, constants } from "node:fs";
import { accessSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { stableDigest } from "../../common/craft-common-base/src/digest.ts";

export const CODEBASE_LSP_CONFIG = "codebase-lsp.json";
export const MAX_LSP_DOCUMENTS = 1_000;
export const MAX_RELATION_SYMBOLS = 1_000;
export const LSP_LANGUAGE_IDS: Readonly<Record<string, string>> = Object.freeze({
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescriptreact",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascriptreact",
  c: "c", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp", mm: "objective-cpp", m: "objective-c",
  java: "java", kt: "kotlin", kts: "kotlin", scala: "scala", sc: "scala", groovy: "groovy", go: "go", rs: "rust", cs: "csharp",
  py: "python", rb: "ruby", php: "php", swift: "swift", dart: "dart", lua: "lua", ex: "elixir", exs: "elixir", hs: "haskell", lhs: "haskell",
  ml: "ocaml", mli: "ocaml", clj: "clojure", cljs: "clojure", cljc: "clojure", pl: "perl", pm: "perl", r: "r", jl: "julia",
  zig: "zig", elm: "elm", erl: "erlang", hrl: "erlang", fs: "fsharp", fsi: "fsharp", fsx: "fsharp", sol: "solidity", nix: "nix",
  vue: "vue", svelte: "svelte", astro: "astro", html: "html", css: "css", scss: "scss", sass: "sass", less: "less", sql: "sql",
  proto: "proto", tf: "terraform", tfvars: "terraform", hcl: "terraform", sh: "shellscript", bash: "shellscript", ps1: "powershell", psm1: "powershell",
});

export type TrustedLspAdapter = { language: string; command: string; args: string[]; analyzer_version: string; relations: string[]; max_documents: number; relation_symbol_limit: number; request_timeout_ms: number };
export type TrustedLspConfig = { path: string; digest: string; adapters: TrustedLspAdapter[]; diagnostics: JsonObject[] };

/** Keep Go language-server and compiler caches inside the owning project's Codebase data directory. */
export function configuredLspWorkerEnvironment(language: string, codebaseDataRoot: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return language === "go" ? { ...inherited, GOPLSCACHE: join(codebaseDataRoot, "gopls-cache"), GOCACHE: join(codebaseDataRoot, "go-build-cache") } : inherited;
}

/** Read only the user-managed config; repository files can never register executables. */
export function readTrustedLspConfig(configDir: string): TrustedLspConfig {
  const path = resolve(configDir, CODEBASE_LSP_CONFIG);
  if (!existsSync(path)) return { path, digest: "none", adapters: [], diagnostics: [] };
  try {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("config_not_regular_file");
    const raw = readFileSync(path, "utf8");
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error("config_exceeds_budget");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_config_shape");
    const root = parsed as Record<string, unknown>;
    if (root.schema_version !== 1 || !Array.isArray(root.adapters) || root.adapters.length > 32) throw new Error("invalid_config_shape");
    const adapters: TrustedLspAdapter[] = [];
    const diagnostics: JsonObject[] = [];
    for (const candidate of (parsed as { adapters: unknown[] }).adapters) {
      try {
        const adapter = validateAdapter(candidate);
        if (adapters.some(existing => existing.language === adapter.language)) throw new Error("duplicate_language");
        adapters.push(adapter);
      }
      catch (error) { diagnostics.push({ status: "unavailable", reason: safeReason(error) }); }
    }
    return { path, digest: stableDigest({ raw }), adapters, diagnostics };
  } catch (error) {
    const reason = safeReason(error);
    return { path, digest: stableDigest({ error: reason }), adapters: [], diagnostics: [{ status: "unavailable", reason }] };
  }
}

function safeReason(error: unknown): string {
  return String(error).replace(/^(?:Error|TypeError): /u, "").slice(0, 80);
}

function validateAdapter(value: unknown): TrustedLspAdapter {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_adapter_shape");
  const item = value as Record<string, unknown>;
  const language = typeof item.language === "string" ? item.language : "";
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(language) || !Object.values(LSP_LANGUAGE_IDS).includes(language)) throw new Error("unsupported_language");
  if (typeof item.command !== "string" || !isAbsolute(item.command) || item.command.length > 1024) throw new Error("command_must_be_absolute");
  let command: string;
  try {
    command = realpathSync(item.command);
    accessSync(command, constants.X_OK);
  } catch { throw new Error("command_unavailable"); }
  const args = item.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(arg => typeof arg !== "string" || arg.length > 1024 || /[\0\r\n]/u.test(arg))) throw new Error("invalid_arguments");
  const analyzer_version = typeof item.analyzer_version === "string" && /^[\w.+-]{1,80}$/u.test(item.analyzer_version) ? item.analyzer_version : "1";
  const relations = item.relations ?? ["definitions", "references", "calls", "implementations", "type_definitions", "type_hierarchy"];
  const allowed = new Set(["definitions", "references", "calls", "implementations", "type_definitions", "type_hierarchy"]);
  if (!Array.isArray(relations) || relations.length > 6 || relations.some(relation => typeof relation !== "string" || !allowed.has(relation))) throw new Error("invalid_relations");
  const max_documents = item.max_documents ?? 100;
  if (typeof max_documents !== "number" || !Number.isInteger(max_documents) || max_documents < 1 || max_documents > MAX_LSP_DOCUMENTS) throw new Error("invalid_document_limit");
  const relation_symbol_limit = item.relation_symbol_limit ?? 100;
  if (typeof relation_symbol_limit !== "number" || !Number.isInteger(relation_symbol_limit) || relation_symbol_limit < 1 || relation_symbol_limit > MAX_RELATION_SYMBOLS) throw new Error("invalid_relation_symbol_limit");
  const request_timeout_ms = item.request_timeout_ms ?? 10_000;
  if (typeof request_timeout_ms !== "number" || !Number.isSafeInteger(request_timeout_ms) || request_timeout_ms < 1 || request_timeout_ms > 120_000) throw new Error("invalid_request_timeout");
  return { language, command, args: args as string[], analyzer_version, relations: relations as string[], max_documents, relation_symbol_limit, request_timeout_ms };
}

export function languageIdForFile(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension ? LSP_LANGUAGE_IDS[extension] : undefined;
}
