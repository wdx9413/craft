/**
 * Group selection for the coverage-gate script, separated so it is testable.
 *
 * The full manifest has hundreds of groups and the whole run takes hours. That
 * makes it useless for the one workflow it exists to serve: verifying a single
 * batch without waiting for every unrelated group. The script had no subset
 * mode, so an agent working on one module either waited out the whole sweep or
 * ran `node --test` by hand and lost the manifest's thresholds.
 *
 * Selection is by group name or by an included source file, and an unknown
 * selector is an error rather than a silent empty run: "0/0 groups passed" would
 * read like success while measuring nothing.
 */

export interface SelectableGroup {
  name: string;
  include: string[];
  tests: string[];
}

export interface GateSelection<T extends SelectableGroup = SelectableGroup> {
  groups: T[];
  /** Selectors that matched no group; empty on success. */
  unknown: string[];
}

const normalizePath = (value: string): string => value.replace(/\\/gu, "/");

/**
 * Choose which groups to run.
 *
 * `selectors` may be group names (`eval-comparator`) or paths whose group
 * includes that file (`capability/craft-eval/compare-run-reports.ts`). An empty
 * selector list means "all groups". Results keep manifest order and de-duplicate
 * a group matched by more than one selector.
 */
export function selectGateGroups<T extends SelectableGroup>(
  groups: readonly T[],
  selectors: readonly string[] = [],
): GateSelection<T> {
  const wanted = selectors.map((item) => item.trim()).filter(Boolean);
  if (!wanted.length) return { groups: [...groups], unknown: [] };

  const matched = new Set<string>();
  const unknown: string[] = [];
  for (const selector of wanted) {
    const path = normalizePath(selector);
    const hits = groups.filter((group) => group.name === selector
      || group.include.some((file) => normalizePath(file) === path));
    if (!hits.length) { unknown.push(selector); continue; }
    for (const group of hits) matched.add(group.name);
  }
  return { groups: groups.filter((group) => matched.has(group.name)), unknown };
}

/** Parse `--group a,b` / `--group=a,b` / repeated `--group a` into selectors. */
export function parseGroupArguments(argv: readonly string[]): { selectors: string[]; list: boolean } {
  const selectors: string[] = [];
  let list = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--list") { list = true; continue; }
    if (arg === "--group") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error("--group requires a value");
      selectors.push(...value.split(","));
      index += 1;
      continue;
    }
    if (arg.startsWith("--group=")) { selectors.push(...arg.slice("--group=".length).split(",")); continue; }
    if (arg.startsWith("-")) throw new Error(`unknown option: ${arg}`);
  }
  return { selectors: selectors.map((item) => item.trim()).filter(Boolean), list };
}
