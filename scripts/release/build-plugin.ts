import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureBuildInputs } from "./capture-build-inputs.ts";
import { prepareTypeScriptCompiler } from "./prepare-typescript-compiler.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = resolve(root, "dist/plugin");
await mkdir(output, { recursive: true });
await prepareTypeScriptCompiler(output);
for (const [entry, file, format] of [
  ["bin/craft-mcp.ts", "craft-mcp.cjs", "cjs"], ["bin/craft-mcp-full.ts", "craft-mcp-full.cjs", "cjs"],
  ["bin/craft-mcp-http.ts", "craft-mcp-http.cjs", "cjs"], ["bin/craft-codex-hook.ts", "craft-codex-hook.cjs", "cjs"],
  ["bin/craft-parser-worker.ts", "craft-parser-worker.js", "esm"],
  ["deploy/experience-learning/worker.ts", "craft-experience-learning-worker.js", "esm"],
] as const) {
  process.stdout.write(`Building ${file}\n`);
  const capture = captureBuildInputs(root);
  const result = await build({ absWorkingDir: root, entryPoints: [entry], outfile: resolve(output, file), bundle: true,
    platform: "node", target: "node23", format, metafile: true, plugins: [capture.plugin],
    ...(file === "craft-experience-learning-worker.js" ? { banner: { js: 'import { createRequire as __craftCreateRequire } from "node:module"; const require = __craftCreateRequire(import.meta.url);' } } : {}),
    define: { CRAFT_TYPESCRIPT_BUNDLE: "true", ...(format === "cjs" ? { "import.meta.url": "undefined" } : {}) } });
  await writeFile(resolve(output, `${file}.inputs.json`), JSON.stringify(capture.seal(result.metafile!)));
  process.stdout.write(`Built ${file}: ${Object.keys(result.metafile!.inputs).length} captured inputs\n`);
}
