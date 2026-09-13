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
    cost_profile: {
        tokens: number;
        latency_ms: number;
    };
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
/** Content-addressed identity, so two assets with the same body are visibly the same asset. */
export declare function assetDigest(envelope: Omit<AssetEnvelope, "digest">): string;
export declare function defineAsset(input: JsonObject): AssetEnvelope;
/** `kind:id@version` — the only string other objects should store about an asset. */
export declare function assetRef(asset: AssetEnvelope): string;
export interface RouterRejection {
    ref: string;
    reason: string;
}
export interface RouterDecision {
    selected: AssetEnvelope[];
    rejected: RouterRejection[];
    reason: string;
    /** Always an asset the router can fall back to when nothing qualifies. */
    baseline: AssetEnvelope | null;
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
export declare function routeAssets(signals: TaskSignals, assets: readonly AssetEnvelope[]): RouterDecision;
