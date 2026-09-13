import { type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { JsonObject } from "./store.ts";
export type EgressResponse = {
    status: number;
    headers: Record<string, string>;
    body: string;
    output_limited: boolean;
};
export type EgressResolver = (hostname: string) => Promise<Array<{
    address: string;
    family: number;
}>>;
export type EgressTransport = (input: {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body: string;
    address: string;
    family: number;
    timeout_ms: number;
    output_limit: number;
}) => Promise<EgressResponse>;
export declare function egressRequestDigest(methodValue: unknown, urlValue: unknown, headersValue: unknown, bodyValue: unknown): string;
export declare function isPrivateEgressAddress(address: string): boolean;
type LookupAll = (hostname: string, options: {
    all: true;
    verbatim: true;
}) => Promise<Array<{
    address: string;
    family: number;
}>>;
export declare function resolvePublic(hostname: string, resolver?: LookupAll): Promise<Array<{
    address: string;
    family: number;
}>>;
type HttpsRequester = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export declare function createHttpsTransport(requester?: HttpsRequester): EgressTransport;
export declare class TrustedEgressBroker {
    readonly env: NodeJS.ProcessEnv;
    readonly resolver: EgressResolver;
    readonly transport?: EgressTransport;
    readonly requester: HttpsRequester;
    constructor(env?: NodeJS.ProcessEnv, resolver?: EgressResolver, transport?: EgressTransport, requester?: HttpsRequester);
    execute(args: JsonObject & {
        secret_ref: string;
    }): Promise<JsonObject>;
}
export {};
