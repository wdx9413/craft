import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PRODUCTS } from "../../core/release-catalog.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const pluginRoot = join(root, "plugins", "craft");
const componentNames = RELEASE_PRODUCTS.filter((product) => product.name !== "craft").map((product) => product.name);
const hookMembers = { "craft-knowledge": "knowledge", "craft-memory": "memory", "craft-experience": "experience" } as const;
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
]) await access(path);

for (const name of componentNames) {
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
    if (name in hookMembers) {
      assert.equal(componentManifest.hooks, "./hooks/codex-hooks.json");
      const hookPath = join(componentRoot, "hooks", "codex-hooks.json");
      await access(hookPath);
      await access(join(componentRoot, "dist", "plugin", "craft-codex-hook.cjs"));
      const hooks = JSON.parse(await readFile(hookPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ type?: string; command?: string; additionalContextLimit?: unknown }> }>> };
      assert(!JSON.stringify(hooks).includes("mcp_tool"), `${name} must not require an MCP Hook handler`);
      assert(!JSON.stringify(hooks).includes("${CLAUDE_PLUGIN_ROOT}"), `${name} must use the Codex root variable`);
      for (const group of Object.values(hooks.hooks).flat()) {
        for (const handler of group.hooks) {
          assert.equal(handler.type, "command", `${name} Hook handlers must use the portable command type`);
          assert.equal(handler.command, `node "\${PLUGIN_ROOT}/dist/plugin/craft-codex-hook.cjs" --member ${hookMembers[name as keyof typeof hookMembers]}`);
          assert.equal(handler.additionalContextLimit, undefined, `${name} must keep the shared Hook file portable`);
        }
      }
    }
  const source = await readFile(join(root, "skills", name, "SKILL.md"), "utf8");
  const packed = await readFile(join(componentRoot, "skills", name, "SKILL.md"), "utf8");
  assert.equal(normalizeText(packed), normalizeText(source));
}

// Public products select only their declared bounded MCP product.  A stale or
// widened value must never make a component bundle expose the full surface.
for (const [name, product, hooked] of [["craft-knowledge", "knowledge", true], ["craft-memory", "memory", true], ["craft-experience", "experience", true], ["craft-codebase", "codebase", false]] as const) {
  const manifest = JSON.parse(await readFile(join(root, "plugins", name, ".claude-plugin", "plugin.json"), "utf8")) as {
    name: string; version: string; hooks?: string; mcpServers: Record<string, { args: string[] }>;
  };
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.hooks, hooked ? "./hooks/hooks.json" : undefined);
  assert.deepEqual(manifest.mcpServers[name]?.args.slice(-2), ["--product", product]);
}

const sourceSkill = await readFile(join(root, "skills", "craft-route", "SKILL.md"), "utf8");
const packagedSkill = await readFile(join(pluginRoot, "skills", "craft-route", "SKILL.md"), "utf8");
assert.equal(normalizeText(packagedSkill), normalizeText(sourceSkill), "the packaged Skill must be an exact generated copy");

for (const marketplacePath of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const marketplace = JSON.parse(await readFile(join(root, marketplacePath), "utf8")) as { plugins: Array<{ name: string; source: { path: string } }> };
  const craft = marketplace.plugins.find((plugin) => plugin.name === "craft");
  assert.equal(craft?.source.path, "./plugins/craft", `${marketplacePath} must target the lightweight plugin directory`);
  for (const name of componentNames) {
    assert.equal(marketplace.plugins.find((plugin) => plugin.name === name)?.source.path, `./plugins/${name}`);
  }
}

const git = spawnSync("git", ["ls-files", "dist"], { cwd: root, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(git.stdout.trim(), "", "root build and desktop artifacts must not be tracked");
process.stdout.write("Lightweight plugin package is complete and root build output is untracked.\n");
