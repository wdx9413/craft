import { observedKernel } from "../../common/craft-common-log/src/index.ts";
import type { CraftCapability } from "../../common/craft-common-base/src/capability-protocol.ts";
import { CORE_KERNELS } from "../../common/craft-common-base/src/capability-protocol.ts";
import type { CraftStore } from "../../common/craft-common-store-local/src/store.ts";
import { CodebaseIndexKernel } from "./codebase-index.ts";
import { CODEBASE_OWNS } from "./ownership.ts";

/** The one kernel owned by the optional, read-only codebase Capability. */
export const CODEBASE_KERNELS = { index: "codebase.index" } as const;
export { CODEBASE_OWNS };

/**
 * Codebase is deliberately not a ContextContributionProvider. It supplies
 * snapshot-pinned references only when a caller explicitly queries it; it does
 * not make a sixth context member or inject source into any Host by default.
 */
export const codebaseCapability: CraftCapability = {
  name: "codebase",
  evaluation: { input_contract: "declared-workspace-checkpoint", output_contract: "snapshot-pinned-structural-references", fixture_id: "codebase-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
  owns: CODEBASE_OWNS,
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    registry.provide(CODEBASE_KERNELS.index, observedKernel(store, "codebase", new CodebaseIndexKernel(registry.require<CraftStore>(CORE_KERNELS.store))));
  },
};
