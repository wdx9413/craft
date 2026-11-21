import { captureBuildInputs } from "../scripts/release/capture-build-inputs.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import { loadedComponentArtifact, writeComponentBuildInputs } from "../core/release-build-inputs.ts";

test("component metadata binds actual compiler inputs and verifies the loaded executable bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-build-inputs-"));
  const output = join(root, "plugins", "component");
  try {
    mkdirSync(join(output, "dist", "plugin"), { recursive: true }); mkdirSync(join(root, "dist", "plugin"), { recursive: true });
    mkdirSync(join(root, "node_modules", "esbuild"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
    writeFileSync(join(root, "node_modules", "esbuild", "package.json"), JSON.stringify({ version: "fixture-compiler" }));
    writeFileSync(join(root, "pnpm-lock.yaml"), "fixture lock");
    mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "entry.js"), "export const answer = 42;\n");
    const bundle = join(output, "dist", "plugin", "entry.js");
    const capture = captureBuildInputs(root);
    const result = await build({ plugins: [capture.plugin], absWorkingDir: root, entryPoints: ["src/entry.js"], bundle: true, platform: "node", format: "esm", outfile: bundle, metafile: true });
    writeFileSync(join(root, "dist", "plugin", "entry.js.inputs.json"), JSON.stringify(capture.seal(result.metafile!)));
    writeFileSync(join(root, "src", "entry.js"), "export const answer = 99;\n");
    writeFileSync(join(output, "dist", "plugin", "craft-typescript.cjs"), "module.exports = {};\n");
    writeFileSync(join(output, "dist", "plugin", "craft-typescript-version.json"), '{"version":"fixture-typescript"}');
    writeComponentBuildInputs(root, output, "craft-fixture", "2.0.0");
    const first = readFileSync(join(output, "dist", "plugin", "build-inputs.json"), "utf8");
    assert(!first.includes(root));
    const metadata = JSON.parse(first); assert.equal(metadata.artifacts.find((item: { file: string }) => item.file === "entry.js").inputs[0].package, "fixture");
    assert.equal(metadata.artifacts.find((item: { file: string }) => item.file === "entry.js").inputs[0].file, "src/entry.js");
    const { createHash } = await import("node:crypto");
    assert.equal(metadata.artifacts.find((item: { file: string }) => item.file === "entry.js").inputs[0].digest, `sha256:${createHash("sha256").update("export const answer = 42;\n").digest("hex")}`);
    assert.throws(() => captureBuildInputs(root).seal({ inputs: { "src/entry.js": { bytes: 0, imports: [] } }, outputs: {} }), /not captured/u);
    assert.equal(metadata.artifacts.find((item: { file: string }) => item.file === "craft-typescript.cjs").compiler_version, "fixture-typescript");
    assert.equal(loadedComponentArtifact(bundle)?.verified, true);
    assert.equal(loadedComponentArtifact(bundle)?.version, "2.0.0");
    writeFileSync(bundle, "changed compiled bytes"); assert.equal(loadedComponentArtifact(bundle)?.verified, false);
    writeComponentBuildInputs(root, output, "craft-fixture", "2.0.1"); assert.equal(loadedComponentArtifact(bundle)?.verified, true);
    writeComponentBuildInputs(root, output, "craft-datasec", "0.2.0");
    assert.equal(JSON.parse(readFileSync(join(output, "dist", "plugin", "build-inputs.json"), "utf8")).runtime_version, null);
    assert.equal(loadedComponentArtifact(""), null);
    assert.throws(() => loadedComponentArtifact(join(output, "dist", "plugin", "other.js")), /absent/u);
    const manifest = join(output, "dist", "plugin", "build-inputs.json");
    writeFileSync(manifest, JSON.stringify({ ...metadata, schema: "unknown" }));
    assert.throws(() => loadedComponentArtifact(bundle), /Unsupported/u);
    writeFileSync(manifest, JSON.stringify({ ...metadata, artifacts: [] }));
    assert.throws(() => loadedComponentArtifact(bundle), /absent/u);
    assert.equal(loadedComponentArtifact(join(root, "missing.js")), null);
    const empty = join(root, "empty"); mkdirSync(join(empty, "dist", "plugin"), { recursive: true });
    writeFileSync(join(empty, "dist", "plugin", "readme.txt"), "not a bundle");
    writeFileSync(join(empty, "dist", "plugin", "unrecorded.js"), "unrecorded bundle");
    assert.throws(() => writeComponentBuildInputs(root, empty, "craft-fixture", "1.0.0"), /no build input/u);
    writeFileSync(join(root, "dist", "plugin", "entry.js.inputs.json"), JSON.stringify({ inputs: { "src/entry.js": {} } }));
    assert.throws(() => writeComponentBuildInputs(root, output, "craft-fixture", "1.0.0"), /not captured/u);
    const unowned = mkdtempSync(join(tmpdir(), "craft-unowned-input-"));
    try {
      const input = join(unowned, "input.js"); writeFileSync(input, "export const unowned = true;");
      writeFileSync(join(root, "dist", "plugin", "entry.js.inputs.json"), JSON.stringify({ inputs: { [input]: {} } }));
      assert.throws(() => writeComponentBuildInputs(root, output, "craft-fixture", "1.0.0"), /no owning package/u);
    } finally { rmSync(unowned, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("compiler capture supports JavaScript, TypeScript and JSON loader variants", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-build-loaders-"));
  try {
    const extensions = ["mts", "cts", "mjs", "cjs", "tsx", "jsx", "json"];
    for (const extension of extensions) writeFileSync(join(root, `entry-${extension}.${extension}`), extension === "json" ? '{"answer":42}' : "export const answer = 42;\n");
    const capture = captureBuildInputs(root);
    const result = await build({ absWorkingDir: root, entryPoints: extensions.map(extension => `entry-${extension}.${extension}`),
      outdir: join(root, "output"), outExtension: { ".js": ".js" }, entryNames: "[name]", write: false, bundle: true,
      platform: "node", format: "esm", metafile: true, plugins: [capture.plugin] });
    const sealed = capture.seal(result.metafile!);
    assert.equal(Object.keys(sealed.inputs).length, extensions.length);
    for (const input of Object.values(sealed.inputs)) assert.match((input as typeof input & { craft_content_digest?: string }).craft_content_digest!, /^sha256:[a-f0-9]{64}$/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
