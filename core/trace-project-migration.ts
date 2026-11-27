import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { readCodexSessionTaskExcerpt } from "./codex-session-archive.ts";

/** Read-only classification: a caller-supplied project or Evidence is never treated as proof. */
export async function previewProjectTraceMigration(store: CraftStore, traceId: string, env: NodeJS.ProcessEnv = process.env,
  readSource: typeof readCodexSessionTaskExcerpt = readCodexSessionTaskExcerpt): Promise<JsonObject> {
  if (typeof traceId !== "string" || !traceId.trim() || traceId.length > 256) throw new Error("trace_id must be a bounded string");
  const receipt = store.projectTraceMigrationReceipt(traceId);
  const trace = store.traceShards.find("trace", traceId) ?? (receipt ? store.find("trace", traceId) : null);
  if (!trace) return { trace_id: traceId, status: "pending", reason: "global_live_trace_unavailable" };
  if (typeof trace.task_id !== "string" || !trace.task_id.startsWith("knowledge:") || trace.task_id.startsWith("knowledge:adjudication:"))
    return { trace_id: traceId, status: "pending", reason: "source_task_not_identifiable" };
  const taskId = trace.task_id.slice("knowledge:".length);
  for (const expected_partition of ["candidate_generation", "held_out"] as const) {
    let source: JsonObject;
    try { source = await readSource(taskId, { expected_partition }, env); }
    catch { return { trace_id: traceId, status: "pending", reason: "host_source_unavailable" }; }
    if (source.status !== "ready") continue;
    if (source.task_id !== taskId || typeof source.project_scope_id !== "string" || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(source.project_scope_id)
      || typeof source.source_ref !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(source.source_ref))
      return { trace_id: traceId, status: "pending", reason: "host_source_identity_unverified" };
    const requests = (receipt ? store.listTraceChildren("trace_event", traceId) : store.traceShards.children("trace_event", traceId)).filter(event => event.event_kind === "model.request");
    const validRequest = requests.some(event => {
      if (!Array.isArray(event.input_refs) || event.source !== "codex-cli-learning-transport" || event.operation_id !== taskId) return false;
      return (["knowledge_session_candidate_generation", "knowledge_held_out_label"] as const).some(purpose => {
        const actor = purpose === "knowledge_session_candidate_generation" ? "knowledge-session-candidate-worker" : "knowledge-session-evaluation-worker";
        if ((purpose === "knowledge_session_candidate_generation" ? "candidate_generation" : "held_out") !== expected_partition) return false;
        return event.actor === actor && (event.input_refs as unknown[]).some(input => typeof input === "string" && /^sha256:[a-f0-9]{64}$/u.test(input)
          && event.data_digest === stableDigest({ purpose, input_digest: input, source_ref: source.source_ref, content_stored: false })
          && traceId === `trace_${stableDigest({ purpose, task_id: taskId, input_digest: input }).slice(-32)}`);
      });
    });
    if (!validRequest) return { trace_id: traceId, status: "pending", reason: "trace_source_binding_unverified" };
    const root = store.projectTraceRegisteredRoot(source.project_scope_id);
    if (!root) return { trace_id: traceId, status: "pending", reason: "project_root_unavailable" };
    const snapshotDigest = store.projectTraceSourceDigest(traceId) ?? receipt?.digest;
    if (typeof snapshotDigest !== "string") return { trace_id: traceId, status: "pending", reason: "trace_snapshot_unavailable" };
    const manifest = { trace_id: traceId, trace_version: trace.version, source_snapshot_digest: snapshotDigest, task_id: taskId,
      project_scope_id: source.project_scope_id, source_ref: source.source_ref, project_root_digest: stableDigest(root) };
    return { ...manifest, manifest_digest: stableDigest(manifest), status: "ready", raw_content_stored: false };
  }
  return { trace_id: traceId, status: "pending", reason: "host_task_not_verified" };
}

const configuredOwners = new WeakSet<CraftStore>();

/** Offline only: the trusted Host owner installs the verifier once per Store instance. */
export async function applyProjectTraceMigration(store: CraftStore, traceId: string, expectedManifest: string,
  env: NodeJS.ProcessEnv = process.env): Promise<JsonObject> {
  if (!configuredOwners.has(store)) {
    store.configureProjectTraceMigrationVerifier(async (id, expected) => {
      const current = await previewProjectTraceMigration(store, id, env);
      if (current.status !== "ready") return current;
      if (current.manifest_digest !== expected) throw new Error("Trace or Host source changed; preview again");
      const project = String(current.project_scope_id), root = store.projectTraceRegisteredRoot(project);
      if (!root || stableDigest(root) !== current.project_root_digest) throw new Error("Project root changed; preview again");
      return { ...current, project_root: root };
    });
    configuredOwners.add(store);
  }
  return store.migrateProjectTrace(traceId, expectedManifest);
}
