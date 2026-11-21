import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const packages = [
  ["@craft/capability-codebase", "craft-codebase"],
  ["@craft/capability-context", "craft-context"],
  ["@craft/capability-knowledge", "craft-knowledge"],
  ["@craft/capability-memory", "craft-memory"],
  ["@craft/capability-experience", "craft-experience"],
  ["@craft/craft-notes", "craft-notes"],
] as const;

for (const [packageName, directory] of packages) {
  const packageJson = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const source = join(dirname(packageJson), "dist");
  const target = join(root, "dist", "capability", directory);
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, dereference: false, errorOnExist: true });
  if (packageName === "@craft/capability-codebase") {
    await cp(join(dirname(packageJson), "analyzers"), join(target, "analyzers"), { recursive: true, dereference: false, errorOnExist: true });
  }
}

for (const packageName of ["craft-common-base", "craft-common-log", "craft-common-store-local"] as const) {
  const packageJson = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const source = join(dirname(packageJson), "dist");
  const target = join(root, "dist", "common", packageName, "dist");
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  await cp(source, target, { recursive: true, dereference: false, errorOnExist: true });
}

console.log(`Copied ${packages.length} installed capability runtimes into dist/capability.`);
