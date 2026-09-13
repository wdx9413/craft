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
/** Placeholders a portable argv template may use; anything else fails closed. */
export declare const ARGV_PLACEHOLDERS: readonly string[];
/**
 * Built-ins carry no argv template because their native drivers own the exact
 * command line (sandbox flags, tool allowlists, budget caps). A declared host
 * must supply one, because the generic driver has nothing else to run.
 */
export declare const BUILTIN_HOST_PROFILES: readonly HostProfile[];
/** The dispatch record kind a host owns. This is the single source that replaced the hardcoded codex/claude ternary. */
export declare function defaultDispatchKind(host: string): string;
/**
 * Validate and normalize one declared host. Declared profiles are never builtin,
 * so a user can add a model CLI but can never silently rewrite a built-in host.
 *
 * A declared host must be a plain text-output CLI with an explicit argv
 * template: Craft only knows how to read structured JSONL from the built-in
 * drivers, and guessing at an unknown CLI's protocol would be worse than
 * refusing it.
 */
export declare function defineHostProfile(input: JsonObject): HostProfile;
/** Parse the `hosts` array of a Craft config file. A non-array value fails closed rather than being ignored. */
export declare function hostProfilesFromConfig(entries: unknown): HostProfile[];
/**
 * Built-ins always win. Shadowing a built-in name is refused instead of merged,
 * because a same-named host would inherit that host's sandbox and approval
 * semantics while running a different binary.
 */
export declare function mergeHostProfiles(configured: HostProfile[], builtins?: readonly HostProfile[]): HostProfile[];
/** Resolve one host, or fail closed so a typo can never fall back to a different model. */
export declare function resolveHostProfile(profiles: readonly HostProfile[], host: string): HostProfile;
/** The model a run should use: the explicit request, else the profile default, else the host's own default. */
export declare function hostModelFor(profile: HostProfile, requested: unknown): string | null;
/**
 * Render a portable argv template. A template that mentions {prompt} carries the
 * prompt on the command line; otherwise the caller must pipe it on stdin.
 */
export declare function renderHostArgv(template: readonly string[], values: Record<string, string>): {
    argv: string[];
    prompt_in_argv: boolean;
};
