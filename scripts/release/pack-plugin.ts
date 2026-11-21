import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";
import { writeComponentBuildInputs } from "../../core/release-build-inputs.ts";
import { RELEASE_PRODUCTS, releaseProductVersion } from "../../core/release-catalog.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const pluginRoot = resolve(root, "plugins", "craft");
const sourceSkill = resolve(root, "skills", "craft-route");
const targetSkill = resolve(pluginRoot, "skills", "craft-route");
const contextSkillMembers = ["craft-codebase", "craft-knowledge", "craft-memory", "craft-experience"];
const compilerAssets = ["craft-typescript.cjs", "craft-typescript-version.json", "craft-typescript-LICENSE.txt", "craft-typescript-NOTICE.txt"];
const sourceBundles = ["craft-mcp.cjs", "craft-mcp-full.cjs", "craft-mcp-http.cjs", "craft-codex-hook.cjs", "craft-parser-worker.js", "craft-experience-learning-worker.js", ...compilerAssets];
const targetBundleDirectory = resolve(pluginRoot, "dist", "plugin");
const requested = process.argv.slice(2).map(arg => {
  const match = /^--product=(.+)$/u.exec(arg);
  if (!match || !RELEASE_PRODUCTS.some(product => product.name === match[1])) throw new Error("Unknown product; use --product=<release product>");
  return match[1]!;
});
if (new Set(requested).size !== requested.length) throw new Error("Duplicate release product");
const selected = RELEASE_PRODUCTS.filter(product => requested.length === 0 || requested.includes(product.name));
const components = selected.filter(product => product.name !== "craft").map(product => product.name);
const pluginsRoot = resolve(root, "plugins");
const codebasePackageJson = fileURLToPath(import.meta.resolve("@craft/capability-codebase/package.json"));
const codebaseAnalyzers = resolve(dirname(codebasePackageJson), "analyzers");

function insidePlugin(path: string): boolean {
  return path === pluginRoot || path.startsWith(`${pluginRoot}/`) || path.startsWith(`${pluginRoot}\\`);
}

if (selected.some(product => product.name === "craft")) {
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

writeComponentBuildInputs(root, pluginRoot, "craft", CRAFT_RELEASE_VERSION);
writeComponentBuildInputs(root, root, "craft", CRAFT_RELEASE_VERSION);
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
  const componentBundles = ["craft-mcp.cjs", "craft-codex-hook.cjs", "craft-parser-worker.js", ...compilerAssets];
  if (["craft-context", "craft-knowledge", "craft-experience"].includes(component)) componentBundles.push("craft-experience-learning-worker.js");
  for (const bundle of componentBundles) {
    await cp(resolve(root, "dist", "plugin", bundle), resolve(componentBundleDirectory, bundle));
  }
  await mkdir(resolve(componentRoot, "skills"), { recursive: true });
  await cp(resolve(root, "skills", component), componentSkill, { recursive: true });
  if (component === "craft-context") {
    for (const member of contextSkillMembers) await cp(resolve(root, "skills", member), resolve(componentSkill, "references", member), { recursive: true });
    const learningAdapter = resolve(root, "plugins", "craft-experience", "assets", "learning-adapter");
    const contextLearningAdapter = resolve(componentSkill, "references", "craft-experience", "assets", "learning-adapter");
    await rm(contextLearningAdapter, { recursive: true, force: true });
    await cp(learningAdapter, contextLearningAdapter, { recursive: true });
  }
  if (["craft-context", "craft-codebase"].includes(component)) {
    const targetScripts = resolve(componentRoot, "scripts", "codebase");
    await rm(targetScripts, { recursive: true, force: true });
    await cp(resolve(root, "scripts", "codebase"), targetScripts, {
      recursive: true,
      filter: (path) => basename(path) !== "__pycache__" && !path.endsWith(".pyc"),
    });
    const analyzerTarget = resolve(targetScripts, "analyzers");
    await mkdir(analyzerTarget, { recursive: true });
    await cp(resolve(codebaseAnalyzers, "analyze-python.py"), resolve(analyzerTarget, "analyze-python.py"));
    await cp(resolve(codebaseAnalyzers, "python-control-flow.py"), resolve(analyzerTarget, "python-control-flow.py"));
    await cp(resolve(codebaseAnalyzers, "python-data-flow.py"), resolve(analyzerTarget, "python-data-flow.py"));
    await cp(resolve(codebaseAnalyzers, "AnalyzeJava.java"), resolve(analyzerTarget, "AnalyzeJava.java"));
    await cp(resolve(codebaseAnalyzers, "AnalyzeJavaControlFlow.java"), resolve(analyzerTarget, "AnalyzeJavaControlFlow.java"));
  }
  const product = RELEASE_PRODUCTS.find(item => item.name === component)!;
  writeComponentBuildInputs(root, componentRoot, component, releaseProductVersion(product));
  await mkdir(resolve(componentRoot, "assets"), { recursive: true });
  if (component !== "craft-context") await cp(resolve(root, "plugins", "craft-context", "assets", "craft-icon.svg"), resolve(componentRoot, "assets", "craft-icon.svg"));
  const codexManifest = JSON.parse(await readFile(resolve(componentRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const { defaultPrompt: _ignoredPrompt, ...codexInterface } = codexManifest.interface ?? { composerIcon: "./assets/craft-icon.svg", logo: "./assets/craft-icon.svg" };
  // Codex currently selects the root portable manifest over the compatibility
  // manifest, but does not load hooks from its OpenAI extension. Let the
  // compatibility manifest own craft-context hooks until Codex supports them.
  if (component === "craft-context") {
    await rm(resolve(componentRoot, "plugin.json"), { force: true });
  } else {
    const extensions = product.hookMember
      ? { extensions: { "com.openai": { interface: codexInterface, hooks: "./hooks/codex-hooks.json" } } }
      : {};
    await writeFile(resolve(componentRoot, "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: component, version: releaseProductVersion(product), description: `Standalone ${component} Skill and MCP`, license: "MIT", ...extensions }, null, 2) + "\n");
  }
  const hostEnv = component === "craft-context" ? { env: { CRAFT_LEARNING_MODEL_HOST: "codex-cli", CRAFT_CONTEXT_MEMBERS: "knowledge,memory,experience,codebase,notes,eval,runtime" } } : {};
  const mcpServer = { command: "node", args: ["${PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs", "--product", component.replace("craft-", "")], ...hostEnv };
  await writeFile(resolve(componentRoot, "mcp.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [component]: { type: "stdio", ...mcpServer } } }, null, 2) + "\n");
  const selected = component.replace("craft-", "");
  for (const host of ["codex", "claude"]) {
    await mkdir(resolve(componentRoot, `.${host}-plugin`), { recursive: true });
    const claudeEnv = component === "craft-context" ? { env: { CRAFT_LEARNING_MODEL_HOST: "claude-code", CRAFT_CONTEXT_MEMBERS: "knowledge,memory,experience,codebase,notes,eval,runtime" } } : {};
    const mcp = host === "codex" ? "./.mcp.json" : { [component]: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/dist/plugin/craft-mcp.cjs", "--product", selected], ...claudeEnv } };
    const previousPath = resolve(componentRoot, `.${host}-plugin`, "plugin.json");
    const previous = existsSync(previousPath) ? JSON.parse(await readFile(previousPath, "utf8")) : {};
    const description = component === "craft-context" ? "Complete Knowledge, Memory, Experience, and Codebase tools in one Craft entry point" : `${component} governed context and repository tools`;
    const manifest = { ...previous, ...(host === "codex" ? { interface: codexInterface } : {}), name: component, version: releaseProductVersion(product), description, author: { name: "wdx9413" }, skills: "./skills/", mcpServers: mcp,
      ...(product.hookMember ? { hooks: host === "codex" ? "./hooks/codex-hooks.json" : "./hooks/hooks.json" } : {}) };
    if (!product.hookMember) delete manifest.hooks;
    await writeFile(resolve(componentRoot, `.${host}-plugin`, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");
  }
  await writeFile(resolve(componentRoot, ".mcp.json"), JSON.stringify({ mcpServers: { [component]: { command: "node", args: ["dist/plugin/craft-mcp.cjs", "--product", selected], cwd: ".", ...hostEnv } } }, null, 2) + "\n");
}

process.stdout.write(`Packed Craft and ${components.length} component plugins.\n`);
