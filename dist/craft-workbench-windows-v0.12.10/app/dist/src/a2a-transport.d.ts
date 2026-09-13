import type { JsonObject } from "./store.ts";
export interface A2AFetch {
    (input: string, init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    }): Promise<{
        status: number;
        json(): Promise<unknown>;
    }>;
}
export declare class A2ATransportKernel {
    dispatch(args: JsonObject, fetchImpl?: A2AFetch): Promise<JsonObject>;
    taskGet(args: JsonObject, fetchImpl?: A2AFetch): Promise<JsonObject>;
    taskCancel(args: JsonObject, fetchImpl?: A2AFetch): Promise<JsonObject>;
}
