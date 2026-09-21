import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";

const COMPONENTS = new Set(["knowledge", "memory", "experience"]);
const HOSTS = new Set(["codex", "claude"]);

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

/**
 * Evidence that a Host actually reached the installed component. Configuration
 * is deliberately not proof: only the hook process writes these content-free
 * receipts. This lets first-run diagnosis distinguish a stale plugin from a
 * trusted but never executed Hook.
 */
export class ActivationProofKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  record(args: JsonObject): JsonObject {
    const host = text(args.host, "host"); if (!HOSTS.has(host)) throw new Error("host must be codex or claude");
    const component = text(args.component, "component"); if (!COMPONENTS.has(component)) throw new Error("component is unsupported");
    const event = text(args.event, "event");
    const sessionId = text(args.session_id ?? "unknown", "session_id");
    const turnId = args.turn_id === undefined || args.turn_id === null ? null : text(args.turn_id, "turn_id");
    const contextReceiptId = args.context_receipt_id === undefined || args.context_receipt_id === null ? null : text(args.context_receipt_id, "context_receipt_id");
    if (contextReceiptId !== null) this.store.get("context_resolution_receipt", contextReceiptId);
    const identity = { host, component, event, session_id: sessionId, turn_id: turnId, context_receipt_id: contextReceiptId,
      memory_written: args.memory_written === true, observation_written: args.observation_written === true,
      plugin_release: text(args.plugin_release ?? CRAFT_RELEASE_VERSION, "plugin_release"), hook_trusted: args.hook_trusted === true,
      mcp_reachable: args.mcp_reachable === true, content_free: true };
    const receiptId = String(args.receipt_id ?? `activation_proof_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("activation_proof_receipt", receiptId); const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Activation proof receipt idempotency conflict");
      return { receipt: existing, idempotent: true };
    }
    return { receipt: this.store.create("activation_proof_receipt", receiptId, { ...identity, identity_digest: identityDigest, observed_at: new Date().toISOString() }), idempotent: false };
  }

  doctor(args: JsonObject = {}): JsonObject {
    const sessionId = args.session_id === undefined ? null : text(args.session_id, "session_id");
    const receipts = this.store.list("activation_proof_receipt", 10_000, (item) => sessionId === null || item.session_id === sessionId);
    const components = [...COMPONENTS].sort().map((component) => {
      const records = receipts.filter((item) => item.component === component);
      const current = records.filter((item) => item.plugin_release === CRAFT_RELEASE_VERSION);
      const hookTrusted = current.some((item) => item.hook_trusted === true);
      const mcpReachable = current.some((item) => item.mcp_reachable === true);
      const context = current.find((item) => typeof item.context_receipt_id === "string") ?? null;
      const memoryWritten = component === "memory" && current.some((item) => item.memory_written === true);
      const observationWritten = component === "experience" && current.some((item) => item.observation_written === true);
      const status = current.length === 0 ? (records.length ? "stale_plugin_or_receipt" : "not_observed")
        : !hookTrusted ? "hook_not_trusted" : !mcpReachable ? "mcp_not_reachable" : "executed";
      return { component, status, current_release: CRAFT_RELEASE_VERSION, executions: current.length,
        hook_trusted: hookTrusted, mcp_reachable: mcpReachable, context_receipt_id: context?.context_receipt_id ?? null,
        ...(component === "memory" ? { explicit_memory_written: memoryWritten } : {}),
        ...(component === "experience" ? { verified_observation_written: observationWritten } : {}),
        last_observed_at: current.length ? current[current.length - 1]!.observed_at : null };
    });
    return { release: CRAFT_RELEASE_VERSION, session_id: sessionId, components,
      data: { context_receipts: this.store.count("context_resolution_receipt"), memory_ledger: this.store.count("memory_ledger"), experience_observations: this.store.count("experience_observation") + this.store.count("workflow_evolution_observation") },
      next_action: components.some((item) => item.status !== "executed") ? "run_one_real_host_turn_then_recheck_this_session" : "inspect_the_component_receipts_and_evidence" };
  }
}
