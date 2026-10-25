import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export type HookSignal = {
  readonly id: string;
  readonly tool: string;
  readonly kind: "edit" | "verification" | "other";
  readonly outcome: "passed" | "failed" | "unknown";
  readonly digest: string;
  readonly verifier: string | null;
  readonly scenario_key?: string;
  readonly coarse_scenario_key?: string;
  readonly observed_path?: string;
};

type HookInput = Record<string, unknown>;

const SECRET_PATH = /(?:secret|token|credential|password|private|\.env)/iu;
const SECRET_ASSIGNMENT = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;
const VERIFY = /^(?:(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?|pytest|(?:python3?\s+-m\s+pytest)|(?:mvn|gradle|gradlew|\.\/gradlew)\s+(?:test|verify)|go\s+test|cargo\s+test|node\s+--test)(?:\s|$)/u;
const EDIT = /(?:^|[;&|\s])(?:apply_patch|git\s+apply|sed\s+-i|perl\s+-pi)\b/iu;

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

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function observedProjectPath(value: unknown, projectRoot: unknown): string | null {
  if (typeof value !== "string" || typeof projectRoot !== "string" || !value.trim() || value.length > 512 || value.includes("\\") || value.includes("\0")) return null;
  try {
    const root = realpathSync(projectRoot), absolute = resolve(root, value.trim()), target = realpathSync(absolute);
    const path = relative(root, target), parts = path.split(sep);
    if (!path || path.startsWith(`..${sep}`) || path === ".." || resolve(target) !== absolute || parts.some(part => !part || part.startsWith(".") || SECRET_PATH.test(part))
      || path.length > 256 || lstatSync(absolute).isSymbolicLink() || !lstatSync(target).isFile()) return null;
    return path.split(sep).join("/");
  } catch { return null; }
}

/** Classify bounded local tool metadata without loading Craft's service graph. */
export class HookSignalSanitizer {
  signal(input: HookInput): HookSignal | null {
    const tool = text(input.tool_name) ?? text(input.toolName) ?? nestedText(input.tool, ["name"]) ?? "unknown";
    const toolInput = (input.tool_input ?? input.toolInput ?? input.input) as unknown;
    const command = nestedText(toolInput, ["command", "cmd", "script"]);
    const rawOutcome = nestedText(input.tool_response ?? input.toolResponse ?? input.output, ["exit_code", "exitCode", "status"]);
    const outcome = rawOutcome === "0" || rawOutcome === "success" || rawOutcome === "passed" ? "passed"
      : rawOutcome && (/^[1-9]\d*$/u.test(rawOutcome) || rawOutcome === "failed" || rawOutcome === "error") ? "failed" : "unknown";
    const kind = /^(?:apply_patch|Edit|Write)$/iu.test(tool) || Boolean(command && EDIT.test(command)) ? "edit"
      : Boolean(command && VERIFY.test(command.trim()) && !/[;&|`$\n]/u.test(command)) ? "verification" : "other";
    if (kind === "other") return null;
    const path = kind === "edit" ? observedProjectPath(nestedText(toolInput, ["file_path", "filePath", "path", "filename"]), input.cwd) : null;
    const stable = { tool, kind, outcome, command_digest: command ? digest(command) : null, path, tool_use_id: text(input.tool_use_id) ?? text(input.toolUseId) ?? randomUUID() };
    return { id: `codex_hook_signal_${digest(stable).slice(-20)}`, tool, kind, outcome, digest: digest(stable), verifier: command ? digest(command) : null, ...(path ? { observed_path: path } : {}) };
  }
}
