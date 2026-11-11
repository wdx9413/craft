import type { SourceAdapter, RawMessage } from "./message-listener.ts";

/**
 * 只读 GitHub 远程消息源：把仓库 issue / PR 当收件箱消息拉取。
 *
 * 安全边界：
 * - 只做 GET，不创建/回复/关闭任何远端对象；
 * - token 只从注入的 env 读取，绝不写进 settings.json 或消息库；
 * - 响应体与条数都有界，失败按源上报而不是阻塞其它源；
 * - externalId 用仓库 + 编号，配合 `message_seen` 实现跨重启去重。
 */
export interface GitHubSourceOptions {
  repo: string;
  apiBaseUrl?: string;
  tokenEnv?: string;
  state?: "issues" | "pull_requests" | "all";
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  maxItems?: number;
}

type GitHubItem = {
  number?: number;
  title?: string;
  body?: string | null;
  user?: { login?: string } | null;
  html_url?: string;
  updated_at?: string;
  pull_request?: unknown;
};

export class GitHubIssueSourceAdapter implements SourceAdapter {
  readonly id: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly tokenEnv: string;
  private readonly state: "issues" | "pull_requests" | "all";
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private errors: string[] = [];
  private failures = 0;

  constructor(options: GitHubSourceOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repo)) throw new Error("GitHub repo must be owner/repo");
    this.repo = options.repo;
    this.id = `github:${options.repo}`;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/u, "");
    this.tokenEnv = options.tokenEnv ?? "GITHUB_TOKEN";
    this.state = options.state ?? "issues";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.env = options.env ?? process.env;
    this.now = options.now ?? (() => new Date().toISOString());
    this.maxItems = Math.max(1, Math.min(options.maxItems ?? 30, 100));
  }
  private readonly now: () => string;
  private readonly maxItems: number;

  diagnostics(): { failed: number; errors: string[] } { return { failed: this.failures, errors: [...this.errors] }; }

  async poll(): Promise<RawMessage[]> {
    this.errors = [];
    this.failures = 0;
    const token = this.env[this.tokenEnv];
    if (!token) throw new Error(`GitHub source requires ${this.tokenEnv} in the environment`);
    const endpoint = `${this.apiBaseUrl}/repos/${this.repo}/issues?state=open&per_page=${this.maxItems}`;
    const response = await this.fetchImpl(endpoint, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "craft-message-source", Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub source returned HTTP ${response.status}`);
    const raw = await response.text();
    if (raw.length > 2_000_000) throw new Error("GitHub source response too large");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("GitHub source response must be an array");
    const out: RawMessage[] = [];
    for (const entry of parsed as GitHubItem[]) {
      if (!entry || typeof entry !== "object" || typeof entry.number !== "number") continue;
      const isPull = Boolean(entry.pull_request);
      if (this.state === "issues" && isPull) continue;
      if (this.state === "pull_requests" && !isPull) continue;
      const title = typeof entry.title === "string" ? entry.title.slice(0, 4_000) : "";
      const body = typeof entry.body === "string" ? entry.body.slice(0, 4_000) : "";
      out.push({
        externalId: `${this.id}#${entry.number}`,
        source: "webhook",
        from: typeof entry.user?.login === "string" ? entry.user.login.slice(0, 200) : "github",
        subject: `${isPull ? "PR" : "Issue"} #${entry.number}: ${title}`,
        summary: body,
        priority: "normal",
        receivedAt: typeof entry.updated_at === "string" ? entry.updated_at : this.now(),
      });
    }
    return out;
  }
}
