import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type HookSignal = {
  readonly id: string;
  readonly tool: string;
  readonly kind: "edit" | "verification" | "verification_gap" | "other";
  readonly outcome: "passed" | "failed" | "unknown";
  readonly digest: string;
  readonly verifier: string | null;
  readonly scenario_key?: string;
  readonly coarse_scenario_key?: string;
  readonly observed_path?: string;
  readonly gap_reason?: "pending_background" | "unsupported_native_envelope";
};

type HookInput = Record<string, unknown>;

const SECRET_PATH = /(?:secret|token|credential|password|private|\.env)/iu;
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
const NODE_TEST = /^node(?:\s+(?:--experimental-strip-types|--experimental-test-coverage|--test-isolation=(?:none|process)|--test-concurrency=\d+|--test-reporter=[\w.-]+|--test-coverage-(?:lines|branches|functions)=\d+|--test-coverage-include=[\w./*:-]+))*\s+--test(?:\s|$)/u;
const VERIFY = /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?|pytest|(?:python3?\s+-m\s+pytest)|(?:mvn|gradle|gradlew|\.\/gradlew)\s+(?:test|verify)|go\s+test|cargo\s+test)(?:\s|$)/u;
const EDIT = /(?:^|[;&|\s])(?:apply_patch|git\s+apply|sed\s+-i|perl\s+-pi)\b/iu;

export function isHookVerificationCommand(command: string): boolean {
  return (VERIFY.test(command.trim()) || NODE_TEST.test(command.trim())) && !/[;&|`$\n]/u.test(command);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function nestedText(value: unknown, names: readonly string[]): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const object = value as Record<string, unknown>;
  for (const name of names) {
    const raw = object[name];
    const found = text(typeof raw === "number" ? String(raw) : raw);
    if (found) return found;
  }
  return null;
}

function verificationOutcome(response: unknown): HookSignal["outcome"] {
  if (!response || typeof response !== "object" || Array.isArray(response)) return "unknown";
  const result = response as Record<string, unknown>;
  const status = nestedText(result, ["status"]);
  if (result.interrupted === true || result.timed_out === true || typeof result.backgroundTaskId === "string"
    || status !== null && ["in_progress", "running", "pending", "cancelled"].includes(status)) return "unknown";
  const exit = nestedText(result, ["exit_code", "exitCode"]);
  const alternate = nestedText(result, ["exitCode"]);
  if (exit !== null && alternate !== null && exit !== alternate) return "unknown";
  const passed = exit === "0" || exit === null && ["success", "passed"].includes(status ?? "");
  const failed = exit !== null && (/^[1-9]\d*$/u.test(exit) || exit === "error")
    || exit === null && ["failed", "error"].includes(status ?? "");
  if (passed && ["failed", "error"].includes(status ?? "")
    || failed && ["success", "passed", "completed"].includes(status ?? "")) return "unknown";
  if (passed) return "passed";
  return failed ? "failed" : "unknown";
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function observedProjectPath(value: unknown, projectRoot: unknown): string | null {
  if (typeof value !== "string" || typeof projectRoot !== "string" || !value.trim() || value.length > 512 || value.includes("\\") || value.includes("\0")) return null;
  try {
    const root = realpathSync(projectRoot), absolute = resolve(root, value.trim()), target = realpathSync(absolute);
    const path = relative(root, target), parts = path.split(sep);
    if (!path || path.startsWith(`..${sep}`) || path === ".." || parts.some(part => !part || part.startsWith(".") || SECRET_PATH.test(part))
      || path.length > 256 || lstatSync(absolute).isSymbolicLink() || !lstatSync(target).isFile()) return null;
    return path.split(sep).join("/");
  } catch { return null; }
}

/** Classify bounded local tool metadata without loading Craft's service graph. */
export class HookSignalSanitizer {
  gap(input: HookInput): HookSignal | null {
    const tool = text(input.tool_name) ?? text(input.toolName);
    const command = nestedText(input.tool_input ?? input.toolInput, ["command", "cmd", "script"]);
    const toolId = text(input.tool_use_id) ?? text(input.toolUseId);
    if (tool !== "Bash" || !command || !isHookVerificationCommand(command) || this.signal(input)
      || !text(input.session_id) || !text(input.cwd) || !toolId) return null;
    const response = (input.tool_response ?? input.toolResponse ?? input.output) as Record<string, unknown> | undefined;
    const reason = response && (typeof response.backgroundTaskId === "string" || ["running", "in_progress", "pending"].includes(String(response.status)))
      ? "pending_background" : "unsupported_native_envelope";
    const identity = { tool, kind: "verification_gap", command_digest: digest(command), reason,
      tool_use_id: toolId };
    return { id: `codex_hook_signal_${digest(identity).slice(-20)}`, tool, kind: "verification_gap", outcome: "unknown",
      digest: digest(identity), verifier: digest(command), gap_reason: reason };
  }

  signal(input: HookInput): HookSignal | null {
    const tool = text(input.tool_name) ?? text(input.toolName) ?? nestedText(input.tool, ["name"]) ?? "unknown";
    const toolInput = (input.tool_input ?? input.toolInput ?? input.input) as unknown;
    const command = nestedText(toolInput, ["command", "cmd", "script"]);
    const response = input.tool_response ?? input.toolResponse ?? input.output;
    const outcome = verificationOutcome(response);
    const kind = /^(?:apply_patch|Edit|Write)$/iu.test(tool) || Boolean(command && EDIT.test(command)) ? "edit"
      : Boolean(command && outcome !== "unknown" && isHookVerificationCommand(command)) ? "verification" : "other";
    if (kind === "other") return null;
    const path = kind === "edit" ? observedProjectPath(nestedText(toolInput, ["file_path", "filePath", "path", "filename"]), input.cwd) : null;
    const stable = { tool, kind, outcome, command_digest: command ? digest(command) : null, path, tool_use_id: text(input.tool_use_id) ?? text(input.toolUseId) ?? randomUUID() };
    return { id: `codex_hook_signal_${digest(stable).slice(-20)}`, tool, kind, outcome, digest: digest(stable), verifier: command ? digest(command) : null, ...(path ? { observed_path: path } : {}) };
  }
}


export type HookHostReadiness = {
  authentication?: "available" | "unavailable" | "unknown";
  hook_trust?: "trusted" | "untrusted" | "unknown";
};
/** Missing Hook events never establish absent authentication or untrusted configuration. */
export function hookVerificationGap(journal: HookInput | null, readiness: HookHostReadiness = {}): HookInput {
  const authentication = readiness.authentication ?? "unknown", trust = readiness.hook_trust ?? "unknown";
  const signals = Array.isArray(journal?.signals) ? journal.signals as HookInput[] : [];
  const lastEdit = signals.findLastIndex(item => item.kind === "edit");
  const pending = new Map<unknown, unknown>();
  for (const signal of signals.slice(lastEdit + 1)) {
    if (signal.kind === "verification_gap") pending.set(signal.verifier, signal.gap_reason);
    else if (signal.kind === "verification") pending.delete(signal.verifier);
  }
  const reason = authentication === "unavailable" ? "host_auth_unavailable" : trust === "untrusted" ? "hook_untrusted"
    : journal?.verification_outcome === "passed" || journal?.verification_outcome === "failed" ? null
    : [...pending.values()].includes("pending_background") ? "pending_background"
    : pending.size ? "unsupported_native_envelope" : "verification_unobserved";
  return { reason, host_authentication: authentication, hook_trust: trust };
}
