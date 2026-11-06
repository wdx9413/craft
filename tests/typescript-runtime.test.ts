import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { prepareTypeScriptCompiler } from "../scripts/release/prepare-typescript-compiler.ts";

test("source semantic modules read version metadata without initializing TypeScript", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict'; import {createRequire} from 'node:module';
    const require=createRequire(import.meta.url), entry=require.resolve('typescript');
    const analysis=await import('./capability/craft-codebase/typescript-analysis.ts');
    assert.equal(require.cache[entry],undefined);
    assert.match(analysis.TYPESCRIPT_ANALYZER_VERSION, /craft-ts-semantic/);
    const runtime=await import('./capability/craft-codebase/typescript-runtime.ts');
    const compiler=runtime.getTypeScript(); assert.equal(runtime.getTypeScript(),compiler);
    assert.equal(compiler.version,runtime.getTypeScriptVersion()); assert.ok(require.cache[entry]);
  `], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("compiler loader validates its explicit bundle configuration and caches only a matching compiler", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-compiler-config-"));
  try {
    await prepareTypeScriptCompiler(directory);
    const metadataPath = join(directory, "craft-typescript-version.json"), original = await readFile(metadataPath, "utf8");
    for (const mode of ["valid", "mismatch", "missing-version", "invalid-version", "dependency"]) {
      await writeFile(metadataPath, mode === "mismatch" ? '{"version":"999.0.0"}' : mode === "missing-version" ? '{}' : mode === "invalid-version" ? '{"version":"invalid"}' : original);
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
        import assert from 'node:assert/strict';
        // Emulate the globals used by the CJS entry; real bundled execution is tested separately.
        globalThis.__filename = ${JSON.stringify(mode === "dependency" ? resolve("package.json") : join(directory, "app.cjs"))};
        globalThis.CRAFT_TYPESCRIPT_BUNDLE = ${mode !== "dependency"};
        const runtime=await import('./capability/craft-codebase/typescript-runtime.ts');
        ${mode === "mismatch" ? "assert.throws(()=>runtime.getTypeScript(), /compiler and version metadata differ/); assert.throws(()=>runtime.getTypeScript(), /compiler and version metadata differ/);"
          : ["missing-version", "invalid-version"].includes(mode) ? "assert.throws(()=>runtime.getTypeScriptVersion(), /version metadata is invalid/);"
          : "const compiler=runtime.getTypeScript(); assert.equal(runtime.getTypeScript(),compiler); assert.equal(compiler.version,runtime.getTypeScriptVersion());"}
      `], { cwd: resolve("."), encoding: "utf8" });
      assert.equal(result.status, 0, `${mode}: ${result.stderr}`);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("standalone CJS and ESM bundles defer their own compiler and reject missing or mismatched assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-lazy-compiler-"));
  try {
    const analysis = resolve("capability/craft-codebase/typescript-analysis.ts");
    for (const format of ["cjs", "esm"] as const) {
      const directory = format === "esm" ? join(root, "plugin") : join(root, "cjs"); await mkdir(directory);
      await prepareTypeScriptCompiler(directory);
      assert.ok((await readFile(join(directory, "craft-typescript-LICENSE.txt"), "utf8")).length > 100);
      assert.ok((await readFile(join(directory, "craft-typescript-NOTICE.txt"), "utf8")).length > 100);
      const outfile = join(directory, format === "esm" ? "app.mjs" : "app.cjs");
      await build({ stdin: { contents: `import {analyzeTypeScript,TYPESCRIPT_ANALYZER_VERSION} from ${JSON.stringify(analysis)};
        if(process.argv.includes('--analyze')) console.log(JSON.stringify(analyzeTypeScript([{path:'a.ts',content:'export function answer(){return 42}',digest:'source',language:'typescript'}])));
        else console.log(TYPESCRIPT_ANALYZER_VERSION);`, resolveDir: resolve(".") }, outfile, bundle: true, platform: "node", format, sourcemap: "inline", define: { CRAFT_TYPESCRIPT_BUNDLE: "true", ...(format === "cjs" ? { "import.meta.url": "undefined" } : {}) } });
      const run = (...args: string[]) => spawnSync(process.execPath, [outfile, ...args], { cwd: directory, encoding: "utf8" });
      const semantic = run("--analyze"); assert.equal(semantic.status, 0, semantic.stderr);
      assert.ok(JSON.parse(semantic.stdout).nodes.some((node: { name?: string }) => node.name === "answer"));
      await rm(join(directory, "craft-typescript.cjs"));
      assert.equal(run().status, 0, "metadata-only startup must not require the compiler");
      assert.notEqual(run("--analyze").status, 0, "missing assets must not fall back to ambient TypeScript");
      await prepareTypeScriptCompiler(directory);
      await writeFile(join(directory, "craft-typescript-version.json"), JSON.stringify({ version: "999.0.0" }));
      assert.match(run("--analyze").stderr, /compiler and version metadata differ/);
      for (const metadata of [{}, { version: "invalid" }]) {
        await writeFile(join(directory, "craft-typescript-version.json"), JSON.stringify(metadata));
        assert.match(run().stderr, /version metadata is invalid/);
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
