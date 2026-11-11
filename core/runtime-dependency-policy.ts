import { loadSettingsSync, type CraftSettings, type RuntimeDependencyConfig } from "./settings.ts";
import { PLUGIN_HOST_PRIORITY } from "./plugin-adapters.ts";

/**
 * Craft 内核默认只使用自己配置好的模型（settings.json 的 models）。
 *
 * Codex CLI / Claude CLI / DSH CLI 不再是默认执行宿主；它们只作为「插件来源」
 * 被 `plugin-adapters.ts` 归一化。是否重新启用原生 CLI 驱动是显式的、默认关闭
 * 的运维开关，避免把外部 CLI 的登录态当成模型凭据。
 */
export interface RuntimeDependencyPolicy {
  externalCliDrivers: boolean;
  hostManagedAuthProvider: boolean;
  configuredModelOnly: boolean;
  pluginAdapterPriority: readonly ("codex" | "claude" | "dsh" | "pi" | "craft" | "generic")[];
}

/** 唯一来源是 plugin-adapters；此处只做别名，避免两处顺序漂移。 */
export const DEFAULT_PLUGIN_ADAPTER_PRIORITY = PLUGIN_HOST_PRIORITY;

export function runtimeDependencyPolicy(settings: CraftSettings = loadSettingsSync()): RuntimeDependencyPolicy {
  const raw: RuntimeDependencyConfig = settings.runtimeDependencies;
  return {
    externalCliDrivers: raw.externalCliDrivers === true,
    hostManagedAuthProvider: raw.hostManagedAuthProvider === true,
    configuredModelOnly: raw.configuredModelOnly !== false,
    pluginAdapterPriority: DEFAULT_PLUGIN_ADAPTER_PRIORITY,
  };
}
