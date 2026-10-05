import type { CdpSession } from "./browser-cdp.ts";

export interface CdpSocket extends EventTarget { send(data: string): void; close(): void }

/** A bounded CDP connection. Loss of transport never means an action succeeded. */
export class BoundedCdpSession implements CdpSession {
  private next = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private socket: CdpSocket;
  private timeoutMs: number;
  constructor(socket: CdpSocket, timeoutMs = 5_000) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Invalid CDP timeout");
    this.socket = socket; this.timeoutMs = timeoutMs;
    socket.addEventListener("message", this.message);
    socket.addEventListener("close", this.disconnected);
    socket.addEventListener("error", this.disconnected);
  }
  private message = (event: Event): void => {
    let data: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    try { data = JSON.parse(String((event as MessageEvent).data)); }
    catch { this.close(); return; }
    if (!data || typeof data !== "object") { this.close(); return; }
    const entry = this.pending.get(Number(data.id));
    if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(Number(data.id));
    if (data.error) entry.reject(new Error("CDP request failed"));
    else entry.resolve(data.result ?? {});
  };
  private disconnected = (): void => { this.close(); };
  call(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new Error("CDP session closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.next;
      const timer = setTimeout(() => this.close(), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { this.close(); }
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.removeEventListener("message", this.message);
    this.socket.removeEventListener("close", this.disconnected);
    this.socket.removeEventListener("error", this.disconnected);
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("CDP transport interrupted; effect may be unknown")); }
    this.pending.clear(); this.socket.close();
  }
}

export function pinnedCdpTarget(targets: unknown, port: number, targetId: string): string {
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !/^[a-zA-Z0-9_-]{1,200}$/u.test(targetId)) throw new Error("Explicit local port and target required");
  if (!Array.isArray(targets) || targets.length > 100) throw new Error("Invalid CDP target list");
  const matches = targets.filter((target) => target && target.type === "page" && target.id === targetId);
  if (matches.length !== 1) throw new Error("Pinned CDP target unavailable or ambiguous");
  const endpoint = new URL(matches[0].webSocketDebuggerUrl);
  if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || Number(endpoint.port) !== port
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== `/devtools/page/${targetId}`) throw new Error("CDP target escaped local session");
  return endpoint.href;
}

export async function connectCdp(port: number, targetId: string): Promise<BoundedCdpSession> {
  // Validate before fetch so malformed ports cannot become a different endpoint.
  pinnedCdpTarget([{ id: targetId, type: "page", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}` }], port, targetId);
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000), redirect: "error" });
  if (!response.ok) throw new Error("Local CDP discovery failed");
  const socket = new WebSocket(pinnedCdpTarget(await response.json(), port, targetId));
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); socket.removeEventListener("open", open); socket.removeEventListener("error", error); socket.removeEventListener("close", error); };
    const open = () => { cleanup(); resolve(); };
    const error = () => { cleanup(); socket.close(); reject(new Error("Cannot open pinned CDP connection")); };
    const timer = setTimeout(error, 5_000);
    socket.addEventListener("open", open, { once: true }); socket.addEventListener("error", error, { once: true }); socket.addEventListener("close", error, { once: true });
  });
  return new BoundedCdpSession(socket);
}
