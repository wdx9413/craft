import { operationErrorCode } from "../../../common/craft-common-log/src/operation.ts";
import { CraftOperationError } from "../../operation-error.ts";
import type { JsonObject } from "../../infrastructure/store.ts";

const SAFE_DETAIL_KEYS = new Set(["field", "budget", "member", "minimum", "maximum", "limit", "node_count", "edge_count", "file_count", "byte_count"]);

function safeDetails(value: JsonObject): JsonObject {
  const entries = Object.entries(value).filter(([key, item]) => {
    if (!SAFE_DETAIL_KEYS.has(key)) return false;
    if (typeof item === "string") return /^[a-z][a-z0-9_]{0,63}$/u.test(item);
    return typeof item === "number" && Number.isFinite(item) && item >= 0 && item <= 1_000_000_000_000;
  });
  return Object.fromEntries(entries) as JsonObject;
}

function knownFailure(error: unknown): { stage: string; details: JsonObject } {
  if (error instanceof CraftOperationError) {
    const stage = /^[a-z][a-z0-9_]{0,63}$/u.test(error.stage) ? error.stage : "repository_ensure";
    return { stage, details: safeDetails(error.safeDetails) };
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "TypeScript graph exceeds import budget" || /analysis (?:nodes\/edges|exceeds) .*budget/iu.test(message))
    return { stage: "analysis_import", details: { budget: "analysis_graph" } };
  if (/TypeScript checkpoint exceeds analysis budget|TypeScript file graph exceeds analysis budget/iu.test(message))
    return { stage: "semantic_analysis", details: { budget: "analysis_graph" } };
  if (/Codebase graph exceeds storage .*budget/iu.test(message))
    return { stage: "index_persist", details: { budget: "storage_graph" } };
  return { stage: "repository_ensure", details: {} };
}

/** Content-free failure evidence for optional Codebase preparation. */
export function codebaseFailureDiagnostic(error: unknown): JsonObject {
  const failure = knownFailure(error);
  return { failure_code: error instanceof CraftOperationError ? error.code : operationErrorCode(error), failure_stage: failure.stage, failure_details: failure.details };
}
