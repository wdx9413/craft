export type HookHostReadiness = {
  authentication?: "available" | "unavailable" | "unknown";
  hook_trust?: "trusted" | "untrusted" | "unknown";
};
export type HookGapReason = "host_auth_unavailable" | "hook_untrusted" | "pending_background" | "unsupported_native_envelope" | "verification_unobserved";
export type HookSignalGapReason = Extract<HookGapReason, "pending_background" | "unsupported_native_envelope">;

type VerificationSignal = { kind?: unknown; verifier?: unknown; gap_reason?: unknown };
type VerificationJournal = { signals?: unknown; verification_outcome?: unknown } | null;
export type HookVerificationGap = { reason: HookGapReason | null; host_authentication: NonNullable<HookHostReadiness["authentication"]>; hook_trust: NonNullable<HookHostReadiness["hook_trust"]> };

/** Missing Hook events never establish absent authentication or untrusted configuration. */
export function hookVerificationGap(journal: VerificationJournal, readiness: HookHostReadiness = {}): HookVerificationGap {
  const authentication = readiness.authentication ?? "unknown";
  const trust = readiness.hook_trust ?? "unknown";
  const signals = Array.isArray(journal?.signals)
    ? journal.signals.filter((item): item is VerificationSignal => !!item && typeof item === "object" && !Array.isArray(item))
    : [];
  const lastEdit = signals.findLastIndex(item => item.kind === "edit");
  const pending = new Map<unknown, unknown>();
  for (const signal of signals.slice(lastEdit + 1)) {
    if (signal.kind === "verification_gap") pending.set(signal.verifier, signal.gap_reason);
    else if (signal.kind === "verification") pending.delete(signal.verifier);
  }
  let reason: HookVerificationGap["reason"];
  if (authentication === "unavailable") reason = "host_auth_unavailable";
  else if (trust === "untrusted") reason = "hook_untrusted";
  else if (journal?.verification_outcome === "passed" || journal?.verification_outcome === "failed") reason = null;
  else if ([...pending.values()].includes("pending_background")) reason = "pending_background";
  else reason = pending.size ? "unsupported_native_envelope" : "verification_unobserved";
  return { reason, host_authentication: authentication, hook_trust: trust };
}
