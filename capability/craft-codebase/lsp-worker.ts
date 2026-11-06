import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { analyzeLspSnapshot, type LspStdioRequest } from "./lsp-stdio-client.ts";

export const CODEBASE_LSP_WORKER_FLAG = "--craft-codebase-lsp-worker";
const MAX_REQUEST_BYTES = 70 * 1024 * 1024;

/** Return only stable, non-sensitive failure fields across the worker boundary. */
export function lspWorkerFailure(error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : "";
  const stage = /(?:during|at) ([a-zA-Z][\w/.-]*)/u.exec(message)?.[1]
    ?? /timed out: ([a-zA-Z][\w/.-]*)/u.exec(message)?.[1];
  const protocolCode = /Language server request failed[^\n]*\((-?\d+)\)/u.exec(message)?.[1];
  const reason = /timed out/iu.test(message) ? "request_timeout"
    : /Unable to start configured language server/u.test(message) ? "server_unavailable"
    : /Language server request failed/u.test(message) ? "server_request_failed"
    : "analysis_failed";
  return { format: "craft-lsp-worker-failure-v1", reason,
    ...(stage ? { failure_stage: stage } : {}),
    ...(protocolCode && Number.isSafeInteger(Number(protocolCode)) ? { protocol_error_code: Number(protocolCode) } : {}) };
}

/** Internal subprocess entry point used by synchronous repository onboarding. */
export async function runCodebaseLspWorker(input: AsyncIterable<Uint8Array>, write: (text: string) => void): Promise<void> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of input) {
    total += chunk.byteLength;
    if (total > MAX_REQUEST_BYTES) throw new Error("LSP worker request exceeds budget");
    chunks.push(Buffer.from(chunk));
  }
  let request: LspStdioRequest;
  try { request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as LspStdioRequest; }
  catch { throw new Error("LSP worker request is invalid"); }
  const result = await analyzeLspSnapshot(request);
  write(`${JSON.stringify(result)}\n`);
}

/** Keep failures machine-readable across the packaged worker process boundary. */
export async function runCodebaseLspWorkerSafely(input: AsyncIterable<Uint8Array>, write: (text: string) => void): Promise<void> {
  try { await runCodebaseLspWorker(input, write); }
  catch (error) { write(`${JSON.stringify(lspWorkerFailure(error))}\n`); }
}
