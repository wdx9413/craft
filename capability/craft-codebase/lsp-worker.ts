import { analyzeLspSnapshot, type LspStdioRequest } from "./lsp-stdio-client.ts";

export const CODEBASE_LSP_WORKER_FLAG = "--craft-codebase-lsp-worker";
const MAX_REQUEST_BYTES = 70 * 1024 * 1024;

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
