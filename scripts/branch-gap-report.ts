import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

type BranchLocation = { line: number; column: number };
type CoverageFile = { path: string; branchMap?: Record<string, { line: number; loc?: { start?: BranchLocation }; locations?: Array<{ start?: BranchLocation }> }>; b?: Record<string, number[]> };

const root = resolve(import.meta.dirname, "..");
const input = resolve(root, process.argv[2] ?? "coverage/coverage-final.json");
const output = resolve(root, process.argv[3] ?? "docs/releases/v0.12.32-branch-gaps.md");
const report = JSON.parse(await readFile(input, "utf8")) as Record<string, CoverageFile>;
const rows: Array<{ file: string; branch: string; line: number; column: number; hits: number; expression: string }> = [];
let total = 0;
let covered = 0;
for (const [file, data] of Object.entries(report)) {
  if (!file.includes(`${resolve(root, "core")}/`) || file.endsWith(".d.ts")) continue;
  for (const [branch, hits] of Object.entries(data.b ?? {})) {
    for (const [index, hit] of hits.entries()) {
      total += 1;
      if (hit > 0) covered += 1;
      else {
        const location = data.branchMap?.[branch]?.locations?.[index]?.start ?? data.branchMap?.[branch]?.loc?.start ?? { line: data.branchMap?.[branch]?.line ?? 0, column: 0 };
        const relativeFile = file.slice(root.length + 1);
        const source = await readFile(resolve(root, relativeFile), "utf8");
        const expression = source.split(/\r?\n/u)[location.line - 1]?.trim() ?? "";
        rows.push({ file: relativeFile, branch: `${branch}.${index}`, line: location.line, column: location.column, hits: hit, expression });
      }
    }
  }
}
rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.branch.localeCompare(b.branch));
const percentage = total === 0 ? 100 : (covered / total) * 100;
const lines = [
  "# Branch coverage gap report",
  "",
  `- Generated from: \`${input}\``,
  "- Source scope: runtime `src/**/*.ts` (CLI and declaration-only `.d.ts` files are not runtime logic)",
  `- Covered branches: ${covered}/${total} (${percentage.toFixed(2)}%)`,
  `- Missing branches: ${rows.length}`,
  "",
  "| File | Branch | Source location | Hits | Expression |",
  "| --- | --- | ---: | ---: | --- |",
  ...rows.map((row) => `| \`${row.file}\` | \`${row.branch}\` | ${row.line}:${row.column} | ${row.hits} | \`${row.expression.replaceAll("|", "\\|")}\` |`),
  "",
];
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${lines.join("\n")}\n`, "utf8");
console.log(`branch coverage: ${covered}/${total} (${percentage.toFixed(2)}%), missing ${rows.length}`);
console.log(`report: ${output}`);
