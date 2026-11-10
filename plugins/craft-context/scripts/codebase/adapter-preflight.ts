import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import type { JsonObject } from "../../common/craft-common-store-local/src/store.ts";

/** Availability is separate from semantic conformance and full-project coverage. */
export function codebaseAdapterPreflight(commands: Record<string, string[]> = {
  python: ["python3", "-c", "import jedi; print(jedi.__version__)"],
  java: ["jdtls", "--version"], go: ["gopls", "version"],
}): JsonObject {
  const languages = Object.entries(commands).map(([language, argv]) => {
    if (!argv.length || argv.some(item => typeof item !== "string" || !item)) throw new Error("Adapter argv must be non-empty strings");
    const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 3000, maxBuffer: 4096 });
    return { language, available: !result.error && result.status === 0, semantic_conformance: "unverified", call_graph_completeness: "partial", diagnostic: result.error ? "executable_unavailable_or_timeout" : result.status !== 0 ? "probe_failed" : "requires_checkpoint_fixture_acceptance" };
  });
  return { languages, executes_repository_code: false, production_verified: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(codebaseAdapterPreflight(), null, 2) + "\n");
