import type { ContextRequest } from "craft-common-base/capability-protocol";
import { MemoryContribution } from "@craft/capability-memory/contribution";
import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_CONTEXT_MAX_ITEMS } from "craft-common-base/context-assets";
import { noCredentialAssignment, optionalScope, sortedUniqueList, text } from "../../validation.ts";
import { scopeAccess } from "../../scope-policy.ts";
import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { hostSessionMemoryArgs } from "./session-memory-scope.ts";

declare module "../craft-service.ts" {
  interface CraftService { memoryRecall(args: JsonObject): Promise<JsonObject>; contextResolutionFeedback(args: JsonObject): JsonObject; knowledgeSearchScoped(args: JsonObject): Promise<JsonObject>; }
}

/**
 * The three delegations that used to reach one class.
 *
 * `KnowledgeMemoryRuntime` served two context members plus the shared context plane from a
 * single object, so every method here went through `this.knowledgeMemory`. Now each method
 * names the **owner of the member it belongs to**: Sources to the knowledge package's registry,
 * Ledger writes to the memory package's kernel, and resolution to the core context plane. The
 * split is therefore visible in the delegation, not only in the directory layout — which is what
 * makes the ownership declarations in each package's `ownership.ts` checkable rather than
 * aspirational.
 */
export function installKnowledgeMemoryMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.knowledgeSearchScoped = function (args) { return this.contextResolution.searchKnowledge(args); };
  serviceClass.prototype.knowledgeMemoryInstallBuiltins = function () { return this.knowledgeSources.installBuiltins(); };
  serviceClass.prototype.knowledgeSourceRegister = function (args) { return this.knowledgeSources.sourceRegister(args); };
  serviceClass.prototype.knowledgeSourceList = function (args) { return this.knowledgeSources.sourceList(args); };
  serviceClass.prototype.knowledgeSourceTransition = function (args) { return this.knowledgeSources.sourceTransition(args); };
  serviceClass.prototype.knowledgeSourceIngest = function (args) {
    const result = this.knowledgeSources.sourceIngest(args);
    const candidates = Array.isArray(result.candidates) ? result.candidates as JsonObject[] : [];
    const claimIds = [...new Set(candidates.map(item => String(item.claim_id ?? "")).filter(Boolean))];
    // Re-evaluate only claims produced by this trusted, registered-source read.
    // The existing local policy still enforces independent support, confidence,
    // scope, expiry and contradiction rules; ingestion never promotes legacy rows.
    const sourceScope = (result.source as JsonObject | undefined)?.scope as JsonObject | undefined;
    const automaticReview = claimIds.length && typeof sourceScope?.kind === "string" && typeof sourceScope.id === "string"
      ? this.knowledgeAutoReview({ claim_ids: claimIds, scope_kind: sourceScope.kind, scope_id: sourceScope.id })
      : { assessments: [], summary: {}, auto_promote: false, skipped: claimIds.length > 0 ? "source_scope_unavailable" : undefined };
    return { ...result, automatic_review: automaticReview };
  };
  serviceClass.prototype.memoryRecall = async function (args) {
    const scoped = hostSessionMemoryArgs(args, this.store);
    const target = optionalScope(scoped);
    if (!target) throw new Error("Memory resolve requires an explicit scope");
    const query = noCredentialAssignment(text(args.query, "query"), "query");
    const access = scopeAccess(args);
    const contribution = await new MemoryContribution(this.store).contribute({
      ...access, cognitive_purpose: access.purpose, query, scope_kind: target.kind as ContextRequest["scope_kind"], scope_id: target.id,
      max_items: Number(args.max_items ?? DEFAULT_CONTEXT_MAX_ITEMS), max_chars: Number(args.max_chars ?? DEFAULT_CONTEXT_MAX_CHARS),
      source_ids: sortedUniqueList(args.source_ids, "source_ids"), memory_ids: sortedUniqueList(args.memory_ids, "memory_ids"),
      allow_restricted: args.allow_restricted === true, include_working_notes: args.include_working_notes === true,
      history_view: args.history_view === true, include_stale: args.include_stale === true,
      now: args.now === undefined ? undefined : text(args.now, "now"),
      as_of: args.as_of === undefined ? undefined : text(args.as_of, "as_of"),
      known_at: args.known_at === undefined ? undefined : text(args.known_at, "known_at"),
    });
    return { ...contribution, scope: target, execution_context: args.history_view !== true && args.as_of === undefined && args.known_at === undefined };
  };
  serviceClass.prototype.memoryLedgerRemember = function (args) { return this.memoryLedger.remember(hostSessionMemoryArgs(args, this.store)); };
  serviceClass.prototype.memoryLedgerGet = function (args) { return this.memoryLedger.get(hostSessionMemoryArgs(args, this.store)); };
  serviceClass.prototype.memoryLedgerList = function (args) { return this.memoryLedger.list(hostSessionMemoryArgs(args, this.store)); };
  serviceClass.prototype.memoryLedgerTransition = function (args) { return this.memoryLedger.transition(hostSessionMemoryArgs(args, this.store)); };
  serviceClass.prototype.memoryLedgerCompatBind = function (args) { return this.memoryLedger.compatBind(args); };
  serviceClass.prototype.contextResolutionResolve = function (args) { return this.contextResolution.resolve(args); };
  serviceClass.prototype.contextResolutionFeedback = function (args) { return this.contextResolution.feedback(args); };
  serviceClass.prototype.contextResolutionGet = function (args) { return this.contextResolution.receiptGet(args); };
  serviceClass.prototype.retrievalAdapterConfigure = function (args) { return this.contextResolution.retrievalConfigure(args); };
  serviceClass.prototype.retrievalAdapterEvaluate = function (args) { return args.dataset === undefined ? this.contextResolution.retrievalEvaluate(args) : this.contextResolution.retrievalRun(args); };
  serviceClass.prototype.scopeIdentityResolveProject = function (args) { return this.scopeIdentity.resolveProject(args); };
  serviceClass.prototype.scopeAliasBind = function (args) { return this.scopeIdentity.bindAlias(args); };
  serviceClass.prototype.scopeAliasMigrate = function (args) { return this.scopeIdentity.migrateAlias(args); };
  serviceClass.prototype.memoryMaintenanceSchedule = function (args) { return this.maintenanceScheduler.tick(args); };
}
