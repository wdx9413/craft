import { captureBuildInputs } from "./capture-build-inputs.ts";
import { writeComponentBuildInputs } from "../../core/release-build-inputs.ts";
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = resolve(root, "plugins/craft-datasec");

// This hook runs in a separate Host process. Bundle the capability and its local
// runtime dependencies so the marketplace payload does not need a node_modules tree.
await mkdir(resolve(plugin, "dist"), { recursive: true });
const capture = captureBuildInputs(root);
const result = await build({
  absWorkingDir: root, plugins: [capture.plugin],
  metafile: true,
  entryPoints: [resolve(root, "bin/craft-datasec-hook.ts")],
  bundle: true,
  platform: "node",
  target: "node23",
  format: "esm",
  outfile: resolve(plugin, "dist/hook.mjs"),
});
await mkdir(resolve(root, "dist/plugin"), { recursive: true });
await writeFile(resolve(root, "dist/plugin/hook.mjs.inputs.json"), JSON.stringify(capture.seal(result.metafile!)));
const manifest = JSON.parse(await readFile(resolve(plugin, ".codex-plugin/plugin.json"), "utf8")) as { version: string };
await writeFile(resolve(plugin, "dist/build.json"), JSON.stringify({ name: "craft-datasec", version: manifest.version }) + "\n");
writeComponentBuildInputs(root, plugin, "craft-datasec", manifest.version, "dist");
process.stdout.write(`Built independent plugin: ${plugin}\n`);
