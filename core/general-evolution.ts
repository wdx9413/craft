import { createHash, randomUUID } from "node:crypto";
import { KnowledgeRelationKernel } from "@craft/capability-knowledge/knowledge-relation";
import { knowledgeLineageImpact } from "@craft/capability-knowledge/knowledge-lineage-impact";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";

export const DOMAIN_ADAPTER_NAMES = ["coding", "office", "travel", "creation", "research"] as const;
export type DomainAdapterName = (typeof DOMAIN_ADAPTER_NAMES)[number];

export const RESEARCH_LAYERS = ["literature_fact", "experiment_observation", "interpretation"] as const;
export type ResearchLayer = (typeof RESEARCH_LAYERS)[number];

export const RESEARCH_RELATIONS = ["derives_from", "supports", "contradicts", "supersedes"] as const;
export type ResearchRelation = (typeof RESEARCH_RELATIONS)[number];

const DOMAIN_PATTERNS: Readonly<Record<DomainAdapterName, RegExp>> = {
  coding: /(?:报错|错误|失败|debug|fix|patch|test|repo|仓库|构建|编译)/iu,
  office: /(?:会议|决议|模板|文档|表格|ppt|流程|审批|附件)/iu,
  travel: /(?:预算|行程|航班|酒店|入住|出发|到达|签证)/iu,
  creation: /(?:prompt|风格|素材|生成|图片|视频|文章|幻灯片|封面)/iu,
  research: /(?:论文|假设|实验|结果|反例|复现|文献|参数)/iu,
};

export interface DomainAdapterRecord {
  name: DomainAdapterName;
  version: string;
  status: "candidate" | "active";
  extraction_patterns: string[];
  value_threshold: number;
  evidence_types: string[];
  eval_case_ids: string[];
  digest: string;
}

export interface ProgramMemoryCandidate {
  id: string;
  scenario_key: string;
  domain: DomainAdapterName | "general";
  statement: string;
  steps: string[];
  evidence_ids: string[];
  repetitions: number;
  status: "diagnostic" | "submitted" | "promoted" | "rejected" | "revoked";
  scope: JsonObject;
  digest: string;
}

export interface ArtifactLineageRecord extends JsonObject {
  id: string;
  artifact_type: "text" | "image" | "video" | "slides";
  modality: "text" | "visual" | "video" | "mixed";
  source_refs: string[];
  prompt: string | null;
  parameters: JsonObject;
  tool: string | null;
  version: number;
  user_choice: "accepted" | "rejected" | "branch" | null;
  evaluation: string | null;
  reliability: number;
  scope: JsonObject;
}

export interface ProspectiveIntention extends JsonObject {
  id: string;
  intention: string;
  trigger: JsonObject;
  scope: JsonObject;
  evidence_ids: string[];
  status: "pending" | "delivered" | "failed" | "expired" | "cancelled";
  receipts: JsonObject[];
}

export interface ResearchNodeRecord extends JsonObject {
  node: JsonObject;
  id: string;
  layer: ResearchLayer;
  content: string;
  source_refs: string[];
  scope: JsonObject;
}

export interface ResearchRelationRecord extends JsonObject {
  relation_id: string;
  source_id: string;
  target_id: string;
  relation: ResearchRelation;
  scope: JsonObject;
  digest: string;
}

export interface ReplicationCandidateRecord extends ProgramMemoryCandidate, JsonObject {
  replication_id: string;
  program_memory_id: string;
  title: string;
  source_id: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 50) : [];
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function scopeKey(scope: JsonObject): string {
  const kind = text(scope.kind);
  const id = text(scope.id);
  if (!kind || !id) throw new Error("scope must declare kind and id");
  return `${kind}:${id}`;
}

function scopeMatches(left: JsonObject, right: JsonObject): boolean {
  return text(left.kind) === text(right.kind) && text(left.id) === text(right.id);
}

function researchScope(claim: JsonObject): JsonObject {
  return object(claim.research_scope);
}

function researchRelationId(sourceId: string, targetId: string, relation: string): string {
  return `research_link_${digest({ sourceId, targetId, relation }).slice(-24)}`;
}

const DEFAULT_ADAPTERS: Record<DomainAdapterName, Omit<DomainAdapterRecord, "digest">> = {
  coding: { name: "coding", version: "v1", status: "active", extraction_patterns: ["error", "fix", "test", "repo"], value_threshold: 2, evidence_types: ["test", "patch", "verification"], eval_case_ids: ["coding.write", "coding.recall", "coding.apply", "coding.forget", "coding.scope_leak"] },
  office: { name: "office", version: "v1", status: "active", extraction_patterns: ["meeting", "template", "document", "decision"], value_threshold: 2, evidence_types: ["document", "decision", "principal"], eval_case_ids: ["office.write", "office.recall", "office.apply", "office.forget", "office.scope_leak"] },
  travel: { name: "travel", version: "v1", status: "active", extraction_patterns: ["budget", "date", "location", "booking"], value_threshold: 2, evidence_types: ["booking", "time", "location"], eval_case_ids: ["travel.write", "travel.recall", "travel.apply", "travel.forget", "travel.scope_leak"] },
  creation: { name: "creation", version: "v1", status: "active", extraction_patterns: ["prompt", "style", "artifact", "version"], value_threshold: 2, evidence_types: ["artifact", "user_choice", "tool"], eval_case_ids: ["creation.write", "creation.recall", "creation.apply", "creation.forget", "creation.scope_leak"] },
  research: { name: "research", version: "v1", status: "active", extraction_patterns: ["hypothesis", "experiment", "result", "counterexample"], value_threshold: 2, evidence_types: ["paper", "experiment", "verification"], eval_case_ids: ["research.write", "research.recall", "research.apply", "research.forget", "research.scope_leak"] },
};

export class GeneralEvolutionKernel {
  readonly store: CraftStore;
  private readonly knowledgeRelations: KnowledgeRelationKernel;
  constructor(store: CraftStore) {
    this.store = store;
    this.knowledgeRelations = new KnowledgeRelationKernel(store);
  }

  ensureAdapters(): JsonObject {
    for (const [name, adapter] of Object.entries(DEFAULT_ADAPTERS)) {
      const id = `domain_adapter_${name}`;
      const existing = this.store.find("domain_adapter", id);
      if (existing) continue;
      this.store.create("domain_adapter", id, { ...adapter, digest: digest(adapter) });
    }
    return { items: this.store.list("domain_adapter", 10, undefined, false) };
  }

  registerAdapter(args: JsonObject): JsonObject {
    const name = text(args.name) as DomainAdapterName;
    if (!DOMAIN_ADAPTER_NAMES.includes(name)) throw new Error("unsupported domain adapter");
    const id = `domain_adapter_${name}_candidate_${randomUUID().slice(0, 8)}`;
    const record = { name, version: text(args.version) || "v0", status: "candidate",
      extraction_patterns: stringArray(args.extraction_patterns), value_threshold: Number(args.value_threshold ?? 2),
      evidence_types: stringArray(args.evidence_types), eval_case_ids: stringArray(args.eval_case_ids) };
    this.store.create("domain_adapter", id, { ...record, digest: digest(record) });
    return this.store.get("domain_adapter", id);
  }

  captureProgramMemory(args: JsonObject): JsonObject {
    const statement = text(args.statement);
    if (!statement) throw new Error("statement must not be empty");
    const scenarioKey = text(args.scenario_key) || `general_${digest(statement).slice(-12)}`;
    const domain = (text(args.domain) || "general") as DomainAdapterName | "general";
    const evidenceIds = stringArray(args.evidence_ids);
    const steps = stringArray(args.steps);
    const scope = object(args.scope);
    const id = text(args.id) || `program_memory_${digest({ statement, scenarioKey, scope }).slice(-24)}`;
    const existing = this.store.find("program_memory_candidate", id);
    const repetitions = Number(existing?.repetitions ?? 0) + 1;
    // Reinforcing an existing candidate must never reset a submitted or
    // promoted lifecycle back to diagnostic.
    const status = existing ? String(existing.status) : "diagnostic";
    const record = { id, scenario_key: scenarioKey, domain, statement, steps, evidence_ids: evidenceIds, repetitions,
      status, scope, digest: digest({ statement, steps, evidenceIds, scope }) };
    this.store.save("program_memory_candidate", id, record);
    return record;
  }

  listProgramMemory(args: JsonObject = {}): JsonObject {
    const status = text(args.status);
    return { items: this.store.list("program_memory_candidate", 100, (item) => !status || item.status === status, false) };
  }

  submitProgramMemory(id: string): JsonObject {
    const current = this.store.get("program_memory_candidate", id);
    const adapter = this.store.find("domain_adapter", `domain_adapter_${current.domain}`) as JsonObject | undefined;
    const threshold = Number(adapter?.value_threshold ?? 2);
    const evidenceIds = Array.isArray(current.evidence_ids) ? current.evidence_ids.map(String) : [];
    // Evidence must exist, not merely be counted: a cited but missing record is
    // not proof. Observations and memory entries are first-class supporting
    // records for adapters that capture from real use.
    const resolved = evidenceIds.filter((evidenceId) =>
      Boolean(this.store.find("evidence", evidenceId))
      || Boolean(this.store.find("workflow_evolution_observation", evidenceId))
      || Boolean(this.store.find("memory_ledger", evidenceId)));
    if (Number(current.repetitions) < threshold || resolved.length === 0)
      throw new Error("program memory candidate does not meet promotion threshold");
    return this.store.save("program_memory_candidate", id, { ...current, status: "submitted", submitted_at: new Date().toISOString() });
  }

  /** Thin domain adapter: extract a scenario-shaped candidate without owning storage. */
  captureDomainStatement(args: JsonObject): JsonObject {
    const domain = text(args.domain) as DomainAdapterName;
    if (!DOMAIN_ADAPTER_NAMES.includes(domain)) throw new Error("unsupported domain adapter");
    const statement = text(args.statement);
    if (!statement) throw new Error("statement must not be empty");
    if (!DOMAIN_PATTERNS[domain].test(statement)) return { status: "ignored", domain, reason: "no domain signal" };
    const scope = object(args.scope);
    const candidate = this.captureProgramMemory({ statement, domain, scope,
      scenario_key: text(args.scenario_key) || `${domain}_${digest(statement).slice(-12)}`,
      steps: stringArray(args.steps), evidence_ids: stringArray(args.evidence_ids) });
    return { status: "candidate", domain, candidate };
  }

  /** Failure attribution stays proposal-only; unattributed failures never become rules. */
  captureFailureCandidate(args: JsonObject): JsonObject {
    const failureClass = text(args.failure_class);
    if (!failureClass || failureClass === "unattributed") throw new Error("an attributed failure_class is required");
    const remedy = text(args.remedy);
    if (!remedy) throw new Error("remedy is required");
    const evidenceIds = stringArray(args.evidence_ids);
    if (!evidenceIds.length) throw new Error("failure attribution requires evidence");
    const id = `program_memory_failure_${digest({ failureClass, remedy, evidenceIds }).slice(-24)}`;
    const record = { id, scenario_key: `failure:${failureClass}`, domain: "general", kind: "failure_pattern",
      statement: `Failure pattern ${failureClass}: ${remedy}`, steps: [], evidence_ids: evidenceIds,
      repetitions: 1, status: "diagnostic", scope: object(args.scope), failure_class: failureClass,
      digest: digest({ failureClass, remedy, evidenceIds }) };
    this.store.save("program_memory_candidate", id, record);
    return record;
  }

  /** Promotion is only possible after an external evaluation reference is bound. */
  promoteProgramMemory(args: JsonObject): JsonObject {
    const id = text(args.id);
    const evaluationRef = text(args.evaluation_ref);
    if (!evaluationRef) throw new Error("evaluation_ref is required");
    const current = this.store.get("program_memory_candidate", id);
    if (current.status !== "submitted") throw new Error("program memory candidate is not submitted");
    return this.store.save("program_memory_candidate", id, { ...current, status: "promoted",
      evaluation_ref: evaluationRef, promoted_at: new Date().toISOString() });
  }

  /** Invocation feedback can degrade or revoke a promoted program memory. */
  recordProgramMemoryFeedback(args: JsonObject): JsonObject {
    const id = text(args.id);
    const outcome = text(args.outcome);
    if (!["confirmed", "degraded", "revoked"].includes(outcome)) throw new Error("outcome must be confirmed, degraded or revoked");
    const current = this.store.get("program_memory_candidate", id);
    const feedback = Array.isArray(current.feedback) ? current.feedback as JsonObject[] : [];
    const status = outcome === "revoked" ? "revoked" : outcome === "degraded" ? "rejected" : current.status;
    return this.store.save("program_memory_candidate", id, { ...current, status,
      feedback: [...feedback, { outcome, at: new Date().toISOString(), evidence_ids: stringArray(args.evidence_ids) }] });
  }

  recordArtifactLineage(args: JsonObject): JsonObject {
    const artifactType = text(args.artifact_type) as ArtifactLineageRecord["artifact_type"];
    if (!["text", "image", "video", "slides"].includes(artifactType)) throw new Error("unsupported artifact type");
    const id = `artifact_lineage_${text(args.id) || randomUUID()}`;
    const existing = this.store.find("artifact_lineage", id);
    const version = Number(existing?.version ?? 0) + 1;
    const record: ArtifactLineageRecord = {
      id, artifact_type: artifactType,
      modality: (text(args.modality) || (artifactType === "text" ? "text" : artifactType === "video" ? "video" : "visual")) as ArtifactLineageRecord["modality"],
      source_refs: stringArray(args.source_refs), prompt: args.prompt === undefined ? null : text(args.prompt),
      parameters: object(args.parameters), tool: args.tool === undefined ? null : text(args.tool), version,
      user_choice: (args.user_choice === undefined ? null : text(args.user_choice)) as ArtifactLineageRecord["user_choice"],
      evaluation: args.evaluation === undefined ? null : text(args.evaluation),
      reliability: Number(args.reliability ?? 0.5), scope: object(args.scope),
    };
    if (record.reliability < 0 || record.reliability > 1) throw new Error("reliability must be between 0 and 1");
    this.store.save("artifact_lineage", id, record);
    return record;
  }

  recallArtifactLineage(args: JsonObject): JsonObject {
    const artifactType = text(args.artifact_type);
    const items = this.store.list("artifact_lineage", 100, (item) => !artifactType || item.artifact_type === artifactType, false)
      .filter((item) => Number(item.reliability) >= 0.4)
      .sort((a, b) => Number(b.reliability) - Number(a.reliability));
    return { items };
  }

  createProspectiveIntention(args: JsonObject): JsonObject {
    const intention = text(args.intention);
    if (!intention) throw new Error("intention must not be empty");
    const trigger = object(args.trigger);
    if (!Object.keys(trigger).length) throw new Error("trigger must not be empty");
    const id = `prospective_${digest({ intention, trigger, scope: object(args.scope) }).slice(-24)}`;
    const record: ProspectiveIntention = {
      id, intention, trigger, scope: object(args.scope), evidence_ids: stringArray(args.evidence_ids),
      status: "pending", receipts: [],
    };
    this.store.create("prospective_intention", id, record);
    return record;
  }

  fireProspectiveIntention(args: JsonObject): JsonObject {
    const id = text(args.id);
    const current = this.store.get("prospective_intention", id);
    if (current.status !== "pending") throw new Error("prospective intention is not pending");
    const trigger = object(args.trigger);
    const expected = object(current.trigger);
    const matched = Object.entries(expected).every(([key, value]) => JSON.stringify(trigger[key]) === JSON.stringify(value));
    const receipt = { at: new Date().toISOString(), matched, cue: object(args.cue) };
    const status = matched ? "delivered" : "failed";
    return this.store.save("prospective_intention", id, { ...current, status, receipts: [...(current.receipts as JsonObject[]), receipt] });
  }

  linkResearch(args: JsonObject): JsonObject {
    const sourceId = text(args.source_id), targetId = text(args.target_id), relation = text(args.relation);
    if (!sourceId || !targetId || !relation) throw new Error("source_id, target_id and relation are required");
    if (!(RESEARCH_RELATIONS as readonly string[]).includes(relation)) throw new Error("unsupported research relation");
    const scope = object(args.scope);
    const scoped = Object.keys(scope).length > 0;
    if (scoped) {
      scopeKey(scope);
      for (const id of [sourceId, targetId]) {
        const claim = this.store.find("knowledge_claim", id);
        if (claim && !scopeMatches(object(claim.research_scope), scope)) throw new Error(`research node ${id} is not in scope`);
      }
    }
    const id = text(args.relation_id) || researchRelationId(sourceId, targetId, relation);
    const endpointsExist = [sourceId, targetId].every((claimId) => this.store.find("knowledge_claim", claimId));
    if (endpointsExist) {
      this.knowledgeRelations.relate({
        relation_id: id, source: { kind: "knowledge_claim", id: sourceId },
        target: { kind: "knowledge_claim", id: targetId }, relation,
        confidence: text(args.confidence) || "bounded", evidence_ids: stringArray(args.evidence_ids),
      });
    }
    const record: ResearchRelationRecord = {
      relation_id: id, source_id: sourceId, target_id: targetId,
      relation: relation as ResearchRelation, scope, digest: digest({ sourceId, targetId, relation, scope }),
    };
    const saved = this.store.save("research_memory_link", id, record);
    if (text(args.layer) && !(RESEARCH_LAYERS as readonly string[]).includes(text(args.layer)))
      throw new Error(`layer must be one of ${RESEARCH_LAYERS.join(", ")}`);
    return { ...saved, layer: text(args.layer) || "experiment_observation" };
  }

  captureResearchNode(args: JsonObject): JsonObject {
    const id = text(args.id);
    const layer = text(args.layer) as ResearchLayer;
    const content = text(args.content);
    if (!id || !content) throw new Error("id and content are required");
    if (!(RESEARCH_LAYERS as readonly string[]).includes(layer)) throw new Error(`layer must be one of ${RESEARCH_LAYERS.join(", ")}`);
    const scope = object(args.scope);
    scopeKey(scope);
    const existing = this.store.find("knowledge_claim", id);
    if (existing && (existing.research_layer !== layer || !scopeMatches(researchScope(existing), scope)))
      throw new Error("research node layer or scope mismatch");
    const saved = this.store.save("knowledge_claim", id, {
      kind: layer === "experiment_observation" ? "decision" : layer === "interpretation" ? "rule" : "fact",
      content, scope: scopeKey(scope), source_refs: stringArray(args.source_refs),
      research_layer: layer, research_scope: scope,
    });
    const record: ResearchNodeRecord = {
      node: { kind: "knowledge_claim", id: String(saved.id), version: Number(saved.version) },
      id: String(saved.id), layer, content, source_refs: stringArray(args.source_refs), scope,
    };
    return record;
  }

  recallResearch(args: JsonObject = {}): JsonObject {
    const scope = object(args.scope);
    scopeKey(scope);
    const query = text(args.query).toLowerCase();
    const items = this.store.list("knowledge_claim", 200, (item) =>
      typeof item.research_layer === "string" && item.research_status !== "forgotten"
      && scopeMatches(researchScope(item), scope)
      && (!query || text(item.content).toLowerCase().includes(query)), false)
      .map((claim) => ({
        node: { kind: "knowledge_claim", id: String(claim.id), version: Number(claim.version) },
        id: String(claim.id), layer: claim.research_layer, content: claim.content,
        source_refs: Array.isArray(claim.source_refs) ? claim.source_refs : [], scope: researchScope(claim),
      }));
    return { items, denied: false, scope };
  }

  applyResearchImpact(args: JsonObject): JsonObject {
    const nodeId = text(args.node_id);
    if (!nodeId) throw new Error("node_id is required");
    const scope = object(args.scope);
    scopeKey(scope);
    const claim = this.store.get("knowledge_claim", nodeId);
    if (typeof claim.research_layer !== "string" || !scopeMatches(object(claim.research_scope), scope))
      throw new Error("research node is not in scope");
    return knowledgeLineageImpact(this.store, {
      node: { kind: "knowledge_claim", id: nodeId },
      as_of: args.as_of, max_nodes: args.max_nodes,
    });
  }

  forgetResearchNode(args: JsonObject): JsonObject {
    const id = text(args.id);
    const scope = object(args.scope);
    scopeKey(scope);
    const claim = this.store.get("knowledge_claim", id);
    if (typeof claim.research_layer !== "string" || !scopeMatches(researchScope(claim), scope))
      throw new Error("research node is not in scope");
    const relations = (this.knowledgeRelations.neighbors({
      node: { kind: "knowledge_claim", id, version: Number(claim.version) }, limit: 1000,
    }) as JsonObject).relations as JsonObject[];
    const retracted: string[] = [];
    for (const relation of relations) {
      const relationId = String(relation.relation_id);
      if (this.store.find("research_memory_link", relationId)) {
        this.knowledgeRelations.retract({ relation_id: relationId, reason: "research node forgotten" });
        retracted.push(relationId);
      }
    }
    const current = this.store.get("knowledge_claim", id);
    this.store.save("knowledge_claim", id, { ...current, research_status: "forgotten", forgotten_at: new Date().toISOString() });
    const node = { kind: "knowledge_claim", id, version: Number(current.version) };
    return { node, status: "forgotten", retracted_relation_ids: retracted };
  }

  proposeReplicationProcedure(args: JsonObject): JsonObject {
    const id = text(args.id), title = text(args.title), sourceId = text(args.source_id);
    const steps = stringArray(args.steps);
    if (!id || !title || !sourceId || !steps.length) throw new Error("id, title, source_id and steps are required");
    const scope = object(args.scope);
    scopeKey(scope);
    const source = this.store.find("knowledge_claim", sourceId);
    if (source && !scopeMatches(researchScope(source), scope)) throw new Error("source node is not in scope");
    const existing = this.store.find("program_memory_candidate", id);
    if (existing && (text(existing.scenario_key) !== "research" || !scopeMatches(object(existing.scope), scope)))
      throw new Error("replication candidate identity conflict");
    const statement = `Replicate: ${title}`;
    const candidate = this.captureProgramMemory({
      id, scenario_key: "research", domain: "research", statement, steps,
      evidence_ids: stringArray(args.evidence_ids), scope,
    });
    const record: ReplicationCandidateRecord = {
      ...candidate as unknown as ProgramMemoryCandidate, replication_id: id,
      program_memory_id: String(candidate.id), title, source_id: sourceId,
    };
    return this.store.save("replication_candidate", id, record);
  }

  evalSummary(): JsonObject {
    const domains = DOMAIN_ADAPTER_NAMES.map((name) => {
      const cases = (DEFAULT_ADAPTERS[name].eval_case_ids ?? []).map((caseId) => ({ case_id: caseId, observed: false }));
      return { domain: name, cases };
    });
    return { schema: "craft.general-evolution-eval.v1", domains, quotable: false };
  }
}
