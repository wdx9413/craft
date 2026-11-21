import { McpServer } from "../../core/mcp.ts";
import { openCapabilityService } from "../../core/interfaces/mcp/runtime.ts";
import { presentStorageOwners } from "../../core/infrastructure/owned-catalog.ts";
import { craftPaths, dataRoot } from "../../core/infrastructure/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

/** Local Worker calls retain the same public tool allowlist and argument checks as MCP calls. */
export async function openOwnedLearningClients(env: NodeJS.ProcessEnv = process.env) {
  const owners = presentStorageOwners(craftPaths(dataRoot(env)).root);
  const runtimes = new Map<string, Awaited<ReturnType<typeof openCapabilityService>>>();
  const servers = new Map<string, McpServer>();
  try {
    for (const owner of owners) {
      if (!["context", "experience", "knowledge", "eval", "runtime"].includes(owner)) continue;
      const runtime = await openCapabilityService(owner, env);
      runtimes.set(owner, runtime); servers.set(owner, new McpServer(runtime.service, owner === "experience" || owner === "knowledge" ? `component-${owner}-worker` : runtime.mode));
    }
    const configured: unknown = env.CRAFT_LEARNING_PROJECT_SCOPES ? JSON.parse(env.CRAFT_LEARNING_PROJECT_SCOPES) : [];
    if (!Array.isArray(configured) || configured.some(scope => !scope || typeof scope !== "object" || scope.kind !== "project"
      || typeof scope.id !== "string" || !scope.id.startsWith("project:"))) throw new Error("LearningProjectScopeConfigurationError");
    const projectScopes = configured as Array<{ kind: string; id: string }>;
    let sequence = 0;
    const forOwner = (fallback: string) => ({ async call(name: string, args: JsonObject = {}): Promise<JsonObject> {
      const owner = name.startsWith("craft_trace_") ? "runtime" : name.startsWith("craft_evaluation_contract_") ? "eval"
        : name.startsWith("craft_knowledge_") ? "knowledge"
        : name.startsWith("craft_experience_") ? "experience"
        : name.startsWith("craft_evolution_") || name.startsWith("craft_learning_cycle_") ? "context" : fallback;
      const experience = runtimes.get("experience")?.service;
      if (experience && name === "craft_experience_learning_evaluation_dispatch_list") {
        const pending = experience.experienceLearningEvaluationList(args).dispatches as JsonObject[];
        for (const scope of projectScopes) {
          const scoped = experience.experienceLearningEvaluationList({ ...args, program_memory_scope_id: scope.id }).dispatches as JsonObject[];
          for (const dispatch of scoped) {
            const procedure = experience.store.get("experience_procedure", String(dispatch.procedure_id));
            const binding = experience.store.find("program_memory_procedure_binding", String(procedure.request_id));
            if ((binding?.scope as JsonObject | undefined)?.id === scope.id) pending.push({ ...dispatch,
              evaluation_design_ref: { kind: "evaluation_contract", id: binding!.design_id, digest: binding!.design_digest },
              candidate_ref: { kind: "experience_procedure", id: procedure.id, version: procedure.candidate_version, digest: procedure.definition_digest } });
          }
        }
        const dispatches = [...new Map(pending.map(item => [item.id, item])).values()];
        return { dispatches, count: dispatches.length };
      }
      if (experience && (name === "craft_experience_learning_evaluation_run" || name === "craft_experience_learning_evaluation_result")) {
        const dispatch = experience.store.find("experience_evaluation_dispatch", String(args.dispatch_id));
        const procedure = dispatch ? experience.store.find("experience_procedure", String(dispatch.procedure_id)) : null;
        const binding = procedure ? experience.store.find("program_memory_procedure_binding", String(procedure.request_id)) : null;
        if (binding) {
          const scope = binding.scope as JsonObject;
          if (!projectScopes.some(project => project.id === scope.id)) throw new Error("LearningProjectScopeForbidden");
          const bound = { ...args, program_memory_scope_id: scope.id };
          return name.endsWith("_run") ? experience.experienceLearningEvaluationRun(bound) : experience.experienceLearningEvaluationResult(bound);
        }
      }
      const server = servers.get(owner);
      if (!server) throw new Error("LearningOwnerUnavailable");
      const reply = await server.handle({ jsonrpc: "2.0", id: ++sequence, method: "tools/call", params: { name, arguments: args } });
      if (!reply || reply.error) throw new Error("LearningToolUnavailable");
      const result = reply.result as JsonObject;
      if (result.isError === true) throw new Error("LearningToolRejected");
      return result.structuredContent as JsonObject;
    } });
    return { context: forOwner("context"), experience: forOwner("experience"), knowledge: forOwner("knowledge"),
      hasContext: servers.has("context"), close() { for (const runtime of runtimes.values()) runtime.close(); } };
  } catch (error) { for (const runtime of runtimes.values()) runtime.close(); throw error; }
}
