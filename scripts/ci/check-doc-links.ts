import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Checks that the documentation's own structure is intact.
 *
 * Two failures this catches, both of which had already happened:
 *
 *  1. **A relative link to a file that is not there.** Measured over the whole tree when this
 *     was written: 382 internal links across 162 documents, of which exactly one was broken —
 *     a link written in the same session as the document that contained it. A link is the only
 *     thing that makes a document reachable, and nothing was checking them.
 *
 *  2. **A decision record that no index mentions.** `docs/adr/` held **six** decisions that
 *     `docs/README.md` did not list, no technical document linked, and nothing referenced at
 *     all. A decision written into a directory nobody indexes is forgotten exactly as reliably
 *     as one never written down — which is the failure this whole exercise is about. So the ADR
 *     index is checked in both directions: every record is listed, and every listed record
 *     exists.
 *
 * Absolute URLs, mailto links and in-page anchors are not followed: they are not filesystem
 * facts this script can decide, and pretending otherwise would make it report noise. A link to a
 * directory is an error rather than a pass, because it resolves for a reader only by accident of
 * the renderer.
 */
const root = resolve(import.meta.dirname, "..", "..");
const docs = join(root, "docs");
const ADR_INDEX = join(docs, "adr", "README.md");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const toRepoPath = (absolute: string): string => relative(root, absolute).split("\\").join("/");

/** Every `](target)` that points at a file rather than at the network or an anchor. */
function relativeLinks(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+)\)/gu)) {
    const target = match[1]!;
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
    const path = target.split("#")[0]!;
    if (path) targets.push(path);
  }
  return targets;
}

const documents = walk(docs);
if (!documents.length) throw new Error("no documentation was found; the docs path is wrong");

const broken: Array<{ file: string; target: string; kind: "missing" | "directory" }> = [];
let linkCount = 0;
for (const file of documents) {
  for (const target of relativeLinks(readFileSync(file, "utf8"))) {
    linkCount += 1;
    const resolved = resolve(dirname(file), target);
    if (!existsSync(resolved)) broken.push({ file: toRepoPath(file), target, kind: "missing" });
    else if (statSync(resolved).isDirectory()) broken.push({ file: toRepoPath(file), target, kind: "directory" });
  }
}

// The ADR index is checked in both directions, so neither an unlisted record nor a dangling
// entry can survive. Records are discovered from the directory, never from the index.
const adrDirectory = join(docs, "adr");
const records = existsSync(adrDirectory)
  ? readdirSync(adrDirectory).filter((entry) => /^\d{4}-.*\.md$/u.test(entry)).sort()
  : [];
if (!records.length) throw new Error("no decision records were found; the adr path is wrong");
if (!existsSync(ADR_INDEX)) throw new Error(`the decision-record index is missing: ${toRepoPath(ADR_INDEX)}`);

const indexText = readFileSync(ADR_INDEX, "utf8");
// Only links that name a *record* count as index entries. The index also links out to the
// technical documents each decision is expanded in, and counting those made this check report
// six dangling entries the first time it ran — a check whose first result is noise gets turned
// off, so the filter is the difference between a usable check and a decorative one.
const indexed = new Set(relativeLinks(indexText)
  .map((target) => target.replace(/^\.\//u, ""))
  .filter((target) => /^\d{4}-[^/]*\.md$/u.test(target)));
const unlisted = records.filter((record) => !indexed.has(record));
const dangling = [...indexed].filter((target) => !records.includes(target));

console.log(`doc check: ${linkCount} internal link(s) across ${documents.length} document(s)`);
console.log(`doc check: ${records.length} decision record(s), ${indexed.size} indexed`);

let failed = false;
if (broken.length) {
  failed = true;
  console.error(`doc check: ${broken.length} broken link(s)`);
  for (const entry of broken) console.error(`  ${entry.file}  ->  ${entry.target}  (${entry.kind === "missing" ? "no such file" : "resolves to a directory"})`);
  console.error("  Fix the path, or move the document it points at.");
}
if (unlisted.length) {
  failed = true;
  console.error(`doc check: ${unlisted.length} decision record(s) missing from the index`);
  for (const record of unlisted) console.error(`  docs/adr/${record}`);
  console.error("  Add a row to docs/adr/README.md. A record nobody indexes is a record nobody reads.");
}
if (dangling.length) {
  failed = true;
  console.error(`doc check: ${dangling.length} index entr(y/ies) with no record behind them`);
  for (const target of dangling) console.error(`  docs/adr/${target}`);
  console.error("  Remove the row, or restore the record it names.");
}

if (failed) process.exitCode = 1;
else console.log(`doc check: clean (${records.length} decision record(s) listed and present)`);
