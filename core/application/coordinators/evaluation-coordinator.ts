import type { CraftStore } from "../../infrastructure/store.ts";
import type { AcceptanceGateKernel, ProviderRouterKernel } from "../../runtime-completion.ts";
import type { EvalCampaignKernel } from "../../eval-campaign.ts";
import type { EvaluationModelProfileKernel } from "../../../capability/craft-experience/evaluation-model-profile.ts";
import type { EvaluationOperationsKernel } from "../../evaluation-operations.ts";
import type { CostLedgerKernel } from "../../cost-ledger.ts";
import type { DomainEvaluatorKernel } from "../../domain-evaluator.ts";
import type { FeedbackLearningKernel } from "../../feedback-learning.ts";
import type { TaskBenchmarkKernel } from "../../task-benchmark.ts";
import type { CampaignRunnerKernel } from "../../campaign-runner.ts";

/** Application-owned Evaluation context; no evaluation policy is duplicated here. */
export class EvaluationCoordinator {
  readonly store: CraftStore;
  readonly evalCampaigns: EvalCampaignKernel;
  readonly evaluationOperations: EvaluationOperationsKernel;
  readonly acceptanceGates: AcceptanceGateKernel;
  readonly domainEvaluators: DomainEvaluatorKernel;
  readonly evaluationModelProfiles: EvaluationModelProfileKernel;
  readonly taskBenchmarks: TaskBenchmarkKernel;
  readonly campaignRunners: CampaignRunnerKernel;
  readonly feedbackLearning: FeedbackLearningKernel;
  readonly costLedger: CostLedgerKernel;
  readonly providerRouter: ProviderRouterKernel;
  constructor(
    store: CraftStore, evalCampaigns: EvalCampaignKernel, evaluationOperations: EvaluationOperationsKernel,
    acceptanceGates: AcceptanceGateKernel, domainEvaluators: DomainEvaluatorKernel,
    evaluationModelProfiles: EvaluationModelProfileKernel, taskBenchmarks: TaskBenchmarkKernel,
    campaignRunners: CampaignRunnerKernel, feedbackLearning: FeedbackLearningKernel,
    costLedger: CostLedgerKernel, providerRouter: ProviderRouterKernel,
  ) {
    this.store = store; this.evalCampaigns = evalCampaigns; this.evaluationOperations = evaluationOperations;
    this.acceptanceGates = acceptanceGates; this.domainEvaluators = domainEvaluators;
    this.evaluationModelProfiles = evaluationModelProfiles; this.taskBenchmarks = taskBenchmarks;
    this.campaignRunners = campaignRunners; this.feedbackLearning = feedbackLearning;
    this.costLedger = costLedger; this.providerRouter = providerRouter;
  }
}
