import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { ContextSyncStatus, ContextSyncTarget, ContextSyncEntry } from "./context-sync-protocol.ts";
import { contextSyncKey } from "./context-sync-protocol.ts";

export interface ContextSyncDocument { key: string; body: string; digest: string; }
export interface ContextSyncAdapter {
  readonly protocol: ContextSyncTarget["protocol"];
  /** 列出远端已有对象；只读，不改变本地。 */
  list(): Promise<ContextSyncDocument[]>;
  /** 写入一个 Markdown 对象；返回是否发生覆盖。 */
  put(document: ContextSyncDocument): Promise<boolean>;
}

function digest(body: string): string {
  return `sha256:${createHash("sha256").update(body).digest("hex")}`;
}

export function contextSyncDocument(target: ContextSyncTarget, entry: ContextSyncEntry, body: string): ContextSyncDocument {
  return { key: contextSyncKey(target, entry), body, digest: digest(body) };
}

/**
 * 本地/挂载目录 adapter：Obsidian vault、云盘同步文件夹、网络挂载都走这一类。
 * 真实写盘但只写 `remoteRoot/<kind>/`，不触碰 craft_data 本地库。
 */
export class LocalDirContextSyncAdapter implements ContextSyncAdapter {
  readonly protocol = "local_dir" as const;
  private readonly root: string;
  private readonly target: ContextSyncTarget;
  constructor(target: ContextSyncTarget) {
    this.target = target;
    if (!target.endpoint) throw new Error("local_dir sync requires an absolute endpoint directory");
    this.root = resolve(target.endpoint);
  }
  async list(): Promise<ContextSyncDocument[]> {
    const out: ContextSyncDocument[] = [];
    const base = join(this.root, this.target.remoteRoot);
    if (!existsSync(base)) return out;
    for (const kind of ["memory", "knowledge", "experience"] as const) {
      const dir = join(base, kind);
      if (!existsSync(dir)) continue;
      const { readdirSync } = await import("node:fs");
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const file = join(dir, name);
        const body = readFileSync(file, "utf8");
        out.push({ key: `${this.target.remoteRoot}/${kind}/${name}`, body, digest: digest(body) });
      }
    }
    return out;
  }
  async put(document: ContextSyncDocument): Promise<boolean> {
    const file = join(this.root, document.key);
    const existed = existsSync(file);
    const previous = existed ? readFileSync(file, "utf8") : null;
    mkdirSync(dirname(file), { recursive: true });
    if (previous !== null && digest(previous) === document.digest) return false;
    writeFileSync(file, document.body, "utf8");
    return existed;
  }
}

/**
 * 通用 HTTP / WebDAV adapter 只读骨架：没有 token 时诚实报错，不在测试里联网。
 * 腾讯/阿里/百度网盘、对象存储、自建 WebDAV 都通过 endpoint + tokenEnv 接入；
 * 具体 PUT/GET 由部署侧的兼容网关实现，内核不内置任何厂商 SDK。
 */
export class RemoteContextSyncAdapter implements ContextSyncAdapter {
  readonly protocol: ContextSyncTarget["protocol"];
  private readonly target: ContextSyncTarget;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  constructor(target: ContextSyncTarget, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch) {
    this.target = target;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.protocol = target.protocol;
  }
  private headers(): Record<string, string> {
    const token = this.env[this.target.tokenEnv];
    if (!token) throw new Error(`context sync requires ${this.target.tokenEnv} in the environment`);
    return { Authorization: `Bearer ${token}`, "Content-Type": "text/markdown" };
  }
  private url(key = ""): string {
    return `${this.target.endpoint.replace(/\/+$/u, "")}/${key}`.replace(/\/+$/u, "");
  }
  async list(): Promise<ContextSyncDocument[]> {
    // 远端目录列举依赖厂商差异；协议只要求返回 [{key, digest}]，
    // 无统一列表接口时返回空数组，push 仍可完成单向备份。
    this.headers();
    const response = await this.fetchImpl(this.url(`${this.target.remoteRoot}/index.json`), { method: "GET", headers: { Authorization: this.headers().Authorization }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [];
    const raw = await response.text();
    if (raw.length > 1_000_000) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is { key: string; digest: string } =>
      Boolean(item) && typeof item === "object" && typeof (item as { key?: unknown }).key === "string" && typeof (item as { digest?: unknown }).digest === "string")
      .map((item) => ({ key: String(item.key), body: "", digest: String(item.digest) }));
  }
  async put(document: ContextSyncDocument): Promise<boolean> {
    const response = await this.fetchImpl(this.url(document.key), {
      method: "PUT", headers: this.headers(), body: document.body, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`context sync remote returned HTTP ${response.status}`);
    return false;
  }
}

export function contextSyncAdapter(target: ContextSyncTarget, env?: NodeJS.ProcessEnv, fetchImpl?: typeof fetch): ContextSyncAdapter {
  if (target.protocol === "local_dir") return new LocalDirContextSyncAdapter(target);
  if (target.protocol === "webdav" || target.protocol === "http_object") return new RemoteContextSyncAdapter(target, env, fetchImpl);
  throw new Error(`context sync protocol ${target.protocol} requires a custom adapter`);
}

/** 单向备份：本地权威，按冲突策略决定是否覆盖远端。 */
export async function runContextSync(target: ContextSyncTarget, documents: ContextSyncDocument[], adapter = contextSyncAdapter(target)): Promise<ContextSyncStatus> {
  const base: ContextSyncStatus = { ok: true, protocol: target.protocol, detail: null, pushed: 0, pulled: 0, conflicts: 0 };
  if (!target.enabled) return { ...base, detail: "context sync is disabled" };
  try {
    const remote = await adapter.list();
    const remoteByKey = new Map(remote.map((item) => [item.key, item]));
    for (const document of documents) {
      const existing = remoteByKey.get(document.key);
      if (existing && existing.digest !== document.digest) {
        base.conflicts += 1;
        if (target.conflict === "remote_wins" || target.conflict === "manual") continue;
      }
      if (existing && existing.digest === document.digest) continue;
      await adapter.put(document);
      base.pushed += 1;
    }
    return base;
  } catch (error) {
    return { ...base, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
