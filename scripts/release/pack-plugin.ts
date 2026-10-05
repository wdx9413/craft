import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";
import { RELEASE_PRODUCTS } from "../../core/release-catalog.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = resolve(root, "plugins", "craft");
const sourceSkill = resolve(root, "skills", "craft-route");
const targetSkill = resolve(pluginRoot, "skills", "craft-route");
const sourceBundles = ["craft-mcp.cjs", "craft-mcp-full.cjs", "craft-mcp-http.cjs", "craft-codex-hook.cjs", "craft-parser-worker.js"];
const targetBundleDirectory = resolve(pluginRoot, "dist", "plugin");
const components = RELEASE_PRODUCTS.filter((product) => product.name !== "craft").map((product) => product.name);
const pluginsRoot = resolve(root, "plugins");

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
  const componentRelative = relative(pluginsRoot, componentRoot);
  if (!componentRelative || componentRelative.startsWith("..") || isAbsolute(componentRelative)) throw new Error(`Refusing to package outside plugins: ${componentRoot}`);
  await rm(componentBundleDirectory, { recursive: true, force: true });
  await rm(componentSkill, { recursive: true, force: true });
  await mkdir(componentBundleDirectory, { recursive: true });
  // The parser worker is resolved relative to the bundle's own directory at
  // startup (`resolveParserWorkerPath`), so a component plugin that ships the
  // MCP bundle without it cannot boot on its own.
  for (const bundle of ["craft-mcp.cjs", "craft-codex-hook.cjs", "craft-parser-worker.js"]) {
    await cp(resolve(root, "dist", "plugin", bundle), resolve(componentBundleDirectory, bundle));
  }
  await mkdir(resolve(componentRoot, "skills"), { recursive: true });
  await cp(resolve(root, "skills", component), componentSkill, { recursive: true });
  if (component === "craft-context") {
    for (const member of components.filter(name => name !== "craft-context")) await cp(resolve(root, "skills", member), resolve(componentSkill, "references", member), { recursive: true });
  }
  if (component === "craft-codebase" || component === "craft-context") {
    const targetScripts = resolve(componentRoot, "scripts", "codebase");
    await rm(targetScripts, { recursive: true, force: true });
    await cp(resolve(root, "scripts", "codebase"), targetScripts, {
      recursive: true,
      filter: (path) => basename(path) !== "__pycache__" && !path.endsWith(".pyc"),
    });
  }
  // Portable core contains only Skill + MCP. Native Hook manifests remain optional compatibility artifacts.
  await writeFile(resolve(componentRoot, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: component, version: CRAFT_RELEASE_VERSION, description: `Standalone ${component} Skill and MCP`, license: "MIT" }, null, 2) + "\n");
  await writeFile(resolve(componentRoot, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [component]: { type: "stdio", command: "node", args: ["${PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs", "--product", component.replace("craft-", "")] } } }, null, 2) + "\n");
  const product = RELEASE_PRODUCTS.find(item => item.name === component)!;
  const selected = component.replace("craft-", "");
  for (const host of ["codex", "claude"]) {
    await mkdir(resolve(componentRoot, `.${host}-plugin`), { recursive: true });
    const mcp = host === "codex" ? "./.mcp.json" : { [component]: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs", "--product", selected] } };
    const previousPath = resolve(componentRoot, `.${host}-plugin`, "plugin.json");
    const previous = existsSync(previousPath) ? JSON.parse(await readFile(previousPath, "utf8")) : {};
    const manifest = { ...previous, name: component, version: CRAFT_RELEASE_VERSION, description: `${component} governed context and repository tools`, author: { name: "wdx9413" }, skills: "./skills/", mcpServers: mcp,
      ...(product.hookMember ? { hooks: host === "codex" ? "./hooks/codex-hooks.json" : "./hooks/hooks.json" } : {}) };
    if (!product.hookMember) delete manifest.hooks;
    await writeFile(resolve(componentRoot, `.${host}-plugin`, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  await writeFile(resolve(componentRoot, ".mcp.json"), JSON.stringify({ mcpServers: { [component]: { command: "node", args: ["dist/plugin/craft-mcp.cjs", "--product", selected], cwd: "." } } }, null, 2) + "\n");
}

process.stdout.write(`Packed Craft and ${components.length} component plugins.\n`);
