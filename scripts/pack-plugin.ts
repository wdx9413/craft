import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugins", "craft");
const sourceSkill = resolve(root, "skills", "craft-route");
const targetSkill = resolve(pluginRoot, "skills", "craft-route");
const sourceBundles = ["craft-mcp.cjs", "craft-mcp-full.cjs"];
const targetBundleDirectory = resolve(pluginRoot, "dist", "plugin");

function insidePlugin(path: string): boolean {
  return path === pluginRoot || path.startsWith(`${pluginRoot}/`) || path.startsWith(`${pluginRoot}\\`);
}

for (const path of [targetSkill, targetBundleDirectory]) {
  if (!insidePlugin(path)) throw new Error(`Refusing to package outside the plugin directory: ${path}`);
  await rm(path, { recursive: true, force: true });
}

await mkdir(dirname(targetSkill), { recursive: true });
await cp(sourceSkill, targetSkill, { recursive: true });
await mkdir(targetBundleDirectory, { recursive: true });
for (const bundle of sourceBundles) {
  await cp(resolve(root, "dist", "plugin", bundle), resolve(targetBundleDirectory, bundle));
}

process.stdout.write(`Packed ${sourceBundles.length} MCP bundles into plugins/craft.\n`);
