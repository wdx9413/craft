import { access, cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, resolve, sep } from "node:path";

type Copy = { source: string; target: string };
type Artifact = { npm_files: string[]; runtime_copies: Copy[] };
type RuntimePackage = { name: string; source: string };

function localPath(root: string, path: string): string {
  const result = resolve(root, path);
  if (result === root || !result.startsWith(`${root}${sep}`)) throw new Error("Artifact path must remain inside its product");
  return result;
}

function validatePhysicalPath(root: string, path: string): void {
  let ancestor = path;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const actual = realpathSync(ancestor);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("Artifact symlink escapes project");
}

/** npm and isolated runtime bundles consume one core product graph; dependency collisions fail before deleting staging. */
export async function prepareRuntimeArtifact(root: string, binary = process.execPath, stagingRoot = root): Promise<string> {
  root = realpathSync(root);
  stagingRoot = realpathSync(stagingRoot);
  const artifact: Artifact = JSON.parse(await readFile(resolve(root, "runtime-artifacts.json"), "utf8"));
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (JSON.stringify(manifest.files) !== JSON.stringify(artifact.npm_files)) throw new Error("npm runtime artifact contract drift");
  const output = resolve(stagingRoot, "dist", "runtime", "app");
  validatePhysicalPath(stagingRoot, output);
  const destinations = new Set<string>();
  for (const entry of artifact.runtime_copies) {
    const target = localPath(output, entry.target);
    if (destinations.has(target)) throw new Error("Duplicate artifact target");
    destinations.add(target);
    const source = localPath(root, entry.source);
    await access(source);
    validatePhysicalPath(root, source);
  }
  await access(binary);
  const packages: RuntimePackage[] = [];
  const installed = new Map<string, { version: string; source: string }>();
  function workspaceManifest(name: string): string | null {
    const capability = /^@craft\/capability-(knowledge|memory|experience|codebase)$/u.exec(name);
    const source = capability ? resolve(root, "capability", `craft-${capability[1]}`)
      : /^craft-common-(store-local|base|log)$/u.test(name) ? resolve(root, "common", name) : null;
    if (!source) return null;
    const path = resolve(source, "package.json");
    if (!existsSync(path)) return null;
    validatePhysicalPath(root, path);
    return path;
  }
  async function collect(name: string, parent: string): Promise<void> {
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/u.test(name)) throw new Error("Invalid runtime package name");
    let manifestPath: string;
    try { manifestPath = createRequire(resolve(parent, "package.json")).resolve(`${name}/package.json`); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND") throw error;
      const fallback = workspaceManifest(name);
      if (!fallback) throw error;
      manifestPath = fallback;
    }
    const source = dirname(manifestPath);
    const dependency = JSON.parse(await readFile(manifestPath, "utf8"));
    if (dependency.name !== undefined && dependency.name !== name) throw new Error(`Runtime package identity conflict: ${name}`);
    const existing = installed.get(name);
    if (existing) {
      if (existing.version !== dependency.version || existing.source !== source) throw new Error(`Runtime dependency collision: ${name}`);
      return;
    }
    installed.set(name, { version: dependency.version, source });
    packages.push({ name, source });
    for (const child of Object.keys(dependency.dependencies ?? {}).sort()) await collect(child, source);
  }
  for (const name of Object.keys(manifest.dependencies ?? {}).sort()) await collect(name, root);
  // Only this explicit, reproducible staging directory is owned by this module.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const entry of artifact.runtime_copies) {
    const target = localPath(output, entry.target);
    await mkdir(dirname(target), { recursive: true });
    await cp(localPath(root, entry.source), target, { recursive: true });
  }
  for (const entry of packages) {
    await cp(entry.source, resolve(output, "node_modules", entry.name), { recursive: true, dereference: true });
  }
  await cp(binary, resolve(output, basename(binary)));
  return output;
}
