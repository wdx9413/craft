import { readFileSync } from "node:fs";
import { normalizeLspSymbols } from "../../capability/craft-codebase/lsp-adapter.ts";
// Local conversion only. Redirect the output and submit it as analysis to craft_codebase_analysis_import.
if (!process.argv[2]) throw new Error("Usage: node scripts/codebase/normalize-lsp.ts lsp-documents.json");
process.stdout.write(JSON.stringify(normalizeLspSymbols(JSON.parse(readFileSync(process.argv[2], "utf8"))), null, 2) + "\n");
