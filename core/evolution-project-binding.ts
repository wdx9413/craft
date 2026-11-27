import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { CraftOperationError } from "./operation-error.ts";
import { evolutionProjectScope, type EvolutionProjectScope } from "@craft/capability-context";

const bindingSources = new WeakMap<CraftStore, Pick<CraftStore, "find">>();
export function bindEvolutionProjectBindingSource(store: CraftStore, source: Pick<CraftStore, "find">): void { bindingSources.set(store, source); }

const KIND = "context_evolution_project_binding";
const TTL_MS = 60 * 60 * 1000;

type HookProjectBinding = {
  host: "codex" | "claude";
  session_id: string;
  turn_id: string;
  project_root: string;
  scope: EvolutionProjectScope;
};

/** Issued by the local Host hook. Only a digest of the presented proof is kept. */
export function mintEvolutionProjectBinding(store: CraftStore, binding: HookProjectBinding): string {
  const id = projectBindingId(binding);
  const token = `${id}.${randomUUID().replaceAll("-", "")}`;
  const record = store.save(KIND, id, { ...binding, token_digest: stableDigest(token), expires_at_ms: Date.now() + TTL_MS });
  const enrollmentId = `context_learning_enrollment_${stableDigest(binding.scope).slice(-24)}`;
  if (!store.find("context_learning_enrollment", enrollmentId)) store.create("context_learning_enrollment", enrollmentId, {
    scope: binding.scope, status: "active", provenance: "hook_project_binding", content_stored: false,
    source_ref: { kind: KIND, id: record.id, version: record.version, digest: stableDigest(record) },
  });
  return token;
}

/** Native Hook enrollment grants only its registered project; bearer tokens never reach the Worker. */
export function registeredLearningProjectScopes(store: CraftStore): JsonObject[] {
  const scopes = new Map<string, JsonObject>();
  for (const enrollment of store.list("context_learning_enrollment", 1_000, item => item.status === "active", false)) {
    const scope = evolutionProjectScope(enrollment.scope), reference = enrollment.source_ref as JsonObject | undefined;
    if (!scope || enrollment.provenance !== "hook_project_binding" || reference?.kind !== KIND || typeof reference.id !== "string"
      || !Number.isSafeInteger(reference.version) || Number(reference.version) < 1) continue;
    const source = store.find(KIND, reference.id, Number(reference.version), false);
    if (!source || stableDigest(source) !== reference.digest || stableDigest(source.scope) !== stableDigest(scope)
      || (source.host !== "codex" && source.host !== "claude")) continue;
    const registered = store.list("scope_alias", 1_000, alias => alias.status === "active" && alias.alias_kind === "path"
      && stableDigest(alias.scope) === stableDigest(scope) && typeof alias.alias === "string" && alias.alias_digest === stableDigest(alias.alias), false);
    if (registered.length) scopes.set(scope.id, scope as JsonObject);
  }
  return [...scopes.values()];
}

function projectBindingId({ host, session_id }: Pick<HookProjectBinding, "host" | "session_id">): string {
  return stableDigest({ host, session_id }).slice(-32);
}

export function expireEvolutionProjectBinding(store: CraftStore, host: HookProjectBinding["host"], sessionId: string): void {
  const id = projectBindingId({ host, session_id: sessionId });
  const binding = store.find(KIND, id);
  if (binding && Number(binding.expires_at_ms) > Date.now()) store.updateIfVersion(KIND, id, Number(binding.version), {
    ...binding, token_digest: null, expires_at_ms: 0,
  });
}

export function evolutionHostTurnSource(binding: Pick<HookProjectBinding, "host" | "session_id" | "turn_id" | "scope">): JsonObject {
  const { host, session_id, turn_id, scope } = binding;
  return { kind: "host_turn", id: stableDigest({ host, session_id, turn_id, scope }), host };
}

function denied(): CraftOperationError {
  return new CraftOperationError("SCOPE_FORBIDDEN", "scope_authorization", "An active Host project binding is required for this operation");
}

function readBinding(store: CraftStore, token: unknown): HookProjectBinding {
  if (typeof token !== "string" || !/^[a-f0-9]{32}\.[a-f0-9]{32}$/u.test(token)) throw denied();
  const binding = (bindingSources.get(store) ?? store).find(KIND, token.slice(0, 32));
  if (!binding || binding.token_digest !== stableDigest(token) || !(Number(binding.expires_at_ms) > Date.now())) throw denied();
  const scope = evolutionProjectScope(binding.scope);
  if (!scope || typeof binding.project_root !== "string" || typeof binding.session_id !== "string"
    || typeof binding.turn_id !== "string" || (binding.host !== "codex" && binding.host !== "claude")) throw denied();
  return { scope, project_root: binding.project_root, host: binding.host, session_id: binding.session_id, turn_id: binding.turn_id };
}

export function bindEvolutionProjectArgs(store: CraftStore, args: JsonObject, operation: string): JsonObject {
  const { project_binding: token, project_root: projectRoot, scope: suppliedScope, ...rest } = args;
  const binding = readBinding(store, token);
  const { scope } = binding;
  if (suppliedScope !== undefined && evolutionProjectScope(suppliedScope)?.id !== scope.id) throw denied();
  if (projectRoot !== undefined && projectRoot !== binding.project_root) throw denied();
  return {
    ...rest, scope, project_root: binding.project_root,
    ...(operation === "craft_experience_trace_distill"
      ? { host: binding.host, session_id: binding.session_id, turn_id: binding.turn_id } : {}),
    ...(PROGRAM_MEMORY_CAPTURE_TOOLS.has(operation) ? { source_refs: [evolutionHostTurnSource(binding)] } : {}),
  };
}

const PROGRAM_MEMORY_CAPTURE_TOOLS = new Set(["craft_evolution_program_memory_capture", "craft_evolution_domain_capture"]);

/** Mirrored assets keep the project policy even through older Experience names. */
export function bindProgramMemoryExperienceArgs(store: CraftStore, args: JsonObject): JsonObject {
  const { project_binding: token, program_memory_scope_id: _, ...forwarded } = args;
  const scopeId = token === undefined ? undefined : readBinding(store, token).scope.id;
  const input = typeof forwarded.input === "object" && forwarded.input && !Array.isArray(forwarded.input) ? forwarded.input as JsonObject : {};
  const records = new Set<unknown>([forwarded.request_id]);
  const find = (kind: string, id: unknown, version?: unknown) => typeof id === "string" && id.trim()
    ? store.find(kind, id.trim(), Number.isSafeInteger(version) ? Number(version) : undefined, false) : null;
  records.add(find("workflow_evolution_proposal", forwarded.proposal_id)?.request_id);
  const dispatch = find("experience_evaluation_dispatch", forwarded.dispatch_id);
  const procedureIds = new Set([forwarded.procedure_id, input.procedure_id, forwarded.graph_id, forwarded.asset_id,
    forwarded.target_asset_id, dispatch?.procedure_id]);
  const invocationIds = [forwarded.invocation_id, ...["baseline_ids", "candidate_ids"].flatMap(key =>
    Array.isArray(forwarded[key]) ? (forwarded[key] as unknown[]).slice(0, 100) : [])];
  for (const id of invocationIds) {
    const invocation = find("procedure_invocation", id);
    if (!invocation) continue;
    const nodes = Array.isArray(invocation.nodes) ? invocation.nodes as JsonObject[] : [];
    for (const node of [invocation, ...nodes]) {
      procedureIds.add(node.procedure_id);
      if (Number.isSafeInteger(node.procedure_version)) records.add(find("experience_procedure", node.procedure_id, node.procedure_version)?.request_id);
    }
  }
  for (const id of procedureIds) {
    records.add(find("experience_procedure", id)?.request_id);
    const activeVersion = find("experience_release", id)?.record_version;
    for (const version of new Set([activeVersion, forwarded.version, forwarded.target_version, forwarded.before_version, forwarded.procedure_version,
      input.procedure_version, dispatch?.procedure_version])) {
      if (Number.isSafeInteger(version)) records.add(find("experience_procedure", id, version)?.request_id);
    }
  }
  for (const requestId of records) {
    const bound = find("program_memory_procedure_binding", requestId);
    if (bound && (!scopeId || evolutionProjectScope(bound.scope)?.id !== scopeId)) throw denied();
  }
  return scopeId === undefined ? forwarded : { ...forwarded, program_memory_scope_id: scopeId };
}

/** The bearer value belongs only at dispatch, including when carried inside syscall args. */
export function projectBindingFreeInput(value: unknown, depth = 3): unknown {
  if (depth === 0 || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const { project_binding: _, ...rest } = value as JsonObject;
  for (const key of ["args", "arguments"]) {
    if (key in rest) rest[key] = projectBindingFreeInput(rest[key], depth - 1);
  }
  return rest;
}
