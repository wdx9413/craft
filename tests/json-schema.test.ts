import assert from "node:assert/strict";
import test from "node:test";
import { validateJsonSchema } from "../src/json-schema.ts";

test("bounded JSON Schema validates nested objects, arrays, scalars, enums, and bounds", () => {
  const schema = { type: "object", required: ["name", "items"], additionalProperties: false, properties: { name: { type: "string", minLength: 2, maxLength: 5 }, items: { type: "array", minItems: 1, maxItems: 2, items: { type: "integer", minimum: 1, maximum: 3 } }, enabled: { type: "boolean" }, ratio: { type: "number" }, empty: { type: "null" }, mode: { type: "string", enum: ["a", "b"], const: "a" } } };
  validateJsonSchema({ name: "craft", items: [1, 3], enabled: true, ratio: 1.5, empty: null, mode: "a" }, schema);
  validateJsonSchema({ extra: "ok" }, { type: "object", additionalProperties: { type: "string" } });
  for (const [value, expected] of [[{}, /required/], [{ name: "x", items: [1] }, /length/], [{ name: "craft", items: [] }, /array length/], [{ name: "craft", items: [0] }, /numeric/], [{ name: "craft", items: [1], extra: true }, /not allowed/], [{ name: "craft", items: [1], enabled: "yes" }, /boolean/], [{ name: "craft", items: [1], ratio: true }, /number/], [{ name: "craft", items: [1], mode: "b" }, /const/], [{ name: "craft", items: [1], mode: "c" }, /allowed/]] as const) assert.throws(() => validateJsonSchema(value as never, schema), expected);
});

test("bounded JSON Schema rejects ambiguous or unsupported schemas", () => {
  const cases: Array<[unknown, unknown, RegExp]> = [
    ["x", null, /object/], ["x", { type: "magic" }, /unsupported/], ["x", { type: ["string"] }, /unsupported/], ["x", { type: "string", pattern: "x" }, /keyword/], ["x", { type: "string", enum: [] }, /enum/],
    [{}, { type: "object", required: "x" }, /unique strings/], [{}, { type: "object", required: ["x", "x"] }, /unique strings/], [{}, { type: "object", properties: [] }, /properties/],
    [[], { type: "array", minItems: -1 }, /non-negative/], [[], { type: "array", minItems: 2, maxItems: 1 }, /bounds/], ["x", { type: "string", minLength: 2, maxLength: 1 }, /bounds/],
    [1, { type: "number", minimum: "bad" }, /numeric/], [1, { type: "number", minimum: 2, maximum: 1 }, /numeric/],
  ]; for (const [value, schema, expected] of cases) assert.throws(() => validateJsonSchema(value as never, schema), expected);
  assert.throws(() => validateJsonSchema([], { type: "array", maxItems: -1 }), /non-negative/); assert.throws(() => validateJsonSchema("x", { type: "string", minLength: -1 }), /non-negative/); assert.throws(() => validateJsonSchema(1.5, { type: "integer" }), /integer/); validateJsonSchema(1, { type: "number" });
  validateJsonSchema([], { type: "array" });
  let schema: Record<string, unknown> = { type: "object", properties: {} }; let cursor = schema; for (let index = 0; index < 66; index += 1) { const next = { type: "object", properties: {} }; (cursor.properties as Record<string, unknown>).x = next; cursor = next; } let value: Record<string, unknown> = {}; let data = value; for (let index = 0; index < 66; index += 1) { data.x = {}; data = data.x as Record<string, unknown>; } assert.throws(() => validateJsonSchema(value as never, schema), /depth/);
});
