export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};
/** A deliberately bounded JSON Schema evaluator. Unsupported keywords fail closed instead of being silently ignored. */
export declare function validateJsonSchema(value: JsonValue, rawSchema: unknown, path?: string, depth?: number): void;
