import type { JsonObject } from "./infrastructure/store.ts";

/**
 * G8: declaration/implementation consistency.
 *
 * Every defect found in the v0.12.38 live run had the same shape: a *declaration*
 * disagreed with the *implementation*, and nothing compared them.
 *
 *  - `MCP_ASSESSED_REVISION = "2026-07-28"` records that this build assessed that
 *    revision, while the initialize handler still whitelists only the three older
 *    ones and still implements `ping`, which 2026-07-28 removed. The declaration
 *    and the code are both individually defensible; nothing tied them together.
 *  - `buildChatRequest` promised an `authorization` header and emitted the
 *    literal text of a template, so the promise and the value disagreed.
 *  - A test asserted `"Bearer $DEMO_API_KEY"`, locking the wrong contract in
 *    place. The test was the declaration that lied.
 *
 * The lesson is not "be careful". It is that a claim and its implementation drift
 * apart silently, because nothing in the build forces them to agree. This module
 * makes the comparison explicit and mechanical: declarations are stated as
 * machine-readable claims, an observation supplies the implementation facts, and
 * every claim is either confirmed, contradicted, or *unverifiable*.
 *
 * `unverifiable` exists for the same reason `unattributed` exists in v0.12.38: an
 * unchecked claim is not a passing claim. Collapsing "I could not check this"
 * into "this is fine" is precisely how the MCP contradiction survived.
 */

/** Where a claim came from, so a report can point at something actionable. */
export interface Declaration {
  /** Stable id for the claim. */
  id: string;
  /** What is being asserted, in prose, for the report. */
  statement: string;
  /** The implementation fact that must be present for the claim to hold. */
  expects: JsonObject;
  /** Reference to the source of the claim, for a human to check. */
  source: string;
}

export interface ConsistencyFinding {
  id: string;
  statement: string;
  source: string;
  /** A claim the observation supports, denies, or that it could not check. */
  verdict: "confirmed" | "contradicted" | "unverifiable";
  /** Which expected facts were missing or mismatched. */
  mismatches: string[];
  /** Missing facts, as opposed to present-but-wrong ones. */
  unchecked: string[];
}

/**
 * Read a required non-empty string.
 *
 * `key` is the property to read; `label` is how the error names it. They are
 * separate because a declaration's fields are reported by index
 * (`declarations[2].id`) while the property itself is just `id` — passing the
 * label as the key looks up a property named "declarations[2].id" and finds
 * nothing.
 */
function text(input: JsonObject, key: string, label = key): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty`);
  return value.trim();
}

/**
 * Compare one expected value against one observed value.
 *
 * Comparison is deliberately by *value equality*, with one extension: an expected
 * array asserts the exact set, so `["a","b"]` fails against observed `["a"]`.
 * That direction matters — a claim listing three supported revisions is a claim
 * that exactly those three are supported, and a subset means the declaration has
 * drifted ahead of the code.
 */
function matches(expected: unknown, observed: unknown): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(observed) || observed.length !== expected.length) return false;
    // Order-insensitive: these are sets of facts, not sequences.
    return [...expected].sort().join("\u0000") === [...observed].sort().join("\u0000");
  }
  return expected === observed;
}

/**
 * Check declarations against observations.
 *
 * A claim whose expected facts are absent from the observation is `unverifiable`,
 * never `confirmed`. That is the whole point: the MCP contradiction survived
 * because a declaration was treated as true in the absence of any check.
 */
export function checkConsistency(input: JsonObject): JsonObject {
  const rawDeclarations = input.declarations;
  if (!Array.isArray(rawDeclarations) || !rawDeclarations.length) throw new Error("declarations must be a non-empty array");
  const observed = input.observed;
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) throw new Error("observed must be an object");
  const facts = observed as JsonObject;

  const findings: ConsistencyFinding[] = rawDeclarations.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`declarations[${index}] must be an object`);
    const declaration = item as JsonObject;
    const id = text(declaration, "id", `declarations[${index}].id`);
    const statement = text(declaration, "statement", `declarations[${index}].statement`);
    const source = text(declaration, "source", `declarations[${index}].source`);
    const expects = declaration.expects;
    if (!expects || typeof expects !== "object" || Array.isArray(expects)) throw new Error(`declarations[${index}].expects must be an object`);
    const expected = expects as JsonObject;
    if (!Object.keys(expected).length) throw new Error(`declarations[${index}].expects must not be empty`);

    const mismatches: string[] = [];
    const unchecked: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(facts, key)) { unchecked.push(key); continue; }
      if (!matches(value, facts[key])) {
        // Both sides are reported: a mismatch is only actionable when the
        // declaration and the reality are visible together.
        mismatches.push(`${key}: declared ${JSON.stringify(value)}, observed ${JSON.stringify(facts[key])}`);
      }
    }

    // A contradiction outranks an unchecked fact: if one claim is provably wrong,
    // a missing fact elsewhere cannot rescue it.
    const verdict: ConsistencyFinding["verdict"] = mismatches.length
      ? "contradicted" : unchecked.length ? "unverifiable" : "confirmed";
    return { id, statement, source, verdict, mismatches, unchecked };
  });

  const contradicted = findings.filter((finding) => finding.verdict === "contradicted");
  const unverifiable = findings.filter((finding) => finding.verdict === "unverifiable");
  return {
    total: findings.length,
    confirmed: findings.filter((finding) => finding.verdict === "confirmed").length,
    contradicted: contradicted.length,
    // Reported as loudly as contradictions: an unchecked claim is the state the
    // MCP revision declaration sat in.
    unverifiable: unverifiable.length,
    // The build should fail on contradictions, not on honest unknowns.
    consistent: contradicted.length === 0,
    // Named callers so a failure points at something to fix.
    contradicted_ids: contradicted.map((finding) => finding.id),
    unverifiable_ids: unverifiable.map((finding) => finding.id),
    findings
  };
}

/**
 * The declarations this build actually makes about its MCP surface.
 *
 * Kept as data rather than prose in a document so the check is mechanical. Each
 * entry names the fact that would falsify it.
 */
export function mcpDeclarations(): Declaration[] {
  return [
    {
      id: "mcp.advertised_versions",
      statement: "The initialize handler negotiates exactly the revisions the runtime declares as supported.",
      // If this fails, the runtime and the handler disagree — which is the exact
      // shape of the 2026-07-28 defect. Both sides are checked, so neither the
      // handler drifting from the constant nor the constant drifting from the
      // handler can pass unnoticed.
      expects: {
        protocol_versions: ["2025-03-26", "2025-06-18", "2025-11-25"],
        protocol_versions_declared: ["2025-03-26", "2025-06-18", "2025-11-25"],
      },
      source: "src/distribution-and-first-run.ts MCP_PROTOCOL_VERSIONS vs src/interfaces/mcp-server.ts initialize",
    },
    {
      id: "mcp.assessed_revision_not_advertised",
      statement: "A revision recorded as assessed-and-deferred is not advertised as supported.",
      expects: { advertises_assessed_revision: false },
      source: "src/distribution-and-first-run.ts MCP_ASSESSED_REVISION / MCP_MIGRATION_STATUS",
    },
    {
      id: "mcp.removed_methods_acknowledged",
      statement: "Implementing a method the assessed revision removed is a recorded, deliberate gap rather than an unnoticed one.",
      // `ping` was removed in 2026-07-28. Implementing it is CORRECT while
      // speaking 2025-11-25, so the claim is not "ping is absent" — that would
      // be a false declaration and the check would rightly fail. The claim is
      // that the gap is known and recorded, which is what the migration
      // assessment is for. This is the difference between a declaration and an
      // aspiration: the first version of this claim asserted the aspiration and
      // was contradicted by the code, which is the check working.
      expects: { implements_removed_ping: true, migration_status: "assessed_deferred" },
      source: "MCP 2026-07-28 changelog (ping removed) vs src/distribution-and-first-run.ts MCP_MIGRATION_STATUS",
    },
    {
      id: "mcp.tool_tiers_mounted",
      statement: "Every tool the internal loop may mount is classified into a mounted tier.",
      expects: { unclassified_mounted_tools: [] },
      source: "src/internal-tool-authorization.ts",
    },
    // v0.12.41: the forward-compatibility claims. Each names the fact that would
    // falsify it, so the readiness report cannot drift into a compliance claim.
    {
      id: "mcp.discover_implemented",
      statement: "The server implements `server/discover`, as the assessed revision mandates.",
      expects: { implements_server_discover: true },
      source: "MCP 2026-07-28 changelog item 3 (server/discover) vs src/interfaces/mcp-server.ts",
    },
    {
      id: "mcp.no_result_type_emitted",
      statement: "Outbound results omit `resultType` while the server speaks an earlier revision, rather than announcing a field it does not implement.",
      expects: { emits_result_type: false },
      source: "MCP 2026-07-28 changelog item 8 (resultType) vs src/mcp-forward-compat.ts",
    },
    {
      id: "mcp.not_claiming_compliance",
      statement: "The build does not claim compliance with the revision it has assessed and deferred.",
      // The single most important claim here: a readiness report that drifts
      // into a compliance claim is the failure this whole module exists to stop.
      expects: { compliant_with_target: false },
      source: "src/mcp-forward-compat.ts forwardCompatibility().compliant_with_target",
    },
  ];
}

/**
 * Read the implementation facts the MCP declarations are checked against.
 *
 * Supplied by the caller rather than imported, so the checker stays a pure
 * function and a test can supply a deliberately wrong observation.
 */
export function observeMcpFacts(input: {
  protocolVersions: readonly string[];
  advertisedVersions: readonly string[];
  assessedRevision: string;
  implementsPing: boolean;
  migrationStatus: string;
  unclassifiedMountedTools: string[];
  implementsServerDiscover: boolean;
  emitsResultType: boolean;
  compliantWithTarget: boolean;
}): JsonObject {
  const advertised = [...input.advertisedVersions];
  return {
    // The HANDLER's advertised set, not the runtime constant. An earlier version
    // of this function returned `input.protocolVersions` here, which made the
    // advertised-versions claim compare a constant with itself: it could never
    // fail. That is the same defect class this module exists to catch, committed
    // inside the checker — a check that passes because it never looks at the
    // thing it claims to check.
    protocol_versions: advertised.filter((version) => version !== input.assessedRevision),
    protocol_versions_declared: [...input.protocolVersions],
    // The interesting fact: is the assessed revision among those advertised?
    advertises_assessed_revision: advertised.includes(input.assessedRevision),
    implements_removed_ping: input.implementsPing,
    migration_status: input.migrationStatus,
    unclassified_mounted_tools: [...input.unclassifiedMountedTools],
    implements_server_discover: input.implementsServerDiscover,
    emits_result_type: input.emitsResultType,
    compliant_with_target: input.compliantWithTarget,
  };
}
