import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugins", "craft");
const sourceSkill = resolve(root, "skills", "craft-route");
const targetSkill = resolve(pluginRoot, "skills", "craft-route");
const sourceBundles = ["craft-mcp.cjs", "craft-mcp-full.cjs"];
const targetBundleDirectory = resolve(pluginRoot, "dist", "plugin");
const components = ["craft-knowledge", "craft-memory", "craft-capability", "craft-skill-quality"];

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

for (const component of components) {
  const componentRoot = resolve(root, "plugins", component);
  const componentBundleDirectory = resolve(componentRoot, "dist", "plugin");
  const componentSkill = resolve(componentRoot, "skills", component);
  if (!componentRoot.startsWith(resolve(root, "plugins") + "/")) throw new Error(`Refusing to package outside plugins: ${componentRoot}`);
  await rm(componentBundleDirectory, { recursive: true, force: true });
  await rm(componentSkill, { recursive: true, force: true });
  await mkdir(componentBundleDirectory, { recursive: true });
  await cp(resolve(root, "dist", "plugin", "craft-mcp.cjs"), resolve(componentBundleDirectory, "craft-mcp.cjs"));
  await mkdir(resolve(componentRoot, "skills"), { recursive: true });
  await cp(resolve(root, "skills", component), componentSkill, { recursive: true });
}

process.stdout.write(`Packed Craft and ${components.length} component plugins.\n`);
