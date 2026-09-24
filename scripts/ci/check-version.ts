import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { RELEASE_PRODUCTS } from "../../core/release-catalog.ts";

/**
 * One release version, enforced.
 *
 * package.json is the source of truth; every consumer that has to agree with it
 * is checked here rather than by convention, because a manifest that silently
 * disagrees produces an adapter that installs and then reports the wrong
 * version. Adapters were previously unmanaged and drifted.
 */
const root = resolve(import.meta.dirname, "..", "..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as Record<string, unknown>;
}

async function jsonAt(base: string, path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(base, path), "utf8")) as Record<string, unknown>;
}

const packageVersion = (await json("package.json")).version;
if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error("package.json must provide a semantic version as the release source of truth");
}

for (const path of [...RELEASE_PRODUCTS.map((product) => `plugins/${product.name}/.codex-plugin/plugin.json`), ".claude-plugin/plugin.json",
  "adapters/workbuddy-expert/.codebuddy-plugin/plugin.json", "adapters/workbuddy-connector/connector-meta.json",
  "adapters/deepseek-harness/package.json"]) {
  const manifestVersion = (await json(path)).version;
  if (manifestVersion !== packageVersion) throw new Error(`${path} version ${String(manifestVersion)} differs from package.json ${packageVersion}`);
}

for (const path of RELEASE_PRODUCTS.filter((product) => product.hookMember).map((product) => `plugins/${product.name}/.claude-plugin/plugin.json`)) {
  const manifestVersion = (await json(path)).version;
  if (manifestVersion !== packageVersion) throw new Error(`${path} version ${String(manifestVersion)} differs from package.json ${packageVersion}`);
}

const versionSource = await readFile(resolve(root, "core/version.ts"), "utf8");
const match = versionSource.match(/CRAFT_RELEASE_VERSION = "([^"]+)"/u);
if (match?.[1] !== packageVersion) throw new Error(`core/version.ts CRAFT_RELEASE_VERSION differs from package.json ${packageVersion}`);

for (const path of ["capability/craft-knowledge/package.json", "capability/craft-memory/package.json", "capability/craft-experience/package.json", "capability/craft-codebase/package.json", "adapters/deepseek-harness/package.json"]) {
  const component = await json(path);
  if (component.version !== packageVersion) throw new Error(`${path} version ${String(component.version)} differs from package.json ${packageVersion}`);
  const peers = (component.peerDependencies ?? {}) as Record<string, unknown>;
  if (peers["craft-agent-harness"] !== undefined && peers["craft-agent-harness"] !== packageVersion) throw new Error(`${path} craft-agent-harness peer differs from package.json ${packageVersion}`);
}

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

/**
 * The marketplace is a separate repository, so nothing above can see it. It
 * drifted for three releases (marketplace manifests 0.12.32, its README 0.12.31,
 * craft 0.12.30) precisely because agreement was maintained by hand.
 *
 * It is checked only when a sibling checkout exists, so this repository still
 * validates in isolation.
 */
const marketplaceRoot = resolve(root, "..", "craft-marketplace");
if (existsSync(resolve(marketplaceRoot, "release.json"))) {
  const marketplaceVersion = (await jsonAt(marketplaceRoot, "release.json")).version;
  if (marketplaceVersion !== packageVersion) {
    throw new Error(`craft-marketplace/release.json version ${String(marketplaceVersion)} differs from craft package.json ${packageVersion}`);
  }

  const marketplaceManifests = [
    ...RELEASE_PRODUCTS.map((product) => `plugins/${product.name}/.codex-plugin/plugin.json`),
    ...RELEASE_PRODUCTS.filter((product) => product.hookMember).map((product) => `plugins/${product.name}/.claude-plugin/plugin.json`),
    ".claude-plugin/marketplace.json",
  ];
  for (const path of marketplaceManifests) {
    if (!existsSync(resolve(marketplaceRoot, path))) continue;
    const manifestVersion = (await jsonAt(marketplaceRoot, path)).version;
    if (manifestVersion !== packageVersion) {
      throw new Error(`craft-marketplace/${path} version ${String(manifestVersion)} differs from craft package.json ${packageVersion}`);
    }
  }

  const marketplaceReadme = await readFile(resolve(marketplaceRoot, "README.md"), "utf8");
  const versionLine = marketplaceReadme.split(/\r?\n/u).find((line) => /Craft version/u.test(line));
  if (versionLine && !versionLine.includes(packageVersion)) {
    throw new Error(`craft-marketplace/README.md must expose Craft version ${packageVersion}`);
  }
}

/**
 * The release version must not appear in a source path.
 *
 * Every check above pins a *version literal*; this one pins the shape of the
 * file tree, because the previous convention encoded the release batch in the
 * filename (`v01236-verification.ts`, `test:v01236`). That made the file list a
 * second changelog: names recorded which release added a module rather than what
 * the module does, and the batch number became permanent identity even after the
 * release shipped. Renaming to the feature name is the fix; this guard is what
 * keeps it fixed instead of relying on the next author to remember.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

const versionedSources = walk(resolve(root, "core"))
  .map((file) => relative(root, file).split("\\").join("/"))
  .filter((path) => /(^|\/)v\d{4,}[-.]/u.test(path));

if (versionedSources.length) {
  throw new Error(
    `source paths must not carry a release version; name the module after what it does:\n  ${versionedSources.join("\n  ")}`,
  );
}
