import { SYSCALL_PASSTHROUGH, SYSCALL_VERBS } from "../../tool-plane.ts";
import type { Tool } from "./tool-schema.ts";

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

export const COMPONENT_SURFACES: Readonly<Record<string, RegExp>> = {
  // Context is the user-facing composition of governed knowledge, scoped
  // memory, and reproducible context selection. Narrow legacy projections
  // remain available for Hosts that deliberately want only one concern.
  "component-context": /^craft_(wiki|knowledge|claim|relation|memory|context_resolution|retrieval_adapter)/,
  // Quality is subject-agnostic: a Skill is only one possible Subject. Keep
  // the prior name as an exact compatibility alias for existing installs.
  "component-quality": QUALITY_TOOLS,
  "component-knowledge": /^craft_(wiki|knowledge|claim|relation|context_resolution|retrieval_adapter)/,
  // Memory entries must retain their explicit source provenance. The bootstrap
  // only registers Craft-owned descriptors, so it belongs to this bounded
  // surface as well as Knowledge without granting external reads.
  "component-memory": /^craft_(memory|knowledge_source|knowledge_bootstrap|context_resolution|retrieval_adapter)/,
  "component-capability": /^craft_(source|capability|logical|semantic)/,
  "component-skill-quality": QUALITY_TOOLS,
  "component-workflow-evolution": /^craft_(workflow_evolution|evaluation_model|experience_mine|experience_candidate|experience_shadow|route_workflow_proposal|workflow_(?:save|get|search|transition|rollback|dag_validate|dag_save|dag_transition|checkpoint|resume|run_cancel|replan|export|import))/,
};

export const COMPONENT_SURFACE_NAMES: readonly string[] = Object.keys(COMPONENT_SURFACES);
export const DOMAIN_SURFACE_NAMES: readonly string[] = SURFACE_RULES.map((rule) => rule.name);
export const SURFACE_NAMES: readonly string[] = ["core", ...DOMAIN_SURFACE_NAMES, ...COMPONENT_SURFACE_NAMES, "syscall", "full"];

export function domainSurfaceOf(toolName: string): string {
  return SURFACE_RULES.find((rule) => rule.pattern.test(toolName))?.name ?? "workflow";
}

export function surfaceToolNames(surface: string, activeTools: readonly Tool[], coreToolNames: ReadonlySet<string>): string[] {
  if (surface === "full") return activeTools.map((tool) => tool.name);
  if (surface === "core") return activeTools.filter((tool) => coreToolNames.has(tool.name)).map((tool) => tool.name);
  if (surface === "syscall") return [...SYSCALL_VERBS, ...SYSCALL_PASSTHROUGH];
  const component = COMPONENT_SURFACES[surface];
  if (component) return activeTools.filter((tool) => tool.name === "craft_info" || component.test(tool.name)).map((tool) => tool.name);
  if (!SURFACE_RULES.some((rule) => rule.name === surface)) throw new Error(`Unknown Craft MCP surface: ${surface}`);
  return activeTools.filter((tool) => !coreToolNames.has(tool.name) && domainSurfaceOf(tool.name) === surface).map((tool) => tool.name);
}
