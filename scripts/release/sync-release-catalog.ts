import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allReleaseProducts, externalDistributionContract, releaseManifest, releaseProductVersion } from "../../core/release-catalog.ts";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const requested = process.argv.slice(2).map(arg => {
  const match = /^--product=(.+)$/u.exec(arg);
  if (!match || !allReleaseProducts().some(product => product.name === match[1])) throw new Error("Unknown release product");
  return match[1]!;
});
if (new Set(requested).size !== requested.length) throw new Error("Duplicate release product");
const selected = allReleaseProducts().filter(product => requested.length === 0 || requested.includes(product.name));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

for (const path of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const existing = JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
  await writeJson(join(root, path), { ...existing, version: CRAFT_RELEASE_VERSION, plugins: releaseManifest().plugins });
}
await writeJson(join(root, "distribution-contract.json"), externalDistributionContract());
const claudePath = join(root, ".claude-plugin", "marketplace.json");
const claude = JSON.parse(await readFile(claudePath, "utf8"));
await writeJson(claudePath, { ...claude, version: CRAFT_RELEASE_VERSION, plugins: allReleaseProducts().map(product => ({ name: product.name, source: product.name === "craft" ? "./" : `./plugins/${product.name}`, description: product.surface === "standalone-hooks" ? `${product.name} independent local redaction hooks` : `${product.name} Skill and MCP` })) });

for (const product of selected) {
  for (const relative of [".codex-plugin/plugin.json", ...(product.name === "craft" ? [] : [".claude-plugin/plugin.json"])]) {
    const path = join(root, "plugins", product.name, relative);
    const existing = await readFile(path, "utf8").then(value => JSON.parse(value) as Record<string, unknown>).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return {}; });
    await writeJson(path, { ...existing, name: product.name, version: releaseProductVersion(product) });
  }
}

if (selected.some(product => product.name === "craft")) {
const rootClaudePluginPath = join(root, ".claude-plugin", "plugin.json");
const rootClaudePlugin = JSON.parse(await readFile(rootClaudePluginPath, "utf8")) as Record<string, unknown>;
await writeJson(rootClaudePluginPath, { ...rootClaudePlugin, name: "craft", version: CRAFT_RELEASE_VERSION });

for (const relative of ["adapters/workbuddy-connector/connector-meta.json", "adapters/deepseek-harness/package.json"]) {
  const path = join(root, relative);
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeJson(path, { ...manifest, version: CRAFT_RELEASE_VERSION });
}

const workbuddyPluginPath = join(root, "adapters", "workbuddy-expert", ".codebuddy-plugin", "plugin.json");
const workbuddyPlugin = JSON.parse(await readFile(workbuddyPluginPath, "utf8")) as Record<string, unknown>;
await writeJson(workbuddyPluginPath, { ...workbuddyPlugin, version: CRAFT_RELEASE_VERSION });

}

process.stdout.write(`Release catalog synchronized at ${CRAFT_RELEASE_VERSION}.\n`);
