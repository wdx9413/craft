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
import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { noCredentialAssignment, parseScope, text } from "../../common/craft-common-base/src/validation.ts";
import { stableDigest, payload } from "../../common/craft-common-base/src/digest.ts";
import { operationErrorCode } from "../../common/craft-common-log/src/operation.ts";
import { knowledgeDirectoryForScope, projectRootForKnowledgeSource } from "../../core/project-knowledge-content.ts";
import { scopeEnvelope } from "../../common/craft-common-base/src/scope-policy.ts";
import { updateKnowledgeScenarioClaim } from "./scenario-catalog.ts";

const SOURCE_KINDS = new Set(["evidence_wiki", "serena", "kefu_wiki", "project_note", "readme", "custom"]);
const TRUSTS = new Set(["untrusted", "bounded", "verified"]);
const ACCESS = new Set(["read_only", "proposal_only"]);
const TRANSITIONS = new Set(["disabled", "revoked"]);
const INGESTIBLE = new Set([".md", ".mdx", ".txt"]);
function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function knowledgeScenarioScope(record: JsonObject): string | undefined {
  const contentRef = record.content_ref && typeof record.content_ref === "object" && !Array.isArray(record.content_ref)
    ? record.content_ref as JsonObject
    : {};
  const scope = record.scope ?? (contentRef.kind === "knowledge" ? contentRef.scope : undefined);
  try {
    const parsed = typeof scope === "string"
      ? scope === "global" ? { kind: "global", id: "global" } : (() => {
        const separator = scope.indexOf(":");
        if (separator <= 0 || separator === scope.length - 1) throw new Error("Knowledge scenario scope is malformed");
        return parseScope({ scope_kind: scope.slice(0, separator), scope_id: scope.slice(separator + 1) });
      })()
      : scope && typeof scope === "object" && !Array.isArray(scope)
        ? parseScope({ scope_kind: (scope as JsonObject).kind, scope_id: (scope as JsonObject).id })
        : undefined;
    if (parsed?.kind === "global" && parsed.id === "global") return "global";
    if (parsed?.kind === "project" && /^(?:project:)?[A-Za-z0-9_-]{1,96}$/u.test(parsed.id)) return `project:${parsed.id}`;
  } catch { return undefined; }
  return undefined;
}
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
  readonly resolvePath: (path: string) => string;
  constructor(store: CraftStore, resolvePath: (path: string) => string = realpathSync) { this.store = store; this.resolvePath = resolvePath; }

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

  /**
   * Enrol only the small set of project documents that Craft can safely discover by convention.
   * Descriptors and all derived Knowledge records live in the central data root; project files
   * remain read-only inputs. Newly enrolled files are ingested once so a cold project produces
   * candidates immediately, while the background worker handles later revisions.
   */
  discoverProjectSources(args: JsonObject): JsonObject {
    const projectRoot = resolve(text(args.project_root, "project_root"));
    const rootStat = lstatSync(projectRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return { status: "skipped", reason: "project_root_not_regular_directory", sources_registered: 0, sources_ingested: 0, candidates_created: 0 };
    const root = this.resolvePath(projectRoot);
    const scope = parseScope({ scope_kind: args.scope_kind, scope_id: args.scope_id });
    if (scope.kind !== "project") throw new Error("Project Knowledge discovery requires project scope");
    const candidates = [
      { relative_path: "README.md", kind: "readme", label: "Project README" },
      { relative_path: "AGENTS.md", kind: "project_note", label: "Project Agent Instructions" },
      { relative_path: ".serena/memories", kind: "serena", label: "Serena Project Memories" },
    ];
    const discoveredSourceIds = candidates.map(candidate => `project_autodiscovered_${stableDigest({ scope, root, path: candidate.relative_path }).slice(-24)}`);
    let registered = 0, ingested = 0, candidateCount = 0, skipped = 0, partialIngests = 0, failedIngests = 0, reactivated = 0;
    const sourceRefs: string[] = [];
    for (const candidate of candidates) {
      const locator = join(root, candidate.relative_path);
      let current = root;
      let safe = true;
      for (const part of candidate.relative_path.split(sep)) {
        current = join(current, part);
        try {
          const stat = lstatSync(current);
          if (stat.isSymbolicLink() || (current !== locator && !stat.isDirectory())) { safe = false; break; }
        } catch { safe = false; break; }
      }
      if (!safe) { skipped++; continue; }
      const stat = lstatSync(locator);
      if (!stat.isFile() && !(candidate.kind === "serena" && stat.isDirectory())) { skipped++; continue; }
      const realLocator = this.resolvePath(locator);
      if (!within(root, realLocator)) { skipped++; continue; }
      const sourceId = `project_autodiscovered_${stableDigest({ scope, root, path: candidate.relative_path }).slice(-24)}`;
      const result = this.sourceRegister({ source_id: sourceId, kind: candidate.kind, label: candidate.label, scope_kind: scope.kind, scope_id: scope.id,
        locator: realLocator, content_digest: stableDigest({ schema: "craft.project-knowledge-source.v1", scope, path: candidate.relative_path }), trust: "bounded", access: "read_only" });
      sourceRefs.push(sourceId);
      if (result.idempotent !== true) {
        if (result.reactivated === true) reactivated++;
        registered++;
        try {
          const output = this.sourceIngest({ source_id: sourceId, max_files: candidate.kind === "serena" ? 50 : 1 });
          if (output.status === "completed" || output.status === "partial") {
            ingested++;
            if (output.status === "partial") partialIngests++;
            candidateCount += Array.isArray(output.candidates) ? output.candidates.length : 0;
          }
        } catch { failedIngests++; /* One malformed project document must not prevent the other bounded Sources. */ }
      }
    }
    const transition = this.disableMissingDiscoveredSources(scope, discoveredSourceIds, new Set(sourceRefs));
    const incomplete = transition.failed > 0 || partialIngests > 0 || failedIngests > 0;
    return { status: incomplete ? "partial" : "ready",
      ...(transition.failed > 0 ? { reason: "source_transition_incomplete" }
        : partialIngests > 0 || failedIngests > 0 ? { reason: "source_ingest_incomplete" } : {}),
      sources_registered: registered, sources_ingested: ingested, candidates_created: candidateCount,
      skipped_sources: skipped, partial_ingests: partialIngests, failed_ingests: failedIngests, sources_disabled: transition.disabled,
      sources_transition_failed: transition.failed, source_transition_failure_codes: transition.failure_codes,
      sources_reactivated: reactivated, source_refs: sourceRefs };
  }

  private disableMissingDiscoveredSources(scope: { kind: string; id: string }, discoveredSourceIds: string[], currentSourceIds: Set<string>): { disabled: number; failed: number; failure_codes: string[] } {
    let disabled = 0;
    const failed = new Set<string>();
    const failureCodes = new Set<string>();
    for (const sourceId of discoveredSourceIds) {
      const source = this.store.find("knowledge_source", sourceId);
      if (!source || source.status !== "active" || (source.scope as JsonObject | undefined)?.kind !== scope.kind
        || (source.scope as JsonObject | undefined)?.id !== scope.id) continue;
      if (currentSourceIds.has(String(source.id)) || this.discoveredSourcePathIsUsable(source)) continue;
      let sourceDisabled = false;
      try {
        this.sourceTransition({ source_id: sourceId, status: "disabled", reason: "autodiscovered_project_source_path_unavailable" }, "project_source_path_unavailable");
        sourceDisabled = true;
      }
      catch (error) {
        // A failed scenario-catalog update must not keep an unavailable Source active or
        // prevent the remaining Sources from being retired. The Source status is the
        // retrieval boundary; the catalog cleanup can be retried by a later transition.
        failed.add(sourceId);
        failureCodes.add(operationErrorCode(error));
        try {
          const current = this.store.get("knowledge_source", sourceId);
          this.store.save("knowledge_source", sourceId, { ...payload(current), status: "disabled",
            automatic_transition: "project_source_path_unavailable",
            transition_reason_digest: current.transition_reason_digest ?? stableDigest("autodiscovered_project_source_path_unavailable") });
          sourceDisabled = true;
        } catch (fallbackError) {
          failed.add(sourceId);
          failureCodes.add(operationErrorCode(fallbackError));
        }
      }
      if (sourceDisabled) disabled++;
    }
    return { disabled, failed: failed.size, failure_codes: [...failureCodes].sort() };
  }

  private discoveredSourcePathIsUsable(source: JsonObject): boolean {
    if (typeof source.locator !== "string" || !source.locator) return false;
    try {
      const stat = lstatSync(source.locator);
      return !stat.isSymbolicLink() && (source.kind === "serena" ? stat.isDirectory() : stat.isFile());
    } catch { return false; }
  }

  private builtinLocator(sourceId: string, current: string, legacy: readonly string[]): string {
    const existing = this.store.find("knowledge_source", sourceId);
    const locator = typeof existing?.locator === "string" ? existing.locator : null;
    return locator !== null && legacy.includes(locator) ? locator : current;
  }

  private updateStaleScenarioClaim(claim: JsonObject, source: JsonObject): void {
    const scope = knowledgeScenarioScope(claim);
    if (typeof claim.scenario_key !== "string" || !scope) return;
    const contentPath = (claim.content_ref as JsonObject | undefined)?.path;
    const projectRoot = projectRootForKnowledgeSource(source);
    updateKnowledgeScenarioClaim(knowledgeDirectoryForScope(this.store, scope, {
      ...(typeof contentPath === "string" ? { reference_path: contentPath } : {}),
      ...(projectRoot ? { project_root: projectRoot } : {}),
    }), { ...claim, scope }, "inactive");
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
      if (existing.status === "disabled" && existing.automatic_transition === "project_source_path_unavailable"
        && sourceId.startsWith("project_autodiscovered_") && this.discoveredSourcePathIsUsable(existing)) {
        const reactivated = this.store.save("knowledge_source", sourceId, { ...payload(existing), status: "active",
          automatic_transition: null, transition_reason_digest: stableDigest("autodiscovered_project_source_path_recovered") });
        return { source: reactivated, idempotent: false, reactivated: true };
      }
      return { source: existing, idempotent: true };
    }
    return { source: this.store.create("knowledge_source", sourceId, { ...identity, identity_digest: identityDigest, status: "active" }), idempotent: false };
  }

  sourceList(args: JsonObject = {}): JsonObject {
    const scopeKind = args.scope_kind === undefined ? null : text(args.scope_kind, "scope_kind"); const scopeId = args.scope_id === undefined ? null : text(args.scope_id, "scope_id");
    if ((scopeKind === null) !== (scopeId === null)) throw new Error("Knowledge Source scope_kind and scope_id must be supplied together");
    return { sources: this.store.list("knowledge_source", Number(args.limit ?? 100), (item) => {
      const scope = item.scope as JsonObject | undefined;
      return item.status === "active" && (scopeKind === null || (scope?.kind === scopeKind && scope.id === scopeId));
    }) };
  }

  /**
   * Disable or revoke one Source without deleting it.
   *
   * A Source is referenced by every Memory Ledger entry that cites it, so removing the record
   * would orphan that provenance. The transition keeps the record and the reason's digest.
   */
  sourceTransition(args: JsonObject, automaticTransition?: string): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id")); const status = text(args.status, "status");
    if (!TRANSITIONS.has(status)) throw new Error("Knowledge Source status is unsupported");
    const saved = this.store.save("knowledge_source", String(source.id), { ...payload(source), status,
      transition_reason_digest: stableDigest(noCredentialAssignment(text(args.reason, "reason"), "reason")),
      ...(automaticTransition ? { automatic_transition: automaticTransition } : {}) });
    for (const claim of this.store.list("knowledge_claim", 100_000, item => item.source_id === source.id && typeof item.scenario_key === "string", false, { source_ids: [String(source.id)], document_ids: [] })) {
      // Transitions only disable or revoke a Source. Every scenario claim that
      // depends on it must leave the active catalog in either case.
      const scope = knowledgeScenarioScope(claim);
      if (!scope) continue;
      updateKnowledgeScenarioClaim(knowledgeDirectoryForScope(this.store, scope, {
        ...((claim.content_ref as JsonObject | undefined)?.path ? { reference_path: String((claim.content_ref as JsonObject).path) } : {}),
      }), { ...claim, scope }, "inactive");
    }
    return { source: saved };
  }

  /**
   * Read a bounded Markdown/README/Obsidian/Serena source into immutable
   * revisions and fragments.  It is deliberately source-first: arbitrary text
   * becomes Evidence and a candidate, never a silently reviewed Claim.
   */
  sourceIngest(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id"));
    const id = `knowledge_ingest_${randomUUID().replaceAll("-", "")}`;
    try {
      const result = this.ingest(args);
      const receipt = this.store.create("knowledge_ingest_receipt", id, { source_id: source.id, source_version: source.version, status: result.status, reason: result.reason ?? null,
        processed_files: result.processed_files ?? 0, total_files: result.total_files ?? null, has_more: result.has_more ?? false,
        invalidated_documents: result.invalidated_documents ?? 0, unscoped_claims_skipped: result.unscoped_claims_skipped ?? 0 });
      return { ...result, ingestion_receipt: receipt };
    } catch (error) {
      this.store.create("knowledge_ingest_receipt", id, { source_id: source.id, source_version: source.version, status: "failed", reason: "ingest_validation_or_read_failed", error_digest: stableDigest(String(error)) });
      throw error;
    }
  }
  private ingest(args: JsonObject): JsonObject {
    const source = this.store.get("knowledge_source", text(args.source_id, "source_id"));
    const sourceProjectRoot = projectRootForKnowledgeSource(source);
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
    const paths = lstatSync(root).isDirectory() ? files(root, 10_001) : [root];
    if (paths.length > 10_000) throw new Error("Knowledge source exceeds 10000 files; register narrower sources");
    let sourceBytes = 0;
    const documents = paths.map(path => {
      const name = relative(allowedRoot, path) || ".";
      let failure = "file_read_failed";
      try {
      const bytes = lstatSync(path).size;
      sourceBytes += bytes;
      if (sourceBytes > 20_000_000) { failure = "source_byte_budget_exceeded"; throw new Error("Knowledge source exceeds 20 MB budget; register narrower sources"); }
      if (bytes > 2_000_000) { failure = "file_byte_budget_exceeded"; throw new Error("Knowledge document exceeds 2 MiB budget"); }
      const body = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
      return { path: name, body, digest: digest(body), id: `knowledge_document_${stableDigest([source.id, name]).slice(-24)}` };
      } catch (error) {
        this.store.create("knowledge_ingest_receipt", `knowledge_ingest_file_${randomUUID().replaceAll("-", "")}`, { source_id: source.id, source_version: source.version, status: "failed", path: name, reason: failure });
        throw error;
      }
    });
    const revisionDigest = stableDigest({ source_id: source.id, root, maxChars, documents: documents.map(doc => [doc.path, doc.digest]) });
    let offset = 0;
    if (args.cursor !== undefined) {
      const cursor = JSON.parse(Buffer.from(text(args.cursor, "cursor"), "base64url").toString("utf8")) as JsonObject;
      if (cursor.digest !== revisionDigest || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) > documents.length) throw new Error("Knowledge cursor is stale or invalid; restart ingestion");
      offset = Number(cursor.offset);
    }
    const selected = documents.slice(offset, offset + maxFiles), nextOffset = offset + selected.length;
    return this.store.transaction(() => {
      const revisionId = String(args.revision_id ?? `knowledge_source_revision_${String(source.id)}_${revisionDigest.slice(-16)}`);
      const existing = this.store.find("knowledge_source_revision", revisionId);
      if (existing && existing.source_revision_digest !== revisionDigest) throw new Error("Knowledge revision identity conflict");
      const revision = existing ?? this.store.create("knowledge_source_revision", revisionId, { source_id: source.id, source_version: source.version, source_revision_digest: revisionDigest, locator_digest: stableDigest(root), file_count: documents.length, status: "current", immutable: true });
      const manifest = new Map(documents.map(doc => [doc.id, doc]));
      // Invalidate changes/deletions before serving any page. Unchanged documents retain review.
      const invalid = new Set<string>();
      let unscopedClaimsSkipped = 0;
      for (const prior of this.store.list("knowledge_document", 10_001, doc => doc.source_id === source.id && doc.root_digest === stableDigest(root))) {
        const current = manifest.get(String(prior.id));
        if (!current || current.digest !== prior.content_digest) {
          invalid.add(String(prior.id));
          this.store.save("knowledge_document", String(prior.id), { ...payload(prior), status: current ? "changed" : "deleted" });
        }
      }
      for (const claim of this.store.list("knowledge_claim", 100_000, item => item.source_id === source.id && Boolean(item.source_revision_id), false, { source_ids: [String(source.id)], document_ids: [] })) {
        const obsolete = claim.document_id ? invalid.has(String(claim.document_id)) : claim.source_revision_id !== revision.id;
        if (obsolete && ["reviewed", "candidate"].includes(String(claim.status))) {
          if (!knowledgeScenarioScope(claim)) {
            unscopedClaimsSkipped++;
            continue;
          }
          const stale = this.store.save("knowledge_claim", String(claim.id), { ...payload(claim), status: "stale", revalidation_required: true, stale_since_revision: revision.id });
          this.updateStaleScenarioClaim(stale, source);
        }
      }
      const fragments: JsonObject[] = [], candidates: JsonObject[] = [];
      for (const doc of selected) {
        const document = this.store.find("knowledge_document", doc.id);
        if (!document || document.content_digest !== doc.digest || document.status !== "current") {
          const data = { source_id: source.id, root_digest: stableDigest(root), path: doc.path, content_digest: doc.digest, status: "current" };
          if (document) this.store.save("knowledge_document", doc.id, data); else this.store.create("knowledge_document", doc.id, data);
        }
        for (let start = 0, ordinal = 0; start < doc.body.length; ordinal++) {
          let end = Math.min(start + maxChars, doc.body.length);
          // Prefer paragraph/heading boundaries, retaining exact source offsets.
          if (end < doc.body.length) {
            const boundary = doc.body.lastIndexOf("\n\n", end);
            if (boundary > start + maxChars / 2) end = Math.min(end, boundary + 2);
          }
          const excerpt = doc.body.slice(start, end), location = start; start = end;
          if (!excerpt.trim()) continue;
          const fragmentId = `knowledge_fragment_${stableDigest([doc.id, doc.digest, maxChars, ordinal, excerpt]).slice(-24)}`;
          let fragment = this.store.find("knowledge_fragment", fragmentId);
          if (!fragment) {
            const contentRef = this.store.contentStore.writeSync({ kind: "knowledge", record_id: fragmentId, version: 1, scope: `${(source.scope as JsonObject).kind}:${(source.scope as JsonObject).id}`, status: "candidate", sensitivity: "internal", source_id: String(source.id), body: excerpt,
              ...(sourceProjectRoot ? { project_root: sourceProjectRoot } : {}) });
            fragment = this.store.create("knowledge_fragment", fragmentId, { source_id: source.id, source_revision_id: revision.id, document_id: doc.id, document_digest: doc.digest, path: doc.path, locator: `${doc.path}#chars=${location}-${end}`, content_ref: contentRef, content_digest: digest(excerpt), status: "current", immutable: true });
          }
          const evidenceId = `evidence_${fragmentId}`;
          const evidence = this.store.find("evidence", evidenceId) ?? this.store.create("evidence", evidenceId, { source_type: "knowledge_fragment", source_id: source.id, source_revision_id: fragment.source_revision_id, fragment_id: fragment.id, locator: fragment.locator, claim: "Source fragment retained for review.", confidence: source.trust === "verified" ? "bounded" : "unverified", content_digest: fragment.content_digest, observed_at: new Date().toISOString() });
          const claimId = `knowledge_claim_from_${fragmentId}`;
          const identity = { source_id: source.id, source_revision_id: fragment.source_revision_id, document_id: doc.id, document_digest: doc.digest, fragment_id: fragment.id, scope: `${(source.scope as JsonObject).kind}:${(source.scope as JsonObject).id}`, scope_envelope: source.scope_envelope, kind: "fact", content_digest: fragment.content_digest, evidence_ids: [evidence.id], valid_until: null };
          // Exact current text in the same scope shares one candidate across
          // source revisions, duplicate files, and independent Sources. Legacy
          // or stale Claims are never reused by this path.
          const shared = this.store.list("knowledge_claim", 100_000, item => item.status === "candidate" && item.content_digest === fragment.content_digest && item.scope === identity.scope && item.id !== claimId)[0];
          let claim = this.store.find("knowledge_claim", claimId);
          if (!claim && shared) {
            const sharedEvidenceIds = (Array.isArray(shared.evidence_ids) ? shared.evidence_ids as unknown[] : []).map(String);
            claim = sharedEvidenceIds.includes(String(evidence.id)) ? shared
              : this.store.save("knowledge_claim", String(shared.id), { ...payload(shared), evidence_ids: [...new Set([...sharedEvidenceIds, String(evidence.id)])].sort() });
          }
          if (!claim) claim = this.store.create("knowledge_claim", claimId, { ...identity, content_ref: fragment.content_ref, identity_digest: stableDigest(identity), status: "candidate", review: null, ingest_generated: true, publication_allowed: false });
          if (source.trust === "verified" && ["bounded", "confirmed"].includes(String(evidence.confidence))) {
            // A revision or a copied file inside one registered Source is not
            // independent corroboration. Count that Source once for this Claim.
            const observationKey = `knowledge-source:${String(source.id)}`;
            const supportIdentity = { claim_id: claim.id, claim_version: claim.version, evidence_id: evidence.id, observation_key: observationKey, scope: identity.scope };
            const supportId = `knowledge_support_${stableDigest(supportIdentity).slice(-24)}`;
            const sourceSupport = this.store.list("knowledge_claim_support", 10_000, item => item.claim_id === claim.id && item.observation_key === observationKey)[0];
            if (!sourceSupport && !this.store.find("knowledge_claim_support", supportId)) this.store.create("knowledge_claim_support", supportId, { ...supportIdentity, identity_digest: stableDigest(supportIdentity), recorded_at: new Date().toISOString(), source_type: evidence.source_type, confidence: evidence.confidence });
          }
          const candidateId = `knowledge_ingest_candidate_${fragmentId}`;
          const candidate = this.store.find("knowledge_ingest_candidate", candidateId) ?? this.store.create("knowledge_ingest_candidate", candidateId, { source_id: source.id, source_revision_id: fragment.source_revision_id, fragment_id: fragment.id, claim_id: claim.id, evidence_id: evidence.id, scope: identity.scope, status: "candidate", structural_review: "pending", semantic_review: "pending", publication_allowed: false });
          fragments.push(fragment); candidates.push(candidate);
        }
      }
      for (const prior of this.store.list("knowledge_source_revision", 10_000, item => item.source_id === source.id && item.id !== revision.id && item.locator_digest === stableDigest(root) && item.status === "current")) this.store.save("knowledge_source_revision", String(prior.id), { ...payload(prior), status: "superseded", superseded_by: revision.id });
      const hasMore = nextOffset < documents.length;
      return { status: hasMore ? "partial" : "completed", source, revision, fragments, candidates, raw_content_stored: false,
        has_more: hasMore, next_cursor: hasMore ? Buffer.from(JSON.stringify({ digest: revisionDigest, offset: nextOffset })).toString("base64url") : null,
        processed_files: selected.length, total_files: documents.length, invalidated_documents: invalid.size, unscoped_claims_skipped: unscopedClaimsSkipped };
    });
  }
}
