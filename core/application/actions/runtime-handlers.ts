import type { McpHandlerGroup, McpHandlerService } from "./handler-types.js";

export function createRuntimeHandlers(service: McpHandlerService): McpHandlerGroup {
  return {
    craft_runtime_policy_save: (a) => service.runtimePolicySave(a),
    craft_runtime_policy_get: (a) => service.get("runtime_policy", "runtime_policy_id", a),
    craft_runtime_policy_list: (a) => service.list("runtime_policy", "runtime_policies", a),
    craft_runtime_run_start: (a) => service.runtimeRunStart(a), craft_runtime_run_get: (a) => service.runtimeRunGet(a),
    craft_runtime_dispatch: (a) => service.runtimeDispatch(a), craft_runtime_operation_get: (a) => service.runtimeOperationGet(a),
    craft_runtime_operation_decision: (a) => service.runtimeOperationDecision(a),
    craft_runtime_operation_submit: (a) => service.runtimeOperationSubmit(a), craft_runtime_run_resume: (a) => service.runtimeRunResume(a),
    craft_runtime_lease_recover: (a) => service.runtimeLeaseRecover(a), craft_runtime_driver_tick: (a) => service.runtimeDriverTick(a),
    craft_runtime_promotion_eligibility: (a) => service.runtimePromotionEligibility(a),
    craft_runtime_adapter_save: (a) => service.runtimeAdapterSave(a),
    craft_runtime_adapter_get: (a) => service.get("runtime_adapter", "runtime_adapter_id", a),
    craft_runtime_adapter_list: (a) => service.list("runtime_adapter", "runtime_adapters", a),
    craft_runtime_adapter_dispatch: (a) => service.runtimeAdapterDispatch(a),
    craft_runtime_adapter_report: (a) => service.runtimeAdapterReport(a),
  };
}
