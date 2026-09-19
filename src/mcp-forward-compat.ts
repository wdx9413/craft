import type { JsonObject } from "./infrastructure/store.ts";
import {
  MCP_ASSESSED_REVISION, MCP_MIGRATION_STATUS, MCP_PREFERRED_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS
} from "./distribution-and-first-run.ts";

/**
 * G7: MCP 2026-07-28 forward compatibility.
 *
 * What this module is, precisely. The 2026-07-28 revision is not a version bump:
 * it removes the `initialize` handshake itself, makes the protocol stateless with
 * per-request `_meta`, mandates `server/discover`, requires `resultType` on every
 * result, removes `ping`, `logging/setLevel` and `resources/subscribe`, drops SSE
 * resumability, and moves Tasks into an extension while replacing server-
 * initiated requests with Multi Round-Trip Requests. Craft cannot adopt that
 * opaquely, and its human-approval flow sits exactly where MRTR now lives.
 *
 * So this module does NOT claim compliance. It implements the two changes that
 * are safe to make while still speaking 2025-11-25, and it records the rest as
 * deliberate, checkable debt — because the failure this project has already
 * diagnosed twice is a declaration drifting ahead of the implementation, and the
 * cure is a declaration that is falsifiable rather than aspirational.
 *
 * Both implemented changes are pure additions, so no existing 2025-11-25 client
 * can observe a behaviour change.
 */

/** What an implementation of 2026-07-28 must do, and where Craft stands. */
export const MCP_REVISION_REQUIREMENTS = [
  { id: "server_discover", requirement: "servers MUST implement `server/discover`", status: "implemented" },
  { id: "result_type", requirement: "every result carries a required `resultType`", status: "forward_compatible" },
  { id: "stateless_meta", requirement: "no `initialize`; version and capabilities per-request in `_meta`", status: "not_adopted" },
  { id: "no_sessions", requirement: "protocol-level sessions and `Mcp-Session-Id` removed", status: "not_adopted" },
  { id: "subscriptions_listen", requirement: "`subscriptions/listen` replaces HTTP GET and `resources/subscribe`", status: "not_adopted" },
  { id: "removed_ping", requirement: "`ping`, `logging/setLevel`, `notifications/roots/list_changed` removed", status: "not_adopted" },
  { id: "mrtr", requirement: "MRTR `InputRequiredResult` replaces server-initiated requests", status: "not_adopted" },
  { id: "tasks_extension", requirement: "Tasks moved to the `io.modelcontextprotocol/tasks` extension", status: "not_adopted" },
  { id: "no_resumability", requirement: "SSE resumability and message redelivery removed", status: "not_adopted" },
  { id: "list_cache_fields", requirement: "`ttlMs` and `cacheScope` required on list results", status: "not_adopted" },
  { id: "request_headers", requirement: "`Mcp-Method` / `Mcp-Name` headers required on POST", status: "not_adopted" },
] as const;

/**
 * The result of a `server/discover` call.
 *
 * 2026-07-28 mandates this RPC so a client can select a version up front, or use
 * it as a backward-compatibility probe over STDIO. Implementing it now is
 * strictly additive: a 2025-11-25 client never calls it, and a newer client gets
 * the honest answer instead of `Method not found`.
 *
 * The `alternate_revisions` field exists so a client can see the migration state
 * rather than infer support from a version string — the same discipline as
 * `negotiateProtocolVersion` returning `migration_status`.
 */
export function discoverResult(input: JsonObject = {}): JsonObject {
  const serverName = typeof input.server_name === "string" && input.server_name.trim() ? input.server_name.trim() : "craft";
  return {
    // The revision this build actually speaks.
    protocolVersion: MCP_PREFERRED_PROTOCOL_VERSION,
    supported_revisions: [...MCP_PROTOCOL_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: { name: serverName, version: String(input.version ?? "0.12.33") },
    // Named rather than implied: a client must not assume the assessed revision
    // is available just because this build knows about it.
    assessed_revision: MCP_ASSESSED_REVISION,
    migration_status: MCP_MIGRATION_STATUS,
    resultType: "complete",
  };
}

/**
 * Accept and normalise an inbound result's `resultType`.
 *
 * The 2026-07-28 spec says clients MUST treat results from earlier-protocol
 * servers that omit the field as `"complete"`. Applying the same rule here means
 * craft tolerates both shapes today, instead of breaking the day a peer starts
 * sending it. An unrecognised value is rejected rather than coerced, because a
 * `"input_required"` result silently read as complete would skip a round trip.
 */
export function normalizeResultType(input: JsonObject): JsonObject {
  const raw = input.resultType;
  if (raw === undefined || raw === null) return { resultType: "complete", present: false, inferred: true };
  if (raw !== "complete" && raw !== "input_required") throw new Error(`resultType is unsupported: ${String(raw)}`);
  // A result claiming to need input is not something this build can service yet,
  // and pretending otherwise would drop the client's required round trip.
  return { resultType: raw, present: true, inferred: false, supported: raw === "complete" };
}

/**
 * Forward-compatibility metadata for an outbound result.
 *
 * Deliberately does NOT add a `resultType` field: 2026-07-28 requires one, but
 * this build speaks 2025-11-25, and the spec says a client must read an absent
 * field as `"complete"`. Emitting it now would be exactly the premature
 * declaration this project keeps catching — announcing a revision it does not
 * speak. The field is returned separately as guidance for the caller.
 */
export function outboundResult(input: JsonObject): JsonObject {
  const result = (input.result ?? {}) as JsonObject;
  return {
    result,
    // The one thing a 2026-07-28 client needs and cannot infer: this build omits
    // `resultType` on purpose, and the correct reading is "complete".
    resultType_omitted: true,
    implied_resultType: "complete",
    note: "resultType is omitted deliberately while speaking 2025-11-25; a 2026-07-28 client MUST read its absence as \"complete\".",
  };
}

/**
 * Whether `ping` may be answered.
 *
 * `ping` was removed in 2026-07-28. It remains correct and necessary while
 * speaking 2025-11-25, so it is kept — and this function exists so the retention
 * is a recorded decision with a stated removal condition, not an oversight that
 * a future migration rediscovers by accident.
 */
export function pingPolicy(input: JsonObject = {}): JsonObject {
  const speaking = typeof input.protocol_version === "string" ? input.protocol_version : MCP_PREFERRED_PROTOCOL_VERSION;
  const removedIn = MCP_ASSESSED_REVISION;
  return {
    speaking,
    serve_ping: speaking !== removedIn,
    removed_in: removedIn,
    // The exact condition under which the removal must happen.
    removal_condition: `stop serving \`ping\` when protocol_version becomes ${removedIn}`,
    reason: speaking === removedIn
      ? "the negotiated revision removed ping, so answering it would be non-conformant"
      : `ping is part of ${speaking} and removing it would break existing clients`,
  };
}

/**
 * Extract the 2026-07-28 per-request `_meta` keys, tolerating their absence.
 *
 * Under the stateless revision every request carries protocol version and client
 * capabilities in `_meta` instead of an `initialize` handshake. Craft does not
 * implement that, but a peer may send the keys, and discarding them unknown
 * would mean a future migration has no record of what clients were actually
 * sending. Unknown `io.modelcontextprotocol/*` keys are reported rather than
 * silently dropped.
 */
export function readRequestMeta(input: JsonObject): JsonObject {
  const meta = input._meta;
  if (meta === undefined || meta === null) return { present: false, protocol_version: null, client_capabilities: null, unknown_keys: [] };
  if (typeof meta !== "object" || Array.isArray(meta)) throw new Error("_meta must be an object");
  const entries = Object.entries(meta as JsonObject);
  const known = new Set([
    "io.modelcontextprotocol/protocolVersion",
    "io.modelcontextprotocol/clientCapabilities",
    "io.modelcontextprotocol/clientInfo",
  ]);
  const protocolVersion = (meta as JsonObject)["io.modelcontextprotocol/protocolVersion"];
  const capabilities = (meta as JsonObject)["io.modelcontextprotocol/clientCapabilities"];
  return {
    present: true,
    protocol_version: typeof protocolVersion === "string" && protocolVersion.trim() ? protocolVersion.trim() : null,
    client_capabilities: capabilities && typeof capabilities === "object" && !Array.isArray(capabilities) ? capabilities : null,
    // Scoped to the MCP namespace so unrelated `_meta` extensions are not
    // reported as protocol drift.
    unknown_keys: entries.map(([key]) => key).filter((key) => key.startsWith("io.modelcontextprotocol/") && !known.has(key)).sort(),
  };
}

/**
 * Summarise forward compatibility for a receipt.
 *
 * Counts implemented requirements against total, so "how ready are we" is a
 * number rather than an impression — and lists what remains, so the gap cannot
 * be forgotten the moment the check passes.
 */
export function forwardCompatibility(input: JsonObject = {}): JsonObject {
  const requirements = MCP_REVISION_REQUIREMENTS.map((item) => ({ ...item }));
  const done = requirements.filter((item) => item.status !== "not_adopted");
  return {
    target_revision: MCP_ASSESSED_REVISION,
    speaking: typeof input.protocol_version === "string" ? input.protocol_version : MCP_PREFERRED_PROTOCOL_VERSION,
    migration_status: MCP_MIGRATION_STATUS,
    total_requirements: requirements.length,
    addressed: done.length,
    remaining: requirements.filter((item) => item.status === "not_adopted").map((item) => item.id),
    // Stated plainly so no reader mistakes this for compliance.
    compliant_with_target: false,
    requirements,
  };
}
