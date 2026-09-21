/**
 * The Memory capability.
 *
 * Memory is the accumulated context member gated by **explicit approval**. Where knowledge is
 * gated by Evidence — a claim carries the Evidence that backs it — a memory entry additionally
 * answers "whose memory is this, and may it be recalled here": it carries a scope, a
 * sensitivity, a validity window and the Knowledge Source version it came from. `resolve`
 * enforces that scope, refuses `restricted` entries unless the caller asks for them, drops an
 * expired entry, and refuses a Source that is not active or is `untrusted`.
 *
 * That gate is why the member exists separately from knowledge, and it is why the tools this
 * package implements are the Ledger's writes plus the signals derived from recall history.
 * Reading is the shared context plane, which belongs to no capability.
 *
 * | kernel | what it holds |
 * |---|---|
 * | `memory-ledger` | `remember`, `transition`, `compatBind`, `get` — content-addressed, Source-pinned, Evidence-checked entries |
 * | `memory-signals` | `memoryDecayWeight`, `rankWithDecay`, `shouldProposeMemory`, `planLegacyPromotion`, `hybridMemoryScores`, `memoryUsageEvidence` — pure functions over recall history |
 *
 * One thing that is **not** here, recorded rather than left to be discovered:
 * `MemoryConsolidationKernel` (`craft_memory_consolidate` / `_resolve` / `_search` /
 * `_remember_episode`) is a separate kernel in the core. It turns episodic entries into a
 * versioned semantic one — a different operation on the same member, and a plausible next kernel
 * for this package. Until it moves, those four families are projected by the product and not
 * claimed as ownership.
 *
 * It declares no `contributes`: the read side is `ContextResolutionKernel`, which takes a query
 * and returns a bounded pack. Knowledge and Experience do provide their distinct read
 * projections; declaring a second Memory provider here would give the same member two contributors, which
 * `buildCapabilityRegistry` rejects outright.
 */
import type { CraftCapability } from "../../src/capability-protocol.ts";
import { CORE_KERNELS } from "../../src/capability-protocol.ts";
import type { CraftStore } from "../../src/infrastructure/store.ts";
import { MemoryLedgerKernel } from "./memory-ledger.ts";
import { MemorySignalsKernel } from "./memory-signals-kernel.ts";
import { MEMORY_OWNS } from "./ownership.ts";

/** Kernel names this capability registers, and the core requires back. */
export const MEMORY_KERNELS = { ledger: "memory.ledger", signals: "memory.signals" } as const;

/** Tool families this capability implements. Declared in `ownership.ts` beside the projection. */
export { MEMORY_OWNS };

export const memoryCapability: CraftCapability = {
  name: "memory",
  product: "craft-memory",
  evaluation: { input_contract: "scoped-memory-request", output_contract: "bounded-memory-ledger-result", fixture_id: "memory-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
  owns: MEMORY_OWNS,
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    registry.provide(MEMORY_KERNELS.ledger, new MemoryLedgerKernel(store));
    registry.provide(MEMORY_KERNELS.signals, new MemorySignalsKernel(store));
  },
};
