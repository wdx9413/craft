import { createHash } from "node:crypto";
import type { JsonObject } from "./store.ts";

/**
 * One envelope for every reusable thing.
 *
 * Craft grew three asset lineages — capability, knowledge, workflow — each with
 * its own naming and its own idea of "healthy". That is fine while they are
 * separate features and expensive as soon as something has to *choose* between
 * them for a task. This module gives them a common shape so routing is one
 * decision rather than three, without collapsing the lineages into one model.
 *
 * The envelope is deliberately descriptive: it says what an asset is and what it
 * is allowed to touch. It grants nothing. Activation and effect gating remain
 * where they already are.
 */

export type AssetKind = "capability" | "knowledge" | "workflow";
export type AssetEffectScope = "read_only" | "local_write" | "external_write" | "destructive";
export type AssetHealth = "healthy" | "degraded" | "blocked" | "unknown";
export type AssetTrust = "verified" | "candidate" | "unverified" | "revoked";

export interface AssetStability {
  /** Behaviour that must hold for every model. */
  core_invariants: string[];
  /** Behaviour expected to vary by model; never used as a gate. */
  model_sensitive: string[];
}

export interface AssetEnvelope {
  kind: AssetKind;
  id: string;
  version: number;
  digest: string;
  source: string;
  trust: AssetTrust;
  health: AssetHealth;
  effect_scope: AssetEffectScope;
  cost_profile: { tokens: number; latency_ms: number };
  policy: string | null;
  tags: string[];
  stability: AssetStability;
}

export interface TaskSignals {
  /** Complexity tier the task was classified into. */
  tier: "small" | "standard" | "frontier";
  risk: "low" | "medium" | "high";
  /** Effects the task is authorized to produce. */
  allowed_effects: AssetEffectScope[];
  /** Remaining token budget, or null when unbounded. */
  budget_tokens: number | null;
  domain: string | null;
  /** Names of capabilities the caller already knows it needs. */
  required_tags: string[];
}

const KIND_IDS: readonly string[] = ["capability", "knowledge", "workflow"];
const TRUSTS: readonly string[] = ["verified", "candidate", "unverified", "revoked"];
const HEALTHS: readonly string[] = ["healthy", "degraded", "blocked", "unknown"];
const EFFECTS: readonly string[] = ["read_only", "local_write", "external_write", "destructive"];
const ASSET_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,127}$/u;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function oneOf<T extends string>(value: unknown, name: string, allowed: readonly string[]): T {
  const result = text(value, name);
  if (!allowed.includes(result)) throw new Error(`Unsupported ${name}: ${result}`);
  return result as T;
}

function stringList(value: unknown, name: string, allowEmpty = true): string[] {
  // A missing required list is empty *and* invalid, so the two cases must not
  // collapse: otherwise an asset could declare no invariant at all.
  if (value === undefined) {
    if (!allowEmpty) throw new Error(`${name} must not be empty`);
    return [];
  }
  if (!Array.isArray(value)) throw new Error(`${name} must be an array of strings`);
  const entries = value.map((item) => text(item, name));
  if (!allowEmpty && !entries.length) throw new Error(`${name} must not be empty`);
  if (new Set(entries).size !== entries.length) throw new Error(`${name} must not repeat an entry`);
  return entries;
}

function nonNegative(value: unknown, name: string, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${name} must be a non-negative number`);
  return Math.round(result);
}

/** Content-addressed identity, so two assets with the same body are visibly the same asset. */
export function assetDigest(envelope: Omit<AssetEnvelope, "digest">): string {
  const { kind, id, version, source, trust, health, effect_scope, cost_profile, policy, tags, stability } = envelope;
  return `sha256:${createHash("sha256").update(JSON.stringify({ kind, id, version, source, trust, health,
    effect_scope, cost_profile, policy, tags, stability })).digest("hex")}`;
}

export function defineAsset(input: JsonObject): AssetEnvelope {
  const kind = oneOf<AssetKind>(input.kind, "kind", KIND_IDS);
  const id = text(input.id, "id");
  if (!ASSET_ID.test(id)) throw new Error(`Unsupported asset id: ${id}`);
  const version = input.version === undefined ? 1 : Number(input.version);
  if (!Number.isInteger(version) || version < 1) throw new Error("Asset version must be a positive integer");
  const rawStability = (input.stability ?? {}) as JsonObject;
  if (typeof rawStability !== "object" || Array.isArray(rawStability)) throw new Error("Asset stability must be an object");
  const coreInvariants = stringList(rawStability.core_invariants, "core_invariants", false);
  const modelSensitive = stringList(rawStability.model_sensitive, "model_sensitive");
  const overlap = coreInvariants.filter((item) => modelSensitive.includes(item));
  if (overlap.length) throw new Error(`An invariant cannot be both core and model-sensitive: ${overlap[0]}`);
  const cost = (input.cost_profile ?? {}) as JsonObject;
  if (typeof cost !== "object" || Array.isArray(cost)) throw new Error("Asset cost_profile must be an object");
  const base = {
    kind, id, version, source: text(input.source, "source"),
    trust: oneOf<AssetTrust>(input.trust ?? "unverified", "trust", TRUSTS),
    health: oneOf<AssetHealth>(input.health ?? "unknown", "health", HEALTHS),
    effect_scope: oneOf<AssetEffectScope>(input.effect_scope ?? "read_only", "effect_scope", EFFECTS),
    cost_profile: { tokens: nonNegative(cost.tokens, "cost_profile.tokens", 0), latency_ms: nonNegative(cost.latency_ms, "cost_profile.latency_ms", 0) },
    policy: input.policy === undefined || input.policy === null ? null : text(input.policy, "policy"),
    tags: stringList(input.tags, "tags"),
    stability: { core_invariants: coreInvariants, model_sensitive: modelSensitive },
  };
  return { ...base, digest: assetDigest(base) };
}

/** `kind:id@version` — the only string other objects should store about an asset. */
export function assetRef(asset: AssetEnvelope): string {
  return `${asset.kind}:${asset.id}@${asset.version}`;
}

export interface RouterRejection { ref: string; reason: string }
export interface RouterDecision {
  selected: AssetEnvelope[];
  rejected: RouterRejection[];
  reason: string;
  /** Always an asset the router can fall back to when nothing qualifies. */
  baseline: AssetEnvelope | null;
}

function effectAllowed(asset: AssetEnvelope, allowed: readonly AssetEffectScope[]): boolean {
  return allowed.includes(asset.effect_scope);
}

/**
 * Choose the smallest set of assets for a task.
 *
 * Two rules do the real work. Trust and health are hard gates — a candidate or a
 * blocked asset is never silently used because it scored well. And cost is
 * treated as a budget: when a task's remaining tokens cannot pay for an asset,
 * the asset is rejected with that reason instead of being chosen and failing
 * later. Nothing here publishes, promotes or executes anything.
 */
export function routeAssets(signals: TaskSignals, assets: readonly AssetEnvelope[]): RouterDecision {
  if (typeof signals !== "object" || signals === null) throw new Error("Task signals must be an object");
  if (!["small", "standard", "frontier"].includes(signals.tier)) throw new Error(`Unsupported task tier: ${signals.tier}`);
  if (!["low", "medium", "high"].includes(signals.risk)) throw new Error(`Unsupported task risk: ${signals.risk}`);
  if (!Array.isArray(signals.allowed_effects) || !signals.allowed_effects.length) throw new Error("Task signals must declare allowed effects");
  for (const effect of signals.allowed_effects) if (!EFFECTS.includes(effect)) throw new Error(`Unsupported allowed effect: ${effect}`);
  const requiredTags = stringList(signals.required_tags, "required_tags");
  if (signals.budget_tokens !== null && (!Number.isInteger(signals.budget_tokens) || signals.budget_tokens < 0)) {
    throw new Error("budget_tokens must be a non-negative integer or null");
  }

  const rejected: RouterRejection[] = [];
  const eligible: AssetEnvelope[] = [];
  for (const asset of assets) {
    const ref = assetRef(asset);
    if (asset.trust !== "verified") { rejected.push({ ref, reason: `trust is ${asset.trust}` }); continue; }
    if (asset.health !== "healthy") { rejected.push({ ref, reason: `health is ${asset.health}` }); continue; }
    if (!effectAllowed(asset, signals.allowed_effects)) {
      rejected.push({ ref, reason: `effect ${asset.effect_scope} exceeds the task's allowed effects` }); continue;
    }
    if (signals.domain !== null && asset.tags.length && !asset.tags.includes(signals.domain)) {
      rejected.push({ ref, reason: `tagged for another domain` }); continue;
    }
    eligible.push(asset);
  }

  const matching = requiredTags.length
    ? eligible.filter((asset) => requiredTags.every((tag) => asset.tags.includes(tag)))
    : eligible;
  // A required tag that matches nothing is a mismatch, not an empty success.
  const pool = requiredTags.length && !matching.length ? [] : matching;
  if (requiredTags.length && !pool.length) {
    for (const asset of eligible) rejected.push({ ref: assetRef(asset), reason: `missing a required tag` });
  }

  const ordered = [...pool].sort((left, right) => {
    const byCost = left.cost_profile.tokens - right.cost_profile.tokens;
    if (byCost !== 0) return byCost;
    const byLatency = left.cost_profile.latency_ms - right.cost_profile.latency_ms;
    return byLatency !== 0 ? byLatency : assetRef(left).localeCompare(assetRef(right));
  });

  const selected: AssetEnvelope[] = [];
  const affordable: AssetEnvelope[] = [];
  let remaining = signals.budget_tokens;
  for (const asset of ordered) {
    if (remaining !== null && asset.cost_profile.tokens > remaining) {
      rejected.push({ ref: assetRef(asset), reason: `costs ${asset.cost_profile.tokens} tokens with ${remaining} remaining` });
      continue;
    }
    affordable.push(asset);
    if (remaining !== null) remaining -= asset.cost_profile.tokens;
  }
  // A high-risk task gets exactly one asset; smaller tasks may compose a few.
  const limit = signals.risk === "high" ? 1 : 3;
  selected.push(...affordable.slice(0, limit));
  const overflow = affordable.slice(limit);
  for (const asset of overflow) rejected.push({ ref: assetRef(asset), reason: `over the ${limit}-asset limit for ${signals.risk} risk` });

  const baseline = ordered[0] ?? null;
  const reason = selected.length
    ? `selected ${selected.length} of ${assets.length} assets for ${signals.tier}/${signals.risk}`
    : assets.length ? "no declared asset satisfied the task constraints" : "no assets were declared";
  if (!selected.length && baseline) rejected.push({ ref: assetRef(baseline), reason: "baseline kept for the caller to consider" });
  return { selected, rejected, reason, baseline: selected.length ? null : baseline };
}
