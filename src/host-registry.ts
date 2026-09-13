import type { JsonObject } from "./store.ts";

/**
 * Host profiles are the declarative half of "plug in any model".
 *
 * A profile says which binary runs, how it is invoked, how its output is read,
 * and which dispatch record kind it owns. Built-in profiles mirror the native
 * Codex/Claude drivers exactly, so declaring a host never changes their argv;
 * user profiles describe additional model CLIs (DeepSeek, GPT, local runners)
 * that the generic driver executes.
 */
export type HostKind = "agent-cli" | "generic-mcp";
export type HostOutputFormat = "codex-jsonl" | "claude-jsonl" | "text";

export interface HostProfile {
  host: string;
  label: string;
  kind: HostKind;
  command: string;
  argv_template: string[];
  output_format: HostOutputFormat;
  dispatch_kind: string;
  models: string[];
  default_model: string | null;
  builtin: boolean;
}

const HOST_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const DISPATCH_KIND = /^[a-z][a-z0-9_]{0,62}$/u;
const HOST_KINDS: readonly string[] = ["agent-cli", "generic-mcp"];

/** Placeholders a portable argv template may use; anything else fails closed. */
export const ARGV_PLACEHOLDERS: readonly string[] = ["{prompt}", "{workspace}", "{model}", "{sandbox}"];

/**
 * Built-ins carry no argv template because their native drivers own the exact
 * command line (sandbox flags, tool allowlists, budget caps). A declared host
 * must supply one, because the generic driver has nothing else to run.
 */
export const BUILTIN_HOST_PROFILES: readonly HostProfile[] = [
  { host: "codex-cli", label: "Codex CLI", kind: "agent-cli", command: "codex", argv_template: [],
    output_format: "codex-jsonl", dispatch_kind: "codex_dispatch", models: [], default_model: null, builtin: true },
  { host: "claude-code", label: "Claude Code", kind: "agent-cli", command: "claude", argv_template: [],
    output_format: "claude-jsonl", dispatch_kind: "claude_dispatch", models: [], default_model: null, builtin: true },
  { host: "generic-mcp", label: "Generic MCP host", kind: "generic-mcp", command: "craft-mcp", argv_template: [],
    output_format: "text", dispatch_kind: "generic_mcp_dispatch", models: [], default_model: null, builtin: true },
];

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function optionalText(value: unknown, name: string): string | null {
  return value === undefined || value === null ? null : text(value, name);
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  const entries = value.map((item) => text(item, name));
  if (new Set(entries).size !== entries.length) throw new Error(`${name} must not repeat an entry`);
  return entries;
}

/** The dispatch record kind a host owns. This is the single source that replaced the hardcoded codex/claude ternary. */
export function defaultDispatchKind(host: string): string {
  return `${host.replaceAll("-", "_")}_dispatch`;
}

/**
 * Validate and normalize one declared host. Declared profiles are never builtin,
 * so a user can add a model CLI but can never silently rewrite a built-in host.
 *
 * A declared host must be a plain text-output CLI with an explicit argv
 * template: Craft only knows how to read structured JSONL from the built-in
 * drivers, and guessing at an unknown CLI's protocol would be worse than
 * refusing it.
 */
export function defineHostProfile(input: JsonObject): HostProfile {
  const host = text(input.host, "host");
  if (!HOST_NAME.test(host)) throw new Error(`Unsupported host name: ${host}`);
  const kind = text(input.kind, "kind");
  if (!HOST_KINDS.includes(kind)) throw new Error(`Unsupported host kind: ${kind}`);
  const outputFormat = text(input.output_format, "output_format");
  if (outputFormat !== "text") throw new Error("Declared hosts must use the text output format");
  const dispatchKind = optionalText(input.dispatch_kind, "dispatch_kind") ?? defaultDispatchKind(host);
  if (!DISPATCH_KIND.test(dispatchKind)) throw new Error(`Unsupported host dispatch kind: ${dispatchKind}`);
  const argvTemplate = stringList(input.argv_template, "argv_template");
  if (kind === "agent-cli" && !argvTemplate.length) throw new Error("Declared agent-cli hosts must provide a non-empty argv_template");
  const models = stringList(input.models, "models");
  const defaultModel = optionalText(input.default_model, "default_model");
  if (defaultModel !== null && !models.includes(defaultModel)) {
    throw new Error("Host default_model must be one of its declared models");
  }
  return { host, label: optionalText(input.label, "label") ?? host, kind: kind as HostKind,
    command: text(input.command, "command"), argv_template: argvTemplate,
    output_format: outputFormat as HostOutputFormat, dispatch_kind: dispatchKind, models,
    default_model: defaultModel, builtin: false };
}

/** Parse the `hosts` array of a Craft config file. A non-array value fails closed rather than being ignored. */
export function hostProfilesFromConfig(entries: unknown): HostProfile[] {
  if (entries === undefined || entries === null) return [];
  if (!Array.isArray(entries)) throw new Error("Craft config hosts must be an array");
  const profiles = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each declared host must be an object");
    return defineHostProfile(entry as JsonObject);
  });
  if (new Set(profiles.map((profile) => profile.host)).size !== profiles.length) {
    throw new Error("Declared hosts must not repeat a host name");
  }
  return profiles;
}

/**
 * Built-ins always win. Shadowing a built-in name is refused instead of merged,
 * because a same-named host would inherit that host's sandbox and approval
 * semantics while running a different binary.
 */
export function mergeHostProfiles(configured: HostProfile[], builtins: readonly HostProfile[] = BUILTIN_HOST_PROFILES): HostProfile[] {
  const reserved = new Set(builtins.map((profile) => profile.host));
  for (const profile of configured) {
    if (reserved.has(profile.host)) throw new Error(`Declared host may not shadow the built-in host: ${profile.host}`);
  }
  return [...builtins, ...configured];
}

/** Resolve one host, or fail closed so a typo can never fall back to a different model. */
export function resolveHostProfile(profiles: readonly HostProfile[], host: string): HostProfile {
  const profile = profiles.find((item) => item.host === host);
  if (!profile) throw new Error(`Unknown host profile: ${host}`);
  return profile;
}

/** The model a run should use: the explicit request, else the profile default, else the host's own default. */
export function hostModelFor(profile: HostProfile, requested: unknown): string | null {
  const explicit = optionalText(requested, "model");
  if (explicit === null) return profile.default_model;
  if (profile.models.length && !profile.models.includes(explicit)) {
    throw new Error(`Host ${profile.host} does not declare model ${explicit}`);
  }
  return explicit;
}

/**
 * Render a portable argv template. A template that mentions {prompt} carries the
 * prompt on the command line; otherwise the caller must pipe it on stdin.
 */
export function renderHostArgv(template: readonly string[], values: Record<string, string>): { argv: string[]; prompt_in_argv: boolean } {
  let promptInArgv = false;
  const argv = template.map((token) => token.replace(/\{[a-z_]+\}/gu, (placeholder) => {
    if (!ARGV_PLACEHOLDERS.includes(placeholder)) throw new Error(`Unsupported argv placeholder: ${placeholder}`);
    if (placeholder === "{prompt}") promptInArgv = true;
    return values[placeholder.slice(1, -1)] ?? "";
  }));
  return { argv, prompt_in_argv: promptInArgv };
}
