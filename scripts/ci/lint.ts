import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A minimal hygiene gate.
 *
 * The repository had no lint configuration or dependency at all, so nothing
 * caught the two classes of defect that actually reached it: text that could not
 * round-trip through UTF-8 (PowerShell `Set-Content` silently corrupts Chinese
 * text in this repo's manifests), and debug leftovers committed by accident.
 *
 * This is deliberately not a style linter. A style pass can be adopted on its
 * own terms later; these two rules encode correctness that already bit us.
 */
const roots = ["core", "scripts", "tests", "docs", "adapters", "plugins"];
const skip = /(^|\/)(node_modules|dist|\.git|\.venv|br-tools|coverage)(\/|$)/u;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (skip.test(relative(".", full).split("\\").join("/"))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const failures = [];
let scanned = 0;

for (const root of roots) {
  let files;
  try {
    files = walk(root).filter((file) => /\.(ts|mts|mjs|js|json|md|cs|ya?ml)$/u.test(file));
  } catch {
    continue;
  }
  for (const file of files) {
    scanned += 1;
    const text = readFileSync(file, "utf8");
    // 1. Text that cannot round-trip means a tool corrupted the encoding.
    if (text.includes("\uFFFD")) failures.push(`${file}: contains U+FFFD (encoding was corrupted)`);
    // 2. Debug leftovers.
    const lines = text.split(/\r?\n/u);
    lines.forEach((line, index) => {
      if (/\bconsole\.log\(/u.test(line) && file.endsWith(".ts") && !file.includes("cli.ts") && !file.startsWith("scripts") && !file.startsWith("tests")) {
        failures.push(`${file}:${index + 1}: console.log left in source`);
      }
      if (/(?:\/\/|\/\*)\s*(?:TODO|FIXME|XXX)\b/u.test(line)) {
        failures.push(`${file}:${index + 1}: unresolved TODO/FIXME marker`);
      }
      if (/\bdebugger;/u.test(line)) failures.push(`${file}:${index + 1}: debugger statement`);
    });
  }
}

console.log(`lint: scanned ${scanned} files under ${roots.join(", ")}`);
if (failures.length) {
  console.error(`lint: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
} else {
  console.log("lint: clean");
}
