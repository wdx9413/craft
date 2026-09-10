import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

async function json(path: string): Promise<{ version?: unknown }> {
  return JSON.parse(await readFile(resolve(root, path), "utf8")) as { version?: unknown };
}

const packageVersion = (await json("package.json")).version;
if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error("package.json must provide a semantic version as the release source of truth");
}

for (const path of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
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
