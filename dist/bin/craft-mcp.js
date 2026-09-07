#!/usr/bin/env node
import { createInterface } from "node:readline";
import { McpServer } from "../src/mcp.js";
import { CraftService } from "../src/service.js";
import { CraftStore } from "../src/store.js";
async function main() {
    const store = await new CraftStore().open();
    const server = new McpServer(new CraftService(store));
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    try {
        for await (const line of input) {
            let response;
            try {
                response = await server.handle(JSON.parse(line));
            }
            catch {
                response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
            }
            if (response)
                process.stdout.write(`${JSON.stringify(response)}\n`);
        }
    }
    finally {
        store.close();
    }
}
main().catch(() => {
    process.stderr.write("Craft MCP failed to start.\n");
    process.exitCode = 1;
});
//# sourceMappingURL=craft-mcp.js.map