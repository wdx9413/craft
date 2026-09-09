import {} from "./store.js";
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const KEYWORDS = new Set(["$schema", "title", "description", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]);
function object(value, name) { if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`); return value; }
function integer(value, name) { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${name} must be a non-negative integer`); return parsed; }
function same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
/** A deliberately bounded JSON Schema evaluator. Unsupported keywords fail closed instead of being silently ignored. */
export function validateJsonSchema(value, rawSchema, path = "$", depth = 0) {
    if (depth > 64)
        throw new Error("JSON Schema validation depth exceeds 64");
    const schema = object(rawSchema, `${path} schema`);
    for (const key of Object.keys(schema))
        if (!KEYWORDS.has(key))
            throw new Error(`Unsupported JSON Schema keyword: ${key}`);
    if (schema.enum !== undefined) {
        if (!Array.isArray(schema.enum) || !schema.enum.length)
            throw new Error(`${path} schema enum must be non-empty`);
        if (!schema.enum.some((item) => same(item, value)))
            throw new Error(`${path} is not one of the allowed values`);
    }
    if (schema.const !== undefined && !same(schema.const, value))
        throw new Error(`${path} does not match const`);
    const type = schema.type;
    if (type === undefined)
        return;
    if (typeof type !== "string" || !TYPES.has(type))
        throw new Error(`${path} schema type is unsupported`);
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
    const matches = type === "number" ? actual === "number" || actual === "integer" : type === actual;
    if (!matches)
        throw new Error(`${path} must be ${type}`);
    if (type === "object") {
        const data = value;
        const properties = object(schema.properties ?? {}, `${path}.properties`);
        const required = schema.required ?? [];
        if (!Array.isArray(required) || required.some((item) => typeof item !== "string") || new Set(required).size !== required.length)
            throw new Error(`${path}.required must contain unique strings`);
        for (const name of required)
            if (!(name in data))
                throw new Error(`${path}.${name} is required`);
        for (const [name, child] of Object.entries(data)) {
            if (properties[name] !== undefined)
                validateJsonSchema(child, properties[name], `${path}.${name}`, depth + 1);
            else if (schema.additionalProperties === false)
                throw new Error(`${path}.${name} is not allowed`);
            else if (schema.additionalProperties && typeof schema.additionalProperties === "object")
                validateJsonSchema(child, schema.additionalProperties, `${path}.${name}`, depth + 1);
        }
    }
    if (type === "array") {
        const data = value;
        const min = integer(schema.minItems ?? 0, `${path}.minItems`);
        const max = schema.maxItems === undefined ? Number.MAX_SAFE_INTEGER : integer(schema.maxItems, `${path}.maxItems`);
        if (max < min)
            throw new Error(`${path} array bounds are invalid`);
        if (data.length < min || data.length > max)
            throw new Error(`${path} array length is outside bounds`);
        if (schema.items !== undefined)
            for (let index = 0; index < data.length; index += 1)
                validateJsonSchema(data[index], schema.items, `${path}[${index}]`, depth + 1);
    }
    if (type === "string") {
        const data = value;
        const min = integer(schema.minLength ?? 0, `${path}.minLength`);
        const max = schema.maxLength === undefined ? Number.MAX_SAFE_INTEGER : integer(schema.maxLength, `${path}.maxLength`);
        if (max < min)
            throw new Error(`${path} string bounds are invalid`);
        if (data.length < min || data.length > max)
            throw new Error(`${path} string length is outside bounds`);
    }
    if (type === "number" || type === "integer") {
        const data = value;
        const min = schema.minimum === undefined ? Number.NEGATIVE_INFINITY : Number(schema.minimum);
        const max = schema.maximum === undefined ? Number.POSITIVE_INFINITY : Number(schema.maximum);
        if (Number.isNaN(min) || Number.isNaN(max) || max < min)
            throw new Error(`${path} numeric bounds are invalid`);
        if (data < min || data > max)
            throw new Error(`${path} is outside numeric bounds`);
    }
}
//# sourceMappingURL=json-schema.js.map