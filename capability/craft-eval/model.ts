/**
 * The single evaluation model configuration.
 *
 * Three scripts (`eval-run`, `eval-recurrence`, `eval-suite-run`) previously each
 * declared this provider, its transport and an identical `ask()` — twenty-four
 * lines copied verbatim — and had already drifted: `supports_tools` was `true` in
 * two and `false` in the third. One copy means a change to the endpoint, the model
 * or the credential variable cannot land in one script and miss another.
 *
 * `supports_tools` is now `true` everywhere. That is not a silent behaviour change:
 * `buildChatRequest` never reads the flag — it emits `tools` only when the caller
 * passes them, and no evaluation script does. The flag is provider metadata, and
 * the three copies disagreed without consequence.
 *
 * The credential is no longer embedded. The scripts injected a literal value for
 * `WORKBUDDY_API_KEY`, which overrode the transport's own lookup and put a
 * credential-shaped string in the source tree — one that the project's own secret
 * detectors (`src/federation.ts`, `src/materialization.ts`) would flag. The
 * transport already reads `process.env` by default and already fails with
 * *set WORKBUDDY_API_KEY before running Craft* when the variable is absent, so the
 * configuration here carries only the endpoint and the budget.
 */
import { buildChatRequest, createFetchTransport, credentialStatus, defineProvider, selectModel } from "../../src/model-gateway.ts";

export const EVAL_PROVIDER = defineProvider({
  provider: "workbuddy", label: "WorkBuddy Local", protocol: "openai-compatible",
  base_url: "http://127.0.0.1:8000/v1", api_key_env: "WORKBUDDY_API_KEY", chat_path: "/chat/completions",
  models: { small: "deepseek-v4.1-flash", standard: "deepseek-v4.1-flash", frontier: "deepseek-v4-pro" },
  supports_tools: true,
});

export const EVAL_MODEL = selectModel(EVAL_PROVIDER, "standard").model;

/**
 * Fail before the first case when the credential is absent.
 *
 * Without this, every case's `try/catch` turns the transport's
 * *set WORKBUDDY_API_KEY* error into an empty answer and grades it `FAIL`, so a run
 * with no credential reports a model that answered everything wrong and exits 0.
 * That is an environment failure wearing a capability failure's clothes — the same
 * mistake the gates and the suite each had to be taught not to make.
 */
export function requireEvaluationCredential(): void {
  const status = credentialStatus(EVAL_PROVIDER);
  if (!status.configured) {
    throw new Error(`${status.api_key_env} is not set; export it before running an evaluation`);
  }
}

// One transport for the process. It resolves the credential per request from
// `process.env`, so a missing key fails on the first turn with the transport's own
// message rather than being papered over by a placeholder.
const transport = createFetchTransport({ timeoutMs: 90_000, maxAttempts: 1 });

/**
 * One deterministic prompt turn.
 *
 * `maxTokens` is the only difference the three copies ever had (64, 32, 64), so it
 * is the only argument.
 */
export async function ask(prompt: string, maxTokens = 64): Promise<string> {
  const request = buildChatRequest(EVAL_PROVIDER, {
    model: EVAL_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0,
  });
  return (await transport.complete(EVAL_PROVIDER, request)).text.trim();
}
