import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = resolve(root, "plugins/craft-datasec");

// This hook runs in a separate Host process. Bundle the capability and its local
// runtime dependencies so the marketplace payload does not need a node_modules tree.
await mkdir(resolve(plugin, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(root, "bin/craft-datasec-hook.ts")],
  bundle: true,
  platform: "node",
  target: "node23",
  format: "esm",
  outfile: resolve(plugin, "dist/hook.mjs"),
});
const manifest = JSON.parse(await readFile(resolve(plugin, ".codex-plugin/plugin.json"), "utf8")) as { version: string };
await writeFile(resolve(plugin, "dist/build.json"), JSON.stringify({ name: "craft-datasec", version: manifest.version }) + "\n");
process.stdout.write(`Built independent plugin: ${plugin}\n`);
