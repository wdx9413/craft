import { readFileSync, readdirSync } from "node:fs";

/**
 * Report uncovered ranges in one source file from a `NODE_V8_COVERAGE` dump.
 *
 * `node --test --experimental-test-coverage` prints only the line/branch/function
 * percentages, which say a gap exists but not where. The repo's gates require 100% for
 * managed modules, so locating the gap is routine work that deserves a tool rather than a
 * hand-written throwaway each time.
 *
 * Usage: NODE_V8_COVERAGE=<dir> node --test <files>; node scripts/coverage/uncovered-ranges.ts <dir> <source-path>
 */
const [coverageDir, target] = process.argv.slice(2);
if (!coverageDir || !target) {
  console.error("usage: uncovered-ranges.ts <coverage-dir> <source-path>");
  process.exit(2);
}

const lines = readFileSync(target, "utf8").split(/\r?\n/u);

/** Map a byte offset to a 1-based line number. */
const lineAt = (offset: number): number => {
  let cursor = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const next = cursor + lines[i].length + 1;
    if (offset < next) return i + 1;
    cursor = next;
  }
  return lines.length;
};

let found = false;
// V8 coverage spans several process dumps (the test runner spawns children), and the same
// range appears in each with that process's own count. A range only counts as uncovered when
// *every* occurrence of it is zero, so counts are merged per (function, offsets) before
// reporting. Printing each file's zero ranges separately reported code as uncovered that the
// test process had fully executed.
const merged = new Map<string, { name: string; startOffset: number; endOffset: number; maxCount: number }>();
for (const report of readdirSync(coverageDir).filter((f) => f.endsWith(".json"))) {
  const json = JSON.parse(readFileSync(`${coverageDir}/${report}`, "utf8"));
  // V8 writes `result` as an array of { url, functions }, not a url-keyed object.
  for (const entry of json.result ?? []) {
    if (!String(entry.url).replaceAll("\\", "/").endsWith(target)) continue;
    found = true;
    for (const fn of entry.functions) {
      for (const range of fn.ranges) {
        const key = `${fn.functionName || "(top level)"}#${range.startOffset}#${range.endOffset}`;
        const seen = merged.get(key);
        if (seen) seen.maxCount = Math.max(seen.maxCount, range.count);
        else merged.set(key, { name: fn.functionName || "(top level)", startOffset: range.startOffset,
          endOffset: range.endOffset, maxCount: range.count });
      }
    }
  }
}
if (!found) {
  console.log(`no coverage entry for ${target}`);
} else {
  for (const { name, startOffset, endOffset, maxCount } of merged.values()) {
    if (maxCount > 0) continue;
    const start = lineAt(startOffset);
    const end = lineAt(endOffset);
    console.log(`uncovered ${name}: lines ${start}-${end}`);
    for (let i = start - 1; i < end && i < lines.length; i += 1) console.log(`  ${i + 1}: ${lines[i]}`);
  }
}
