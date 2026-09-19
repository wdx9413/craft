import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const version = (JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string }).version;
const components = ["craft", "craft-context", "craft-quality", "craft-knowledge", "craft-memory", "craft-capability", "craft-skill-quality", "craft-workflow-evolution"];
for (const name of components) {
  const manifest = JSON.parse(await readFile(join(root, "plugins", name, ".codex-plugin", "plugin.json"), "utf8")) as { name: string; version: string };
  assert.equal(manifest.name, name);
  assert.equal(manifest.version, version, `${name} version mismatch`);
  await access(join(root, "plugins", name, "dist", "plugin", "craft-mcp.cjs"));
}
for (const path of ["marketplace.json", ".agents/plugins/marketplace.json"]) {
  const marketplace = JSON.parse(await readFile(join(root, path), "utf8")) as { version?: string; plugins: unknown[] };
  assert.equal(marketplace.version, version, `${path} version mismatch`);
}
process.stdout.write(`Plugin and marketplace versions are aligned at ${version}.\n`);
