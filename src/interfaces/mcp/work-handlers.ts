import type { McpHandlerGroup, McpHandlerService } from "./handler-types.js";

export function createWorkHandlers(service: McpHandlerService): McpHandlerGroup {
  return {
    craft_task_control_refresh: (a) => service.taskControlRefresh(a), craft_task_control_get: (a) => service.taskControlGet(a), craft_task_control_handoff: (a) => service.taskControlHandoff(a),
    craft_task_run_prepare: (a) => service.taskRunPrepare(a), craft_task_run_refresh: (a) => service.taskRunRefresh(a), craft_task_run_get: (a) => service.taskRunGet(a),
    craft_task_run_pause: (a) => service.taskRunPause(a), craft_task_run_resume: (a) => service.taskRunResume(a), craft_task_run_cancel: (a) => service.taskRunCancel(a), craft_task_run_handoff: (a) => service.taskRunHandoff(a),
    craft_verified_work_loop_prepare: (a) => service.verifiedWorkLoopPrepare(a), craft_verified_work_loop_advance: (a) => service.verifiedWorkLoopAdvance(a), craft_verified_work_loop_decide: (a) => service.verifiedWorkLoopDecide(a), craft_verified_work_loop_resume: (a) => service.verifiedWorkLoopResume(a), craft_verified_work_loop_get: (a) => service.verifiedWorkLoopGet(a),
    craft_host_activation_manifest_prepare: service.hostActivationManifestPrepare.bind(service), craft_host_activation_manifest_validate: service.hostActivationManifestValidate.bind(service), craft_host_activation_manifest_consume: service.hostActivationManifestConsume.bind(service), craft_host_activation_manifest_get: service.hostActivationManifestGet.bind(service),
    craft_execution_fabric_prepare: service.executionFabricPrepare.bind(service), craft_execution_fabric_execute: service.executionFabricExecute.bind(service), craft_execution_fabric_advance: service.executionFabricAdvance.bind(service), craft_execution_fabric_consume: service.executionFabricConsume.bind(service), craft_execution_fabric_get: service.executionFabricGet.bind(service), craft_host_bridge_get: service.hostBridgeGet.bind(service),
    craft_state_workspace_observe: (a) => service.stateWorkspaceObserve(a), craft_state_workspace_compare: (a) => service.stateWorkspaceCompare(a),
    craft_workspace_observer_observe: (a) => service.workspaceObserverObserve(a), craft_workspace_observer_get: (a) => service.workspaceObserverGet(a), craft_autonomy_ladder_decide: (a) => service.autonomyLadderDecide(a), craft_autonomy_ladder_get: (a) => service.autonomyLadderGet(a), craft_work_coordinator_prepare: (a) => service.workCoordinatorPrepare(a), craft_work_coordinator_attach_host_run: (a) => service.workCoordinatorAttachHostRun(a), craft_work_coordinator_observe: (a) => service.workCoordinatorObserve(a), craft_work_coordinator_handoff: (a) => service.workCoordinatorHandoff(a), craft_work_coordinator_get: (a) => service.workCoordinatorGet(a),
    craft_work_launch_prepare: (a) => service.workLaunchPrepare(a), craft_work_launch_decide: (a) => service.workLaunchDecide(a), craft_work_launch_get: (a) => service.workLaunchGet(a), craft_work_launch_retry: (a) => service.workLaunchRetry(a),
    craft_work_delivery_observe: (a) => service.workDeliveryObserve(a), craft_work_delivery_get: (a) => service.workDeliveryGet(a),
  };
}
