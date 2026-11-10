import { readFileSync } from "node:fs";
import { analyzeLspSnapshot, type LspStdioRequest } from "../../capability/craft-codebase/lsp-stdio-client.ts";

const configPath = process.argv[2];
if (!configPath || process.argv.length !== 3) throw new Error("Usage: node --experimental-strip-types scripts/codebase/analyze-lsp.ts <request.json>");
const raw = readFileSync(configPath);
if (raw.byteLength > 70 * 1024 * 1024) throw new Error("LSP request file exceeds 70 MiB budget");
const request = JSON.parse(raw.toString("utf8")) as LspStdioRequest;
const analysis = await analyzeLspSnapshot(request);
process.stdout.write(`${JSON.stringify(analysis, null, 2)}\n`);
