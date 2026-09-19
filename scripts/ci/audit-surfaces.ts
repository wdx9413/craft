import { ACTIVE_TOOLS } from "../../src/interfaces/mcp-server.ts";
import { COMPONENT_SURFACES, SURFACE_RULES, domainSurfaceOf } from "../../src/interfaces/mcp/surface-registry.ts";

/**
 * Checks that a tool's surface is the one its name declares.
 *
 * `surface-registry.ts` says of itself: *"The registry owns only names and matching
 * rules; execution remains in McpServer."* That makes the name a contract, and nothing
 * was checking it. `domainSurfaceOf` returns the **first** rule that matches, so:
 *
 *  - a rule whose every match an earlier rule also claims is unreachable — dead weight
 *    that reads as coverage;
 *  - a tool whose prefix belongs to one domain but which an earlier rule serves lands
 *    in a domain its name does not announce.
 *
 * Neither fails today, and neither would fail tomorrow if a new tool arrived with a
 * prefix that collides. This audit makes both visible: unreachable rules fail, and a
 * cross-domain match must be named in `KNOWN_OVERLAPS` with a reason. An entry that
 * stops matching is reported as *stale*, so an exemption cannot outlive its cause —
 * the same discipline `audit-layering.ts` applies to upward imports.
 *
 * Reason strings answer "why is serving this elsewhere correct", not "what is it".
 */

/**
 * Tools whose name reads as one domain but which an earlier rule serves.
 *
 * Each entry is a judgement that the serving domain is the right one, so the entry is
 * the place the judgement is recorded rather than a rule ordering nobody re-derives.
 */
const KNOWN_OVERLAPS: Array<{ pattern: RegExp; servedBy: string; reason: string }> = [
  {
    pattern: /^craft_agent_eval_lab_/,
    servedBy: "evaluation",
    // `agent` also prefixes the collaboration rule, and `agent_eval` also matches the
    // quality pattern. The lab measures agents, so evaluation is its domain; the name
    // is what collides, not the ownership.
    reason: "agent eval lab instruments a versioned agent asset; the evaluation rule's `agent_eval` term claims it before collaboration's `agent` term can. Serving it under evaluation is correct, and the shared `agent` prefix is the only reason it looks otherwise.",
  },
];

const names = ACTIVE_TOOLS.map((tool) => tool.name);
if (!names.length) throw new Error("no active tools were found; the catalog import is wrong");

// A rule that owns nothing is unreachable: every tool it matches is claimed earlier.
// It reads as coverage in the registry while never selecting anything.
const unreachable = SURFACE_RULES.filter((rule) => !names.some((name) => rule.pattern.test(name) && domainSurfaceOf(name) === rule.name));

// A tool matching more than one rule is resolved by rule order, so its domain is an
// implementation detail of the ordering rather than of the name.
//
// The catch-all is excluded, and identifying it by behaviour rather than by position is
// deliberate: a rule matching *every* tool overlaps everything by construction, so
// counting it would report all 829 tools as cross-domain. Only prefix rules can
// disagree about a name.
const catchAllRule = SURFACE_RULES.find((rule) => names.every((name) => rule.pattern.test(name)));
const prefixRules = SURFACE_RULES.filter((rule) => rule !== catchAllRule);

const crossDomain = new Map<string, { owner: string; claimers: string[] }>();
for (const name of names) {
  const claimers = prefixRules.filter((rule) => rule.pattern.test(name)).map((rule) => rule.name);
  if (claimers.length > 1) crossDomain.set(name, { owner: domainSurfaceOf(name), claimers });
}

const declared = (name: string, owner: string): boolean =>
  KNOWN_OVERLAPS.some((entry) => entry.pattern.test(name) && entry.servedBy === owner);

const undeclared = [...crossDomain.entries()].filter(([name, info]) => !declared(name, info.owner));
const stale = KNOWN_OVERLAPS.filter((entry) => ![...crossDomain.entries()].some(([name, info]) => entry.pattern.test(name) && entry.servedBy === info.owner));

// The catch-all is expected to absorb whatever no prefix rule claims; measuring it keeps
// a shrinking partition from going unnoticed.
const catchAllOwned = catchAllRule ? names.filter((name) => domainSurfaceOf(name) === catchAllRule.name).length : 0;

console.log(`surface audit: ${names.length} tool(s) across ${SURFACE_RULES.length} domain rule(s)`);
for (const rule of SURFACE_RULES) {
  const owned = names.filter((name) => domainSurfaceOf(name) === rule.name).length;
  console.log(`  ${rule.name.padEnd(15)} ${String(owned).padStart(4)}`);
}
console.log(`  ${"components".padEnd(15)} ${String(Object.keys(COMPONENT_SURFACES).length).padStart(4)} surface(s)`);
console.log(`cross-domain: ${crossDomain.size} tool(s) match more than one prefix rule, ${crossDomain.size - undeclared.length} declared`);
console.log(`catch-all: ${catchAllRule?.name ?? "(none)"} owns ${catchAllOwned}`);

let failed = false;
if (unreachable.length) {
  failed = true;
  console.error(`surface audit: ${unreachable.length} unreachable rule(s) — every match is claimed by an earlier rule`);
  for (const rule of unreachable) console.error(`  ${rule.name}  ${String(rule.pattern)}`);
  console.error("  Remove the rule, or move it above the rule that shadows it.");
}
if (undeclared.length) {
  failed = true;
  console.error(`surface audit: ${undeclared.length} undeclared cross-domain tool(s)`);
  for (const [name, info] of undeclared) {
    console.error(`  ${name}  served by ${info.owner}  (also matches: ${info.claimers.filter((c) => c !== info.owner).join(", ")})`);
  }
  console.error("  Name the tool after its domain, or add a KNOWN_OVERLAPS entry stating why the serving domain is right.");
}
if (stale.length) {
  failed = true;
  console.error(`surface audit: ${stale.length} stale exemption(s) — the overlap no longer occurs, remove the entry`);
  for (const entry of stale) console.error(`  ${String(entry.pattern)} -> ${entry.servedBy}`);
}

if (failed) process.exitCode = 1;
else console.log(`surface audit: clean (${KNOWN_OVERLAPS.length} documented cross-domain tool family(ies))`);
