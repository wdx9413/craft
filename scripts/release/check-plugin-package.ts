import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PRODUCTS } from "../../core/release-catalog.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pluginRoot = join(root, "plugins", "craft");
const componentProducts = RELEASE_PRODUCTS.filter((product) => product.name !== "craft");
const hookContextLimits: Record<string, number> = { "craft-context": 1_200, "craft-knowledge": 400, "craft-memory": 400, "craft-experience": 400 };
const normalizeText = (value: string): string => value.replaceAll("\r\n", "\n");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const pluginManifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")) as { name: string; version: string; skills: string; mcpServers: string; interface?: { composerIcon?: string; logo?: string } };

assert.equal(pluginManifest.name, "craft");
assert.equal(pluginManifest.version, packageJson.version, "plugin and package versions must match");
assert.equal(pluginManifest.skills, "./skills/");
assert.equal(pluginManifest.mcpServers, "./.mcp.json");
assert.equal(pluginManifest.interface?.composerIcon, "./assets/craft-icon.svg");
assert.equal(pluginManifest.interface?.logo, "./assets/craft-icon.svg");
await access(join(pluginRoot, "assets", "craft-icon.svg"));

for (const path of [
  join(pluginRoot, ".mcp.json"),
  join(pluginRoot, "skills", "craft-route", "SKILL.md"),
  join(pluginRoot, "dist", "plugin", "craft-mcp.cjs"),
  join(pluginRoot, "dist", "plugin", "craft-mcp-full.cjs"),
  join(pluginRoot, "dist", "plugin", "craft-experience-learning-worker.js"),
]) await access(path);

for (const product of componentProducts) {
  const name = product.name;
  const componentRoot = join(root, "plugins", name);
  const componentManifest = JSON.parse(await readFile(join(componentRoot, ".codex-plugin", "plugin.json"), "utf8")) as { name: string; version: string; skills: string; mcpServers: string; hooks?: string; interface?: { composerIcon?: string; logo?: string } };
  assert.equal(componentManifest.name, name);
  assert.equal(componentManifest.version, packageJson.version);
  assert.equal(componentManifest.skills, "./skills/");
  assert.equal(componentManifest.mcpServers, "./.mcp.json");
  assert.equal(componentManifest.interface?.composerIcon, "./assets/craft-icon.svg");
  assert.equal(componentManifest.interface?.logo, "./assets/craft-icon.svg");
  await access(join(componentRoot, "assets", "craft-icon.svg"));
  await access(join(componentRoot, "dist", "plugin", "craft-mcp.cjs"));
  if (name === "craft-context") {
    await access(join(componentRoot, "scripts", "codebase", "analyzers", "python-control-flow.py"));
    await access(join(componentRoot, "scripts", "codebase", "analyzers", "python-data-flow.py"));
    await access(join(componentRoot, "scripts", "codebase", "analyzers", "AnalyzeJava.java"));
    await access(join(componentRoot, "scripts", "codebase", "analyzers", "AnalyzeJavaControlFlow.java"));
  }
  if (name === "craft-context") {
    await access(join(componentRoot, "dist", "plugin", "craft-experience-learning-worker.js"));
  }
    if (product.hookMember) {
      const portable = JSON.parse(await readFile(join(componentRoot, "plugin.json"), "utf8")) as { extensions?: { "com.openai"?: { hooks?: string; interface?: { composerIcon?: string; logo?: string } } } };
      assert.equal(portable.extensions?.["com.openai"]?.hooks, "./hooks/codex-hooks.json", `${name} portable manifest must expose Codex hooks`);
      assert.equal(portable.extensions?.["com.openai"]?.interface?.composerIcon, componentManifest.interface?.composerIcon);
      assert.equal(portable.extensions?.["com.openai"]?.interface?.logo, componentManifest.interface?.logo);
      assert.equal(componentManifest.hooks, "./hooks/codex-hooks.json");
      const hookPath = join(componentRoot, "hooks", "codex-hooks.json");
      await access(hookPath);
      await access(join(componentRoot, "dist", "plugin", "craft-codex-hook.cjs"));
      const hooks = JSON.parse(await readFile(hookPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ type?: string; command?: string; additionalContextLimit?: unknown }> }>> };
      assert(!JSON.stringify(hooks).includes("mcp_tool"), `${name} must not require an MCP Hook handler`);
      assert(!JSON.stringify(hooks).includes("${CLAUDE_PLUGIN_ROOT}"), `${name} must use the Codex root variable`);
      for (const [event, groups] of Object.entries(hooks.hooks)) {
        for (const group of groups) {
          for (const handler of group.hooks) {
          assert.equal(handler.type, "command", `${name} Hook handlers must use the portable command type`);
          assert.equal(handler.command, `node "\${PLUGIN_ROOT}/dist/plugin/craft-codex-hook.cjs" --member ${product.hookMember}`);
          if (handler.additionalContextLimit !== undefined) {
            assert.equal(event, "UserPromptSubmit", `${name} Hook context budget is scoped to UserPromptSubmit`);
            assert(Number.isInteger(handler.additionalContextLimit) && Number(handler.additionalContextLimit) >= 0 && Number(handler.additionalContextLimit) <= hookContextLimits[name], `${name} Hook context budget exceeds its limit`);
          }
          }
        }
      }
    }
  const source = await readFile(join(root, "skills", name, "SKILL.md"), "utf8");
  const packed = await readFile(join(componentRoot, "skills", name, "SKILL.md"), "utf8");
  assert.equal(normalizeText(packed), normalizeText(source));
}

// The public marketplace currently ships one complete context entry point.
for (const { name, hookMember } of componentProducts) {
  const manifest = JSON.parse(await readFile(join(root, "plugins", name, ".claude-plugin", "plugin.json"), "utf8")) as {
    name: string; version: string; hooks?: string; mcpServers: Record<string, { args: string[] }>;
  };
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.hooks, hookMember ? "./hooks/hooks.json" : undefined);
  assert.deepEqual(manifest.mcpServers[name]?.args.slice(-2), ["--product", name.replace("craft-", "")]);
  if (name === "craft-context") {
    for (const member of ["craft-codebase", "craft-knowledge", "craft-memory", "craft-experience"])
      await access(join(root, "plugins", name, "skills", "craft-context", "references", member, "SKILL.md"));
    await access(join(root, "plugins", name, "skills", "craft-context", "references", "craft-experience", "assets", "learning-adapter", "adapter.example.json"));
  }
}

const sourceSkill = await readFile(join(root, "skills", "craft-route", "SKILL.md"), "utf8");
const packagedSkill = await readFile(join(pluginRoot, "skills", "craft-route", "SKILL.md"), "utf8");
assert.equal(normalizeText(packagedSkill), normalizeText(sourceSkill), "the packaged Skill must be an exact generated copy");

for (const marketplacePath of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const marketplace = JSON.parse(await readFile(join(root, marketplacePath), "utf8")) as { plugins: Array<{ name: string; source: { path: string } }> };
  const craft = marketplace.plugins.find((plugin) => plugin.name === "craft");
  assert.equal(craft?.source.path, "./plugins/craft", `${marketplacePath} must target the lightweight plugin directory`);
  for (const { name } of componentProducts) {
    assert.equal(marketplace.plugins.find((plugin) => plugin.name === name)?.source.path, `./plugins/${name}`);
  }
}

const git = spawnSync("git", ["ls-files", "dist"], { cwd: root, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(git.stdout.trim(), "", "root build and desktop artifacts must not be tracked");
process.stdout.write("Lightweight plugin package is complete and root build output is untracked.\n");
