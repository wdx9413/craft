import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { stableDigest } from "../digest.ts";
import type { ControlAuthority, ControlGrant, ControlScope } from "../../capability/control-session.ts";

/** Host-only binding. Never deserialize this configuration from an MCP action. */
export type ControlHostBinding = Omit<ControlGrant, "activation_version" | "policy_digest" | "capability_digest"> & {
  principal: string; contract_id: string; effect: "external_write";
};

/**
 * Resolves the existing ledger, without creating authority records or installing a Host.
 * A declarative Kit or recommended Profile alone is not execution authorization:
 * the explicit Host binding and Task contract must independently allow the effect.
 * All records are pinned at construction; every decision rechecks current state.
 */
export function createStoreControlAuthority(store: CraftStore, input: ControlHostBinding): ControlAuthority {
  const binding = structuredClone(input);
  if (!binding.principal.trim() || binding.effect !== "external_write") throw new Error("Explicit Host principal and external effect binding required");
  function records(scope: ControlScope) {
    if (scope.task_id !== binding.task_id || scope.activation_id !== binding.activation_id || scope.target_id !== binding.target_id) {
      throw new Error("Control scope does not match Host binding");
    }
    const task = store.get("task", scope.task_id);
    const contract = store.get("task_control_contract", binding.contract_id);
    const activation = store.get("capability_kit_activation", scope.activation_id);
    const kit = store.get("capability_kit", String(activation.kit_id));
    const profileRef = contract.activation_profile as { id: string; version: number } | null;
    if (!profileRef) throw new Error("Task contract requires a pinned Activation Profile");
    const profile = store.get("activation_profile", profileRef.id);
    const manifest = kit.manifest as JsonObject;
    const conformance = store.get("capability_kit_conformance", `kit_conformance_${kit.id}_${kit.version}`);
    if (task.status !== "active" || task.project_id !== binding.project_id || task.permission_mode !== "human_approval"
      || contract.status !== "active" || contract.task_id !== task.id || contract.acceptance_required !== true
      || activation.status !== "active" || activation.task_id !== task.id || activation.activation_profile_id !== profile.id
      || profile.task_id !== task.id || profile.version !== profileRef.version || profile.activation !== "host_mediated"
      || !["active", "recommended"].includes(String(profile.status))
      || kit.status !== "installed" || activation.kit_version !== kit.version || activation.manifest_digest !== kit.manifest_digest
      || stableDigest(manifest) !== kit.manifest_digest || conformance.verdict !== "passed"
      || conformance.kit_version !== kit.version || conformance.manifest_digest !== kit.manifest_digest) {
      throw new Error("Control authority records are inactive, mismatched or unverified");
    }
    for (const effects of [contract.allowed_effects, profile.allowed_effects, manifest.effects]) {
      if (!Array.isArray(effects) || !effects.includes(binding.effect)) throw new Error("Control effect is not independently authorized");
    }
    if (!Array.isArray(manifest.hooks) || !manifest.hooks.includes("execute.adapter")) throw new Error("Kit has no execution phase");
    if (!Array.isArray(manifest.depends_on)) throw new Error("Kit dependencies are invalid");
    const dependencies = manifest.depends_on.map((ref) => {
      const declaration = ref as JsonObject;
      const dependency = store.get("capability_kit", String(declaration.kit_id));
      if (dependency.status !== "installed" || dependency.manifest_version !== declaration.manifest_version
        || stableDigest(dependency.manifest) !== dependency.manifest_digest) throw new Error("Control dependency unavailable or drifted");
      return dependency;
    });
    return { task, contract, activation, kit, profile, conformance, dependencies };
  }
  const scope = { task_id: binding.task_id, activation_id: binding.activation_id, target_id: binding.target_id };
  const pinned = stableDigest(records(scope));
  return {
    principal: binding.principal,
    resolve(request) {
      const current = records(request);
      if (stableDigest(current) !== pinned) throw new Error("Control authority changed; explicit reactivation required");
      return { ...scope, project_id: binding.project_id, host_id: binding.host_id, activation_version: Number(current.activation.version),
        policy_digest: stableDigest({ task: current.task, contract: current.contract, profile: current.profile }),
        capability_digest: stableDigest({ activation: current.activation, kit: current.kit, conformance: current.conformance, dependencies: current.dependencies }),
        target_identity: binding.target_identity, operations: [...binding.operations], allowed_origins: [...binding.allowed_origins],
        expires_at: binding.expires_at, max_actions: binding.max_actions, timeout_ms: binding.timeout_ms };
    },
  };
}
