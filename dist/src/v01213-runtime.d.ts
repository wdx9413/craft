import { CraftStore, type JsonObject } from "./store.ts";
/** v0.12.13 bounded action gateway. The default adapter never executes shell or remote effects. */
export declare class ActionGatewayKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    execute(args: JsonObject): Promise<JsonObject>;
    private executeAsync;
    private finish;
    get(args: JsonObject): JsonObject;
}
/** Independent acceptance gate. Host completion is never a passing verdict. */
export declare class AcceptanceGateKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    prepare(args: JsonObject): JsonObject;
    assess(args: JsonObject): JsonObject;
    outcome(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
/** Local Worker lease/recovery state; a tray or OS service remains the host that calls tick. */
export declare class DurableWorkerKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    configure(args?: JsonObject): JsonObject;
    start(args?: JsonObject): JsonObject;
    stop(args?: JsonObject): JsonObject;
    enqueue(args: JsonObject): JsonObject;
    tick(args?: JsonObject): JsonObject;
    recover(args?: JsonObject): JsonObject;
    get(args?: JsonObject): JsonObject;
}
/** Provider routing policy; transport remains injected by the selected Host. */
export declare class ProviderRouterKernel {
    readonly store: CraftStore;
    constructor(store: CraftStore);
    plan(args: JsonObject): JsonObject;
    record(args: JsonObject): JsonObject;
    get(args: JsonObject): JsonObject;
}
/** Full protocol-shaped A2A calls. Raw remote content is never stored. */
export declare class A2AProtocolKernel {
    sendMessage(args: JsonObject, fetchImpl?: typeof fetch): Promise<JsonObject>;
    listTasks(args: JsonObject, fetchImpl?: typeof fetch): Promise<JsonObject>;
    streamMessage(args: JsonObject, fetchImpl?: typeof fetch): Promise<JsonObject>;
    private request;
}
