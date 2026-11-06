import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";
import { ComponentReadinessKernel, type ComponentName } from "../../component-readiness.ts";

/**
 * Quality-profile and first-run proof use cases.
 *
 * This is the seam between the stable CraftService facade and the deep domain
 * modules that own evaluation, activation evidence and historical migration.
 * The facade keeps the established method names; new quality behaviour belongs
 * in those kernels or here, never as another method body in CraftService.
 */
declare module "../craft-service.ts" {
  interface CraftService {
    componentReadinessGet(args: JsonObject, mountedComponent?: ComponentName): JsonObject;
    componentDiagnose(args: JsonObject, mountedComponent?: ComponentName): JsonObject;
    activationProofDoctor(args?: JsonObject): JsonObject;
    activationProofRecord(args: JsonObject): JsonObject;
    componentHistoryKnowledgeReviewedMigrate(args?: JsonObject): JsonObject;
    componentHistoryExperienceMigrate(args?: JsonObject): JsonObject;
    engineeringQualityProfileInstall(): JsonObject;
    engineeringQualityProfileCaseSave(args: JsonObject): JsonObject;
    engineeringQualityProfileActivate(args: JsonObject): JsonObject;
    engineeringQualityProfileTrialContext(args: JsonObject): JsonObject;
    engineeringQualityProfileContribution(args: JsonObject): JsonObject;
    engineeringQualityProfileReviewAggregate(args: JsonObject): JsonObject;
    engineeringQualityProfileEvaluationPlan(args: JsonObject): JsonObject;
    engineeringQualityProfileEvaluationRecord(args: JsonObject): JsonObject;
    engineeringQualityProfileEvaluationReceiptRecord(args: JsonObject): JsonObject;
    engineeringQualityProfileVerifiedReceiptImport(args: JsonObject): JsonObject;
    engineeringQualityProfileEvaluationEvaluate(args: JsonObject): JsonObject;
    engineeringQualityProfileEvaluationGet(args: JsonObject): JsonObject;
  }
}

export function installQualityProfileMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.componentReadinessGet = function (args, mountedComponent) { return new ComponentReadinessKernel(this.store).get(args, mountedComponent); };
  serviceClass.prototype.componentDiagnose = function (args, mountedComponent) { return new ComponentReadinessKernel(this.store).diagnose(args, mountedComponent); };
  serviceClass.prototype.activationProofDoctor = function (args = {}) { return this.activationProof.doctor(args); };
  serviceClass.prototype.activationProofRecord = function (args) { return this.activationProof.record(args); };
  serviceClass.prototype.componentHistoryKnowledgeReviewedMigrate = function (args = {}) { return this.componentHistoryMigration.knowledgeReviewed(args); };
  serviceClass.prototype.componentHistoryExperienceMigrate = function (args = {}) { return this.componentHistoryMigration.experienceWorkflowEvolution(args); };
  serviceClass.prototype.engineeringQualityProfileInstall = function () { return this.engineeringQualityProfile.install(); };
  serviceClass.prototype.engineeringQualityProfileCaseSave = function (args) { return this.engineeringQualityProfile.caseSave(args); };
  serviceClass.prototype.engineeringQualityProfileActivate = function (args) { return this.engineeringQualityProfile.activate(args); };
  serviceClass.prototype.engineeringQualityProfileTrialContext = function (args) { return this.engineeringQualityProfile.trialContext(args); };
  serviceClass.prototype.engineeringQualityProfileContribution = function (args) { return this.engineeringQualityProfile.contribute(args); };
  serviceClass.prototype.engineeringQualityProfileReviewAggregate = function (args) { return this.engineeringQualityProfile.reviewAggregate(args); };
  serviceClass.prototype.engineeringQualityProfileEvaluationPlan = function (args) { return this.engineeringQualityProfile.evaluationPlan(args); };
  serviceClass.prototype.engineeringQualityProfileEvaluationRecord = function (args) { return this.engineeringQualityProfile.evaluationRecord(args); };
  serviceClass.prototype.engineeringQualityProfileEvaluationReceiptRecord = function (args) { return this.engineeringQualityProfile.evaluationReceiptRecord(args); };
  serviceClass.prototype.engineeringQualityProfileVerifiedReceiptImport = function (args) { return this.engineeringQualityProfile.evaluationVerifiedReceiptImport(args); };
  serviceClass.prototype.engineeringQualityProfileEvaluationEvaluate = function (args) { return this.engineeringQualityProfile.evaluationEvaluate(args); };
  serviceClass.prototype.engineeringQualityProfileEvaluationGet = function (args) { return this.engineeringQualityProfile.evaluationGet(args); };
}
