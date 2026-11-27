import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import type { CraftPaths } from "./paths.ts";
import type { JsonObject } from "./store.ts";

const MAX_BODY = 256 * 1024;
const MAX_CONTEXT_BODY = 2 * 1024 * 1024;

export class SupervisorClient {
  readonly paths: CraftPaths; private readonly expectedOwnerId?: string;
  constructor(paths: CraftPaths, expectedOwnerId?: string) { this.paths = paths; this.expectedOwnerId = expectedOwnerId; }
  async call(method: "GET" | "POST", path: string, body: JsonObject = {}): Promise<JsonObject> {
    let state: JsonObject;
    try { state = JSON.parse(await readFile(join(this.paths.runtimeDir, "supervisor.json"), "utf8")) as JsonObject; }
    catch (cause) { throw new Error("Craft Supervisor is unavailable", { cause }); }
    if (state.status !== "running") throw new Error("Craft Supervisor is not running");
    if (this.expectedOwnerId !== undefined && state.owner_id !== this.expectedOwnerId) throw new Error("Craft Supervisor owner changed");
    const base = new URL(String(state.url)); const target = new URL(path, base);
    // Validate the resolved target before attaching local credentials. A path
    // can otherwise replace the origin, even when the saved URL is loopback.
    if (base.hostname !== "127.0.0.1" || base.protocol !== "http:" || target.origin !== base.origin || target.username || target.password) throw new Error("Supervisor state has an unsafe endpoint");
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const request = httpRequest(target, { method, headers: { authorization: `Bearer ${String(state.owner_id)}`, "content-type": "application/json", "content-length": data.length } }, (response) => {
        const chunks: Buffer[] = []; let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (path === "/context/snapshot-get" ? 7 * 1024 * 1024 : path.startsWith("/context/") ? MAX_CONTEXT_BODY : MAX_BODY)) response.destroy(new Error("Supervisor response exceeds size limit"));
          else chunks.push(chunk);
        });
        response.once("error", (error) => { clearTimeout(timer); reject(error); });
        response.on("end", () => {
          clearTimeout(timer);
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Supervisor response must be an object");
            if (Number(response.statusCode) >= 400) reject(new Error(String((value as JsonObject).error)));
            else resolve(value as JsonObject);
          } catch (error) { reject(error); }
        });
      });
      // Wall-clock deadline also bounds a peer that keeps dribbling bytes.
      const timer = setTimeout(() => request.destroy(new Error("Supervisor request timed out")), 5_000);
      request.once("error", (error) => { clearTimeout(timer); reject(error); });
      request.end(data);
    });
  }
  status(): Promise<JsonObject> { return this.call("GET", "/health"); }
  contextPut(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/put", args); }
  contextGet(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/get", args); }
  contextSnapshotGet(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/snapshot-get", args); }
  contextSnapshotPublish(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/snapshot-publish", args); }
  contextSnapshotAbort(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/snapshot-abort", args); }
  contextPurge(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/purge", args); }
  contextClaim(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/claim", args); }
  contextRelease(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/release", args); }
  contextStart(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/start", args); }
  contextEnd(args: JsonObject): Promise<JsonObject> { return this.call("POST", "/context/end", args); }
}
