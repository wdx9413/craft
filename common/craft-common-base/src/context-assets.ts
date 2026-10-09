import type { JsonObject } from "../../craft-common-store-local/src/store.ts";
import { stableDigest } from "./digest.ts";
import { scopeFromKey } from "./scope-policy.ts";
import { text } from "./validation.ts";

export const CONTEXT_ASSET_MEMBERS = ["knowledge", "memory", "experience", "codebase", "history", "state"] as const;

/** Asset identity never falls back to its Source or a guessed latest revision. */
export function contextAssetRef(member: string, item: JsonObject, scope: JsonObject): JsonObject {
  if (!(CONTEXT_ASSET_MEMBERS as readonly string[]).includes(member)) throw new Error("Unsupported Context asset member");
  const id = text(item.memory_id ?? item.claim_id ?? item.procedure_id ?? item.node_id ?? item.ref_id ?? item.id, "Context asset id");
  const version = item.memory_version ?? item.claim_version ?? item.procedure_version ?? item.record_version ?? item.version;
  if (!Number.isSafeInteger(version) || Number(version) < 1) throw new Error("Context asset version must be explicit and positive");
  return { member, id, version, content_version: item.content_version ?? version,
    digest: item.content_digest ?? item.definition_digest ?? item.source_digest ?? stableDigest(item.content ?? item),
    scope: typeof item.scope === "string" ? scopeFromKey(item.scope) : item.scope ?? scope, source_id: item.source_id ?? null, index_id: item.index_id ?? null, checkpoint_id: item.checkpoint_id ?? null };
}

export function contextAssetKey(ref: JsonObject): string { return `${ref.member}:${ref.id}@${ref.version}`; }

export function contextAssetMatches(required: JsonObject, actual: JsonObject): boolean {
  return required.member === actual.member && required.id === actual.id
    && (required.version === undefined || required.version === actual.version)
    && (required.digest === undefined || required.digest === actual.digest)
    && (required.index_id === undefined || required.index_id === actual.index_id)
    && (required.checkpoint_id === undefined || required.checkpoint_id === actual.checkpoint_id);
}

export function requiredContextRef(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Required Context reference must be an object");
  const ref = value as JsonObject;
  if (!(CONTEXT_ASSET_MEMBERS as readonly unknown[]).includes(ref.member)) throw new Error("Unsupported required Context member");
  text(ref.id, "required Context id");
  if (ref.version !== undefined && (!Number.isSafeInteger(ref.version) || Number(ref.version) < 1)) throw new Error("Required Context version must be positive");
  if (ref.digest !== undefined) text(ref.digest, "required Context digest");
  return ref;
}

/** A bounded projection uses the same accounting for Host, recalled and code material. */
export class ContextBudgetError extends Error {
  constructor(message: string) { super(message); this.name = "ContextBudgetError"; }
}
export class ContextBudget {
  readonly maxItems: number;
  readonly maxChars: number;
  items = 0;
  chars = 0;
  constructor(maxItems: number, maxChars: number) {
    if (!Number.isSafeInteger(maxItems) || maxItems < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1) throw new ContextBudgetError("Context budget is invalid");
    this.maxItems = maxItems; this.maxChars = maxChars;
  }
  reserve(items: number, chars: number, required: boolean, message: string): boolean {
    if (!Number.isSafeInteger(items) || items < 0 || !Number.isSafeInteger(chars) || chars < 0) throw new ContextBudgetError("Context reservation must use nonnegative integer counts");
    if (this.items + items > this.maxItems || this.chars + chars > this.maxChars) {
      if (required) throw new ContextBudgetError(message);
      return false;
    }
    this.items += items; this.chars += chars; return true;
  }
}
