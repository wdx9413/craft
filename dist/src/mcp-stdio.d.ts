import { McpServer } from "./mcp.ts";
type Mode = "core" | "full";
type Server = Pick<McpServer, "handle">;
type Start = (mode: Mode) => Promise<{
    server: Server;
    close: () => void;
}>;
export declare function serveMcpStdio(options: {
    mode: Mode;
    input: NodeJS.ReadableStream;
    write: (line: string) => void;
    start?: Start;
}): Promise<void>;
export {};
