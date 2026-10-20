import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { blankResult, FAILURE, handleHook, hidden, type Event, type HookInput, type Host } from "../capability/craft-datasec/hook.ts";
import { DEFAULT_RULES, type Rule } from "../capability/craft-datasec/rules.ts";

const [host, event] = process.argv.slice(2) as [Host, Event];
if (!["claude", "codex"].includes(host) || !["PreToolUse", "PostToolUse", "UserPromptSubmit"].includes(event)) {
  process.stderr.write("craft-datasec: expected <claude|codex> <PreToolUse|PostToolUse|UserPromptSubmit>\n");
  process.exitCode = 2;
} else {
  let input: HookInput = {};
  try {
    const raw = readFileSync(0, "utf8");
    input = JSON.parse(raw) as HookInput;
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid event");
    const config = process.env.CRAFT_DATASEC_RULES;
    const rules = config ? JSON.parse(readFileSync(config, "utf8")) as Rule[] : DEFAULT_RULES;
    const root = process.env.CRAFT_DATASEC_DIR ?? join(homedir(), ".craft-datasec");
    process.stdout.write(JSON.stringify(handleHook(host, event, input, root, rules)) + "\n");
  } catch {
    const fallback = event === "PostToolUse" ? hidden(host, FAILURE, blankResult(input?.tool_response ?? null))
      : handleHook(host, event, {}, "", []);
    process.stdout.write(JSON.stringify(fallback) + "\n");
  }
}
