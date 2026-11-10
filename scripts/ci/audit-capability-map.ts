import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

// Run from a three-repository checkout; ordinary documentation audit remains
// usable when only Craft is available. The map itself is the anchor inventory.
const craftRoot = resolve(import.meta.dirname, "../..");
const workspace = resolve(process.argv[2] ?? dirname(craftRoot));
const map = readFileSync(resolve(craftRoot, "docs/product/capability-architecture-map.zh-CN.md"), "utf8");
let failed = false;
const roots = new Map([["craft", craftRoot], ["craft-workbench", resolve(workspace, "craft-workbench")], ["craft-eval", resolve(workspace, "craft-eval")]]);
const counts = new Map<string, number>();
const declarations = [...map.matchAll(/https:\/\/github\.com\/wdx9413\/([^\s)]+)/gu)].map(match => match[1]!);
for (const declaration of declarations) {
  const [repository, kind, branch, ...segments] = declaration.split("/");
  const root = roots.get(repository!);
  if (!root) { console.error(`unknown declared repository in architecture link: ${declaration}`); failed = true; continue; }
  if (kind !== "blob" || branch !== "main" || segments.length === 0 || segments.some(segment => segment === ".." || segment === ".")) {
    console.error(`${repository}: malformed architecture link ${declaration}; expected blob/main/<file>`); failed = true; continue;
  }
  const anchor = segments.join("/");
  const file = resolve(root, anchor);
  const path = relative(root, file);
  if (!path || path.startsWith("..") || isAbsolute(path) || !existsSync(file) || !statSync(file).isFile()) {
    console.error(`${repository}: unavailable architecture anchor ${anchor}`); failed = true;
  }
  counts.set(repository!, (counts.get(repository!) ?? 0) + 1);
}
for (const repository of ["craft-workbench", "craft-eval"]) {
  const count = counts.get(repository) ?? 0;
  if (count === 0) { console.error(`${repository}: no declared architecture anchors`); failed = true; }
  else console.log(`${repository}: checked ${count} declared anchor(s)`);
}
if (failed) process.exitCode = 1;
