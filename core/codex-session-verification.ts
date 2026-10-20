import { stableDigest } from "./digest.ts";
import type { JsonObject } from "./infrastructure/store.ts";

export interface CodexTaskTranscriptRecord {
  readonly record_type: string;
  readonly payload: JsonObject;
}

const MAX_COMMAND_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 1_000_000;

function testRunner(commandValue: unknown): string | null {
  if (typeof commandValue !== "string" || !commandValue.trim() || commandValue.length > MAX_COMMAND_CHARS
    || /[\r\n\0`$;|<>]/u.test(commandValue)) return null;
  let command = commandValue.trim();
  const directoryChange = /^cd\s+(?:"[^"\r\n]+"|'[^'\r\n]+'|[^\s;&|]+)\s*&&\s*/u.exec(command);
  if (directoryChange) command = command.slice(directoryChange[0].length).trim();
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

/** Extract only digest-pinned success facts from paired Codex exec calls and outputs. */
export function extractCodexSessionVerificationArtifacts(records: readonly CodexTaskTranscriptRecord[]): JsonObject[] {
  const calls = new Map<string, { runner: string; command_digest: string }>();
  const outputs = new Map<string, string>();
  for (const record of records) {
    if (record.record_type !== "response_item") continue;
    const payload = record.payload;
    const callId = payload.call_id;
    if (typeof callId !== "string" || !callId.trim() || callId.length > 160) continue;
    if (payload.type === "custom_tool_call" && payload.name === "exec") {
      const runner = testRunner(payload.input);
      if (runner) calls.set(callId, { runner, command_digest: stableDigest(payload.input) });
    } else if (payload.type === "custom_tool_call_output") {
      const text = outputText(payload.output);
      if (text) outputs.set(callId, text);
    }
  }
  const artifacts: JsonObject[] = [];
  for (const [callId, call] of calls) {
    const output = outputs.get(callId);
    if (!output || !/Process exited with code 0\s*$/imu.test(output) || !successfulSummary(call.runner, output)) continue;
    artifacts.push({ runner: call.runner, command_digest: call.command_digest, result_digest: stableDigest(output),
      call_digest: stableDigest(callId), exit_code: 0, summary_kind: "tests_passed", content_stored: false });
    if (artifacts.length === 8) break;
  }
  return artifacts;
}
