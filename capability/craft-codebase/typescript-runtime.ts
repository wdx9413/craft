import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type TypeScript from "typescript";

// CJS plugins ship an adjacent compiler; source/ESM packages use their declared dependency.
const moduleUrl = typeof __filename === "string" ? pathToFileURL(__filename).href : import.meta.url;
declare const CRAFT_TYPESCRIPT_BUNDLE: boolean;
const bundled = typeof CRAFT_TYPESCRIPT_BUNDLE !== "undefined" && CRAFT_TYPESCRIPT_BUNDLE === true;
const requireLocal = createRequire(moduleUrl);
let compiler: typeof TypeScript | undefined;
let version: string | undefined;

export function getTypeScriptVersion(): string {
  if (version === undefined) {
    const metadata = requireLocal(bundled ? "./craft-typescript-version.json" : "typescript/package.json") as { version?: unknown };
    if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(metadata.version)) throw new Error("TypeScript compiler version metadata is invalid");
    version = metadata.version;
  }
  return version;
}

/** Compiler initialization belongs to semantic work, never to ordinary Hook startup. */
export function getTypeScript(): typeof TypeScript {
  if (compiler === undefined) {
    const loaded = requireLocal(bundled ? "./craft-typescript.cjs" : "typescript") as typeof TypeScript;
    if (loaded.version !== getTypeScriptVersion()) throw new Error("TypeScript compiler and version metadata differ");
    compiler = loaded;
  }
  return compiler;
}
