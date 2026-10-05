import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packages = [
  ...["craft-common-store-local", "craft-common-base", "craft-common-log"].map(name => `common/${name}`),
  ...["knowledge", "memory", "experience", "codebase"].map(name => `capability/craft-${name}`),
];

// Root declaration build keeps the exact checked types. Each package's JS is
// then bundled so its runtime cannot reach back into the monorepo checkout.
execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json")], { cwd: root, stdio: "inherit" });
for (const relative of packages) {
  const packageRoot = join(root, relative);
  const sourceDir = join(packageRoot, relative.startsWith("common/") ? "src" : "");
  const outDir = join(packageRoot, "dist");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const sources = readdirSync(sourceDir).filter(file => file.endsWith(".ts")).map(file => join(sourceDir, file));
  execFileSync(join(root, "node_modules/.bin/esbuild"), [
    ...sources, "--bundle", "--packages=external", "--platform=node", "--format=esm", "--target=node23",
    `--outbase=${sourceDir}`, `--outdir=${outDir}`,
  ], { cwd: root, stdio: "inherit" });
  const declarations = join(root, "dist", relative, relative.startsWith("common/") ? "src" : "");
  for (const file of readdirSync(declarations).filter(file => file.endsWith(".d.ts"))) {
    const output = join(outDir, file);
    cpSync(join(declarations, file), output);
    let body = readFileSync(output, "utf8");
    body = body.replace(/\.\.\/\.\.\/common\/(craft-common-[a-z-]+)\/src\/([a-z-]+)\.ts/gu, "$1/$2");
    body = body.replace(/\.\.\/\.\.\/craft-common-store-local\/src\/([a-z-]+)\.ts/gu, "craft-common-store-local/$1");
    body = body.replace(/\.\/([a-z0-9-]+)\.ts/gu, "./$1.js");
    writeFileSync(output, body);
  }
  process.stdout.write(`Built standalone package ${relative}\n`);
}
