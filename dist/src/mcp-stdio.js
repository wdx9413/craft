import { createInterface } from "node:readline";
import { McpServer } from "./mcp.js";
import { CraftService } from "./service.js";
import { CraftStore } from "./store.js";
async function start(mode) {
    const store = await new CraftStore().open();
    return { server: new McpServer(await CraftService.open(store), mode), close: () => store.close() };
}
function parseError() {
    return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
}
export async function serveMcpStdio(options) {
    const input = createInterface({ input: options.input, crlfDelay: Infinity });
    const pending = [];
    let closed = false;
    let wake;
    input.on("line", (line) => { pending.push(line); wake?.(); });
    input.on("close", () => { closed = true; wake?.(); });
    const runtime = await (options.start ?? start)(options.mode);
    try {
        while (pending.length || !closed) {
            if (!pending.length)
                await new Promise((resolve) => { wake = resolve; });
            wake = undefined;
            const line = pending.shift();
            if (line === undefined)
                continue;
            let response;
            try {
                response = await runtime.server.handle(JSON.parse(line));
            }
            catch {
                response = parseError();
            }
            if (response)
                options.write(`${JSON.stringify(response)}\n`);
        }
    }
    finally {
        runtime.close();
    }
}
//# sourceMappingURL=mcp-stdio.js.map