import type { JsonObject } from "./store.ts";
import { SecurityBrokerKernel } from "./security.ts";
export declare function analyzeUntrustedContent(raw: string, requestedFormat: unknown, requestedSelectors: unknown): JsonObject;
export declare class DataOnlyParserAdapter {
    readonly security: SecurityBrokerKernel;
    constructor(security: SecurityBrokerKernel);
    parse(args: JsonObject): JsonObject;
    evaluate(args: JsonObject): JsonObject;
}
