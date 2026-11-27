import { pathToFileURL } from "node:url";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { applyProjectTraceMigration, previewProjectTraceMigration } from "../core/trace-project-migration.ts";

/** Inspect the default Host task index; caller-supplied project and source paths are not accepted as proof. */
export async function previewTraceProjectMigration(dataRoot: string, traceId: string, manifest?: string): Promise<Record<string, unknown>> {
  const store = await new CraftStore(craftPaths(dataRoot)).open();
  try {
    const env = { ...process.env, CRAFT_DATA_DIR: dataRoot };
    return manifest ? await applyProjectTraceMigration(store, traceId, manifest, env) : await previewProjectTraceMigration(store, traceId, env);
  }
  finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const roots = args.filter(arg => arg.startsWith("--data-root="));
  const ids = args.filter(arg => arg.startsWith("--trace-id="));
  const manifests = args.filter(arg => arg.startsWith("--manifest="));
  const apply = args.includes("--apply");
  if (roots.length !== 1 || ids.length !== 1 || !roots[0]!.slice(12) || !ids[0]!.slice(11)
    || args.some(arg => !arg.startsWith("--data-root=") && !arg.startsWith("--trace-id=") && !arg.startsWith("--manifest=") && arg !== "--apply" && arg !== "--offline")
    || apply && (!args.includes("--offline") || manifests.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(manifests[0]!.slice(11)))
    || !apply && (args.includes("--offline") || manifests.length))
    throw new Error("Usage: trace-project-migration-preview.ts --data-root=<path> --trace-id=<id> [--apply --offline --manifest=<sha256>]");
  process.stdout.write(`${JSON.stringify(await previewTraceProjectMigration(roots[0]!.slice(12), ids[0]!.slice(11), apply ? manifests[0]!.slice(11) : undefined))}\n`);
}
