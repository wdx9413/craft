import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PRODUCTS, externalDistributionContract, releaseManifest } from "../../src/release-catalog.ts";
import { CRAFT_RELEASE_VERSION } from "../../src/version.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

for (const path of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const existing = JSON.parse(await readFile(join(root, path), "utf8")) as Record<string, unknown>;
  await writeJson(join(root, path), { ...existing, version: CRAFT_RELEASE_VERSION, plugins: releaseManifest().plugins });
}
await writeJson(join(root, "distribution-contract.json"), externalDistributionContract());

for (const product of RELEASE_PRODUCTS) {
  for (const relative of [".codex-plugin/plugin.json", ...(product.name === "craft" ? [] : [".claude-plugin/plugin.json"])]) {
    const path = join(root, "plugins", product.name, relative);
    const existing = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeJson(path, { ...existing, name: product.name, version: CRAFT_RELEASE_VERSION });
  }
}

process.stdout.write(`Release catalog synchronized at ${CRAFT_RELEASE_VERSION}.\n`);
