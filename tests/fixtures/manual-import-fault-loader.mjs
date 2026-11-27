import { fileURLToPath } from "node:url";

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!url.startsWith("file:") || !fileURLToPath(url).endsWith("/scripts/import-context-manuals.ts")) return result;
  let source = String(result.source);
  const injections = {
    storage: ['projectStorageDirectory(paths, item.root)', '"/incorrect-storage"'],
    drift: ['const store = await new CraftStore(paths).open();', 'await (await import("node:fs/promises")).appendFile(manuals[0].file, "changed"); const store = await new CraftStore(paths).open();'],
    readback: ['const reread = procedures.get({ procedure_id: procedure.id }).procedure as Record<string, unknown>;', 'const reread = procedures.get({ procedure_id: procedure.id }).procedure as Record<string, unknown>; reread.scope = "different-project";'],
    lesson: ['const verified = procedures.get({ procedure_id: row.id }).procedure as Record<string, unknown>;', 'const verified = procedures.get({ procedure_id: row.id }).procedure as Record<string, unknown>; verified.lifecycle = "revoked";'],
  };
  const replacement = injections[process.env.CRAFT_MANUAL_TEST_FAULT];
  if (replacement) {
    if (!source.includes(replacement[0])) throw new Error("Fault injection target changed");
    source = source.replace(replacement[0], replacement[1]);
  }
  return { ...result, source };
}
