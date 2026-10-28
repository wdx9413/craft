import { stableDigest } from "./digest.ts";
import type { JsonObject } from "./infrastructure/store.ts";

export interface CodexTaskTranscriptRecord {
  readonly record_type: string;
  readonly payload: JsonObject;
}

const MAX_COMMAND_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_CUSTOM_CALL_IDS = 4096;

function commandScript(commandValue: unknown): string | null {
  if (typeof commandValue === "string") return commandValue;
  if (!Array.isArray(commandValue) || commandValue.length !== 3
    || !["/bin/zsh", "/usr/bin/zsh", "/bin/bash", "/usr/bin/bash", "zsh", "bash"].includes(String(commandValue[0]))
    || commandValue[1] !== "-lc" || typeof commandValue[2] !== "string") return null;
  return commandValue[2];
}

function testRunner(commandValue: unknown): string | null {
  const commandInput = commandScript(commandValue);
  if (!commandInput || !commandInput.trim() || commandInput.length > MAX_COMMAND_CHARS
    || /[\r\n\0`$;|<>]/u.test(commandInput)) return null;
  let command = commandInput.trim();
  const directoryChange = /^cd\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|]+)\s*&&\s*/u.exec(command);
  if (directoryChange) command = command.slice(directoryChange[0].length).trim();
  if (/[;&|<>`$]/u.test(command)) return null;
  const patterns: ReadonlyArray<[string, RegExp]> = [
    ["javascript", /^(?:(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+test(?::[a-z0-9:_-]+)?|(?:pnpm|npx|yarn|bun)\s+(?:exec\s+)?(?:vitest|jest)(?:\s+run)?)\b/iu],
    ["javascript", /^node\s+--test\b/iu],
    ["python", /^(?:pytest|python\d*(?:\.\d+)?\s+-m\s+pytest)\b/iu],
    ["go", /^go\s+test\b/iu],
    ["rust", /^cargo\s+test\b/iu],
    ["java-maven", /^mvn(?:w)?\b[^\r\n]*\btest\b/iu],
    ["java-gradle", /^(?:\.\/)?(?:gradle|gradlew)\b[^\r\n]*\btest\b/iu],
    ["dotnet", /^dotnet\s+test\b/iu],
  ];
  return patterns.find(([, pattern]) => pattern.test(command))?.[0] ?? null;
}

function outputText(value: unknown): string | null {
  if (typeof value === "string") return value.slice(0, MAX_OUTPUT_CHARS);
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  let size = 0;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const text = (item as JsonObject).text;
    if (typeof text !== "string" || !text) continue;
    const remaining = MAX_OUTPUT_CHARS - size;
    if (remaining <= 0) break;
    parts.push(text.slice(0, remaining));
    size += Math.min(text.length, remaining);
  }
  return parts.length ? parts.join("\n") : null;
}

function successfulSummary(runner: string, output: string): boolean {
  if (/\b[1-9]\d*\s+(?:failed|failures?|errors?)\b|(?:Failures|Errors):\s*[1-9]\d*/iu.test(output)) return false;
  if (runner === "go") return /^ok\s+\S+/mu.test(output);
  if (runner === "rust") return /test result:\s*ok\.\s*[1-9]\d*\s+passed\b/iu.test(output);
  if (runner === "java-maven") return /Tests run:\s*[1-9]\d*\s*,\s*Failures:\s*0\s*,\s*Errors:\s*0/iu.test(output);
  if (runner === "java-gradle") return /> Task :[^\r\n]*test[^\r\n]*\r?\n[\s\S]*BUILD SUCCESSFUL/iu.test(output);
  if (runner === "dotnet") return /Passed:\s*[1-9]\d*/iu.test(output);
  if (runner === "python") return /\b[1-9]\d*\s+passed\b/iu.test(output);
  return /(?:\bTests?\s+[1-9]\d*\s+passed\b|\bTest Files\s+[1-9]\d*\s+passed\b|^#\s*pass\s+[1-9]\d*\s*$)/imu.test(output);
}

function artifact(runner: string, command: string, output: string, callId: string): JsonObject | null {
  if (!successfulSummary(runner, output)) return null;
  return { runner, command_digest: stableDigest(command), result_digest: stableDigest(output),
    call_digest: stableDigest(callId), exit_code: 0, summary_kind: "tests_passed", content_stored: false };
}

/** Extract only digest-pinned success facts from exact Codex command completion records. */
export function createCodexSessionVerificationCollector() {
  const calls = new Map<string, { runner: string; command_digest: string }>();
  const outputs = new Map<string, { digest: string; passed: string[] }>();
  const seenCalls = new Set<string>();
  const seenOutputs = new Set<string>();
  const ambiguous = new Set<string>();
  const structuredCalls = new Map<string, string>();
  const artifacts: JsonObject[] = [];
  let customOverflow = false;
  let structuredConflict = false;
  let structuredOverflow = false;
  function add(record: CodexTaskTranscriptRecord): void {
    if (record.record_type === "event_msg" && record.payload.type === "item_completed") {
      const item = record.payload.item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const commandItem = item as JsonObject;
        if (commandItem.type === "CommandExecution") {
          if (typeof commandItem.id === "string" && commandItem.id.length > 0 && commandItem.id.length <= 160) {
            const digest = stableDigest(commandItem);
            const previous = structuredCalls.get(commandItem.id);
            if (previous !== undefined && previous !== digest) structuredConflict = true;
            if (previous === undefined && structuredCalls.size >= MAX_CUSTOM_CALL_IDS) structuredOverflow = true;
            else if (previous === undefined) structuredCalls.set(commandItem.id, digest);
          }
          const command = commandItem.command;
          const script = commandScript(command);
          const runner = testRunner(command);
          const output = outputText(commandItem.aggregated_output);
          const exitCode = commandItem.exit_code;
          const callId = commandItem.id;
          if (runner && script && commandItem.status === "completed" && exitCode === 0 && output) {
            const itemArtifact = artifact(runner, script, output, typeof callId === "string" ? callId : stableDigest({ command, output }));
            if (itemArtifact && artifacts.length < 8 && !artifacts.some(existing => existing.call_digest === itemArtifact.call_digest)) artifacts.push(itemArtifact);
          }
        }
      }
      return;
    }
    if (record.record_type !== "response_item") return;
    if (customOverflow) return;
    const payload = record.payload;
    const callId = payload.call_id;
    if (typeof callId !== "string" || !callId.trim() || callId.length > 160) return;
    if ((payload.type === "custom_tool_call" && !seenCalls.has(callId) && seenCalls.size >= MAX_CUSTOM_CALL_IDS)
      || (payload.type === "custom_tool_call_output" && !seenOutputs.has(callId) && seenOutputs.size >= MAX_CUSTOM_CALL_IDS)) {
      customOverflow = true;
      calls.clear(); outputs.clear(); seenCalls.clear(); seenOutputs.clear(); ambiguous.clear();
      return;
    }
    if (payload.type === "custom_tool_call") {
      if (seenCalls.has(callId)) { ambiguous.add(callId); return; }
      seenCalls.add(callId);
      if (payload.name !== "exec") return;
      const runner = testRunner(payload.input);
      if (runner) calls.set(callId, { runner, command_digest: stableDigest(payload.input) });
    } else if (payload.type === "custom_tool_call_output") {
      if (seenOutputs.has(callId)) { ambiguous.add(callId); return; }
      seenOutputs.add(callId);
      const text = outputText(payload.output);
      if (text) outputs.set(callId, { digest: stableDigest(text), passed: /Process exited with code 0\s*$/imu.test(text)
        ? ["javascript", "python", "go", "rust", "java-maven", "java-gradle", "dotnet"].filter(runner => successfulSummary(runner, text)) : [] });
    }
  }
  function finish(): JsonObject[] {
    if (structuredConflict || structuredOverflow) return [];
    for (const [callId, call] of calls) {
      if (artifacts.length >= 8) break;
      if (ambiguous.has(callId)) continue;
      const output = outputs.get(callId);
      if (!output || !output.passed.includes(call.runner)) continue;
      if (artifacts.some(existing => existing.call_digest === stableDigest(callId))) continue;
      artifacts.push({ runner: call.runner, command_digest: call.command_digest, result_digest: output.digest,
        call_digest: stableDigest(callId), exit_code: 0, summary_kind: "tests_passed", content_stored: false });
      if (artifacts.length === 8) break;
    }
    return artifacts;
  }
  return { add, finish, customCallsOverflowed: () => customOverflow,
    structuredCallsConflicted: () => structuredConflict, structuredCallsOverflowed: () => structuredOverflow };
}

export function extractCodexSessionVerificationArtifacts(records: readonly CodexTaskTranscriptRecord[]): JsonObject[] {
  const collector = createCodexSessionVerificationCollector();
  for (const record of records) collector.add(record);
  return collector.finish();
}
