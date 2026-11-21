import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CRAFT_RELEASE_VERSION } from "./version.ts";

const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function inputIdentity(root: string, path: string, digest: unknown): { package: string; version: string; file: string; digest: string } {
  const absolute = resolve(root, path);
  let directory = dirname(absolute);
  for (;;) {
    const manifest = join(directory, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; version: string };
      if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(digest)) throw new Error("Compiler input digest was not captured during the build");
      return { package: pkg.name, version: pkg.version, file: relative(directory, absolute).split(sep).join("/"), digest };
    }
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Build input has no owning package");
    directory = parent;
  }
}

/** Capture actual esbuild inputs, including nested installed package instances. */
export function writeComponentBuildInputs(root: string, componentRoot: string, component: string, version: string, bundleDirectory = "dist/plugin"): void {
  const directory = join(componentRoot, bundleDirectory);
  const bundles = readdirSync(directory).filter(file => /\.(?:cjs|mjs|js)$/u.test(file) && (file === "craft-typescript.cjs" || existsSync(join(root, "dist", "plugin", `${file}.inputs.json`)))).sort();
  if (!bundles.length) throw new Error("Component has no build input metafiles");
  const artifacts = bundles.map(file => {
    if (file === "craft-typescript.cjs") return { file, digest: sha(readFileSync(join(directory, file))), inputs: [],
      compiler_version: JSON.parse(readFileSync(join(directory, "craft-typescript-version.json"), "utf8")).version };
    const metafile = JSON.parse(readFileSync(join(root, "dist", "plugin", `${file}.inputs.json`), "utf8")) as { inputs: Record<string, { craft_content_digest?: string }> };
    const inputs = Object.keys(metafile.inputs).sort().map(path => inputIdentity(root, path, metafile.inputs[path]!.craft_content_digest));
    return { file, digest: sha(readFileSync(join(directory, file))), inputs };
  });
  const lock = join(root, "pnpm-lock.yaml");
  const metadata = { schema: "craft.component-build-inputs.v1", component, version, runtime_version: component === "craft-datasec" ? null : CRAFT_RELEASE_VERSION,
    compiler: JSON.parse(readFileSync(join(root, "node_modules", "esbuild", "package.json"), "utf8")).version,
    lock_digest: sha(readFileSync(lock)), artifacts };
  writeFileSync(join(directory, "build-inputs.json"), JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
}

export function loadedComponentArtifact(executable = process.argv[1]): Record<string, unknown> | null {
  if (!executable) return null;
  const path = resolve(executable), manifest = join(dirname(path), "build-inputs.json");
  if (!existsSync(manifest)) return null;
  const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { schema: string; component: string; version: string; runtime_version: string;
    artifacts: Array<{ file: string; digest: string }> };
  if (metadata.schema !== "craft.component-build-inputs.v1") throw new Error("Unsupported component build metadata");
  const artifact = metadata.artifacts.find(item => item.file === basename(path));
  if (!artifact) throw new Error("Loaded executable is absent from component build metadata");
  const digest = sha(readFileSync(path));
  return { component: metadata.component, version: metadata.version, runtime_version: metadata.runtime_version,
    executable: basename(path), digest, verified: digest === artifact.digest };
}
