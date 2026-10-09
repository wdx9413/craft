/**
 * The Memory capability.
 *
 * Memory is the accumulated context member gated by **explicit approval**. Where knowledge is
 * gated by Evidence — a claim carries the Evidence that backs it — a memory entry additionally
 * answers "whose memory is this, and may it be recalled here": it carries a scope, a
 * sensitivity, a validity window and the Knowledge Source version it came from. `MemoryContribution`
 * enforces that scope, refuses `restricted` entries unless the caller asks for them, drops an
 * expired entry, and refuses a Source that is not active or is `untrusted`.
 *
 * That gate is why the member exists separately from knowledge, and it is why the tools this
 * package implements are the Ledger's writes plus the signals derived from recall history.
 * Candidate reading belongs here; cross-member selection belongs to Context.
 *
 * | kernel | what it holds |
 * |---|---|
 * | `memory-ledger` | `remember`, `transition`, `compatBind`, `get` — content-addressed, Source-pinned, Evidence-checked entries |
 * | `memory-governance` | consent policy, candidate review, conflict selection, approved commit, topic suggestions and confirmations |
 * | `memory-signals` | `memoryDecayWeight`, `rankWithDecay`, `shouldProposeMemory`, `planLegacyPromotion`, `hybridMemoryScores`, `memoryUsageEvidence` — pure functions over recall history |
 *
 * One thing that is **not** here, recorded rather than left to be discovered:
 * `MemoryConsolidationKernel` (`craft_memory_consolidate` / `_resolve` / `_search` /
 * `_remember_episode`) is a separate kernel in the core. It turns episodic entries into a
 * versioned semantic one — a different operation on the same member, and a plausible next kernel
 * for this package. Until it moves, those four families are projected by the product and not
 * claimed as ownership.
 *
 * `MemoryContribution` owns candidate eligibility and read snapshots. Context combines
 * those candidates with other members using its shared retrieval, budget and receipt.
 */
import type { CraftCapability } from "../../common/craft-common-base/src/capability-protocol.ts";
import { CORE_KERNELS } from "../../common/craft-common-base/src/capability-protocol.ts";
import type { CraftStore } from "../../common/craft-common-store-local/src/store.ts";
import { MemoryContribution } from "./contribution.ts";
import { MemoryGovernanceKernel } from "./memory-governance.ts";
import { MemoryLedgerKernel } from "./memory-ledger.ts";
import { MemorySignalsKernel } from "./memory-signals-kernel.ts";
import { MEMORY_OWNS } from "./ownership.ts";

/** Kernel names this capability registers, and the core requires back. */
export const MEMORY_KERNELS = { ledger: "memory.ledger", signals: "memory.signals", governance: "memory.governance" } as const;

/** Tool families this capability implements. Declared in `ownership.ts` beside the projection. */
export { MEMORY_OWNS };

export const memoryCapability: CraftCapability = {
  name: "memory",
  product: "craft-memory",
  evaluation: { input_contract: "scoped-memory-request", output_contract: "bounded-memory-ledger-result", fixture_id: "memory-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
  owns: MEMORY_OWNS,
  contributes: registry => new MemoryContribution(registry.require<CraftStore>(CORE_KERNELS.store)),
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    const ledger = new MemoryLedgerKernel(store);
    registry.provide(MEMORY_KERNELS.ledger, ledger);
    registry.provide(MEMORY_KERNELS.governance, new MemoryGovernanceKernel(store, ledger));
    registry.provide(MEMORY_KERNELS.signals, new MemorySignalsKernel(store));
  },
};
