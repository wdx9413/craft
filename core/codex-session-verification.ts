import { stableDigest } from "./digest.ts";
import type { JsonObject } from "./infrastructure/store.ts";

export interface CodexTaskTranscriptRecord {
  readonly record_type: string;
  readonly payload: JsonObject;
}

const MAX_COMMAND_CHARS = 16_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const MAX_CUSTOM_CALL_IDS = 4096;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RUNNERS = ["javascript", "python", "go", "rust", "java-maven", "java-gradle", "dotnet"];

export interface CodexVerificationCollectorState {
  calls: Array<[string, { runner: string; command_digest: string }]>;
  outputs: Array<[string, { digest: string; passed: string[] }]>;
  seen_calls: string[]; seen_outputs: string[]; ambiguous: string[];
  structured_calls: Array<[string, string]>; artifacts: JsonObject[];
  custom_overflow: boolean; structured_conflict: boolean; structured_overflow: boolean;
}

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
  if (runner === "go") {
    let passedInPackage = false;
    for (const line of output.split("\n")) {
      if (/^--- PASS:\s+\S+/u.test(line)) passedInPackage = true;
      if (/^ok\s+\S+/u.test(line)) {
        if (passedInPackage && !/\(cached\)|\[no tests to run\]/u.test(line)) return true;
        passedInPackage = false;
      }
    }
    const passingTests = new Set<string>();
    const passingPackages = new Set<string>();
    const excludedPackages = new Set<string>();
    for (const line of output.split("\n")) {
      if (!line.startsWith("{")) continue;
      let entry: JsonObject;
      try { entry = JSON.parse(line) as JsonObject; } catch { continue; }
      if (typeof entry.Package === "string" && typeof entry.Output === "string" && /\(cached\)|\[no tests to run\]/u.test(entry.Output)) excludedPackages.add(entry.Package);
      if (entry.Action !== "pass" || typeof entry.Package !== "string" || !entry.Package) continue;
      if (typeof entry.Test === "string" && entry.Test) passingTests.add(entry.Package);
      else if (entry.Test === undefined) passingPackages.add(entry.Package);
    }
    return [...passingTests].some(packageName => passingPackages.has(packageName) && !excludedPackages.has(packageName));
  }
  if (runner === "rust") return /test result:\s*ok\.\s*[1-9]\d*\s+passed\b/iu.test(output);
  if (runner === "java-maven") return [...output.matchAll(/Tests run:\s*([1-9]\d*)\s*,\s*Failures:\s*0\s*,\s*Errors:\s*0(?:\s*,\s*Skipped:\s*(\d+))?/giu)]
    .some(match => Number(match[1]) > Number(match[2] ?? 0));
  if (runner === "java-gradle") return /BUILD SUCCESSFUL/u.test(output)
    && [...output.matchAll(/\b([1-9]\d*) tests? completed(?:,\s*(\d+) skipped)?/giu)]
      .some(match => Number(match[1]) > Number(match[2] ?? 0));
  if (runner === "dotnet") return /Passed:\s*[1-9]\d*/iu.test(output);
  if (runner === "python") return /\b[1-9]\d*\s+passed\b/iu.test(output);
  return /(?:\bTests?\s+[1-9]\d*\s+passed\b|^#\s*pass\s+[1-9]\d*\s*$)/imu.test(output);
}

function artifact(runner: string, command: string, output: string, callId: string): JsonObject | null {
  if (!successfulSummary(runner, output)) return null;
  return { runner, command_digest: stableDigest(command), result_digest: stableDigest(output),
    call_digest: stableDigest(callId), exit_code: 0, summary_kind: "tests_passed", content_stored: false };
}

/** Extract only digest-pinned success facts from exact Codex command completion records. */
export function createCodexSessionVerificationCollector(saved?: CodexVerificationCollectorState) {
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
  if (saved) {
    const pairs = (value: unknown): value is Array<[string, unknown]> => Array.isArray(value) && value.length <= MAX_CUSTOM_CALL_IDS
      && value.every(item => Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && DIGEST.test(item[0]));
    const ids = (value: unknown): value is string[] => Array.isArray(value) && value.length <= MAX_CUSTOM_CALL_IDS && value.every(item => typeof item === "string" && DIGEST.test(item));
    if (Object.keys(saved).length !== 10 || !pairs(saved.calls) || !saved.calls.every(([, v]) => v && typeof v === "object" && Object.keys(v).length === 2
      && RUNNERS.includes(v.runner) && typeof v.command_digest === "string" && DIGEST.test(v.command_digest))
      || !pairs(saved.outputs) || !saved.outputs.every(([, v]) => v && typeof v === "object" && Object.keys(v).length === 2
        && typeof v.digest === "string" && DIGEST.test(v.digest) && Array.isArray(v.passed) && v.passed.length <= RUNNERS.length && v.passed.every(runner => RUNNERS.includes(runner)))
      || !ids(saved.seen_calls) || !ids(saved.seen_outputs) || !ids(saved.ambiguous)
      || !pairs(saved.structured_calls) || !saved.structured_calls.every(([, digest]) => typeof digest === "string" && DIGEST.test(digest))
      || !Array.isArray(saved.artifacts) || saved.artifacts.length > 8 || !saved.artifacts.every(item => item && RUNNERS.includes(String(item.runner))
        && [item.command_digest, item.result_digest, item.call_digest].every(value => typeof value === "string" && DIGEST.test(value))
        && item.exit_code === 0 && item.summary_kind === "tests_passed" && item.content_stored === false && Object.keys(item).length === 7)
      || typeof saved.custom_overflow !== "boolean" || typeof saved.structured_conflict !== "boolean" || typeof saved.structured_overflow !== "boolean") throw new Error("Codex verification collector state is invalid");
    for (const [key, value] of saved.calls) calls.set(key, value);
    for (const [key, value] of saved.outputs) outputs.set(key, value);
    for (const key of saved.seen_calls) seenCalls.add(key);
    for (const key of saved.seen_outputs) seenOutputs.add(key);
    for (const key of saved.ambiguous) ambiguous.add(key);
    for (const [key, value] of saved.structured_calls) structuredCalls.set(key, value);
    artifacts.push(...saved.artifacts);
    customOverflow = saved.custom_overflow; structuredConflict = saved.structured_conflict; structuredOverflow = saved.structured_overflow;
  }
  function add(record: CodexTaskTranscriptRecord): void {
    if (record.record_type === "event_msg" && record.payload.type === "item_completed") {
      const item = record.payload.item;
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const commandItem = item as JsonObject;
        if (commandItem.type === "CommandExecution") {
          if (typeof commandItem.id === "string" && commandItem.id.length > 0 && commandItem.id.length <= 160) {
            const digest = stableDigest(commandItem);
            const structuredId = stableDigest(commandItem.id);
            const previous = structuredCalls.get(structuredId);
            if (previous !== undefined && previous !== digest) structuredConflict = true;
            if (previous === undefined && structuredCalls.size >= MAX_CUSTOM_CALL_IDS) structuredOverflow = true;
            else if (previous === undefined) structuredCalls.set(structuredId, digest);
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
    const rawCallId = payload.call_id;
    if (typeof rawCallId !== "string" || !rawCallId.trim() || rawCallId.length > 160) return;
    const callId = stableDigest(rawCallId);
    const isCall = payload.type === "custom_tool_call" || payload.type === "function_call";
    const isOutput = payload.type === "custom_tool_call_output" || payload.type === "function_call_output";
    if ((isCall && !seenCalls.has(callId) && seenCalls.size >= MAX_CUSTOM_CALL_IDS)
      || (isOutput && !seenOutputs.has(callId) && seenOutputs.size >= MAX_CUSTOM_CALL_IDS)) {
      customOverflow = true;
      calls.clear(); outputs.clear(); seenCalls.clear(); seenOutputs.clear(); ambiguous.clear();
      return;
    }
    if (isCall) {
      if (seenCalls.has(callId)) { ambiguous.add(callId); return; }
      seenCalls.add(callId);
      let command: unknown = payload.input;
      if (payload.type === "function_call") {
        if (payload.name !== "exec_command" || typeof payload.arguments !== "string" || payload.arguments.length > MAX_COMMAND_CHARS * 2) return;
        try { const args: unknown = JSON.parse(payload.arguments);
          if (!args || typeof args !== "object" || Array.isArray(args)) return;
          command = (args as JsonObject).cmd;
        } catch { return; }
      } else if (payload.name !== "exec") return;
      const runner = testRunner(command);
      if (runner) calls.set(callId, { runner, command_digest: stableDigest(command) });
    } else if (isOutput) {
      if (seenOutputs.has(callId)) { ambiguous.add(callId); return; }
      seenOutputs.add(callId);
      const text = outputText(payload.output);
      if (text) {
        const exitCodes = [...text.matchAll(/^Process exited with code (\d+)\s*$/gimu)];
        const stillRunning = /^(?:Process running with session ID|Script running with cell ID|Session ID:)\s*\S+/imu.test(text);
        outputs.set(callId, { digest: stableDigest(text), passed: !stillRunning && exitCodes.length === 1 && exitCodes[0]![1] === "0"
          ? ["javascript", "python", "go", "rust", "java-maven", "java-gradle", "dotnet"].filter(runner => successfulSummary(runner, text)) : [] });
      }
    }
  }
  function finish(): JsonObject[] {
    if (structuredConflict || structuredOverflow) return [];
    for (const [callId, call] of calls) {
      if (artifacts.length >= 8) break;
      if (ambiguous.has(callId)) continue;
      const output = outputs.get(callId);
      if (!output || !output.passed.includes(call.runner)) continue;
      if (artifacts.some(existing => existing.call_digest === callId)) continue;
      artifacts.push({ runner: call.runner, command_digest: call.command_digest, result_digest: output.digest,
        call_digest: callId, exit_code: 0, summary_kind: "tests_passed", content_stored: false });
      if (artifacts.length === 8) break;
    }
    return artifacts;
  }
  const snapshot = (): CodexVerificationCollectorState => ({ calls: [...calls], outputs: [...outputs], seen_calls: [...seenCalls], seen_outputs: [...seenOutputs], ambiguous: [...ambiguous], structured_calls: [...structuredCalls], artifacts: [...artifacts], custom_overflow: customOverflow, structured_conflict: structuredConflict, structured_overflow: structuredOverflow });
  return { add, finish, snapshot, customCallsOverflowed: () => customOverflow,
    structuredCallsConflicted: () => structuredConflict, structuredCallsOverflowed: () => structuredOverflow };
}

export function extractCodexSessionVerificationArtifacts(records: readonly CodexTaskTranscriptRecord[]): JsonObject[] {
  const collector = createCodexSessionVerificationCollector();
  for (const record of records) collector.add(record);
  return collector.finish();
}
