import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const plugin = resolve(root, "plugins/craft-datasec");

// The capability package is an external dependency: bundling it would give the
// plugin its own copy of the runtime and break shared prototypes across packages.
await mkdir(resolve(plugin, "dist"), { recursive: true });
await build({
  entryPoints: [resolve(root, "bin/craft-datasec-hook.ts")],
  bundle: true,
  packages: "external",
  platform: "node",
  target: "node23",
  format: "esm",
  outfile: resolve(plugin, "dist/hook.mjs"),
});
const source = JSON.parse(await readFile(resolve(root, "node_modules/@craft/capability-datasec/package.json"), "utf8")) as { version: string };
await writeFile(resolve(plugin, "dist/build.json"), JSON.stringify({ name: "craft-datasec", version: source.version }) + "\n");
process.stdout.write(`Built independent plugin: ${plugin}\n`);
