/**
 * 消息监听层（纯工程：监听 / 解析 / 本地存储，0 Token）。
 *
 * NEEDREAD 末段要求把「邮箱 / 微信 / 钉钉 / Slack」等外部消息源以插件的形态嵌入
 * 三模架构。核心原则是「能用工程代码搞定的绝不用 AI」：监听、拉取、解析、去重、
 * 落库全程纯工程，界面渲染与摘要也 0 Token；只有用户显式「智能处理」才派发 Worker。
 *
 * 本模块实现两类适配器：
 *  - `LocalDropAdapter`：监听一个本地 / 挂载的云目录（放置 .json / .md 消息文件），
 *    用于「连接云电脑上的目录」这类场景；完全离线、可单测。
 *  - `ImapAdapter` / `WebhookAdapter`：真实协议入口，无配置时诚实报错，不在测试里联网。
 *
 * 监听器只负责把原始消息交给注入的 `ingest(raw)` 回调（即 `messageIngest` 门禁：
 * 来源白名单 + 字段归一 + datasec 脱敏），自己从不调用模型。
 */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface RawMessage {
  /** Stable id from the source (filename hash, IMAP uid, webhook event id). */
  externalId: string;
  source: "email" | "im" | "webhook" | "other";
  from: string;
  subject: string;
  summary: string;
  priority?: "low" | "normal" | "high";
  receivedAt?: string;
}

export type IngestFn = (raw: RawMessage) => unknown;

const MAX_MESSAGE_BYTES = 1024 * 1024;

/** Read only a bounded regular file, without following the final symlink. */
function readMessageFile(path: string): string {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("unsafe message file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error("message file changed");
    if (opened.size > MAX_MESSAGE_BYTES) throw new Error("message file too large");
    const buffer = Buffer.allocUnsafe(MAX_MESSAGE_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used > MAX_MESSAGE_BYTES) throw new Error("message file too large");
    return buffer.subarray(0, used).toString("utf8");
  } finally { closeSync(fd); }
}

export interface SourceAdapter {
  readonly id: string;
  /** Pull currently-available messages; may be async but must not call a model. */
  poll(): Promise<RawMessage[]>;
  /** Make messages that were not ingested available on a later poll. */
  retry?(messages: RawMessage[]): void;
  /** Diagnostics from the most recent poll, without message contents. */
  diagnostics?(): { failed: number; errors: string[] };
}

/**
 * Local-drop adapter: a directory of message files. Files are read once; a file
 * is "new" when its content hash was not seen in the previous poll of this
 * adapter instance, so re-running is idempotent and never double-ingests.
 */
export class LocalDropAdapter implements SourceAdapter {
  readonly id: string;
  private readonly dir: string;
  private seen: Set<string>;
  private failures = 0;
  private errors: string[] = [];
  constructor(dir: string, id = `drop:${dir}`) {
    // Do not throw here: a missing/unreadable source must be reported by the
    // listener as one failed adapter, not abort the whole poll. Validation is
    // deferred to poll() so the error is captured per source.
    this.dir = dir;
    this.id = id;
    this.seen = new Set();
  }
  /** Pre-mark already-known content so the first poll does not ingest the backlog. */
  prime(knownHashes: Iterable<string>): void { for (const h of knownHashes) this.seen.add(h); }
  async poll(): Promise<RawMessage[]> {
    this.failures = 0;
    this.errors = [];
    if (!existsSync(this.dir) || !statSync(this.dir).isDirectory()) {
      throw new Error(`drop directory does not exist: ${this.dir}`);
    }
    const out: RawMessage[] = [];
    for (const name of readdirSync(this.dir).sort()) {
      const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      if (ext !== "json" && ext !== "md") continue;
      try {
        const full = join(this.dir, name);
        if (lstatSync(full).isDirectory()) continue;
        const raw = readMessageFile(full);
        const hash = createHash("sha256").update(raw).digest("hex").slice(0, 16);
        // Identical content in different files represents different messages.
        const fileKey = `${name}#${hash}`;
        if (this.seen.has(fileKey)) continue;
        const parsed = ext === "json" ? parseJsonMessage(raw, name) : parseMarkdownMessage(raw, name);
        out.push({ ...parsed, externalId: `${this.id}#${fileKey}` });
      } catch {
        this.failures++;
        if (this.errors.length < 20) this.errors.push(`无法读取或解析消息文件: ${name.slice(0, 200)}`);
      }
    }
    for (const message of out) this.seen.add(message.externalId.slice(this.id.length + 1));
    return out;
  }
  diagnostics(): { failed: number; errors: string[] } { return { failed: this.failures, errors: [...this.errors] }; }
  retry(messages: RawMessage[]): void {
    const prefix = `${this.id}#`;
    for (const message of messages) if (message.externalId.startsWith(prefix)) this.seen.delete(message.externalId.slice(prefix.length));
  }
}

function parseJsonMessage(raw: string, name: string): RawMessage {
  let data: Record<string, unknown>;
  try { data = JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new Error(`invalid JSON message file: ${name}`); }
  const source = data.source === "email" || data.source === "im" || data.source === "webhook" ? data.source : "other";
  const from = typeof data.from === "string" && data.from.trim() ? data.from.trim() : "unknown";
  const subject = typeof data.subject === "string" ? data.subject : "";
  const summary = typeof data.summary === "string" ? data.summary : "";
  const priority = data.priority === "low" || data.priority === "high" ? data.priority : "normal";
  const receivedAt = typeof data.receivedAt === "string" ? data.receivedAt : (typeof data.received_at === "string" ? data.received_at : undefined);
  return { externalId: name, source, from, subject, summary, priority, receivedAt };
}

function parseMarkdownMessage(raw: string, name: string): RawMessage {
  const lines = raw.split(/\r?\n/u);
  let from = "unknown";
  let subject = name.replace(/\.md$/u, "");
  const body: string[] = [];
  let inFront = false;
  for (const line of lines) {
    const fm = /^(from|subject):\s*(.*)$/u.exec(line);
    if (line.trim() === "---") { inFront = !inFront; continue; }
    if (inFront && fm) {
      if (fm[1] === "from") from = fm[2].trim();
      else subject = fm[2].trim();
      continue;
    }
    if (!inFront) body.push(line);
  }
  return { externalId: name, source: "email", from, subject, summary: body.join("\n").trim(), priority: "normal" };
}

/**
 * IMAP / Webhook adapters are the real-protocol entry points. They require
 * explicit credentials and a reachable server, so without configuration they
 * fail loudly instead of silently swallowing messages. The polling loop itself
 * stays protocol-agnostic via the `SourceAdapter` contract.
 */
export class ImapAdapter implements SourceAdapter {
  readonly id = "imap";
  private readonly config: { host?: string; user?: string };
  constructor(config: { host?: string; user?: string } = {}) { this.config = config; }
  async poll(): Promise<RawMessage[]> {
    if (!this.config.host || !this.config.user) throw new Error("IMAP adapter requires host and user configuration");
    throw new Error("IMAP adapter requires a live mail server; wire fetch/imap behind this guard to enable");
  }
}

export class MessageListener {
  private readonly adapters: SourceAdapter[];
  private readonly ingest: IngestFn;
  /** externalId -> last ingested hash, for cross-run dedup if the caller persists it. */
  private readonly ingested: Map<string, string> = new Map();
  constructor(adapters: SourceAdapter[], ingest: IngestFn) {
    this.adapters = adapters;
    this.ingest = ingest;
  }
  /** Register previously-ingested external ids so a restart does not re-ingest. */
  primeIngested(ids: Iterable<string>): void { for (const id of ids) this.ingested.set(id, "primed"); }
  get adapterCount(): number { return this.adapters.length; }
  /**
   * Poll every adapter once and ingest each unseen message through the gate.
   * Returns a per-source report; a failing adapter is reported, never thrown, so
   * one dead source does not block the others (engineering resilience, 0 Token).
   */
  async pollAll(): Promise<{ source: string; ingested: number; error?: string; failed?: number; errors?: string[] }[]> {
    const reports: { source: string; ingested: number; error?: string; failed?: number; errors?: string[] }[] = [];
    for (const adapter of this.adapters) {
      let ingested = 0;
      let ingestFailures = 0;
      const ingestErrors: string[] = [];
      try {
        const messages = await adapter.poll();
        for (let index = 0; index < messages.length; index++) {
          const message = messages[index];
          if (this.ingested.has(message.externalId)) continue;
          let result: unknown;
          try { result = this.ingest(message); }
          catch (error) {
            adapter.retry?.([message]);
            ingestFailures++;
            if (ingestErrors.length < 20) ingestErrors.push(error instanceof Error ? error.message.slice(0, 200) : "消息入库失败");
            continue;
          }
          this.ingested.set(message.externalId, "ingested");
          if (result !== false) ingested++;
        }
        const diagnostics = adapter.diagnostics?.();
        const failed = ingestFailures + (diagnostics?.failed ?? 0);
        const errors = [...(diagnostics?.errors ?? []), ...ingestErrors].slice(0, 20);
        reports.push({ source: adapter.id, ingested, ...(failed > 0 ? { failed, errors } : {}) });
      } catch (error) {
        reports.push({ source: adapter.id, ingested, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return reports;
  }
}
