import type { JsonObject } from "./infrastructure/store.ts";

const GRADERS = new Set(["exit_code", "file_exists", "json_equals", "stdout_contains", "stdout_not_contains"]);
const relativePath = (value: unknown) => typeof value === "string" && !!value && !/^[\\/]|^[A-Za-z]:|[\u0000-\u001f\u007f]/u.test(value) && !value.split(/[\\/]/u).some(part => !part || part === ".." || part === ".");

/** A bounded deterministic assert set, reviewed together with the held-out task evidence. */
export function knowledgeTaskContract(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("task_contract must be an object");
  const contract = value as JsonObject;
  if (Object.keys(contract).some(key => !["checks", "safety_checks"].includes(key)) || Buffer.byteLength(JSON.stringify(contract)) > 64 * 1024) throw new Error("task_contract contains unsupported or oversized data");
  for (const key of ["checks", "safety_checks"]) {
    const entries = contract[key];
    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 32) throw new Error("task_contract requires 1..32 task and safety checks");
    const ids = new Set();
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || typeof entry.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u.test(entry.id) || ids.has(entry.id) || !GRADERS.has(String(entry.kind))) throw new Error("task_contract requires unique deterministic checks");
      const allowed = ["id", "kind", "weight", "judge", ...(entry.kind === "exit_code" ? ["equals"] : entry.kind === "file_exists" ? ["path"] : entry.kind === "json_equals" ? ["path", "key", "equals"] : ["value"])];
      if (Object.keys(entry).some(field => !allowed.includes(field)) || entry.weight !== undefined && (typeof entry.weight !== "number" || !Number.isFinite(entry.weight) || entry.weight <= 0)
        || entry.judge !== undefined && typeof entry.judge !== "string") throw new Error("task_contract check has unsupported fields or weights");
      if (entry.kind === "exit_code" && !Number.isSafeInteger(entry.equals)
        || ["file_exists", "json_equals"].includes(String(entry.kind)) && !relativePath(entry.path)
        || entry.kind === "json_equals" && (typeof entry.key !== "string" || !entry.key || !Object.hasOwn(entry, "equals"))
        || ["stdout_contains", "stdout_not_contains"].includes(String(entry.kind)) && (typeof entry.value !== "string" || !entry.value)) throw new Error("task_contract check parameters are invalid");
      ids.add(entry.id);
    }
  }
  if (!(contract.checks as JsonObject[]).some(check => check.kind !== "exit_code")) throw new Error("task_contract needs an observable task outcome beyond process exit");
  return JSON.parse(JSON.stringify(contract)) as JsonObject;
}
