import type { CraftService } from "../craft-service.ts";

export function installRuntimeLearningMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.traceReview = function (args) { return this.traceReviews.review(args); };
  serviceClass.prototype.traceReviewGet = function (args) { return this.traceReviews.get(args); };
  serviceClass.prototype.traceReviewList = function (args = {}) { return this.traceReviews.list(args); };
  serviceClass.prototype.memoryMaintenanceRun = function (args = {}) { return this.memoryMaintenance.run(args); };
  serviceClass.prototype.memoryMaintenanceSignal = function (args) { return this.memoryMaintenance.signal(args); };
  serviceClass.prototype.memoryMaintenanceCycle = function (args = {}) { return this.memoryMaintenance.cycle(args); };
  serviceClass.prototype.memoryMaintenanceGet = function (args) { return this.memoryMaintenance.get(args); };
}
