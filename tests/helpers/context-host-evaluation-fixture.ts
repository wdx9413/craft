import type { CraftService } from "../../core/service.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import { stableDigest } from "../../core/digest.ts";
import { contextAssetKey } from "../../common/craft-common-base/src/context-assets.ts";

/** Public preparation creates an actual TaskRun, HostSession and Context Open without starting a Host. */
export async function prepareContextEvaluationRun(service: CraftService, root: string, id: string, environment: JsonObject = {}, budget: JsonObject = {}): Promise<JsonObject> {
  const identity = service.scopeIdentityResolveProject({ project_root: root }).identity as JsonObject;
  const scope = identity.canonical_scope as JsonObject;
  const task = service.taskOpen({ title: "Context evaluation", goal: "Verify exact Context binding", project_id: scope.id }).task as JsonObject;
  const control = service.taskControlSave({ task_id: task.id, workspace: root, allowed_effects: ["read_only"] }).contract as JsonObject;
  const prepared = service.taskRunPrepare({ task_run_id: id, contract_id: control.id, host: "codex-cli", workspace: root, prompt: "fixture context", sandbox: "read-only", defer_host_start: true, environment, budget });
  service.hostSessionOpen({ session_id: id, task_id: task.id, host_id: "codex-cli", environment_fingerprint: "fixture", policy_fingerprint: "fixture", capability_fingerprint: "schema", model_fingerprint: "model" });
  const context = await service.contextOpen({ project_root: root, include_codebase: false, query: "fixture context", task_id: task.id, session_id: id, turn_id: id });
  const pack = context.pack_receipt as JsonObject;
  const refs = (pack.asset_refs as JsonObject[]).map(contextAssetKey);
  return { task_run: prepared.task_run, task_id: task.id, host_session_id: id, host_id: "codex-cli", receipt_id: pack.id, scope: `${scope.kind}:${scope.id}`, available_refs: refs, available_refs_digest: stableDigest(refs), emitted_refs: refs, emission_digest: "fixture-prompt", injected_tokens: 12, schema_tokens: 100, history_tokens: 80, latency_ms: 3 };
}
