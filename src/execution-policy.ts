import type { JsonObject } from "./store.ts";

const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const ISOLATED_PLATFORMS = new Set(["darwin", "linux"]);

export type ExecutionDecision = {
  tier: "host_read_only" | "isolated_local" | "approval_required" | "blocked";
  autonomous: boolean;
  requires_approval: boolean;
  requires_isolation: boolean;
  reason: string;
};

export function decideExecution(input: JsonObject): ExecutionDecision {
  const effect = String(input.effect);
  const platform = String(input.platform);
  if (!EFFECTS.has(effect)) throw new Error("Execution effect is unsupported");
  if (input.requires_credential === true) {
    return { tier: "blocked", autonomous: false, requires_approval: false, requires_isolation: false, reason: "trusted_credential_broker_required" };
  }
  if (effect === "read_only") {
    return { tier: "host_read_only", autonomous: true, requires_approval: false, requires_isolation: false, reason: "read_only_host_execution" };
  }
  if (effect === "local_write" && input.generated_code === true && ISOLATED_PLATFORMS.has(platform)) {
    return { tier: "isolated_local", autonomous: true, requires_approval: false, requires_isolation: true, reason: "generated_code_requires_isolation" };
  }
  if (effect === "destructive" && input.has_compensation !== true) {
    return { tier: "blocked", autonomous: false, requires_approval: true, requires_isolation: false, reason: "destructive_effect_requires_compensation" };
  }
  return { tier: "approval_required", autonomous: false, requires_approval: true, requires_isolation: effect === "local_write", reason: effect === "local_write" ? "isolation_unavailable_or_not_selected" : "external_effect_requires_approval" };
}
