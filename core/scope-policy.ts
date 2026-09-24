/**
 * Scope policy is deliberately orthogonal to a record's applicability scope.
 *
 * A `project` record answers "where can this help?"; it does not by itself
 * answer who owns it, which principal may read it, or whether it can be kept
 * after a session ends.  Keeping those questions together here prevents each
 * cognitive member from inventing a subtly different team-sharing rule.
 */
import type { JsonObject } from "./infrastructure/store.ts";
import type { ScopeRef } from "./validation.ts";

export const COGNITIVE_SCOPE_KINDS = ["user", "project", "workspace", "task", "session", "team", "organization", "global"] as const;
export type CognitiveScopeKind = typeof COGNITIVE_SCOPE_KINDS[number];
export type CognitivePurpose = "working_note" | "preference" | "episode" | "fact" | "procedure";
export type CognitiveRetention = "session" | "working" | "long_term" | "archival";

export type ScopeEnvelope = Readonly<{
  applicability: ScopeRef;
  custody: ScopeRef;
  audience: Readonly<{ mode: "private" | "scoped" | "public"; principal_ids: readonly string[] }>;
  purpose: CognitivePurpose;
  retention: CognitiveRetention;
  tenant_id: string | null;
}>;

export type ScopeAccess = Readonly<{
  principal_id?: string;
  principal_ids?: readonly string[];
  tenant_id?: string;
  purpose?: CognitivePurpose;
}>;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function scope(value: unknown, fallback: ScopeRef): ScopeRef {
  if (value === undefined || value === null) return fallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scope envelope scope must be an object");
  const item = value as JsonObject;
  const kind = required(item.kind, "scope envelope kind");
  if (!(COGNITIVE_SCOPE_KINDS as readonly string[]).includes(kind)) throw new Error("scope envelope kind is unsupported");
  return { kind, id: required(item.id, "scope envelope id") };
}

function defaultPurpose(kind: string): CognitivePurpose {
  if (kind === "task" || kind === "session") return "working_note";
  if (kind === "user") return "preference";
  return "fact";
}

function defaultRetention(purpose: CognitivePurpose): CognitiveRetention {
  if (purpose === "working_note") return "working";
  if (purpose === "episode") return "archival";
  return "long_term";
}

/** Parse new envelopes and provide a safe, deterministic legacy envelope. */
export function scopeEnvelope(value: unknown, applicability: ScopeRef): ScopeEnvelope {
  if (value === undefined || value === null) {
    const purpose = defaultPurpose(applicability.kind);
    return {
      applicability,
      custody: applicability,
      audience: { mode: applicability.kind === "global" ? "public" : "scoped", principal_ids: [] },
      purpose,
      retention: defaultRetention(purpose),
      tenant_id: null,
    };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("scope_envelope must be an object");
  const raw = value as JsonObject;
  const actualApplicability = scope(raw.applicability, applicability);
  if (actualApplicability.kind !== applicability.kind || actualApplicability.id !== applicability.id) throw new Error("scope_envelope applicability must match record scope");
  const purpose = raw.purpose === undefined ? defaultPurpose(applicability.kind) : required(raw.purpose, "scope_envelope purpose") as CognitivePurpose;
  if (!(["working_note", "preference", "episode", "fact", "procedure"] as const).includes(purpose)) throw new Error("scope_envelope purpose is unsupported");
  const retention = raw.retention === undefined ? defaultRetention(purpose) : required(raw.retention, "scope_envelope retention") as CognitiveRetention;
  if (!(["session", "working", "long_term", "archival"] as const).includes(retention)) throw new Error("scope_envelope retention is unsupported");
  const audienceRaw = raw.audience === undefined ? {} : raw.audience;
  if (!audienceRaw || typeof audienceRaw !== "object" || Array.isArray(audienceRaw)) throw new Error("scope_envelope audience must be an object");
  const audienceValue = audienceRaw as JsonObject;
  const mode = audienceValue.mode === undefined ? (applicability.kind === "global" ? "public" : "scoped") : required(audienceValue.mode, "scope_envelope audience mode");
  if (!["private", "scoped", "public"].includes(mode)) throw new Error("scope_envelope audience mode is unsupported");
  const principalIds = audienceValue.principal_ids === undefined ? [] : audienceValue.principal_ids;
  if (!Array.isArray(principalIds) || principalIds.some((item) => typeof item !== "string" || !item.trim())) throw new Error("scope_envelope audience principal_ids must be strings");
  const unique = [...new Set(principalIds.map((item) => String(item).trim()))].sort();
  if (mode === "private" && unique.length !== 1) throw new Error("private scope_envelope requires exactly one audience principal");
  const tenant = raw.tenant_id === undefined || raw.tenant_id === null ? null : required(raw.tenant_id, "scope_envelope tenant_id");
  return { applicability, custody: scope(raw.custody, applicability), audience: { mode: mode as ScopeEnvelope["audience"]["mode"], principal_ids: unique }, purpose, retention, tenant_id: tenant };
}

/** A record is visible only when all declared audience/tenant constraints pass. */
export function scopeAllows(envelope: ScopeEnvelope, access: ScopeAccess): boolean {
  if (envelope.tenant_id !== null && envelope.tenant_id !== access.tenant_id) return false;
  if (access.purpose !== undefined && envelope.purpose !== access.purpose) return false;
  if (envelope.audience.mode === "public") return true;
  // Legacy scoped records had no principal ACL. Their explicit applicability
  // scope remains the access boundary, so retaining an empty audience keeps
  // old data readable without treating it as global/public data.
  if (envelope.audience.mode === "scoped" && envelope.audience.principal_ids.length === 0) return true;
  const principals = new Set([...(access.principal_ids ?? []), ...(access.principal_id ? [access.principal_id] : [])]);
  return envelope.audience.principal_ids.some((principal) => principals.has(principal));
}

/** Parse host-attested access metadata without turning model text into identity. */
export function scopeAccess(value: JsonObject): ScopeAccess {
  const principalId = value.principal_id === undefined ? undefined : required(value.principal_id, "principal_id");
  const principals = value.principal_ids === undefined ? [] : value.principal_ids;
  if (!Array.isArray(principals) || principals.some((item) => typeof item !== "string" || !item.trim())) throw new Error("principal_ids must be non-empty strings");
  const purpose = value.cognitive_purpose === undefined ? undefined : required(value.cognitive_purpose, "cognitive_purpose") as CognitivePurpose;
  if (purpose !== undefined && !(["working_note", "preference", "episode", "fact", "procedure"] as const).includes(purpose)) throw new Error("cognitive_purpose is unsupported");
  return { principal_id: principalId, principal_ids: [...new Set(principals.map((item) => String(item).trim()))], tenant_id: value.tenant_id === undefined ? undefined : required(value.tenant_id, "tenant_id"), purpose };
}

export function scopeEnvelopeReceipt(envelope: ScopeEnvelope): JsonObject {
  return { applicability: envelope.applicability, custody: envelope.custody, audience: { mode: envelope.audience.mode, principal_count: envelope.audience.principal_ids.length }, purpose: envelope.purpose, retention: envelope.retention, tenant_bound: envelope.tenant_id !== null };
}

/** Legacy claims use `kind:id`; keep parsing in the policy module rather than in each capability. */
export function scopeFromKey(value: string): ScopeRef {
  const [kind, ...rest] = value.split(":");
  if (kind === "global" && rest.length === 0) return { kind: "global", id: "global" };
  if (!kind || !rest.join(":")) throw new Error("scope key must be kind:id");
  // Claims imported before canonical scope identities can carry a `legacy:*`
  // key.  They remain non-routeable until revalidated, but saving/reviewing
  // them must not fail simply because an Envelope was introduced later.
  return { kind, id: rest.join(":") };
}
