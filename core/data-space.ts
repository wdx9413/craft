import { createHash } from "node:crypto";
import { resolve } from "node:path";

/**
 * Stable, content-free identity for one Craft data root. It lets independent
 * plugin processes detect whether their local ledgers can be compared without
 * exposing user, project, or record content as an interoperability key.
 */
export function dataSpaceId(dataRoot: string): string {
  const normalized = resolve(dataRoot);
  return `sha256:${createHash("sha256").update(JSON.stringify({ data_root: normalized })).digest("hex")}`;
}
