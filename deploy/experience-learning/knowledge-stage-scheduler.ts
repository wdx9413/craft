import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { atomicPrivateJson } from "../../common/craft-common-store-local/src/paths.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

export const KNOWLEDGE_LEARNING_STAGES = ["classification", "session_candidate", "session_evaluation"] as const;
export type KnowledgeLearningStage = typeof KNOWLEDGE_LEARNING_STAGES[number];
const SCHEMA = "craft.knowledge-learning-stage-cursor.v1";
const PASS_ORDER_SCHEMA = "craft.learning-pass-order.v1";

/** Alternate which learning capability receives first use of the one-call Host budget. */
export async function nextLearningPassOrder(pathValue: string): Promise<"experience_first" | "knowledge_first"> {
  const path = resolve(pathValue);
  try {
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Learning pass cursor directory is invalid");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  let order: "experience_first" | "knowledge_first" = "experience_first";
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) throw new Error("Learning pass cursor file is invalid");
    const state = JSON.parse(readFileSync(path, "utf8")) as JsonObject;
    if (state.schema !== PASS_ORDER_SCHEMA || !["experience_first", "knowledge_first"].includes(String(state.next_order))) throw new Error("Learning pass cursor state is invalid");
    order = state.next_order as "experience_first" | "knowledge_first";
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const next = order === "experience_first" ? "knowledge_first" : "experience_first";
  await atomicPrivateJson(path, { schema: PASS_ORDER_SCHEMA, next_order: next, updated_at: new Date().toISOString() });
  return order;
}

/** Persist a round-robin cursor so a steady stream of Knowledge reviews cannot starve session learning. */
export async function nextKnowledgeLearningStage(pathValue: string, enabledStages: readonly KnowledgeLearningStage[] = KNOWLEDGE_LEARNING_STAGES): Promise<KnowledgeLearningStage> {
  if (!enabledStages.length || new Set(enabledStages).size !== enabledStages.length
    || enabledStages.some(stage => !KNOWLEDGE_LEARNING_STAGES.includes(stage))) throw new Error("Knowledge stages must be a non-empty unique supported list");
  const path = resolve(pathValue);
  try {
    const parent = lstatSync(dirname(path));
    if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error("Knowledge stage cursor directory is invalid");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let cursor = 0;
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4_096) throw new Error("Knowledge stage cursor file is invalid");
    const state = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown; cursor?: unknown };
    if (state.schema !== SCHEMA || !Number.isSafeInteger(state.cursor) || Number(state.cursor) < 0 || Number(state.cursor) > 10_000) throw new Error("Knowledge stage cursor state is invalid");
    cursor = Number(state.cursor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const index = cursor % enabledStages.length;
  const stage = enabledStages[index]!;
  await atomicPrivateJson(path, { schema: SCHEMA, cursor: (index + 1) % enabledStages.length, updated_at: new Date().toISOString() });
  return stage;
}
