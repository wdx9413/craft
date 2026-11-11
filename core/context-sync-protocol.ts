import type { JsonObject } from "./infrastructure/store.ts";

/**
 * 外部知识库 / 云盘同步的最小协议。
 *
 * 设计边界：
 * - 本地 `craft_data` 永远是权威数据；远端只是 Markdown 镜像/备份，不参与裁决。
 * - 不写腾讯/阿里/百度/各云盘专用 SDK：它们通过三类通用传输接入
 *   （本地挂载目录、WebDAV、通用 HTTP 对象接口），差异留给 adapter 配置。
 * - 协议只描述「文件名 + 内容摘要 + 更新时间」三元组，避免把远端目录结构
 *   变成第二套事实来源；冲突策略固定为 local_wins / remote_wins / manual。
 * - 凭据只从环境变量读取，绝不写进 settings.json。
 */
export const CONTEXT_SYNC_PROTOCOLS = ["local_dir", "webdav", "http_object", "custom"] as const;
export type ContextSyncProtocol = typeof CONTEXT_SYNC_PROTOCOLS[number];
export const CONTEXT_SYNC_CONFLICTS = ["local_wins", "remote_wins", "manual"] as const;
export type ContextSyncConflict = typeof CONTEXT_SYNC_CONFLICTS[number];
export const CONTEXT_SYNC_KINDS = ["memory", "knowledge", "experience"] as const;
export type ContextSyncKind = typeof CONTEXT_SYNC_KINDS[number];

export interface ContextSyncTarget {
  enabled: boolean;
  protocol: ContextSyncProtocol;
  /** local_dir: 绝对路径；webdav/http_object: HTTPS URL；custom: adapter 自定义。 */
  endpoint: string;
  /** 远端子目录，三类知识分别落在 knowledge/ memory/ experience/ 下。 */
  remoteRoot: string;
  tokenEnv: string;
  intervalMs: number;
  conflict: ContextSyncConflict;
  /** 只同步这三类中的选中项；空数组表示全同步。 */
  kinds: ContextSyncKind[];
}

export interface ContextSyncEntry {
  kind: ContextSyncKind;
  /** 相对文件名，不含路径分隔符；由 slug 生成。 */
  name: string;
  digest: string;
  updatedAt: string;
}

export interface ContextSyncStatus {
  ok: boolean;
  protocol: ContextSyncProtocol;
  detail: string | null;
  pushed: number;
  pulled: number;
  conflicts: number;
}

export const DEFAULT_CONTEXT_SYNC: ContextSyncTarget = {
  enabled: false,
  protocol: "local_dir",
  endpoint: "",
  remoteRoot: "craft_data",
  tokenEnv: "CRAFT_CONTEXT_SYNC_TOKEN",
  intervalMs: 300_000,
  conflict: "local_wins",
  kinds: [],
};

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/u;
const REMOTE_ROOT = /^[A-Za-z0-9_.\-/]{1,128}$/u;

function stringValue(value: unknown, name: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

/** 校验并归一化一个同步目标；失败时 fail-closed，不返回半配置。 */
export function normalizeContextSync(value: unknown): ContextSyncTarget {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (typeof input.enabled !== "undefined" && typeof input.enabled !== "boolean") throw new Error("contextSync.enabled must be a boolean");
  const enabled = input.enabled === true;
  const protocol = stringValue(input.protocol, "contextSync.protocol", DEFAULT_CONTEXT_SYNC.protocol) as ContextSyncProtocol;
  if (!(CONTEXT_SYNC_PROTOCOLS as readonly string[]).includes(protocol)) throw new Error("contextSync.protocol is unsupported");
  const conflict = stringValue(input.conflict, "contextSync.conflict", DEFAULT_CONTEXT_SYNC.conflict) as ContextSyncConflict;
  if (!(CONTEXT_SYNC_CONFLICTS as readonly string[]).includes(conflict)) throw new Error("contextSync.conflict is unsupported");
  const endpoint = input.endpoint === undefined || input.endpoint === null || input.endpoint === ""
    ? "" : stringValue(input.endpoint, "contextSync.endpoint", "");
  const remoteRoot = stringValue(input.remoteRoot, "contextSync.remoteRoot", DEFAULT_CONTEXT_SYNC.remoteRoot);
  if (!REMOTE_ROOT.test(remoteRoot) || remoteRoot.includes("..")) throw new Error("contextSync.remoteRoot must be a bounded relative path");
  const tokenEnv = stringValue(input.tokenEnv, "contextSync.tokenEnv", DEFAULT_CONTEXT_SYNC.tokenEnv);
  if (!ENV_NAME.test(tokenEnv)) throw new Error("contextSync.tokenEnv must be an environment variable name");
  if (protocol === "webdav" || protocol === "http_object") {
    if (endpoint) {
      let url: URL;
      try { url = new URL(endpoint); } catch { throw new Error("contextSync.endpoint must be a valid HTTP(S) URL for remote protocols"); }
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("contextSync.endpoint must be HTTP(S)");
    }
  }
  if (enabled && !endpoint) throw new Error("contextSync.endpoint is required when enabled");
  const kinds: ContextSyncKind[] = [];
  if (input.kinds !== undefined) {
    if (!Array.isArray(input.kinds)) throw new Error("contextSync.kinds must be an array");
    for (const kind of input.kinds) {
      if (!(CONTEXT_SYNC_KINDS as readonly string[]).includes(String(kind))) throw new Error("contextSync.kinds has an unsupported member");
      kinds.push(kind as ContextSyncKind);
    }
  }
  return {
    enabled,
    protocol,
    endpoint,
    remoteRoot,
    tokenEnv,
    intervalMs: integer(input.intervalMs, "contextSync.intervalMs", DEFAULT_CONTEXT_SYNC.intervalMs, 10_000, 86_400_000),
    conflict,
    kinds: [...new Set(kinds)],
  };
}

/** 远端对象键：固定三段，避免厂商目录结构泄漏进内核。 */
export function contextSyncKey(target: ContextSyncTarget, entry: ContextSyncEntry): string {
  return `${target.remoteRoot.replace(/^\/+|\/+$/gu, "")}/${entry.kind}/${entry.name}`;
}

/** 只返回脱敏后的投影，供 UI / Doctor 读取。 */
export function contextSyncProjection(target: ContextSyncTarget): JsonObject {
  return {
    enabled: target.enabled, protocol: target.protocol, endpoint: target.endpoint,
    remote_root: target.remoteRoot, token_env: target.tokenEnv,
    interval_ms: target.intervalMs, conflict: target.conflict, kinds: target.kinds,
    credentials_stored: false,
    local_authoritative: true,
  };
}
