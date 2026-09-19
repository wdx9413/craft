/**
 * The Knowledge Source registry.
 *
 * A Knowledge Source is a **descriptor**, not content: kind, trusted label, scope, locator,
 * content digest, trust level and read/write boundary. Registering one never scans the location
 * and never writes to it, so a Source is a statement about where knowledge lives and how far it
 * may be trusted — the content stays with Wiki, Serena, kefu or the project files.
 *
 * This was one half of `KnowledgeMemoryRuntime`, a class that served this member's writes and
 * memory's Ledger writes at once. One class serving two members meant neither member could be a
 * capability: the class belonged to neither package, so `craft-knowledge` could not claim
 * `craft_knowledge_source_*` and `component-knowledge` had to project tools the capability did
 * not assemble. Cut along the member boundary, each half has one owner.
 *
 * The trust and access sets are the whole security surface of retrieval: `resolve` refuses a
 * requested Source that is not `active`, and treats `untrusted` as unavailable regardless.
 */
import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "../../src/infrastructure/store.ts";
import { noCredentialAssignment, parseScope, text } from "../../src/validation.ts";
import { stableDigest, payload } from "../../src/digest.ts";

const SOURCE_KINDS = new Set(["evidence_wiki", "serena", "kefu_wiki", "project_note", "readme", "custom"]);
const TRUSTS = new Set(["untrusted", "bounded", "verified"]);
const ACCESS = new Set(["read_only", "proposal_only"]);
const TRANSITIONS = new Set(["disabled", "revoked"]);

export class KnowledgeSourceRegistry {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Register the two descriptors Craft itself ships with.
   *
   * Both are idempotent through `sourceRegister`, so calling this twice is not a double
   * registration: the identity digest of each descriptor is fixed, and a second call returns the
   * existing record with `idempotent: true`. That is what makes it safe as a bootstrap step a
   * Host may run on every start.
   */
  installBuiltins(): JsonObject {
    const sources = [
      this.sourceRegister({ source_id: "builtin.evidence-wiki", kind: "evidence_wiki", label: "Craft Evidence Wiki", scope_kind: "user", scope_id: "local", locator: "~/.craft_data/knowledge/md", content_digest: "builtin:evidence-wiki:v1", trust: "verified", access: "proposal_only" }).source,
      this.sourceRegister({ source_id: "builtin.serena-project-knowledge", kind: "serena", label: "Serena project knowledge", scope_kind: "project", scope_id: "selected-project", locator: ".serena/memories", content_digest: "builtin:serena-project-knowledge:v1", trust: "bounded", access: "read_only" }).source,
    ];
    return { sources };
  }

  sourceRegister(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!SOURCE_KINDS.has(kind)) throw new Error("Knowledge Source kind is unsupported");
    const trust = text(args.trust ?? "untrusted", "trust"); if (!TRUSTS.has(trust)) throw new Error("Knowledge Source trust is unsupported");
    const access = text(args.access ?? "read_only", "access"); if (!ACCESS.has(access)) throw new Error("Knowledge Source access is unsupported");
    const sourceScope = parseScope(args); const identity = { kind, label: noCredentialAssignment(text(args.label, "label"), "label"), scope: sourceScope,
      locator: noCredentialAssignment(text(args.locator, "locator"), "locator"), content_digest: text(args.content_digest, "content_digest"), trust, access };
    const sourceId = String(args.source_id ?? `knowledge_source_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("knowledge_source", sourceId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Knowledge Source idempotency conflict"); return { source: existing, idempotent: true }; }
    return { source: this.store.create("knowledge_source", sourceId, { ...identity, identity_digest: identityDigest, status: "active" }), idempotent: false };
  }

  sourceList(args: JsonObject = {}): JsonObject {
    const scopeKind = args.scope_kind === undefined ? null : text(args.scope_kind, "scope_kind"); const scopeId = args.scope_id === undefined ? null : text(args.scope_id, "scope_id");
    if ((scopeKind === null) !== (scopeId === null)) throw new Error("Knowledge Source scope_kind and scope_id must be supplied together");
    return { sources: this.store.list("knowledge_source", Number(args.limit ?? 100), (item) => item.status === "active" && (scopeKind === null || (item.scope as JsonObject).kind === scopeKind && (item.scope as JsonObject).id === scopeId)) };
  }

  /**
   * Disable or revoke one Source without deleting it.
   *
   * A Source is referenced by every Memory Ledger entry that cites it, so removing the record
   * would orphan that provenance. The transition keeps the record and the reason's digest.
   */
  sourceTransition(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id")); const status = text(args.status, "status");
    if (!TRANSITIONS.has(status)) throw new Error("Knowledge Source status is unsupported");
    return { source: this.store.save("knowledge_source", String(source.id), { ...payload(source), status, transition_reason_digest: stableDigest(noCredentialAssignment(text(args.reason, "reason"), "reason")) }) };
  }
}
