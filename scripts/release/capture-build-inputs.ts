import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import type { Loader, Metafile, Plugin } from "esbuild";

/** Hash the exact buffers returned to the compiler, rather than rereading mutable source during packaging. */
export function captureBuildInputs(root: string): { plugin: Plugin; seal: (metafile: Metafile) => Metafile } {
  const hashes = new Map<string, string>();
  return {
    plugin: { name: "craft-input-digests", setup(builder) {
      builder.onLoad({ filter: /\.(?:[cm]?[jt]sx?|json)$/ }, async args => {
        const contents = await readFile(args.path);
        hashes.set(realpathSync(args.path), `sha256:${createHash("sha256").update(contents).digest("hex")}`);
        const extension = extname(args.path).slice(1);
        const loader = extension === "mts" || extension === "cts" ? "ts" : extension === "mjs" || extension === "cjs" ? "js" : extension;
        return { contents, loader: loader as Loader, resolveDir: dirname(args.path) };
      });
    } },
    seal(metafile) {
      for (const [path, input] of Object.entries(metafile.inputs)) {
        const digest = hashes.get(realpathSync(resolve(root, path)));
        if (!digest) throw new Error("Compiler input was not captured");
        Object.assign(input, { craft_content_digest: digest });
      }
      return metafile;
    },
  };
}
