/**
 * Proves the G8 checker is falsifiable.
 *
 * A consistency check that cannot fail is worse than none: it manufactures
 * confidence. The first version of `observeMcpFacts` returned the runtime
 * constant as the handler's advertised set, so `mcp.advertised_versions`
 * compared a value with itself and could never fire — the same defect class the
 * module exists to catch, committed inside the checker.
 *
 * This script mutates each fact in turn and confirms the check notices.
 */
import { MCP_ASSESSED_REVISION, MCP_MIGRATION_STATUS, MCP_PROTOCOL_VERSIONS } from "../../core/distribution-and-first-run.ts";
import { checkConsistency, mcpDeclarations, observeMcpFacts } from "../../core/declaration-consistency.ts";

// Annotated with the observer's own parameter type: each mutation below is
// *deliberately* wrong, so `base` must not inherit narrow literal types from the
// `as const` constants it is seeded with, or the mutations would not compile and
// the script could never exercise the shapes it exists to reject.
const base: Parameters<typeof observeMcpFacts>[0] = {
  protocolVersions: MCP_PROTOCOL_VERSIONS,
  advertisedVersions: MCP_PROTOCOL_VERSIONS,
  assessedRevision: MCP_ASSESSED_REVISION,
  implementsPing: true,
  migrationStatus: MCP_MIGRATION_STATUS,
  unclassifiedMountedTools: [] as string[],
  implementsServerDiscover: true,
  emitsResultType: false,
  compliantWithTarget: false,
};

const baseline = checkConsistency({ declarations: mcpDeclarations(), observed: observeMcpFacts(base) });
console.log(`baseline: consistent=${String(baseline.consistent)} confirmed=${String(baseline.confirmed)} unverifiable=${String(baseline.unverifiable)}`);

/** Each mutation must be caught, or the check is decorative. */
const mutations: Array<[string, typeof base]> = [
  ["handler advertises the assessed revision", { ...base, advertisedVersions: [...MCP_PROTOCOL_VERSIONS, MCP_ASSESSED_REVISION] }],
  ["handler drops a declared version", { ...base, advertisedVersions: ["2025-11-25"] }],
  ["handler advertises an unknown version", { ...base, advertisedVersions: ["2025-11-25", "1999-01-01"] }],
  ["removed method is really gone but claimed present", { ...base, implementsPing: false }],
  ["migration status silently changes", { ...base, migrationStatus: "adopted" }],
  ["a mounted tool escapes classification", { ...base, unclassifiedMountedTools: ["craft_mystery_tool"] }],
  // v0.12.41: the forward-compatibility claims must be falsifiable too, or the
  // readiness report becomes an unverifiable compliance claim.
  ["server/discover quietly removed", { ...base, implementsServerDiscover: false }],
  ["a resultType is emitted after all", { ...base, emitsResultType: true }],
  ["the build starts claiming compliance", { ...base, compliantWithTarget: true }],
];

let caught = 0;
const missed: string[] = [];
for (const [label, mutated] of mutations) {
  const report = checkConsistency({ declarations: mcpDeclarations(), observed: observeMcpFacts(mutated) });
  const detected = report.consistent === false;
  if (detected) caught += 1; else missed.push(label);
  console.log(`${detected ? "CAUGHT " : "MISSED "} ${label.padEnd(46)} -> ${JSON.stringify(report.contradicted_ids)}`);
}
console.log(`\nfalsifiable on ${caught}/${mutations.length} mutations`);

// A missed mutation means the checker cannot see that shape of contradiction, so
// it must fail the build. Reporting the count and exiting 0 would make this
// script decorative — the exact defect (a check that cannot fire) it was written
// to detect in `observeMcpFacts`.
//
// The baseline counts too: if the *unmutated* facts are not consistent, every
// mutation below is measuring a broken fixture rather than the checker.
if (missed.length) {
  console.error(`\n${missed.length} mutation(s) went undetected:`);
  for (const label of missed) console.error(`  MISSED ${label}`);
  process.exitCode = 1;
}
if (baseline.consistent !== true) {
  console.error("\nbaseline is inconsistent; the mutations below are not measuring the checker");
  process.exitCode = 1;
}
