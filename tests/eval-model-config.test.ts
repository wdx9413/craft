import assert from "node:assert/strict";
import test from "node:test";
import { evaluationProviderConfig } from "../capability/craft-eval/model.ts";

test("the evaluation gateway defaults to local WorkBuddy and can be redirected", () => {
  const fallback = evaluationProviderConfig({});
  assert.equal(fallback.provider, "workbuddy");
  assert.equal(fallback.base_url, "http://127.0.0.1:8000/v1");
  assert.equal(fallback.api_key_env, "WORKBUDDY_API_KEY");
  assert.equal(fallback.model, "deepseek-v4.1-flash");
  assert.equal(fallback.frontier_model, "deepseek-v4-pro");

  const custom = evaluationProviderConfig({
    CRAFT_EVAL_BASE_URL: "https://gateway.test/v1", CRAFT_EVAL_API_KEY_ENV: "GATEWAY_KEY",
    CRAFT_EVAL_MODEL: "custom-model", CRAFT_EVAL_FRONTIER_MODEL: "custom-frontier",
    CRAFT_EVAL_PROVIDER: "gateway", CRAFT_EVAL_LABEL: "Gateway",
  });
  assert.deepEqual(custom, {
    provider: "gateway", label: "Gateway", base_url: "https://gateway.test/v1", api_key_env: "GATEWAY_KEY",
    model: "custom-model", frontier_model: "custom-frontier",
  });

  // Blank overrides fall back to the default instead of producing an empty config.
  assert.equal(evaluationProviderConfig({ CRAFT_EVAL_MODEL: "   " }).model, "deepseek-v4.1-flash");
  assert.equal(evaluationProviderConfig({ CRAFT_EVAL_BASE_URL: "" }).base_url, "http://127.0.0.1:8000/v1");
});
