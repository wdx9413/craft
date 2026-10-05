/** Provider selection used by optional Experience evaluation profiles. */
export type ModelProtocol = "openai-compatible" | "anthropic";
export type ModelTier = "small" | "standard" | "frontier";
export interface ModelProviderSpec {
  provider: string;
  label: string;
  protocol: ModelProtocol;
  base_url: string;
  api_key_env: string;
  chat_path: string;
  models: Partial<Record<ModelTier, string>>;
  cost_hint: number;
  supports_tools: boolean;
  context_cache?: { readonly mode: "none" | "automatic_prefix"; readonly requires_exact_prefix: boolean; readonly usage_fields: "none" | "deepseek" };
}

const ORDER: readonly ModelTier[] = ["frontier", "standard", "small"];

export function credentialStatus(spec: ModelProviderSpec, env: NodeJS.ProcessEnv = process.env): { provider: string; configured: boolean; api_key_env: string } {
  const value = env[spec.api_key_env];
  return { provider: spec.provider, configured: typeof value === "string" && value.length > 0, api_key_env: spec.api_key_env };
}

export function selectModel(spec: ModelProviderSpec, tier: ModelTier): { tier: ModelTier; model: string; downgraded: boolean } {
  if (!ORDER.includes(tier)) throw new Error(`Unsupported model tier: ${String(tier)}`);
  for (let index = ORDER.indexOf(tier); index < ORDER.length; index += 1) {
    const candidate = ORDER[index]!;
    const model = spec.models[candidate];
    if (model) return { tier: candidate, model, downgraded: candidate !== tier };
  }
  throw new Error(`Provider ${spec.provider} declares no usable model tier`);
}
