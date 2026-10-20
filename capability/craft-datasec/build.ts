import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const plugin = resolve(root, "plugins/craft-datasec");
await mkdir(resolve(plugin, "dist"), { recursive: true });
await build({ entryPoints: [resolve(root, "bin/craft-datasec-hook.ts")], bundle: true, platform: "node", target: "node23", format: "esm", outfile: resolve(plugin, "dist/hook.mjs") });
const source = JSON.parse(await readFile(resolve(import.meta.dirname, "package.json"), "utf8"));
await writeFile(resolve(plugin, "dist/build.json"), JSON.stringify({ name: "craft-datasec", version: source.version }) + "\n");
process.stdout.write(`Built independent plugin: ${plugin}\n`);
