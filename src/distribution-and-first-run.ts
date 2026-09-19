import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson } from "./digest.ts";

/**
 * v0.12.33 first-run and distribution readiness.
 *
 * Three gaps were closed by earlier releases' *absence* of them, not by missing
 * kernel depth:
 *
 *  1. Credentials could only come from the process environment, and nothing in
 *     the product could write one there. A desktop user pasting a key had no
 *     path from clipboard to `env[apiKeyEnv]`.
 *  2. MCP was pinned at 2025-11-25 while the 2026-07-28 revision changes the
 *     handshake, session and human-in-the-loop surface. The pin was an inline
 *     literal with no negotiation record and no migration decision.
 *  3. Windows had no isolation backend, so the flagship desktop platform
 *     degraded every generated-code write to human approval.
 *
 * This module makes each one observable and contestable instead of implicit.
 * It deliberately does not read secrets into records: only env-var *names* are
 * ever persisted, and resolution happens in memory at call time.
 */

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;





/** An environment overlay: names to values, never persisted. */
export interface CredentialOverlay {
  read(variable: string): string | undefined;
  names(): string[];
}

/**
 * Resolves API keys from an ordered list of environment-like sources.
 *
 * The process environment is always consulted last so an explicitly installed
 * overlay can never be silently shadowed by a stale machine-wide variable, and
 * so a desktop shell that injects the key at spawn time behaves identically to
 * one that relies on the ambient environment.
 */
export function createCredentialResolver(sources: NodeJS.ProcessEnv[]): { env: NodeJS.ProcessEnv } {
  const env: NodeJS.ProcessEnv = {};
  // Later sources win, so the caller lists the process environment first and the
  // explicitly installed overlay last.
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" && value.length > 0) env[key] = value;
    }
  }
  return { env };
}

/**
 * Which of a model set is actually runnable right now.
 *
 * This is the metric the product was missing: it answers "can an ordinary user
 * complete a first task", not "did the agent do the work correctly".
 */
export function firstRunReadiness(input: JsonObject): JsonObject {
  const models = Array.isArray(input.models) ? input.models as JsonObject[] : [];
  const env = (input.env ?? {}) as NodeJS.ProcessEnv;
  const resolved = createCredentialResolver([env]).env;
  const credentialSource = typeof input.credential_source === "string" ? input.credential_source : "process_environment";

  const ready: JsonObject[] = [];
  const blocked: JsonObject[] = [];
  for (const model of models) {
    const id = text(model.id, "model.id");
    const variable = text(model.apiKeyEnv, "model.apiKeyEnv");
    if (!ENV_NAME.test(variable)) throw new Error(`apiKeyEnv ${variable} must be an uppercase environment-variable name`);
    const value = resolved[variable];
    const configured = typeof value === "string" && value.length > 0;
    (configured ? ready : blocked).push({ id, api_key_env: variable, configured });
  }

  const usable = ready.length > 0;
  return {
    credential_source: credentialSource,
    configured_count: ready.length,
    blocked_count: blocked.length,
    usable,
    // Naming the blocking variable is what turns "it did not work" into a fix.
    remedy: usable ? null : blocked.length
      ? `set ${String(blocked[0]!.api_key_env)} or paste a key in Studio settings`
      : "add a model before running work",
    models: [...ready, ...blocked],
    readiness_digest: digestJson({ source: credentialSource, ready: ready.map((item) => item.id), blocked: blocked.map((item) => item.id) }),
  };
}

/**
 * The MCP revision this build speaks, and whether it has been assessed.
 *
 * The pre-0.12.33 code compared the requested version against an inline literal
 * and silently fell back to the newest supported one. Falling back is the right
 * behaviour, but doing it silently meant a client speaking a newer revision got
 * a downgrade with no record of it.
 */
export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2025-06-18", "2025-11-25"] as const;
export const MCP_PREFERRED_PROTOCOL_VERSION = "2025-11-25";
export const MCP_ASSESSED_REVISION = "2026-07-28";
export const MCP_MIGRATION_STATUS = "assessed_deferred" as const;

export interface ProtocolNegotiation extends JsonObject {
  negotiated: string;
  requested: string | null;
  downgraded: boolean;
  reason: string;
  migration_status: string;
  assessed_revision: string;
}

/**
 * Negotiates the MCP protocol version and reports what it did.
 *
 * 2026-07-28 is a breaking revision (stateless transport, MRTR replacing
 * server-initiated elicitation/sampling/roots, Tasks moved to an extension), and
 * it is explicitly not backward compatible. Speaking 2025-11-25 remains correct
 * for this build; advertising that this is a deliberate, recorded decision is
 * the part that was missing.
 */
export function negotiateProtocolVersion(requested: unknown): ProtocolNegotiation {
  const asked = typeof requested === "string" && requested.trim() ? requested.trim() : null;
  if (asked && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked)) {
    return { negotiated: asked, requested: asked, downgraded: false, reason: "requested_version_supported",
      migration_status: MCP_MIGRATION_STATUS, assessed_revision: MCP_ASSESSED_REVISION };
  }
  return {
    negotiated: MCP_PREFERRED_PROTOCOL_VERSION,
    requested: asked,
    downgraded: asked !== null,
    reason: asked === null ? "client_did_not_negotiate" : "requested_version_unsupported",
    migration_status: MCP_MIGRATION_STATUS,
    assessed_revision: MCP_ASSESSED_REVISION,
  };
}

/**
 * Whether the 2026-07-28 revision can be adopted yet.
 *
 * Craft cannot adopt it opaquely: its human-in-the-loop approval flow and its
 * durable long-task model both sit exactly where MRTR and the Tasks extension
 * now live, so the migration is a design decision, not a version bump.
 */
export function assessMcpMigration(input: JsonObject): JsonObject {
  const hostSupportsMrtr = input.host_supports_mrtr === true;
  const hasDurableTasks = input.has_durable_tasks === true;
  const tasksExtensionAdopted = input.tasks_extension_adopted === true;
  const blocking: string[] = [];
  if (!hostSupportsMrtr) blocking.push("host does not implement Multi Round-Trip Requests (SEP-2322)");
  if (hasDurableTasks && !tasksExtensionAdopted) blocking.push("durable task model is not yet mapped to io.modelcontextprotocol/tasks");
  return {
    target_revision: MCP_ASSESSED_REVISION,
    currently_speaking: MCP_PREFERRED_PROTOCOL_VERSION,
    status: blocking.length ? "blocked" : "ready",
    blocking,
    // Downward-compatible shims exist in the official Go and C# SDKs, so this is
    // bounded work rather than a rewrite.
    guidance: blocking.length
      ? "keep negotiating 2025-11-25; the revision is not backward compatible"
      : "the migration can be scheduled; transport compatibility is the remaining work",
    decision_digest: digestJson({ hostSupportsMrtr, hasDurableTasks, tasksExtensionAdopted }),
  };
}

/**
 * Platform isolation capability, stated honestly.
 *
 * Windows returns `job_object` as a *declared* boundary only. Reporting it as
 * available when no backend executes it is how a platform silently becomes
 * second class; `enforced` distinguishes a real backend from a plan.
 */
export function isolationCapability(platform: string): JsonObject {
  const supported = new Set(["win32", "darwin", "linux"]);
  if (!supported.has(platform)) throw new Error(`Unsupported platform ${platform}`);
  if (platform === "darwin") {
    return { platform, boundary: "sandbox_profile", enforced: true, mechanism: "sandbox-exec", autonomous_generated_code: true };
  }
  if (platform === "linux") {
    return { platform, boundary: "landlock_or_namespace", enforced: true, mechanism: "bwrap", autonomous_generated_code: true };
  }
  return {
    platform,
    boundary: "job_object",
    // No Job Object confinement backend executes yet, so this must not claim
    // enforcement: on Windows a generated-code write still requires approval.
    enforced: false,
    mechanism: null,
    autonomous_generated_code: false,
    note: "job_object is a declared boundary; generated-code writes require approval until a backend enforces it",
  };
}

/**
 * The distribution entry point a user is expected to use.
 *
 * Before v0.12.33 the only way to obtain a desktop build was to run
 * `pnpm run pack:desktop` on a developer machine, and the release workflow
 * uploaded no assets, so the answer to "where do I download this" was "nowhere".
 */
export function distributionPlan(input: JsonObject): JsonObject {
  const version = text(input.version, "version");
  const repository = text(input.repository, "repository");
  const releaseAssetsAvailable = input.release_assets_available === true;
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return {
    version,
    user_download_available: releaseAssetsAvailable,
    channel: releaseAssetsAvailable ? "github_release_asset" : "developer_command_only",
    assets: [
      { platform: "windows", name: `craft-workbench-windows-v${version}.zip`, url: releaseAssetsAvailable ? `${base}/craft-workbench-windows-v${version}.zip` : null, requires_runner: "windows-latest" },
      { platform: "macos", name: `craft-workbench-macos-v${version}.dmg`, url: releaseAssetsAvailable ? `${base}/craft-workbench-macos-v${version}.dmg` : null, requires_runner: "macos-latest" }
    ],
    remainder: releaseAssetsAvailable ? [] : ["publish a GitHub release so assets are attached", "build the DMG on a native macOS runner"],
    plan_digest: digestJson({ version, releaseAssetsAvailable })
  };
}

/**
 * Reads a desktop-injected credential file without ever logging its contents.
 *
 * The launcher writes names and values into the child environment; this reads
 * the same file so a headless run can reproduce the desktop behaviour.
 */
export function readCredentialFile(path: string): JsonObject {
  const absolute = resolve(path);
  if (!existsSync(absolute)) return { found: false, path: absolute, names: [], env: {} };
  const raw = readFileSync(absolute, "utf8");
  const env: NodeJS.ProcessEnv = {};
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) throw new Error(`Malformed credential line in ${absolute}`);
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!ENV_NAME.test(name)) throw new Error(`Credential name ${name} must be an uppercase environment-variable name`);
    if (!value) throw new Error(`Credential ${name} must not be empty`);
    env[name] = value;
  }
  // Only names escape this function; values stay in the returned env overlay.
  return { found: true, path: absolute, names: Object.keys(env).sort(), env };
}
