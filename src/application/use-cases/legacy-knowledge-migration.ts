import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

function candidateScope(candidate: JsonObject): string { return `legacy:${String(candidate.scope)}:${String(candidate.project ?? "shared")}`; }
function memoryKind(candidate: JsonObject): string { return ["workflow", "technical_decision"].includes(String(candidate.knowledge_type)) ? "procedural" : "working"; }

export function installLegacyKnowledgeMigrationMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.legacyKnowledgeMigrationDiscover = function (args: JsonObject) {
    if (args.offline !== true) throw new Error("Legacy knowledge discovery is offline-only; use scripts/import-legacy-knowledge.ts");
    return this.legacyKnowledgeMigration.discover(args);
  };
  serviceClass.prototype.legacyKnowledgeMigrationCandidateImport = async function (args: JsonObject) {
    if (args.offline !== true) throw new Error("Legacy knowledge import is offline-only; use scripts/import-legacy-knowledge.ts");
    const migration = this.store.get("legacy_knowledge_migration", String(args.migration_id));
    const sourceId = `legacy_knowledge_source_${String(migration.source_digest).slice(-24)}`;
    this.knowledgeSourceRegister({ source_id: sourceId, kind: "custom", label: "Offline legacy formal knowledge snapshot", scope_kind: "user", scope_id: "local", locator: `offline://legacy-import/${String(migration.source_digest).slice(-24)}`, content_digest: String(migration.source_digest), trust: "bounded", access: "proposal_only" });
    return this.legacyKnowledgeMigration.importCandidates(args, sourceId, (entry, _source, _sourceId, candidateId) => {
      const evidenceId = `legacy_knowledge_evidence_${candidateId.slice(-24)}`; const claimId = `legacy_knowledge_claim_${candidateId.slice(-24)}`;
      this.evidenceRecord({ evidence_id: evidenceId, source_type: "legacy_kefu_wiki_formal_page", claim: `Legacy formal page imported as unverified candidate: ${entry.title}`, confidence: "unverified", locator: entry.rel_path, metadata: { source_digest: entry.page_digest, evidence_type: entry.evidence_type, migration: true } });
      this.knowledgeClaimSave({ claim_id: claimId, title: entry.title, kind: ({ domain_rule: "fact", technical_decision: "decision", workflow: "rule", troubleshooting: "failure_mode", stable_project_fact: "fact" } as Record<string, string>)[entry.knowledge_type], content: `${entry.title}\n\n${entry.summary}`, evidence_ids: [evidenceId], scope: `legacy:${entry.scope}:${entry.project ?? "shared"}`, tags: entry.tags });
      return { evidence_id: evidenceId, claim_id: claimId };
    });
  };
  serviceClass.prototype.legacyKnowledgeMigrationPublish = async function (args: JsonObject) {
    const prepared = this.legacyKnowledgeMigration.publishReady(args); if (prepared.idempotent) return prepared;
    const candidate = prepared.candidate as JsonObject; const reviewer = String(args.reviewer ?? "").trim(); if (!reviewer) throw new Error("reviewer must not be empty");
    const pageId = `legacy_knowledge_wiki_${String(candidate.id).slice(-24)}`; const memoryId = `legacy_knowledge_memory_${String(candidate.id).slice(-24)}`;
    try {
      await this.wikiPageSave({ page_id: pageId, title: String(candidate.title), body: `# ${String(candidate.title)}\n\n${String(candidate.summary)}\n\n来源：${String(candidate.source_locator)}\n来源摘要 digest：${String(candidate.source_digest)}`, claim_ids: [String(candidate.claim_id)], scope: candidateScope(candidate), author: reviewer });
      this.memoryLedgerRemember({ memory_id: memoryId, source_id: String(candidate.source_id), kind: memoryKind(candidate), scope_kind: "project", scope_id: candidateScope(candidate), content: `${String(candidate.title)}\n\n${String(candidate.summary)}`, sensitivity: "internal", confidence: "bounded", evidence_ids: [String(candidate.evidence_id)] });
      return { candidate: this.legacyKnowledgeMigration.completePublish(String(candidate.id), pageId, memoryId), idempotent: false };
    } catch (error) { this.legacyKnowledgeMigration.recordFailure(String(candidate.migration_id), "publish", String(candidate.source_locator), error instanceof Error ? error.message : "publish_failed"); throw error; }
  };
  serviceClass.prototype.legacyKnowledgeMigrationRetract = async function (args: JsonObject) {
    const prepared = this.legacyKnowledgeMigration.retractReady(args); if (prepared.idempotent) return prepared;
    const candidate = prepared.candidate as JsonObject; const reviewer = String(args.reviewer ?? "").trim(); const reason = String(args.reason ?? "").trim(); if (!reviewer || !reason) throw new Error("reviewer and reason must not be empty");
    try {
      this.knowledgeClaimReview({ claim_id: String(candidate.claim_id), status: "disputed", reviewer, reason });
      this.memoryLedgerTransition({ memory_id: String(candidate.memory_id), status: "revoked", reason });
      await this.wikiPageSave({ page_id: String(candidate.wiki_page_id), title: String(candidate.title), body: `# ${String(candidate.title)}\n\n此历史知识迁移项已撤回；不保留旧系统原文。`, claim_ids: [], scope: candidateScope(candidate), author: reviewer });
      return { candidate: this.legacyKnowledgeMigration.completeRetraction(String(candidate.id), reason), idempotent: false };
    } catch (error) { this.legacyKnowledgeMigration.recordFailure(String(candidate.migration_id), "retract", String(candidate.source_locator), error instanceof Error ? error.message : "retract_failed"); throw error; }
  };
  serviceClass.prototype.legacyKnowledgeMigrationFailureReport = function (args: JsonObject) { return this.legacyKnowledgeMigration.failureReport(args); };
}
