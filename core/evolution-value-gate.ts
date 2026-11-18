import { createHash } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";

export const EVOLUTION_VALUE_ACTIONS = [
  "store_as_fact",
  "store_as_preference",
  "candidate_procedure",
  "candidate_mod",
  "ignore",
  "needs_review",
] as const;

export type EvolutionValueAction = (typeof EVOLUTION_VALUE_ACTIONS)[number];

export interface EvolutionValueDecision {
  readonly action: EvolutionValueAction;
  readonly reason: string;
  readonly digest: string;
  readonly scope: JsonObject;
  readonly note_refs: readonly JsonObject[];
  readonly source_refs: readonly JsonObject[];
  readonly gate_version: string;
}

export interface EvolutionValueInput {
  statement?: unknown;
  source_kind?: unknown;
  evidence_ids?: unknown;
  verification?: unknown;
  repetitions?: unknown;
  explicit?: unknown;
  domain?: unknown;
  scope?: unknown;
  device_id?: unknown;
  path?: unknown;
  artifact_refs?: unknown;
  note_refs?: unknown;
  adapter_version?: unknown;
}

const GATE_VERSION = "evolution-value-gate.v1";
const SECRET = /\{\{\s*[A-Z][A-Za-z0-9_]*\s*\}\}|(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{6,}/iu;
const DO_NOT_REMEMBER = /(?:无需|不用|不要|别)(?:记录|记住|保存)|(?:do not|don't)\s+(?:remember|save|store)/iu;
const PREFERENCE = /^(?:我偏好|我更喜欢|我长期使用|我习惯|I prefer|I usually use|my default is)\s*[:：,，]?\s*(.+)$/iu;
const RULE = /^(?:(?:本项目|这个项目|该项目)(?:的)?(?:约定|规范|默认规则|标准操作)(?:是)?\s*[:：,，]?\s*|(?:我们约定|项目要求|编码规范是|必须|始终|always|must|never|do not|don't)\s*[:：,，]?\s*|(?:以后|今后)(?:在本项目中)?(?:请)?(?:默认)?(?:使用|采用|遵循|保持|优先|避免|不要|总是)\s*[:：,，]?\s*)(.+)$/iu;
const FACT = /^(?:(?:本项目|这个项目|该项目)(?:目前)?(?:默认)?(?:使用|采用|基于|运行在|部署在)\s*[:：,，]?\s*|(?:the project|this project|we use|it uses|default)\s*[:：,，]?\s*)(.+)$/iu;
const STEPS = /^(?:怎么|如何|步骤|操作|流程|workflow|steps?|how to)(?:[^。.!?]{0,40})[:：]|(?:先|然后|接着|最后)\s*.+(?:再|后|然后|最后)/iu;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sourceRefs(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)).slice(0, 20);
}

function noteRefs(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item)
    && item.member === "craft_notes" && ["device", "directory", "file"].includes(String(item.subject_type))
    && typeof item.id === "string" && item.id.length > 0 && Number.isSafeInteger(item.version)).slice(0, 20);
}

function scopeOf(input: EvolutionValueInput): JsonObject {
  const raw = input.scope && typeof input.scope === "object" && !Array.isArray(input.scope) ? input.scope as JsonObject : {};
  const notes = noteRefs(input.note_refs);
  return {
    ...raw,
    ...(text(input.domain) ? { domain: text(input.domain) } : {}),
    ...(text(input.device_id) ? { device_id: text(input.device_id) } : {}),
    ...(text(input.path) ? { path: text(input.path) } : {}),
    ...(notes.length ? { note_refs: notes } : {}),
  };
}

/**
 * Deterministic first-stage Value Gate. It produces reviewable decisions,
 * never durable facts by itself. Callers still route each decision through the
 * owning capability's write gate (ontology validation, evidence, signoff...).
 */
export function evaluateEvolutionValue(input: EvolutionValueInput): EvolutionValueDecision {
  const statement = text(input.statement);
  const scope = scopeOf(input);
  const scopeNotes = (scope.note_refs ?? []) as JsonObject[];
  const sourceRefsValue = sourceRefs(input.evidence_ids ?? input.artifact_refs);
  const base = { scope, note_refs: scopeNotes, source_refs: sourceRefsValue, gate_version: GATE_VERSION };
  const finish = (action: EvolutionValueAction, reason: string): EvolutionValueDecision => ({
    ...base, action, reason,
    digest: createHash("sha256").update(JSON.stringify({ action, statement, scope, note_refs: scopeNotes, source_refs: sourceRefsValue, gate_version: GATE_VERSION })).digest("hex"),
  });

  if (!statement) return finish("ignore", "empty statement");
  if (SECRET.test(statement)) return finish("ignore", "credential or placeholder rejected");
  if (DO_NOT_REMEMBER.test(statement)) return finish("ignore", "explicit opt-out");
  if (statement.length > 300) return finish("needs_review", "statement exceeds durable-record limit");

  const explicit = input.explicit === true;
  const repetitions = Number(input.repetitions ?? 0);
  const verified = input.verification === "passed" || input.verification === true;
  const hasEvidence = sourceRefsValue.length > 0;

  if (PREFERENCE.test(statement)) return finish("store_as_preference", "explicit preference statement");
  if (RULE.test(statement)) return finish("store_as_fact", "explicit rule or convention");
  if (FACT.test(statement)) return finish("store_as_fact", "explicit project fact");

  if (STEPS.test(statement)) {
    return verified || repetitions >= 2
      ? finish("candidate_procedure", "operating steps with verification or repetition")
      : finish("needs_review", "operating steps require verification or repetition");
  }

  if (input.source_kind === "failure" || input.verification === "failed") {
    return hasEvidence
      ? finish("candidate_mod", "attributed failure with evidence")
      : finish("needs_review", "failure lacks attribution evidence");
  }

  if (explicit) return finish("needs_review", "explicit but unclassified statement");
  if (verified && hasEvidence && repetitions >= 2) return finish("candidate_procedure", "repeated verified evidence-backed signal");
  return finish("ignore", "ordinary task text");
}
