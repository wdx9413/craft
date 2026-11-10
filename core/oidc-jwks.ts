import { createPublicKey, verify } from "node:crypto";
import type { RemoteMcpPrincipal } from "./remote-mcp-access.ts";
import { text } from "./validation.ts";

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface OidcJwksVerifierOptions {
  issuer: string;
  audience: string;
  /** Explicit JWKS endpoint is useful behind a private issuer gateway. */
  jwksUrl?: string;
  fetch?: FetchLike;
  now?: () => number;
  cacheTtlMs?: number;
}



function httpsUrl(value: string, name: string): string {
  const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password) throw new Error(`${name} must be an HTTPS URL without credentials`);
  return url.toString();
}

function decode(part: string, name: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error(`OIDC token ${name} is not valid JSON`); }
}

function audience(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value as string[];
  throw new Error("OIDC token audience is invalid");
}

function scopes(value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value !== "string") throw new Error("OIDC token scope is invalid");
  return value.split(/\s+/u).filter(Boolean).sort();
}

function jwksEndpoint(issuer: string): string { return `${issuer.replace(/\/$/u, "")}/.well-known/jwks.json`; }

/**
 * Small RS256 resource-server verifier for the optional Craft MCP reference
 * deployment. It intentionally performs no OAuth login or token exchange:
 * those are Authorization Server/Broker responsibilities. Network failure,
 * unknown key and unsupported algorithms all fail closed.
 */
export function createOidcJwksVerifier(options: OidcJwksVerifierOptions): (token: string) => Promise<RemoteMcpPrincipal> {
  const issuer = httpsUrl(text(options.issuer, "issuer"), "issuer"); const targetAudience = text(options.audience, "audience");
  const endpoint = httpsUrl(options.jwksUrl ?? jwksEndpoint(issuer), "jwksUrl"); const fetchImpl = options.fetch ?? fetch as unknown as FetchLike;
  const now = options.now ?? Date.now; const cacheTtlMs = options.cacheTtlMs ?? 300_000;
  if (!Number.isInteger(cacheTtlMs) || cacheTtlMs < 1) throw new Error("cacheTtlMs must be a positive integer");
  let cache: { expires: number; keys: Record<string, unknown>[] } | null = null;

  async function keys(): Promise<Record<string, unknown>[]> {
    if (cache && now() < cache.expires) return cache.keys;
    const response = await fetchImpl(endpoint, { method: "GET", headers: { accept: "application/json" } });
    if (response.status < 200 || response.status >= 300) throw new Error(`OIDC JWKS HTTP ${response.status}`);
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray((body as Record<string, unknown>).keys)) throw new Error("OIDC JWKS response is invalid");
    const values = (body as { keys: unknown[] }).keys;
    if (!values.length || values.some((key) => !key || typeof key !== "object" || Array.isArray(key))) throw new Error("OIDC JWKS response has no usable keys");
    cache = { expires: now() + cacheTtlMs, keys: values as Record<string, unknown>[] };
    return cache.keys;
  }

  return async (token: string): Promise<RemoteMcpPrincipal> => {
    const parts = text(token, "token").split("."); if (parts.length !== 3) throw new Error("OIDC token must be a compact JWT");
    const header = decode(parts[0]!, "header"); const claims = decode(parts[1]!, "claims");
    if (header.alg !== "RS256") throw new Error("OIDC token algorithm is unsupported"); const kid = text(header.kid, "OIDC token kid");
    const key = (await keys()).find((candidate) => candidate.kid === kid && candidate.kty === "RSA"); if (!key) throw new Error("OIDC token key is unknown");
    let valid = false;
    try { valid = verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2]!, "base64url")); }
    catch { throw new Error("OIDC token key is invalid"); }
    if (!valid) throw new Error("OIDC token signature is invalid");
    if (claims.iss !== issuer) throw new Error("OIDC token issuer does not match");
    if (!audience(claims.aud).includes(targetAudience)) throw new Error("OIDC token audience does not match");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp * 1_000 <= now()) throw new Error("OIDC token is expired");
    return { subject: text(claims.sub, "OIDC token subject"), issuer, audience: targetAudience, scopes: scopes(claims.scope), expires_at: new Date(claims.exp * 1_000).toISOString(), ...(typeof claims.client_id === "string" ? { client_id: claims.client_id } : {}) };
  };
}
