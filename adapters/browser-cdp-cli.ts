import { BrowserCdpAdapter, type CdpSession } from "./browser-cdp.ts";

function port(args: string[]): number {
  const value = Number(args[args.indexOf("--port") + 1]);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error("--port must name a local CDP port");
  return value;
}

async function session(portNumber: number): Promise<CdpSession> {
  const targets = await fetch(`http://127.0.0.1:${portNumber}/json/list`).then(async (response) => {
    if (!response.ok) throw new Error("CDP endpoint did not accept the local request");
    return response.json() as Promise<Array<{ type?: string; webSocketDebuggerUrl?: string }>>;
  });
  const target = targets.find((item) => item.type === "page" && item.webSocketDebuggerUrl);
  if (!target?.webSocketDebuggerUrl) throw new Error("No inspectable page exists on the local CDP browser");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve(), { once: true }); socket.addEventListener("error", () => reject(new Error("Cannot connect to the local CDP page")), { once: true }); });
  let next = 1;
  return { call(method, params = {}) { return new Promise((resolve, reject) => {
    const id = next += 1;
    const onMessage = (event: MessageEvent) => { const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } }; if (message.id !== id) return; socket.removeEventListener("message", onMessage); if (message.error) reject(new Error(message.error.message ?? "CDP request failed")); else resolve(message.result ?? {}); };
    socket.addEventListener("message", onMessage); socket.send(JSON.stringify({ id, method, params }));
  }); } };
}

const body = await new Promise<string>((resolve) => { let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => resolve(input)); });
try { process.stdout.write(`${JSON.stringify(await new BrowserCdpAdapter(await session(port(process.argv.slice(2)))).execute(JSON.parse(body)))}\n`); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
