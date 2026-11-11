import type { JsonObject } from "./infrastructure/store.ts";

/**
 * 领航员（Pilot / Workbench `pilot` 模式）只能用 Craft 内置执行器。
 *
 * 这是产品边界，不是宿主能力清单：其它模式仍可读取/配置 Codex、Claude、DSH
 * 等 Host，但领航员 intake、路由与派发不得把任务交给它们。
 */
export const PILOT_CRAFT_ONLY_HOSTS = ["craft", "craft-internal"] as const;

export type PilotPolicyViolation = {
  code: "PILOT_CRAFT_ONLY";
  requested: string;
  allowed_hosts: readonly string[];
  message: string;
};

export function pilotPolicyViolation(requested: string): PilotPolicyViolation {
  return {
    code: "PILOT_CRAFT_ONLY",
    requested,
    allowed_hosts: PILOT_CRAFT_ONLY_HOSTS,
    message: `领航员只允许使用 Craft；收到禁止的执行器 ${requested}`,
  };
}

/** 规范化领航员执行器名，外部 CLI 名称一律拒绝。 */
export function assertPilotCraftOnly(value: unknown, field = "executor_template"): string {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) return "craft";
  if ((PILOT_CRAFT_ONLY_HOSTS as readonly string[]).includes(requested)) return "craft";
  throw Object.assign(new Error(`领航员只允许使用 Craft：${field} 不能是 ${requested}`), pilotPolicyViolation(requested));
}

/** 校验 task split 数组里每个 executor_template，并统一改写为 craft。 */
export function enforcePilotSplitCraftOnly(split: unknown, field = "split"): JsonObject[] {
  if (!Array.isArray(split)) throw new Error(`${field} must be an array`);
  return split.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`${field}[${index}] must be an object`);
    const item = entry as JsonObject;
    if (item.executor_template !== undefined && item.executor_template !== null && String(item.executor_template).trim()) {
      assertPilotCraftOnly(item.executor_template, `${field}[${index}].executor_template`);
    }
    return { ...item, executor_template: "craft" };
  });
}
