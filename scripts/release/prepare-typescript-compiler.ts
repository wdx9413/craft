import { createRequire } from "node:module";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Ship the pinned compiler once, outside the latency-sensitive Hook/MCP bundles. */
export async function prepareTypeScriptCompiler(output: string): Promise<void> {
  const requireLocal = createRequire(import.meta.url);
  const version = String((requireLocal("typescript/package.json") as { version: string }).version);
  await mkdir(output, { recursive: true });
  await copyFile(requireLocal.resolve("typescript"), join(output, "craft-typescript.cjs"));
  const packageRoot = dirname(requireLocal.resolve("typescript/package.json"));
  await copyFile(join(packageRoot, "LICENSE.txt"), join(output, "craft-typescript-LICENSE.txt"));
  await copyFile(join(packageRoot, "ThirdPartyNoticeText.txt"), join(output, "craft-typescript-NOTICE.txt"));
  await writeFile(join(output, "craft-typescript-version.json"), JSON.stringify({ version }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareTypeScriptCompiler(resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/plugin"));
}
