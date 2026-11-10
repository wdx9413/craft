import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeModelEgressRequest } from "../core/model-egress-security.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

const provider = { base_url: "https://models.example/v1", chat_path: "/chat/completions" };
const request = (body: unknown = { model: "test", messages: [{ role: "user", content: "safe" }] }) => ({
  url: "https://models.example/v1/chat/completions", headers: { ignored: "secret" }, body: body as JsonObject,
  prompt_tokens_estimate: 1, context_cache: { mode: "none" as const, eligible: false, prefix_message_count: 0, prefix_digest: null, reason: null },
});

test("final egress scrubs sensitive values recursively while preserving schema fields and request metadata", () => {
  const source = request({ model: "test", messages: [{ role: "user", content: "password=private-pass-987" }],
    credentials: { api_token: "raw-sensitive-value", nested: ["another-secret", { password: "hidden" }, 7, null] },
    tools: [{ function: { parameters: { type: "object", properties: {
      password: { type: "string", description: "credential field", default: { nested: ["schema-secret", 3, false] }, enum: ["one", "two"] },
      query: { type: "string", description: "ordinary value" },
    } } } }], metadata: { properties: ["not-a-schema-map"] } });
  const sanitized = sanitizeModelEgressRequest(provider, source);
  const serialized = JSON.stringify(sanitized.body);
  for (const value of ["private-pass-987", "raw-sensitive-value", "another-secret", "hidden", "schema-secret", "one", "two"]) assert.equal(serialized.includes(value), false);
  const properties = (((sanitized.body.tools as JsonObject[])[0]?.function as JsonObject).parameters as JsonObject).properties as JsonObject;
  assert.deepEqual(properties.password, { type: "string", description: "credential field", default: { nested: ["[REDACTED]", 3, false] }, enum: ["[REDACTED]", "[REDACTED]"] });
  assert.deepEqual(properties.query, { type: "string", description: "ordinary value" });
  assert.deepEqual(sanitized.headers, source.headers);
  assert.equal(source.body.messages instanceof Array && (source.body.messages[0] as JsonObject).content, "password=private-pass-987");
});

test("final egress rejects destination changes, invalid bodies, and excessive nesting", () => {
  assert.throws(() => sanitizeModelEgressRequest(provider, { ...request(), url: "https://other.example/send" }), /destination/u);
  assert.throws(() => sanitizeModelEgressRequest(provider, request(null)), /body must be an object/u);
  assert.throws(() => sanitizeModelEgressRequest(provider, request([])), /body must be an object/u);
  let nested: unknown = "x";
  for (let index = 0; index < 66; index++) nested = [nested];
  assert.throws(() => sanitizeModelEgressRequest(provider, request({ nested })), /nesting exceeds/u);
  assert.throws(() => sanitizeModelEgressRequest(provider, request({ parameters: { type: "object", properties: {
    password: { type: "string", default: nested },
  } } })), /nesting exceeds/u);
});

test("ordinary properties objects do not bypass sensitive value redaction", () => {
  const sanitized = sanitizeModelEgressRequest(provider, request({
    messages: [{ role: "tool", content: { properties: { password: "hidden-value", query: "safe-value" } } }],
    parameters: { type: "object", properties: { password: { type: "string", description: "Password field" } } },
  }));
  const message = (sanitized.body.messages as JsonObject[])[0] as JsonObject;
  assert.deepEqual((message.content as JsonObject).properties, { password: "[REDACTED]", query: "safe-value" });
  assert.deepEqual((sanitized.body.parameters as JsonObject).properties, { password: { type: "string", description: "Password field" } });
});
