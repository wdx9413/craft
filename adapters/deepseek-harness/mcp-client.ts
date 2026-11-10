import { spawn } from "node:child_process";

export type Launch = { command: string; args: string[]; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBytes?: number };
/** One bounded MCP exchange with negotiated initialization and schema discovery. */
export function exchange(launch: Launch, method: "tools/list" | "tools/call", params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let buffer = ""; let bytes = 0; let done = false; let stage = 1;
    const finish = (error: Error | null, value?: unknown) => {
      if (done) return;
      done = true; clearTimeout(timer); child.kill();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`Craft MCP exchange timed out at ${stage === 1 ? "initialize" : method}`)), launch.timeoutMs ?? 60000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const closed = () => finish(new Error("Craft MCP exited or input closed before response"));
    child.stdin.on("error", closed);
    child.on("error", () => finish(new Error("Craft MCP launch failed")));
    child.on("exit", closed);
    child.stderr.resume();
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk); buffer += chunk;
      if (bytes > (launch.maxBytes ?? 5_000_000)) { finish(new Error("Craft MCP output exceeds budget")); return; }
      let at: number;
      while (!done && (at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { finish(new Error("Invalid Craft MCP JSON")); return; }
        if (message.id !== stage) continue;
        if (message.error || !message.result) { finish(new Error("Craft MCP request rejected")); return; }
        if (stage === 1) {
          if (!["2025-03-26", "2025-06-18", "2025-11-25"].includes(message.result.protocolVersion)) { finish(new Error("Unsupported MCP protocol")); return; }
          send({ jsonrpc: "2.0", method: "notifications/initialized" }); stage = 2;
          send({ jsonrpc: "2.0", id: 2, method, params });
        } else {
          if (message.result.isError) { finish(new Error("Craft tool call failed")); return; }
          finish(null, message.result);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "dsh-craft-adapter", version: "1" } } });
  });
}
