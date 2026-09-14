import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * One release version, enforced.
 *
 * package.json is the source of truth; every consumer that has to agree with it
 * is checked here rather than by convention, because a manifest that silently
 * disagrees produces an adapter that installs and then reports the wrong
 * version. Adapters were previously unmanaged and drifted.
 */
const root = resolve(import.meta.dirname, "..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
}

const packageVersion = (await json("package.json")).version;
if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error("package.json must provide a semantic version as the release source of truth");
}

for (const path of ["plugins/craft/.codex-plugin/plugin.json", "plugins/craft-knowledge/.codex-plugin/plugin.json",
  "plugins/craft-memory/.codex-plugin/plugin.json", "plugins/craft-capability/.codex-plugin/plugin.json",
  "plugins/craft-skill-quality/.codex-plugin/plugin.json", "plugins/craft-workflow-evolution/.codex-plugin/plugin.json", ".claude-plugin/plugin.json",
  "adapters/workbuddy-expert/.codebuddy-plugin/plugin.json", "adapters/workbuddy-connector/connector-meta.json",
  "adapters/deepseek-harness/package.json"]) {
  const manifestVersion = (await json(path)).version;
  if (manifestVersion !== packageVersion) throw new Error(`${path} version ${String(manifestVersion)} differs from package.json ${packageVersion}`);
}

const service = await readFile(resolve(root, "src/service.ts"), "utf8");
const match = service.match(/export const VERSION = "([^"]+)";/u);
if (match?.[1] !== packageVersion) throw new Error(`src/service.ts VERSION differs from package.json ${packageVersion}`);

for (const path of ["README.md", "README.en.md"]) {
  const readme = await readFile(resolve(root, path), "utf8");
  const releaseLine = readme.split(/\r?\n/u).find((line) => /(?:当前发布版本|Current release)/u.test(line));
  if (!releaseLine?.includes(`v${packageVersion}`)) {
    throw new Error(`${path} must expose the current release v${packageVersion}`);
  }
}

// The adapter Skill files quote the release they ship with, so they must move too.
for (const path of ["adapters/workbuddy-expert/skills/craft-route/SKILL.md",
  "adapters/workbuddy-connector/skills/craft-route/SKILL.md",
  "adapters/trae-work/skills/craft-route/SKILL.md"]) {
  const skill = await readFile(resolve(root, path), "utf8");
  const quoted = skill.match(/(?:\bv|version:\s*)(\d+\.\d+\.\d+)\b/u);
  if (quoted && quoted[1] !== packageVersion) {
    throw new Error(`${path} quotes v${quoted[1]} but package.json is ${packageVersion}`);
  }
}
