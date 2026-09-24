import type { CraftStore } from "../../infrastructure/store.ts";
import type { ChangeSetKernel } from "../../changeset.ts";
import type { HydrationKernel } from "../../hydration.ts";
import type { LineageKernel } from "../../lineage.ts";
import type { ProjectBrainKernel } from "../../../capability/craft-knowledge/project-brain.ts";
import type { StateWorkspaceKernel } from "../../state-workspace.ts";
import type { TransactionCoordinator } from "../../transaction.ts";
import type { WorkspaceObserverKernel } from "../../workspace-observer.ts";
import type { WorkspaceState } from "../../workspace.ts";
import type { WorkbenchKernel } from "../../workbench.ts";

/** Application-owned Workspace context for state, artifacts and recovery. */
export class WorkspaceCoordinator {
  readonly store: CraftStore;
  readonly workspace: WorkspaceState;
  readonly transaction: TransactionCoordinator;
  readonly workbench: WorkbenchKernel;
  readonly stateWorkspace: StateWorkspaceKernel;
  readonly workspaceObserver: WorkspaceObserverKernel;
  readonly changeSets: ChangeSetKernel;
  readonly projectBrain: ProjectBrainKernel;
  readonly lineage: LineageKernel;
  readonly hydration: HydrationKernel;
  constructor(
    store: CraftStore, workspace: WorkspaceState, transaction: TransactionCoordinator,
    workbench: WorkbenchKernel, stateWorkspace: StateWorkspaceKernel,
    workspaceObserver: WorkspaceObserverKernel, changeSets: ChangeSetKernel,
    projectBrain: ProjectBrainKernel, lineage: LineageKernel, hydration: HydrationKernel,
  ) {
    this.store = store; this.workspace = workspace; this.transaction = transaction;
    this.workbench = workbench; this.stateWorkspace = stateWorkspace;
    this.workspaceObserver = workspaceObserver; this.changeSets = changeSets;
    this.projectBrain = projectBrain; this.lineage = lineage; this.hydration = hydration;
  }
}
