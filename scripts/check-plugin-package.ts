import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginRoot = join(root, "plugins", "craft");
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
const pluginManifest = JSON.parse(await readFile(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8")) as { name: string; version: string; skills: string; mcpServers: string };

assert.equal(pluginManifest.name, "craft");
assert.equal(pluginManifest.version, packageJson.version, "plugin and package versions must match");
assert.equal(pluginManifest.skills, "./skills/craft-route/");
assert.equal(pluginManifest.mcpServers, "./.mcp.json");

for (const path of [
  join(pluginRoot, ".mcp.json"),
  join(pluginRoot, "skills", "craft-route", "SKILL.md"),
  join(pluginRoot, "dist", "plugin", "craft-mcp.cjs"),
  join(pluginRoot, "dist", "plugin", "craft-mcp-full.cjs"),
]) await access(path);

const sourceSkill = await readFile(join(root, "skills", "craft-route", "SKILL.md"), "utf8");
const packagedSkill = await readFile(join(pluginRoot, "skills", "craft-route", "SKILL.md"), "utf8");
assert.equal(packagedSkill, sourceSkill, "the packaged Skill must be an exact generated copy");

for (const marketplacePath of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const marketplace = JSON.parse(await readFile(join(root, marketplacePath), "utf8")) as { plugins: Array<{ name: string; source: { path: string } }> };
  const craft = marketplace.plugins.find((plugin) => plugin.name === "craft");
  assert.equal(craft?.source.path, "./plugins/craft", `${marketplacePath} must target the lightweight plugin directory`);
}

const git = spawnSync("git", ["ls-files", "dist"], { cwd: root, encoding: "utf8" });
assert.equal(git.status, 0, git.stderr);
assert.equal(git.stdout.trim(), "", "root build and desktop artifacts must not be tracked");
process.stdout.write("Lightweight plugin package is complete and root build output is untracked.\n");
