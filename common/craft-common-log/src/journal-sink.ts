import { createHash } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TelemetryEvent, TelemetrySink } from "./telemetry.ts";

const queueKey = Symbol.for("craft.telemetry.journal.pending");
type JournalQueues = Map<string, Promise<void>>;
const processState = globalThis as typeof globalThis & { [queueKey]?: JournalQueues };
const queues = processState[queueKey] ??= new Map<string, Promise<void>>();

/**
 * Append content-free observations outside SQLite. This sink is for operations
 * that must stay lock-free on the request path, such as MCP reads.
 */
export class JsonlTelemetryJournal implements TelemetrySink {
  readonly runtimeDir: string;
  readonly onError: (error: unknown) => void;
  #pending = new Set<Promise<void>>();

  constructor(runtimeDir: string, onError: (error: unknown) => void = () => undefined) {
    if (!runtimeDir.trim()) throw new Error("runtimeDir must be non-empty");
    this.runtimeDir = runtimeDir;
    this.onError = onError;
  }

  append(event: TelemetryEvent): Promise<void> {
    const capability = createHash("sha256").update(event.capability_id).digest("hex").slice(0, 20);
    const directory = join(this.runtimeDir, "operation-journal", capability);
    const file = join(directory, `${process.pid}.jsonl`);
    const line = `${JSON.stringify(event)}\n`;
    const previous = queues.get(file) ?? Promise.resolve();
    const write = previous.then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await appendFile(file, line, { encoding: "utf8", mode: 0o600 });
    });
    const tail = write.then(() => undefined, () => undefined);
    queues.set(file, tail);
    void tail.then(() => { if (queues.get(file) === tail) queues.delete(file); });
    void write.catch(error => { try { this.onError(error); } catch { /* Logging must not affect the operation. */ } });
    this.#pending.add(write);
    void write.then(() => this.#pending.delete(write), () => this.#pending.delete(write));
    return write;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.#pending].map(write => write.catch(() => undefined)));
  }
}
