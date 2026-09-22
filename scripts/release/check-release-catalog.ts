import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RELEASE_PRODUCTS, RETIRED_MCP_PREFIXES, RETIRED_PUBLIC_PRODUCTS, externalDistributionContract, releaseManifest } from "../../src/release-catalog.ts";
import { CRAFT_RELEASE_VERSION } from "../../src/version.ts";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
assert.deepEqual(JSON.parse(await readFile(join(root, "distribution-contract.json"), "utf8")), externalDistributionContract(), "distribution contract must be generated from ReleaseCatalog");
for (const path of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const actual = JSON.parse(await readFile(join(root, path), "utf8")) as { version?: string; plugins?: Array<{ name?: string; source?: { path?: string } }> };
  assert.equal(actual.version, CRAFT_RELEASE_VERSION, `${path} release mismatch`);
  assert.deepEqual(actual.plugins, releaseManifest().plugins, `${path} must be generated from ReleaseCatalog`);
}
for (const product of RELEASE_PRODUCTS) {
  const rootPath = join(root, "plugins", product.name);
  const codex = JSON.parse(await readFile(join(rootPath, ".codex-plugin", "plugin.json"), "utf8")) as { name?: string; version?: string; hooks?: string };
  assert.equal(codex.name, product.name); assert.equal(codex.version, CRAFT_RELEASE_VERSION);
  await access(join(rootPath, ".mcp.json")); await access(join(rootPath, "dist", "plugin", "craft-mcp.cjs"));
  if (product.hookMember) assert.equal(codex.hooks, "./hooks/codex-hooks.json", `${product.name} must retain its Codex Hook bridge`);
  if (product.name !== "craft") {
    const claude = JSON.parse(await readFile(join(rootPath, ".claude-plugin", "plugin.json"), "utf8")) as { name?: string; version?: string; hooks?: string };
    assert.equal(claude.name, product.name); assert.equal(claude.version, CRAFT_RELEASE_VERSION);
    if (product.hookMember) assert.equal(claude.hooks, "./hooks/hooks.json");
    else assert.equal(claude.hooks, undefined, `${product.name} must not install an automatic Hook`);
  }
}
const server = await readFile(join(root, "src", "interfaces", "mcp-server.ts"), "utf8");
for (const prefix of RETIRED_MCP_PREFIXES) assert(!server.includes(`tool("${prefix}`), `${prefix} must not be public`);
for (const product of RETIRED_PUBLIC_PRODUCTS) {
  const marketplace = JSON.stringify(releaseManifest());
  assert(!marketplace.includes(`\"${product}\"`), `${product} must not be released as a public product`);
}
process.stdout.write(`Release catalog is aligned at ${CRAFT_RELEASE_VERSION}.\n`);
