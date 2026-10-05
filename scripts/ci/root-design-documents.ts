import { lstatSync } from "node:fs";
import { join } from "node:path";

/** Required root contracts share the existing documentation link gate. */
export function rootDesignDocuments(root: string): string[] {
  return ["DESIGN.md", "UX-CONTRACT.md"].map((name) => {
    const file = join(root, name);
    if (!lstatSync(file).isFile()) throw new Error(`Root design contract must be a regular file: ${name}`);
    return file;
  });
}
