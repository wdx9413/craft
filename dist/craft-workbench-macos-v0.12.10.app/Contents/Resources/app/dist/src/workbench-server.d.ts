import { CraftService } from "./service.ts";
export type WebRequest = {
    method: string;
    path: string;
    token?: string;
    origin?: string;
    body?: string;
};
export type WebResponse = {
    status: number;
    contentType: string;
    body: string;
};
export declare class WorkbenchWebApp {
    readonly service: CraftService;
    readonly token: string;
    readonly origin: string;
    constructor(service: CraftService, token: string, origin: string);
    handle(request: WebRequest): WebResponse;
}
export declare class LocalWorkbenchServer {
    #private;
    readonly service: CraftService;
    readonly token: string;
    readonly acceptanceTick: () => Promise<unknown>;
    constructor(service: CraftService, token?: string, options?: {
        acceptanceTick?: () => Promise<unknown>;
    });
    start(port?: number): Promise<{
        url: string;
        token: string;
    }>;
    close(): Promise<void>;
}
