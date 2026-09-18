import { createHash } from "node:crypto";
import { CraftStore, type JsonObject } from "./store.ts";
import { buildChatRequest, credentialStatus, type ModelProviderSpec, type ModelTransport } from "./model-gateway.ts";

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

/** Keyless model health seam. A probe is evidence of reachability only, never a quality claim. */
export class RuntimeModelProbeKernel {
  readonly store: CraftStore; readonly providers: readonly ModelProviderSpec[]; readonly transport: ModelTransport | null;
  constructor(store: CraftStore, providers: readonly ModelProviderSpec[], transport: ModelTransport | null = null) { this.store = store; this.providers = providers; this.transport = transport; }

  status(): JsonObject {
    return { providers: this.providers.map((provider) => ({ ...credentialStatus(provider), model: provider.models.standard ?? provider.models.frontier ?? provider.models.small ?? null, supports_tools: provider.supports_tools })) };
  }

  async probe(args: JsonObject): Promise<JsonObject> {
    const providerId = args.provider === undefined ? this.providers[0]?.provider : text(args.provider, "provider");
    const provider = this.providers.find((item) => item.provider === providerId);
    if (!provider) throw new Error("Model provider is not declared");
    const model = provider.models.standard ?? provider.models.frontier ?? provider.models.small;
    if (!model) throw new Error("Model provider has no usable model");
    const probeId = String(args.probe_id ?? `model_probe_${provider.provider}_${digest({ provider: provider.provider, model }).slice(-16)}`);
    const existing = this.store.find("runtime_model_probe", probeId);
    if (existing && args.refresh !== true) return { probe: existing, idempotent: true };
    const configured = credentialStatus(provider).configured;
    let status = "unavailable"; let reason = configuredReason(provider);
    if (configured && this.transport) {
      try {
        const request = buildChatRequest(provider, { model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 4, temperature: 0 });
        const result = await this.transport.complete(provider, request);
        status = result.text.trim() ? "available" : "unavailable"; reason = status === "available" ? "model_replied" : "empty_model_response";
      } catch (error) { reason = error instanceof Error ? error.message.replace(/\s+/gu, " ").slice(0, 240) : "model_probe_failed"; }
    }
    const record = { provider: provider.provider, model, configured, status, reason, checked_at: new Date().toISOString(), raw_content_stored: false, probe_digest: digest({ provider: provider.provider, model, status, reason }) };
    if (existing) return { probe: this.store.save("runtime_model_probe", probeId, record), idempotent: false };
    return { probe: this.store.create("runtime_model_probe", probeId, record), idempotent: false };
  }
}

function configuredReason(provider: ModelProviderSpec): string {
  return process.env[provider.api_key_env]?.trim() ? "probe_not_run" : `missing_${provider.api_key_env}`;
}
