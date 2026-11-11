import { existsSync, readFileSync } from "node:fs";
import { atomicPrivateJson, type CraftPaths } from "./infrastructure/paths.ts";

/**
 * Owner-only API key store for keys entered in the Workbench.
 *
 * Craft has always read credentials from the environment; `settings.json`
 * deliberately never holds a key. This store is a separate file (`secrets.json`,
 * created with mode 0600 through `atomicPrivateJson`) so a person can paste a key
 * in the UI without editing their shell profile. The file is never read back to
 * the browser: the API only reports whether an env var is configured.
 *
 * Precedence: a real environment variable always wins, so a deployment that owns
 * its environment keeps control and a stale local key can never shadow it.
 */

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const MAX_KEY_LENGTH = 8192;

export type SecretStore = Readonly<Record<string, string>>;

/** Read the stored keys, returning an empty object for a missing/corrupt file. */
export function readSecrets(paths: CraftPaths): SecretStore {
  if (!existsSync(paths.secretsFile)) return {};
  try {
    const value: unknown = JSON.parse(readFileSync(paths.secretsFile, "utf8").replace(/^\uFEFF/u, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [name, key] of Object.entries(value as Record<string, unknown>)) {
      if (ENV_NAME.test(name) && typeof key === "string" && key.length > 0 && key.length <= MAX_KEY_LENGTH) out[name] = key;
    }
    return out;
  } catch {
    // A malformed secrets file must never prevent Craft from starting.
    return {};
  }
}

/** Persist a key (or remove it with an empty value). Never writes to settings.json. */
export async function writeSecret(paths: CraftPaths, envName: string, key: string): Promise<void> {
  if (!ENV_NAME.test(envName)) throw new Error("envName must be an uppercase environment-variable name");
  if (typeof key !== "string") throw new Error("key must be a string");
  if (key.length > MAX_KEY_LENGTH) throw new Error("key is too long");
  const next: Record<string, string> = { ...readSecrets(paths) };
  if (key.trim()) next[envName] = key.trim();
  else delete next[envName];
  await atomicPrivateJson(paths.secretsFile, next);
}

/** Which env var names currently have a key stored locally (never the values). */
export function storedSecretNames(paths: CraftPaths): string[] {
  return Object.keys(readSecrets(paths)).sort();
}

/**
 * Make stored keys visible to the model gateway without overriding the real
 * environment. Called once during startup.
 */
export function hydrateSecretsIntoEnv(paths: CraftPaths, env: NodeJS.ProcessEnv = process.env): string[] {
  const adopted: string[] = [];
  for (const [name, value] of Object.entries(readSecrets(paths))) {
    if (typeof env[name] === "string" && env[name].length > 0) continue;
    env[name] = value;
    adopted.push(name);
  }
  return adopted;
}
