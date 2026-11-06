import type { CraftStore } from "../../infrastructure/store.ts";
import type { DeliveryLoopKernel } from "../../delivery-loop.ts";
import type { TaskControlKernel } from "../../task-control.ts";
import type { TaskRunKernel } from "../../task-run.ts";
import type { VerifiedWorkLoopKernel } from "../../verified-work-loop.ts";
import type { WorkDeliveryKernel } from "../../work-delivery.ts";
import type { WorkSessionKernel } from "../../work-session.ts";

/** Application-owned Work context. Domain kernels remain the behavior owners. */
export class WorkCoordinator {
  readonly store: CraftStore;
  readonly taskControl: TaskControlKernel;
  readonly taskRuns: TaskRunKernel;
  readonly verifiedWorkLoops: VerifiedWorkLoopKernel;
  readonly workDelivery: WorkDeliveryKernel;
  readonly deliveryLoop: DeliveryLoopKernel;
  readonly workSessions: WorkSessionKernel;
  constructor(
    store: CraftStore, taskControl: TaskControlKernel, taskRuns: TaskRunKernel,
    verifiedWorkLoops: VerifiedWorkLoopKernel, workDelivery: WorkDeliveryKernel,
    deliveryLoop: DeliveryLoopKernel, workSessions: WorkSessionKernel,
  ) {
    this.store = store; this.taskControl = taskControl; this.taskRuns = taskRuns;
    this.verifiedWorkLoops = verifiedWorkLoops; this.workDelivery = workDelivery;
    this.deliveryLoop = deliveryLoop; this.workSessions = workSessions;
  }
}
