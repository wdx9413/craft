import type { JsonObject } from "./store.ts";

/**
 * The tool plane.
 *
 * Craft used to expose one MCP tool per operation, which meant the host paid for
 * 485 tool schemas on every turn before the model had read a single message. The
 * industry measurement is that this fixed cost is the dominant tax on an agent
 * harness, and that it does not scale down by writing shorter descriptions.
 *
 * The fix is structural: expose a handful of *verbs* and make the capability
 * itself data. A resource/operation pair is a registry row, not a tool. New
 * capabilities therefore add zero tools, and the default surface stays O(1).
 *
 * Nothing here duplicates a handler: every registry row points at the legacy
 * `craft_*` tool name that already implements it, so the syscall surface is a
 * re-index of the same code rather than a second implementation.
 */

/** The verbs a host learns once. Everything else is addressed by (resource, operation). */
export const SYSCALL_VERBS: readonly string[] = [
  "craft_describe", "craft_list", "craft_get", "craft_create", "craft_update", "craft_run", "craft_cancel", "craft_search",
];

/**
 * Tools the routing Skill calls by name. They stay verbatim on the minimal
 * surface because `craft-route` is a published contract: rewriting the Skill and
 * every host adapter at the same moment as the surface change would be two
 * migrations in one step.
 */
export const SYSCALL_PASSTHROUGH: readonly string[] = [
  "craft_info", "craft_default_route", "craft_default_route_resume", "craft_default_route_find",
  "craft_default_route_execute", "craft_task_checkpoint", "craft_evidence_record",
];

export type ToolEffect = "read_only" | "local_write" | "external_write" | "destructive";
export type ToolRisk = "low" | "medium" | "high";
export type AuditPolicy = "always" | "on_write" | "never";

export interface ToolLike { name: string; description: string; inputSchema: JsonObject; annotations?: JsonObject }

/** The governed metadata a registry row carries, modelled on the tool-registry fields production harnesses converge on. */
export interface RegistryEntry {
  tool: string;
  resource: string;
  operation: string;
  description: string;
  effect: ToolEffect;
  risk: ToolRisk;
  approval_required: boolean;
  idempotent: boolean;
  timeout_ms: number;
  audit_policy: AuditPolicy;
  roles: string[];
  required: string[];
  optional: string[];
}

/**
 * Operations Craft actually uses as a trailing verb. A tool whose last segment
 * is not in this set is treated as a bare resource whose operation is `info`,
 * which keeps multi-word resources such as `default_route` intact.
 */
const OPERATIONS: readonly string[] = [
  "create", "update", "delete", "remove", "list", "get", "run", "execute", "start", "cancel", "stop",
  "record", "issue", "consume", "prepare", "decide", "refresh", "sync", "scan", "search", "register",
  "resolve", "observe", "advance", "resume", "find", "plan", "report", "publish", "import", "export",
  "validate", "compare", "aggregate", "evaluate", "promote", "rollback", "recover", "settle", "reserve",
  "bind", "apply", "compile", "materialize", "certify", "revoke", "suspend", "deprecate", "install",
  "configure", "enable", "disable", "status", "inspect", "check", "tick", "trial", "claim", "retire",
  "diff", "preview", "archive", "restore", "append", "ack", "defer", "derive", "propose", "approve",
  "deny", "link", "unlink", "hydrate", "dehydrate", "signoff", "settlement", "budget", "usage", "catalog",
  "receipt", "activation", "profile", "audit", "health", "count", "summarize", "grant",
  // Imperative nouns Craft already uses as trailing verbs. Without these the syscall
  // surface still reaches every tool, but the address would be an opaque
  // `craft_get({resource:"acceptance_plan_save"})` instead of the operation a model
  // would naturally guess. Collisions are impossible to slip through: buildRegistry
  // throws on a duplicate (resource, operation) pair.
  "save", "open", "add", "put", "begin", "complete", "finish", "commit", "abort", "pause",
  "dispatch", "decision", "submit", "recommend", "probe", "assess", "discover", "handoff", "review",
  "reopen", "conclude", "authorize", "attest", "simulate", "forecast", "sample", "verify", "test",
  "fork", "merge", "split", "move", "copy", "clone", "attach", "detach", "assign", "notify", "request",
  "respond", "emit", "flush", "reset", "clear", "purge", "prune", "sweep", "rebuild", "reindex",
  "migrate", "upgrade", "replay", "estimate", "schedule", "queue", "release", "deliver", "accept", "reject",
];

const DESTRUCTIVE_OPERATIONS = new Set(["delete", "remove", "revoke", "purge", "rollback"]);
const READ_OPERATIONS = new Set(["get", "list", "status", "search", "find", "describe", "compare", "diff",
  "preview", "plan", "report", "count", "inspect", "health", "catalog", "audit", "summarize", "info", "check", "usage",
  "probe", "discover", "assess", "recommend", "review", "forecast", "sample", "estimate", "verify"]);
const IDEMPOTENT_OPERATIONS = new Set(["get", "list", "status", "search", "find", "describe", "compare",
  "diff", "preview", "plan", "report", "count", "inspect", "health", "catalog", "audit", "summarize", "info", "usage",
  "probe", "discover", "assess", "recommend", "review", "forecast", "sample", "estimate", "verify"]);
const EXTERNAL_OPERATIONS = new Set(["grant", "publish", "materialize", "certify", "register", "configure", "install"]);
/** Resources whose whole point is reaching outside the local machine. */
const EXTERNAL_RESOURCES = /(egress|credential|enterprise|a2a|trigger|webhook|federation|hub|connector|materialization|contract|sandbox|docker)/u;
const LONG_RUNNING_OPERATIONS = new Set(["run", "execute", "start", "trial", "scan", "sync", "materialize", "install", "dehydrate", "hydrate"]);
const GOVERNANCE_RESOURCES = /(certification|supply|federation|hub|certification|publication|revoke|enterprise|autonomy|policy)/u;

/** Split a legacy tool name into the resource/operation pair that addresses it. */
export function parseToolName(name: string): { resource: string; operation: string } {
  const rest = name.startsWith("craft_") ? name.slice("craft_".length) : name;
  const cut = rest.lastIndexOf("_");
  if (cut === -1) return { resource: rest, operation: "info" };
  const operation = rest.slice(cut + 1);
  if (!OPERATIONS.includes(operation)) return { resource: rest, operation: "info" };
  return { resource: rest.slice(0, cut), operation };
}

function classifyEffect(tool: ToolLike, operation: string, resource: string): ToolEffect {
  if (tool.annotations?.readOnlyHint === true) return "read_only";
  if (DESTRUCTIVE_OPERATIONS.has(operation)) return "destructive";
  if (EXTERNAL_OPERATIONS.has(operation) || EXTERNAL_RESOURCES.test(resource)) return "external_write";
  if (READ_OPERATIONS.has(operation)) return "read_only";
  return "local_write";
}

function riskOf(effect: ToolEffect): ToolRisk {
  if (effect === "destructive" || effect === "external_write") return "high";
  return effect === "read_only" ? "low" : "medium";
}

function auditOf(effect: ToolEffect): AuditPolicy {
  if (effect === "read_only") return "never";
  return effect === "local_write" ? "on_write" : "always";
}

function schemaParts(tool: ToolLike): { required: string[]; optional: string[] } {
  const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required.map(String) : [];
  const properties = (tool.inputSchema.properties ?? {}) as JsonObject;
  const optional = Object.keys(properties).filter((key) => !required.includes(key));
  return { required, optional };
}

/**
 * Build the registry from the legacy tool list.
 *
 * The (resource, operation) pair must be unique, because that pair is the only
 * way the syscall surface can address a tool. A collision is a programming
 * error rather than a runtime condition, so it throws here instead of silently
 * shadowing an operation.
 */
export function buildRegistry(tools: readonly ToolLike[]): RegistryEntry[] {
  const seen = new Map<string, string>();
  return tools.map((tool) => {
    const { resource, operation } = parseToolName(tool.name);
    const key = `${resource}.${operation}`;
    const clash = seen.get(key);
    if (clash) throw new Error(`Tool registry collision: ${tool.name} and ${clash} both map to ${key}`);
    seen.set(key, tool.name);
    const effect = classifyEffect(tool, operation, resource);
    const { required, optional } = schemaParts(tool);
    return {
      tool: tool.name, resource, operation, description: tool.description, effect, risk: riskOf(effect),
      approval_required: effect !== "read_only",
      idempotent: IDEMPOTENT_OPERATIONS.has(operation),
      timeout_ms: LONG_RUNNING_OPERATIONS.has(operation) ? 300_000 : 30_000,
      audit_policy: auditOf(effect),
      roles: GOVERNANCE_RESOURCES.test(resource) ? ["owner", "admin"] : ["owner"],
      required, optional,
    };
  });
}

/** The one operation the (resource, operation) pair addresses, or null when it does not exist. */
export function findEntry(entries: readonly RegistryEntry[], resource: string, operation: string): RegistryEntry | null {
  return entries.find((entry) => entry.resource === resource && entry.operation === operation) ?? null;
}

/**
 * Resolve a syscall request. When the caller omits the operation the tool's own
 * default is used, and when the resource has exactly one operation that is used
 * instead — so `craft_get({resource:"info"})` works without the model having to
 * learn that `info` is also its own operation name.
 */
export function resolveEntry(entries: readonly RegistryEntry[], resource: string, operation: string | undefined,
  fallback: string): RegistryEntry | null {
  if (operation) return findEntry(entries, resource, operation);
  const direct = findEntry(entries, resource, fallback);
  if (direct) return direct;
  const candidates = entries.filter((entry) => entry.resource === resource);
  return candidates.length === 1 ? candidates[0] : null;
}

/** Compact catalog for `craft_describe` with no arguments: what exists, without any schema body. */
export function catalogOf(entries: readonly RegistryEntry[]): { resources: number; operations: number;
  catalog: Array<{ resource: string; operations: string[]; effect: ToolEffect }> } {
  const grouped = new Map<string, { operations: string[]; effect: ToolEffect }>();
  for (const entry of entries) {
    const existing = grouped.get(entry.resource);
    if (existing) { existing.operations.push(entry.operation); continue; }
    grouped.set(entry.resource, { operations: [entry.operation], effect: entry.effect });
  }
  const catalog = [...grouped.entries()].map(([resource, value]) => ({ resource,
    operations: [...value.operations].sort(), effect: value.effect })).sort((a, b) => a.resource.localeCompare(b.resource));
  return { resources: catalog.length, operations: entries.length, catalog };
}

/** Arg contract for one (resource, operation), plus the governance metadata the caller must respect. */
export function describeEntry(entry: RegistryEntry): JsonObject {
  return { resource: entry.resource, operation: entry.operation, tool: entry.tool, description: entry.description,
    effect: entry.effect, risk: entry.risk, approval_required: entry.approval_required,
    idempotent: entry.idempotent, timeout_ms: entry.timeout_ms, audit_policy: entry.audit_policy,
    roles: entry.roles, required: entry.required, optional: entry.optional };
}

/**
 * Token-economy report for a surface, so the claim "the default surface is small"
 * is a measurement rather than an assertion.
 */
export function measureSurface(tools: readonly ToolLike[]): { tools: number; characters: number; estimated_tokens: number } {
  const characters = tools.reduce((total, tool) => total + JSON.stringify(tool).length, 0);
  return { tools: tools.length, characters, estimated_tokens: Math.ceil(characters / 4) };
}
