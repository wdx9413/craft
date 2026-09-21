import { SYSCALL_PASSTHROUGH, SYSCALL_VERBS } from "../../tool-plane.ts";
import type { Tool } from "../../mcp/tool-schema.ts";
import { EXPERIENCE_COMPONENT } from "../../../capability/craft-experience/ownership.ts";
import { KNOWLEDGE_COMPONENT, KNOWLEDGE_CONTEXT_SOURCE } from "../../../capability/craft-knowledge/ownership.ts";
import { MEMORY_COMPONENT, MEMORY_CONTEXT_SOURCE } from "../../../capability/craft-memory/ownership.ts";

// Tool surfaces are a bounded projection over the canonical tool catalog. The
// registry owns only names and matching rules; execution remains in McpServer.
const QUALITY_TOOLS = /^craft_(evaluation|eval|benchmark|campaign|judge|grader|grade|signoff|harness|trial|trajectory|experience|adaptation|adaptive|canary|acceptance|outcome|delivery_evaluation|agent_eval|verified_iteration|feedback|trace|verification)/;

export const SURFACE_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "governance", pattern: /^craft_(capability|source|logical|contract|hub|supply|federation|materialization|certification|skill|publication|catalog|domain|hook)/ },
  { name: "evaluation", pattern: QUALITY_TOOLS },
  { name: "execution", pattern: /^craft_(sandbox|docker|effect|egress|credential|execution|managed|platform|isolated|local|external|recovery|durable|trigger|webhook|orchestration|runtime|autonomy|speculative|web)/ },
  { name: "knowledge", pattern: /^craft_(wiki|knowledge|context|memory|project|semantic|claim|relation|turn)/ },
  { name: "workspace", pattern: /^craft_(workspace|work_object|change_set|state|transaction|lineage|hydration|dehydration|artifact|evidence|untrusted)/ },
  { name: "collaboration", pattern: /^craft_(a2a|enterprise|agent|expert|federated|attention|work_coordinator|home|decision|guided|strategy)/ },
  { name: "workflow", pattern: /^craft_/ },
];

/**
 * The tools a Host needs in order to *resolve* what a component stored.
 *
 * `context_resolution` and `retrieval_adapter` are the two verbs that turn stored material
 * into a bounded, reproducible context pack. They belong to the projections rather than to a
 * capability, because a Host that loads only one concern still has to be able to resolve the
 * material that concern holds. They are implemented by `src/context-resolution.ts`, which is in
 * the core for exactly that reason.
 */
const SHARED_CONTEXT_TOOLS = "craft_(?:context_resolution|decision_context_gate|retrieval_adapter)";

export const COMPONENT_SURFACES: Readonly<Record<string, RegExp>> = {
  // Context is the user-facing composition of governed knowledge, scoped memory, and
  // reproducible context selection. Narrow legacy projections remain available for Hosts that
  // deliberately want only one concern. It composes the *frozen* knowledge name space rather
  // than the knowledge product's, because adding a family here would change what an existing
  // Host sees; `ownership.ts` records which is which and why.
  "component-context": new RegExp(`^(?:${KNOWLEDGE_CONTEXT_SOURCE}|${MEMORY_CONTEXT_SOURCE})`),
  // Quality is subject-agnostic: a Skill is only one possible Subject. Keep the prior name as
  // an exact compatibility alias for existing installs.
  "component-quality": QUALITY_TOOLS,
  // Knowledge is owned by `capability/craft-knowledge`, which declares `owns` and this
  // projection in `ownership.ts`. The projection is deliberately the broad name space, not the
  // narrower ownership list: a Host loading the Knowledge product expects `craft_knowledge_*`
  // even where the facade still implements it.
  "component-knowledge": KNOWLEDGE_COMPONENT,
  // Memory is owned by `capability/craft-memory`, which declares both `owns` and this projection
  // in `ownership.ts`. Its projection is wider than its ownership in two directions: the derived
  // signals the facade still implements, and the Knowledge Source bootstrap verbs — because a
  // memory entry's provenance *is* a Source, so a Host that loads only Memory still has to
  // register the Source its entries cite.
  "component-memory": MEMORY_COMPONENT,
  "component-capability": /^craft_(source|capability|logical|semantic)/,
  "component-skill-quality": QUALITY_TOOLS,
  // Experience is owned by `capability/craft-experience`, which declares both `owns` and this
  // projection in `ownership.ts`; the projection adds the experience families a separate
  // kernel implements but the same product serves. The shared context verbs are not part of
  // it: experience is not resolved through the context plane.
  "component-experience": EXPERIENCE_COMPONENT,
};

/**
 * The public component products are intentionally smaller than their advanced
 * compatibility surfaces.  A standalone Host should see the repeatable daily
 * path first, rather than several dozen lifecycle and diagnostic operations.
 * Advanced callers may still select `component-*` explicitly.
 */
const DAILY_COMPONENT_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "component-knowledge-daily": [
    "craft_component_readiness_get", "craft_component_diagnose", "craft_knowledge_bootstrap_install", "craft_knowledge_source_list",
    "craft_knowledge_source_register", "craft_knowledge_source_ingest", "craft_evidence_record", "craft_knowledge_search", "craft_knowledge_claim_get", "craft_knowledge_promotion_policy_get", "craft_knowledge_host_review", "craft_knowledge_support_record", "craft_knowledge_auto_review",
    "craft_knowledge_claim_save", "craft_context_resolution_resolve", "craft_knowledge_memory_bundle",
  ],
  "component-memory-daily": [
    "craft_component_readiness_get", "craft_component_diagnose", "craft_knowledge_bootstrap_install", "craft_knowledge_source_list",
    "craft_memory_capture_user_statement", "craft_memory_candidate_propose", "craft_memory_candidate_review", "craft_memory_ledger_remember_approved",
    "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_conflict_list", "craft_memory_conflict_resolve",
    "craft_context_resolution_resolve", "craft_memory_maintenance_run", "craft_memory_maintenance_schedule", "craft_knowledge_memory_bundle",
  ],
  "component-experience-daily": [
    "craft_component_readiness_get", "craft_component_diagnose", "craft_evidence_record", "craft_experience_observe",
    "craft_experience_patterns_list", "craft_experience_procedure_draft", "craft_experience_procedure_submit", "craft_experience_procedure_get",
    "craft_procedure_create", "craft_procedure_get", "craft_procedure_list", "craft_procedure_gate", "craft_procedure_export_skill",
  ],
};

export const COMPONENT_SURFACE_NAMES: readonly string[] = Object.keys(COMPONENT_SURFACES);
export const DOMAIN_SURFACE_NAMES: readonly string[] = SURFACE_RULES.map((rule) => rule.name);
export const SURFACE_NAMES: readonly string[] = ["core", ...DOMAIN_SURFACE_NAMES, ...COMPONENT_SURFACE_NAMES, "syscall", "full"];

export type MountedComponent = "knowledge" | "memory" | "experience";

export function componentForSurface(surface: string): MountedComponent | undefined {
  if (surface === "component-knowledge" || surface === "component-knowledge-daily") return "knowledge";
  if (surface === "component-memory" || surface === "component-memory-daily") return "memory";
  if (surface === "component-experience" || surface === "component-experience-daily") return "experience";
  return undefined;
}

export function domainSurfaceOf(toolName: string): string {
  return SURFACE_RULES.find((rule) => rule.pattern.test(toolName))?.name ?? "workflow";
}

export function surfaceToolNames(surface: string, activeTools: readonly Tool[], coreToolNames: ReadonlySet<string>): string[] {
  if (surface === "full") return activeTools.map((tool) => tool.name);
  if (surface === "core") return activeTools.filter((tool) => coreToolNames.has(tool.name)).map((tool) => tool.name);
  if (surface === "syscall") return [...SYSCALL_VERBS, ...SYSCALL_PASSTHROUGH];
  const daily = DAILY_COMPONENT_TOOLS[surface];
  if (daily) return daily.filter((name) => activeTools.some((tool) => tool.name === name));
  const component = COMPONENT_SURFACES[surface];
  if (component) return activeTools.filter((tool) => tool.name === "craft_info" || component.test(tool.name)).map((tool) => tool.name);
  if (!SURFACE_RULES.some((rule) => rule.name === surface)) throw new Error(`Unknown Craft MCP surface: ${surface}`);
  return activeTools.filter((tool) => !coreToolNames.has(tool.name) && domainSurfaceOf(tool.name) === surface).map((tool) => tool.name);
}
