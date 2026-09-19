import type { Tool } from "./mcp/tool-schema.ts";
import type { ChatToolDefinition } from "./model-gateway.ts";

/**
 * Tiered authorization for Craft's *own* loop.
 *
 * The internal host is Craft running the loop itself, so every tool the model
 * can address is also a power Craft grants to itself. Widening that surface to
 * the full MCP catalog is only safe if the surface stays *tiered* rather than
 * *flat*: the loop may always read, may usually propose, and must never
 * silently gain a power that a human would otherwise have to approve.
 *
 * The four levels are a property of the tool, not of the caller:
 *   read       — observe only; no record is written on the caller's behalf.
 *   candidate  — append a proposal / candidate / observation that a later
 *                governed decision still has to accept.
 *   governed   — commit an approval-gated outcome (publish, promote, decide,
 *                sign off, rollback). Never mounted on the internal loop by
 *                default; a host has to opt in explicitly.
 *   forbidden  — sandbox, credential, host-config and other self-modifying
 *                powers that must not be reachable from inside a loop at all.
 *
 * Classification deliberately does *not* reuse the coarse MCP surface regexes:
 * those group tools for projection and would mis-authorize (`craft_runtime_
 * policy_save` lives on the "execution" surface but is an ordinary governed
 * save, while `craft_isolation_capability_get` groups as "workflow" yet reports
 * an isolation bound). Authorization reads the name directly instead.
 */
export type ToolAuthorization = "read" | "candidate" | "governed" | "forbidden";

/** The four tiers in strength order, low to high privilege. */
export const TOOL_AUTHORIZATIONS: readonly ToolAuthorization[] = ["read", "candidate", "governed", "forbidden"];

/** The surface Craft's own loop mounts when a host does not override it. */
export const DEFAULT_INTERNAL_AUTHORIZATION: readonly ToolAuthorization[] = ["read", "candidate"];

/** Return true when `control` grants every tier in `required`. */
export function authorizationAllows(
  control: readonly ToolAuthorization[],
  required: ToolAuthorization,
): boolean {
  return control.includes(required);
}

// A forbidden resource is one a loop must never reach at all, regardless of the
// verb: keys, credentials, sandboxes and egress are capabilities a human or an
// external host grants, never something the model can help itself to.
const FORBIDDEN_RESOURCES = /(?:^|_)(?:credential|secret|sandbox|docker|egress|isolation|isolated)(?:_|$)/;

// Ordered verb vocabulary. The last segment decides, and reads win: `_get` must
// never become writable just because the resource sounds active. Anything not
// listed falls closed to `governed`.
//
// `write` is deliberately *candidate*, not governed: a plain write still has to
// clear the approval gate inside the handler (`approved`, `approval_ref`), so it
// is exactly "propose something a later governed decision must accept". Filing
// it under governed instead would make the loop unable to do ordinary bounded
// work, which is the surface it was already granted.
const READ_VERBS = /(?:^|_)(?:get|list|search|describe|info|read|resolve|preview|inspect|status|check|explain|render|export|score|assess|traverse|neighbors|health|stats|schema|capabilities|version|view|diff|discover|evaluate|compare|recommend|replay|query|due|report)(?:_|$)/;

const GOVERNED_VERBS = /(?:^|_)(?:save|publish|promote|decide|signoff|accept|approve|authorize|rollback|suspend|retire|delete|remove|revoke|commit|finalize|bind|certify|materialize|deploy|release|enforce|grant|apply|transition|refresh|issue|consume|execute|run|cancel|start|stop|tick|recover|advance|claim|settle|close|open|dispatch|ingest|import|install|lock|unlock|emergency|intervene|override)(?:_|$)/;

const CANDIDATE_VERBS = /(?:^|_)(?:propose|submit|observe|remember|record|append|write|create|register|update|draft|stage|prepare|capture|note|checkpoint|relate|refine|learn|consolidate|attest|reassess|probe|preflight|simulate|shadow|canary|evaluate_candidate)(?:_|$)/;

function lastSegment(toolName: string): string {
  const stripped = toolName.replace(/^craft_/u, "");
  return stripped.slice(stripped.lastIndexOf("_") + 1);
}

function syntaxOf(toolName: string): string {
  return `_${lastSegment(toolName)}`;
}

/**
 * Classify one canonical tool name.
 *
 * Order is deliberate and fail-closed: a forbidden *resource* wins over any
 * verb, a read *verb* wins over candidate and governed so observation is never
 * accidentally gated, and anything unrecognised becomes `governed` — the safe
 * direction is "a human must opt in", never "the loop may do it".
 */
export function classifyTool(toolName: string): ToolAuthorization {
  const stripped = toolName.replace(/^craft_/u, "");
  if (FORBIDDEN_RESOURCES.test(`_${stripped}`)) return "forbidden";
  const syntax = syntaxOf(toolName);
  if (READ_VERBS.test(syntax)) return "read";
  if (CANDIDATE_VERBS.test(syntax)) return "candidate";
  if (GOVERNED_VERBS.test(syntax)) return "governed";
  return "governed";
}

/** Project the full canonical tool table down to the tiers a host mounted. */
export function authorizedTools(tools: readonly Tool[], authorization: readonly ToolAuthorization[]): Tool[] {
  const allowed = new Set(authorization);
  return tools.filter((tool) => allowed.has(classifyTool(tool.name)));
}

const SCHEMA_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);

interface JsonSchemaLike { type?: unknown; enum?: unknown }

/**
 * Convert one canonical MCP `Tool` schema into the model-facing chat tool that
 * the internal host hands to a provider.
 *
 * The schema is a single source: the internal loop advertises exactly the
 * parameters the public tool advertises. The action name is the canonical
 * `craft_*` name minus the `craft_` prefix, which keeps `invokeInternalAction`
 * verb dispatch stable and readable.
 */
export function toChatToolDefinition(tool: Tool): ChatToolDefinition {
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required as string[] : [];
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, JsonSchemaLike>;
  const params: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(properties)) {
    const type = typeof schema.type === "string" && SCHEMA_TYPES.has(schema.type) ? schema.type : "string";
    params[name] = { type, ...(Array.isArray(schema.enum) ? { enum: schema.enum } : {}) };
  }
  return { type: "function", function: {
    name: actionNameOf(tool.name),
    description: tool.description,
    parameters: { type: "object", properties: params, ...(required.length ? { required } : {}) },
  } };
}

/** `craft_knowledge_search` -> `knowledge_search`; non-craft names pass through. */
export function actionNameOf(toolName: string): string {
  return toolName.startsWith("craft_") ? toolName.slice("craft_".length) : toolName;
}

/**
 * Build the model-facing tool list for the internal loop from the canonical
 * catalog. `provider` is the function that resolves the live catalog so this
 * stays a projection, not a second source of truth.
 *
 * `extras` are the loop-only operations that have no canonical MCP counterpart
 * but are still genuinely bounded Craft actions (today: the approval-gated
 * `workspace_read` / `workspace_write` pair that the internal host predates the
 * MCP catalog with). They are appended *after* the projection rather than
 * merged earlier so a future canonical tool of the same name always wins and
 * the union can never shadow the public surface.
 *
 * `dispatchable` is the join between "authorized" and "answerable". A tier says
 * what the loop *may* do; it does not say the service can route the call. Every
 * advertised tool the loop cannot dispatch becomes a failed turn, because the
 * loop cannot answer a call it cannot resolve -- the model is told a capability
 * exists and then punished for using it. Filtering here, at the single place the
 * model-facing list is built, is what makes the advertised surface truthful: a
 * tool is offered only when it is inside a mounted tier *and* resolvable.
 *
 * `extras` are exempt from that filter: they are supplied by the caller that
 * also supplies the dispatcher for them, so their presence in the list is itself
 * the assertion that they can be answered.
 */
export function internalToolDefinitions(
  provider: () => readonly Tool[],
  authorization: readonly ToolAuthorization[] = DEFAULT_INTERNAL_AUTHORIZATION,
  extras: readonly ChatToolDefinition[] = [],
  dispatchable?: () => ReadonlySet<string>,
): ChatToolDefinition[] {
  const projected = authorizedTools(provider(), authorization);
  const answerable = dispatchable?.();
  const definitions = (answerable ? projected.filter((tool) => answerable.has(actionNameOf(tool.name))) : projected)
    .map(toChatToolDefinition);
  if (!extras.length) return definitions;
  const seen = new Set(definitions.map((definition) => definition.function.name));
  return [...definitions, ...extras.filter((definition) => !seen.has(definition.function.name))];
}
