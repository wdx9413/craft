export type ModelDiscoveryResult = {
  status: "ok" | "credential_missing" | "invalid_configuration" | "unauthorized" | "unsupported" | "provider_error" | "timeout" | "network_error" | "invalid_response" | "empty";
  models: string[];
  message: string;
};

type DiscoverOptions = {
  env?: NodeJS.ProcessEnv;
  fetcher?: typeof fetch;
  timeoutMs?: number;
};

function result(status: ModelDiscoveryResult["status"], message: string, models: string[] = []): ModelDiscoveryResult {
  return { status, message, models };
}

function endpoint(baseUrl: string, protocol: string): URL | null {
  let base: URL;
  try { base = new URL(baseUrl); } catch { return null; }
  if (!(["http:", "https:"].includes(base.protocol)) || base.username || base.password || base.search || base.hash) return null;
  if (protocol !== "openai-compatible" && protocol !== "anthropic") return null;
  const path = base.pathname.replace(/\/+$/u, "");
  base.pathname = protocol === "anthropic"
    ? `${path.endsWith("/v1") ? path : `${path}/v1`}/models`
    : `${path}/models`;
  return base;
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new RangeError("response too large");
  if (!response.body) throw new SyntaxError("response body missing");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new RangeError("response too large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Fetch only the model catalog at the user supplied endpoint; credentials never leave the server. */
export async function discoverProviderModels(args: Record<string, unknown>, options: DiscoverOptions = {}): Promise<ModelDiscoveryResult> {
  const baseUrl = typeof args.baseUrl === "string" ? args.baseUrl.trim() : "";
  const protocol = typeof args.protocol === "string" ? args.protocol : "";
  const envName = typeof args.apiKeyEnv === "string" ? args.apiKeyEnv.trim() : "";
  const url = endpoint(baseUrl, protocol);
  if (!url || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(envName)) {
    return result("invalid_configuration", "请检查 API Base URL、接口协议和密钥环境变量名。");
  }
  const apiKey = (options.env ?? process.env)[envName];
  if (!apiKey) return result("credential_missing", `未找到环境变量 ${envName}。设置密钥并重启 Craft 后可再次探测；也可以手动填写模型 ID。`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (protocol === "anthropic") {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else headers.authorization = `Bearer ${apiKey}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const finish = (value: ModelDiscoveryResult): ModelDiscoveryResult => { clearTimeout(timeout); return value; };
  try {
    const response = await (options.fetcher ?? fetch)(url, { method: "GET", headers, signal: controller.signal, redirect: "error" });
    if (response.status === 401 || response.status === 403) return finish(result("unauthorized", "服务商拒绝了当前密钥，请检查凭据和账号权限。"));
    if (response.status === 404 || response.status === 405) return finish(result("unsupported", "此端点不提供模型列表；可以手动填写服务商文档中的模型 ID。"));
    if (!response.ok) return finish(result("provider_error", `服务商返回 HTTP ${response.status}；可以重试或手动填写模型 ID。`));
    let payload: unknown;
    try { payload = await readBoundedJson(response, 1_048_576); }
    catch (error) {
      return finish(result("invalid_response", error instanceof RangeError
        ? "服务商返回的模型列表超过 1 MiB，无法安全解析。"
        : "服务商返回的模型列表不是有效 JSON。"));
    }
    if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
      return finish(result("invalid_response", "服务商响应缺少模型列表；请手动填写模型 ID。"));
    }
    const models = Array.from(new Set(((payload as { data: unknown[] }).data)
      .filter((item): item is { id: string } => Boolean(item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"))
      .map(item => item.id.trim()).filter(id => id.length > 0 && id.length <= 256))).slice(0, 500);
    return finish(models.length ? result("ok", `已从服务商发现 ${models.length} 个模型。`, models)
      : result("empty", "服务商返回了空模型列表；可以手动填写模型 ID。"));
  } catch (error) {
    if (controller.signal.aborted) return finish(result("timeout", "连接超时；请检查 Base URL、网络和服务商状态，或手动填写模型 ID。"));
    return finish(result("network_error", error instanceof Error && error.name === "TypeError"
      ? "无法连接服务商；请检查 Base URL、网络和 TLS 配置，或手动填写模型 ID。"
      : "请求未能完成；请检查 Base URL 和网络，或手动填写模型 ID。"));
  }
}
