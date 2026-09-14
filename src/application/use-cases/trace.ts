import type { CraftService } from "../craft-service.ts";

export function installTraceMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.traceStart = function (args) { return this.trace.start(args); };
  serviceClass.prototype.traceAppend = function (args) { return this.trace.append(args); };
  serviceClass.prototype.traceObserve = function (args) { return this.trace.observe(args); };
  serviceClass.prototype.traceFeedback = function (args) { return this.trace.feedback(args); };
  serviceClass.prototype.traceFinalize = function (args) { return this.trace.finalize(args); };
  serviceClass.prototype.traceGet = function (args) { return this.trace.get(args); };
  serviceClass.prototype.traceQuery = function (args = {}) { return this.trace.query(args); };
  serviceClass.prototype.traceReplayBundle = function (args) { return this.trace.replayBundle(args); };
  serviceClass.prototype.traceCaseCompile = function (args) { return this.trace.compileCase(args); };
  serviceClass.prototype.traceRetentionPlan = function (args) { return this.trace.retentionPlan(args); };
  serviceClass.prototype.traceRetentionSweep = function (args = {}) { return this.trace.retentionSweep(args); };
}
