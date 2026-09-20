import type { CraftService } from "../craft-service.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

/** Thin application delegate: policy belongs to the domain kernel, not the facade. */
export function installKnowledgeAutoReviewMethods(serviceClass: typeof CraftService): void {
  serviceClass.prototype.knowledgeAutoReview = function (args = {}) { return this.knowledgeAutoReviewKernel.assess(args); };
  serviceClass.prototype.knowledgePromotionPolicyGet = function () { return this.knowledgeAutoReviewKernel.policyGet(); };
  serviceClass.prototype.knowledgePromotionPolicySave = function (args) { return this.knowledgeAutoReviewKernel.policySave(args); };
  serviceClass.prototype.knowledgeClaimSupportRecord = function (args) { return this.knowledgeAutoReviewKernel.supportRecord(args); };
  serviceClass.prototype.knowledgeHostReview = function (args) { return this.knowledgeAutoReviewKernel.hostReview(args); };
}
