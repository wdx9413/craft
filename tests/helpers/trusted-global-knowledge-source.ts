import type { JsonObject } from "../../core/infrastructure/store.ts";
import { stableDigest } from "../../core/digest.ts";
import { scopeEnvelope } from "craft-common-base/scope-policy";

/** Register a global verified fixture exactly as a Runtime-pinned source. */
export function registerTrustedGlobalKnowledgeSource(
  register: (args: JsonObject) => JsonObject,
  args: JsonObject,
): JsonObject {
  const source: JsonObject = { ...args, scope_kind: "global", scope_id: "global", trust: "verified", access: args.access ?? "read_only" };
  const scope = { kind: "global", id: "global" };
  const identity: JsonObject = {
    kind: String(source.kind), label: String(source.label).trim(), scope,
    scope_envelope: scopeEnvelope(source.scope_envelope, scope), locator: String(source.locator).trim(),
    content_digest: String(source.content_digest).trim(), trust: "verified", access: String(source.access),
  };
  const previous = process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
  process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = JSON.stringify([{ id: String(source.source_id), identity_digest: stableDigest(identity) }]);
  try { return register(source); }
  finally {
    if (previous === undefined) delete process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
    else process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = previous;
  }
}
