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
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { CraftStore, JsonObject } from "../../src/infrastructure/store.ts";
import { noCredentialAssignment, parseScope, text } from "../../src/validation.ts";
import { stableDigest, payload } from "../../src/digest.ts";
import { scopeEnvelope } from "../../src/scope-policy.ts";

const SOURCE_KINDS = new Set(["evidence_wiki", "serena", "kefu_wiki", "project_note", "readme", "custom"]);
const TRUSTS = new Set(["untrusted", "bounded", "verified"]);
const ACCESS = new Set(["read_only", "proposal_only"]);
const TRANSITIONS = new Set(["disabled", "revoked"]);
const INGESTIBLE = new Set([".md", ".mdx", ".txt"]);
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function within(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.split(sep).includes(".."));
}
function files(root: string, limit: number): string[] {
  const result: string[] = []; const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      if (result.length >= limit || name === ".git" || name === "node_modules" || name.startsWith(".")) continue;
      const path = join(directory, name); const stat = lstatSync(path);
      // A registered source is a containment boundary.  Never recursively follow
      // a symlink or ingest a special file simply because it is reachable below it.
      if (stat.isSymbolicLink() || !within(root, resolve(path))) continue;
      if (stat.isDirectory()) walk(path); else if (stat.isFile() && INGESTIBLE.has(name.slice(name.lastIndexOf(".")).toLowerCase())) result.push(path);
    }
  }; walk(root); return result.sort();
}

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
    // The v0.12.31 content-store migration moved the built-in descriptor from
    // `wiki` to `knowledge/md`.  A pre-migration, otherwise trusted descriptor
    // must stay usable until it is explicitly migrated; treating that known
    // locator change as an idempotency conflict makes an explicit Memory write
    // fail before it can create its Evidence.  Unknown locator drift remains a
    // conflict in `sourceRegister`.
    const evidenceLocator = this.builtinLocator("builtin.evidence-wiki", "~/.craft_data/knowledge/md", ["~/.craft_data/wiki"]);
    const sources = [
      this.sourceRegister({ source_id: "builtin.evidence-wiki", kind: "evidence_wiki", label: "Craft Evidence Wiki", scope_kind: "user", scope_id: "local", locator: evidenceLocator, content_digest: "builtin:evidence-wiki:v1", trust: "verified", access: "proposal_only" }).source,
      this.sourceRegister({ source_id: "builtin.serena-project-knowledge", kind: "serena", label: "Serena project knowledge", scope_kind: "project", scope_id: "selected-project", locator: ".serena/memories", content_digest: "builtin:serena-project-knowledge:v1", trust: "bounded", access: "read_only" }).source,
    ];
    return { sources };
  }

  private builtinLocator(sourceId: string, current: string, legacy: readonly string[]): string {
    const existing = this.store.find("knowledge_source", sourceId);
    const locator = typeof existing?.locator === "string" ? existing.locator : null;
    return locator !== null && legacy.includes(locator) ? locator : current;
  }

  sourceRegister(args: JsonObject): JsonObject {
    const kind = text(args.kind, "kind"); if (!SOURCE_KINDS.has(kind)) throw new Error("Knowledge Source kind is unsupported");
    const trust = text(args.trust ?? "untrusted", "trust"); if (!TRUSTS.has(trust)) throw new Error("Knowledge Source trust is unsupported");
    const access = text(args.access ?? "read_only", "access"); if (!ACCESS.has(access)) throw new Error("Knowledge Source access is unsupported");
    const sourceScope = parseScope(args); const envelope = scopeEnvelope(args.scope_envelope, sourceScope); const identity = { kind, label: noCredentialAssignment(text(args.label, "label"), "label"), scope: sourceScope, scope_envelope: envelope,
      locator: noCredentialAssignment(text(args.locator, "locator"), "locator"), content_digest: text(args.content_digest, "content_digest"), trust, access };
    const sourceId = String(args.source_id ?? `knowledge_source_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("knowledge_source", sourceId); const identityDigest = stableDigest(identity);
    if (existing) {
      const legacyIdentity = { kind, label: identity.label, scope: sourceScope, locator: identity.locator, content_digest: identity.content_digest, trust, access };
      if (existing.identity_digest !== identityDigest && existing.identity_digest !== stableDigest(legacyIdentity)) throw new Error("Knowledge Source idempotency conflict");
      return { source: existing, idempotent: true };
    }
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

  /**
   * Read a bounded Markdown/README/Obsidian/Serena source into immutable
   * revisions and fragments.  It is deliberately source-first: arbitrary text
   * becomes Evidence and a candidate, never a silently reviewed Claim.
   */
  sourceIngest(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id"));
    if (source.status !== "active" || source.access !== "read_only") throw new Error("Knowledge Source is unavailable for read-only ingest");
    const requestedRoot = resolve(text(args.root ?? source.locator, "root"));
    const registeredRoot = resolve(String(source.locator));
    if (!existsSync(registeredRoot) || !existsSync(requestedRoot)) return { status: "unavailable", reason: "source_root_unavailable", source };
    // Both lexical and resolved paths must remain under the registered locator.
    // This blocks `../` and symlink escapes even when a caller controls `root`.
    const locatorStat = lstatSync(registeredRoot); const requestedStat = lstatSync(requestedRoot);
    if (locatorStat.isSymbolicLink() || requestedStat.isSymbolicLink()) return { status: "unavailable", reason: "source_root_symlink_unsupported", source };
    const allowedRoot = realpathSync(registeredRoot); const root = realpathSync(requestedRoot);
    if (!within(allowedRoot, root)) throw new Error("Knowledge ingest root is outside the registered Source locator");
    const maxFiles = Number(args.max_files ?? 50); const maxChars = Number(args.max_chars_per_fragment ?? 4_000);
    if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 500 || !Number.isInteger(maxChars) || maxChars < 100 || maxChars > 20_000) throw new Error("Knowledge ingest budget is invalid");
    const discovered = lstatSync(root).isDirectory() ? files(root, maxFiles) : [root];
    const revisionDigest = digest(discovered.map((path) => `${relative(root, path)}:${digest(readFileSync(path, "utf8"))}`).join("\n"));
    const revisionId = String(args.revision_id ?? `knowledge_source_revision_${String(source.id)}_${revisionDigest.slice(-16)}`);
    const revision = this.store.find("knowledge_source_revision", revisionId) ?? this.store.create("knowledge_source_revision", revisionId, { source_id: source.id, source_version: source.version, source_revision_digest: revisionDigest, locator_digest: stableDigest(root), file_count: discovered.length, status: "current", immutable: true });
    const fragments: JsonObject[] = []; const candidates: JsonObject[] = [];
    for (const path of discovered) {
      const body = readFileSync(path, "utf8").replace(/\r\n/g, "\n"); const relativePath = relative(root, path) || path;
      for (let offset = 0, ordinal = 0; offset < body.length; offset += maxChars, ordinal += 1) {
        const excerpt = body.slice(offset, offset + maxChars); if (!excerpt.trim()) continue;
        const fragmentId = `knowledge_fragment_${digest(`${revision.id}:${relativePath}:${ordinal}:${digest(excerpt)}`).slice(-20)}`;
        const contentRef = this.store.contentStore.writeSync({ kind: "knowledge", record_id: fragmentId, version: 1, scope: `${(source.scope as JsonObject).kind}:${(source.scope as JsonObject).id}`, status: "candidate", sensitivity: "internal", source_id: String(source.id), body: excerpt });
        const fragment = this.store.find("knowledge_fragment", fragmentId) ?? this.store.create("knowledge_fragment", fragmentId, { source_id: source.id, source_revision_id: revision.id, path: relativePath, locator: `${relativePath}#chars=${offset}-${offset + excerpt.length}`, content_ref: contentRef, content_digest: digest(excerpt), status: "current", immutable: true });
        const evidenceId = `evidence_${fragmentId}`;
        const evidence = this.store.find("evidence", evidenceId) ?? this.store.create("evidence", evidenceId, { source_type: "knowledge_fragment", source_id: source.id, source_revision_id: revision.id, fragment_id: fragment.id, locator: fragment.locator, claim: "Source fragment retained for review.", confidence: source.trust === "verified" ? "bounded" : "unverified", content_digest: fragment.content_digest, observed_at: new Date().toISOString() });
        const claimId = `knowledge_claim_from_${fragmentId}`;
        const claimIdentity = { source_id: source.id, source_revision_id: revision.id, fragment_id: fragment.id, scope: `${(source.scope as JsonObject).kind}:${(source.scope as JsonObject).id}`, scope_envelope: source.scope_envelope, kind: "fact", content_digest: fragment.content_digest, evidence_ids: [evidence.id], valid_until: null };
        const claim = this.store.find("knowledge_claim", claimId) ?? this.store.create("knowledge_claim", claimId, { ...claimIdentity, content_ref: contentRef, identity_digest: stableDigest(claimIdentity), status: "candidate", review: null, ingest_generated: true, publication_allowed: false });
        const candidateId = `knowledge_ingest_candidate_${fragmentId}`;
        const candidate = this.store.find("knowledge_ingest_candidate", candidateId) ?? this.store.create("knowledge_ingest_candidate", candidateId, { source_id: source.id, source_revision_id: revision.id, fragment_id: fragment.id, claim_id: claim.id, evidence_id: evidence.id, scope: `${(source.scope as JsonObject).kind}:${(source.scope as JsonObject).id}`, status: "candidate", structural_review: "pending", semantic_review: "pending", publication_allowed: false });
        fragments.push(fragment); candidates.push(candidate);
      }
    }
    // A changed revision does not erase old evidence. Claims attributed to the
    // prior revision become explicitly stale and require a fresh review.
    for (const prior of this.store.list("knowledge_source_revision", 10_000, (item) => item.source_id === source.id && item.id !== revision.id && item.status === "current")) this.store.save("knowledge_source_revision", String(prior.id), { ...payload(prior), status: "superseded", superseded_by: revision.id });
    for (const claim of this.store.list("knowledge_claim", 10_000, (item) => Boolean(item.source_id === source.id && item.source_revision_id && item.source_revision_id !== revision.id && item.status === "reviewed"))) this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "stale", revalidation_required: true, stale_since_revision: revision.id });
    return { status: "completed", source, revision, fragments, candidates, raw_content_stored: false };
  }
}
