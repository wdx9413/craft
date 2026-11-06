export const EXECUTION_HOST_MODES = ["embedded", "managed", "remote"] as const;
export type ExecutionHostMode = typeof EXECUTION_HOST_MODES[number];

export interface ExecutionHostDescriptor {
  id: string;
  mode: ExecutionHostMode;
  executesOutsideCraft: boolean;
  startsChildProcess: boolean;
  receiptRequired: true;
}

/**
 * Describes who performs an Action Contract. The embedded bridge represents
 * the already-running Codex, Claude, or IDE host; it never starts a second CLI.
 */
export function executionHostDescriptor(id: string, mode: ExecutionHostMode): ExecutionHostDescriptor {
  if (!id.trim()) throw new Error("Execution Host id must not be empty");
  return {
    id: id.trim(),
    mode,
    executesOutsideCraft: true,
    startsChildProcess: mode === "managed",
    receiptRequired: true,
  };
}

export function assertExecutionHostMode(value: string): ExecutionHostMode {
  if (!(EXECUTION_HOST_MODES as readonly string[]).includes(value)) throw new Error(`Unsupported Execution Host mode: ${value}`);
  return value as ExecutionHostMode;
}

export function defaultExecutionHostMode(id: string): ExecutionHostMode {
  const normalized = id.trim().toLowerCase();
  if (normalized.endsWith("-cli") || normalized === "local-worker") return "managed";
  if (normalized.startsWith("a2a:") || normalized.startsWith("remote:")) return "remote";
  return "embedded";
}
