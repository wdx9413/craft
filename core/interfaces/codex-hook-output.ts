/** Convert the internal Hook result to Codex's event-specific stdout schema. */
export function formatCodexHookOutput(event: string, output: Record<string, unknown>): Record<string, unknown> {
  if (event !== "UserPromptSubmit" || typeof output.additionalContext !== "string") return output;
  const { additionalContext, ...rest } = output;
  const priorSpecific = rest.hookSpecificOutput;
  const specific = priorSpecific && typeof priorSpecific === "object" && !Array.isArray(priorSpecific)
    ? priorSpecific as Record<string, unknown>
    : {};
  return {
    ...rest,
    hookSpecificOutput: { ...specific, hookEventName: "UserPromptSubmit", additionalContext },
  };
}
