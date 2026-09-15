import { createHash } from "node:crypto";

export interface RemoteMcpPrincipal {
  subject: string;
  issuer: string;
  audience: string;
  scopes: string[];
  expires_at: string;
  client_id?: string;
}

export interface RemoteMcpAccessReceipt {
  status: "accepted";
  audience: string;
  scopes: string[];
  subject_digest: string;
  client_id_digest: string | null;
  expires_at: string;
  authorized_at: string;
  token_stored: false;
}

export class RemoteMcpAccessError extends Error {
  readonly statusCode: 401 | 429;
  constructor(message: string, statusCode: 401 | 429 = 401) { super(message); this.name = "RemoteMcpAccessError"; this.statusCode = statusCode; }
}

export interface RemoteMcpAccessPolicyOptions {
  issuer: string;
  audience: string;
  requiredScopes?: string[];
  requestsPerMinute?: number;
  now?: () => string;
  verifyAccessToken?: (token: string) => Promise<RemoteMcpPrincipal>;
}

export interface RemoteMcpAccessRequest {
  authorization: string | string[] | undefined;
  secure_transport: boolean;
}

function requiredText(value: string, name: string): string {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}

function digest(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

function scopes(values: readonly string[]): string[] {
  const result = values.map((value) => requiredText(value, "scope"));
  if (new Set(result).size !== result.length) throw new Error("requiredScopes must be unique");
  return result.sort();
}

/**
 * A fail-closed authorization seam for a remotely exposed MCP HTTP endpoint.
 * Token validation belongs to the deployer's OIDC/OAuth broker. Craft only
 * checks the verified principal's issuer, audience, scope, expiry and budget.
 */
export class RemoteMcpAccessPolicy {
  readonly issuer: string;
  readonly audience: string;
  readonly requiredScopes: string[];
  readonly requestsPerMinute: number;
  readonly now: () => string;
  readonly verifyAccessToken: ((token: string) => Promise<RemoteMcpPrincipal>) | undefined;
  readonly #windows = new Map<string, { startedAt: number; count: number }>();

  constructor(options: RemoteMcpAccessPolicyOptions) {
    this.issuer = requiredText(options.issuer, "issuer");
    this.audience = requiredText(options.audience, "audience");
    this.requiredScopes = scopes(options.requiredScopes ?? []);
    this.requestsPerMinute = options.requestsPerMinute ?? 60;
    if (!Number.isInteger(this.requestsPerMinute) || this.requestsPerMinute < 1) throw new Error("requestsPerMinute must be a positive integer");
    this.now = options.now ?? (() => new Date().toISOString());
    this.verifyAccessToken = options.verifyAccessToken;
  }

  async authorize(request: RemoteMcpAccessRequest): Promise<RemoteMcpAccessReceipt> {
    if (!request.secure_transport) throw new RemoteMcpAccessError("Remote MCP access requires secure transport");
    if (typeof request.authorization !== "string") throw new RemoteMcpAccessError("Remote MCP access requires one Bearer token");
    const matched = /^Bearer ([^\s]+)$/u.exec(request.authorization);
    if (!matched) throw new RemoteMcpAccessError("Remote MCP access requires a Bearer token");
    if (!this.verifyAccessToken) throw new RemoteMcpAccessError("Remote MCP access verifier is not configured");
    const principal = await this.verifyAccessToken(matched[1]!);
    this.validate(principal);
    this.consumeRate(principal);
    const authorizedAt = this.timestamp();
    return {
      status: "accepted", audience: this.audience, scopes: [...this.requiredScopes], subject_digest: digest(principal.subject),
      client_id_digest: principal.client_id ? digest(principal.client_id) : null, expires_at: principal.expires_at,
      authorized_at: authorizedAt, token_stored: false,
    };
  }

  private validate(principal: RemoteMcpPrincipal): void {
    requiredText(principal.subject, "principal.subject");
    if (principal.issuer !== this.issuer) throw new RemoteMcpAccessError("Remote MCP issuer does not match");
    if (principal.audience !== this.audience) throw new RemoteMcpAccessError("Remote MCP audience does not match");
    if (!Array.isArray(principal.scopes) || this.requiredScopes.some((scope) => !principal.scopes.includes(scope))) throw new RemoteMcpAccessError("Remote MCP scope is insufficient");
    const expiresAt = Date.parse(principal.expires_at);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.parse(this.timestamp())) throw new RemoteMcpAccessError("Remote MCP token is expired");
  }

  private consumeRate(principal: RemoteMcpPrincipal): void {
    const now = Date.parse(this.timestamp()); const key = `${principal.subject}:${principal.client_id ?? ""}`;
    const prior = this.#windows.get(key); const current = !prior || now - prior.startedAt >= 60_000 ? { startedAt: now, count: 0 } : prior;
    if (current.count >= this.requestsPerMinute) throw new RemoteMcpAccessError("Remote MCP request rate exceeded", 429);
    current.count += 1; this.#windows.set(key, current);
  }

  private timestamp(): string {
    const value = this.now();
    if (!Number.isFinite(Date.parse(value))) throw new Error("Remote MCP clock must return an ISO timestamp");
    return value;
  }
}
