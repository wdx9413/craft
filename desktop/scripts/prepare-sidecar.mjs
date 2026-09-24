import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "..");
const resources = join(desktop, "src-tauri", "resources", "app");

// Tauri owns the native window, but Craft remains the tested Node runtime.  Copy its
// compiled graph into a resource directory rather than downloading or evaluating code at
// install time.  The packaged Rust process runs only this bundled Node executable.
await rm(resources, { recursive: true, force: true });
await mkdir(join(resources, "dist"), { recursive: true });
await mkdir(join(resources, "adapters"), { recursive: true });
await mkdir(join(resources, "assets"), { recursive: true });
await cp(join(root, "dist", "core"), join(resources, "dist", "core"), { recursive: true });
await cp(join(root, "workbench"), join(resources, "dist", "workbench"), { recursive: true });
await cp(join(root, "adapters", "windows-vision-cli.ts"), join(resources, "adapters", "windows-vision-cli.ts"), { recursive: true });
await cp(join(root, "adapters", "windows-vision-native.ps1"), join(resources, "adapters", "windows-vision-native.ps1"), { recursive: true });
await cp(join(root, "assets", "ocr"), join(resources, "assets", "ocr"), { recursive: true });
await cp(join(root, "package.json"), join(resources, "package.json"));
// pnpm exposes dependencies through symlinks. Bundle their actual bytes: creating a
// symlink in the resource tree fails on Windows machines without Developer Mode and
// would point outside the installer even when it succeeded.
await cp(join(root, "node_modules", "yaml"), join(resources, "node_modules", "yaml"), { recursive: true, dereference: true });
async function copyRuntimePackage(name, copied = new Set(), parent = root) {
  const resolver = createRequire(join(parent, "package.json"));
  const manifestPath = resolver.resolve(`${name}/package.json`);
  const source = dirname(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const copyKey = `${name}@${manifest.version}`;
  if (copied.has(copyKey)) return;
  copied.add(copyKey);
  await cp(source, join(resources, "node_modules", ...name.split("/")), { recursive: true, dereference: true });
  for (const dependency of Object.keys(manifest.dependencies ?? {})) await copyRuntimePackage(dependency, copied, source);
}
await copyRuntimePackage("tesseract.js");
await cp(process.execPath, join(resources, process.platform === "win32" ? "node.exe" : "node"));
