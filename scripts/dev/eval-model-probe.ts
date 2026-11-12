/**
 * Probe the configured evaluation gateway and report what it actually returns.
 *
 * `pnpm run eval:local` grades model cases from response bytes. When a gateway
 * spends most of `max_tokens` on hidden reasoning, the graded answer comes back
 * empty and looks like a capability failure. This probe separates that case:
 * it prints the finish reason, the reasoning/output token split and the visible
 * text for both a small and a large budget, so an operator can tell an
 * environment limit from a wrong answer.
 *
 *   node --import ./scripts/dev/load-env.ts --experimental-strip-types scripts/dev/eval-model-probe.ts
 */
import { buildChatRequest, createFetchTransport, credentialStatus } from "../../core/model-gateway.ts";
import { EVAL_MODEL, EVAL_PROVIDER, evaluationCredentialMissing } from "craft-eval/model";

const missing = evaluationCredentialMissing();
if (missing) {
  console.error(missing);
  process.exitCode = 2;
} else {
  const status = credentialStatus(EVAL_PROVIDER);
  console.log(`provider=${EVAL_PROVIDER.provider} model=${EVAL_MODEL} base_url=${EVAL_PROVIDER.base_url}`);
  console.log(`credential: ${status.api_key_env} configured=${String(status.configured)}`);
  const transport = createFetchTransport({ timeoutMs: 120_000, maxAttempts: 1 });
  const prompt = "What is 17 * 23? Reply with the number only, no punctuation.";
  for (const maxTokens of [32, 512]) {
    const request = buildChatRequest(EVAL_PROVIDER, {
      model: EVAL_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: maxTokens, temperature: 0,
    });
    const started = Date.now();
    try {
      const result = await transport.complete(EVAL_PROVIDER, request);
      console.log(JSON.stringify({ max_tokens: maxTokens, ms: Date.now() - started,
        visible_text: result.text, usage: result.usage, tool_calls: result.tool_calls?.length ?? 0 }));
    } catch (error) {
      console.log(JSON.stringify({ max_tokens: maxTokens, ms: Date.now() - started, error: (error as Error).message }));
    }
  }
}
