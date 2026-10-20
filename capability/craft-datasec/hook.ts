import { extname } from "node:path";
import { DEFAULT_RULES, Sanitizer, type Json, type Rule } from "./rules.ts";
import { TokenVault } from "./vault.ts";

export type Host = "claude" | "codex";
export type Event = "PreToolUse" | "PostToolUse" | "UserPromptSubmit";
export interface HookInput { session_id?: string; hook_event_name?: string; tool_name?: string; tool_input?: Json; tool_response?: Json; prompt?: string }
export const FAILURE = "craft-datasec：本地脱敏失败，内容已隐藏。请检查本地规则和私有映射目录。";
const BINARY = /\.(?:xls[xmb]?|xlt[xm]|pdf|png|jpe?g|gif|webp|bmp|svg|ico|zip|gz|tar|7z|docx?|pptx?|mp[34]|wav)$/i;
const EDIT = /^(?:Edit|Write|MultiEdit|NotebookEdit|apply_patch)$/;
function denied(event: Event, reason: string): object {
  if (event === "PreToolUse") return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: reason } };
  return { decision: "block", reason };
}
export function hidden(host: Host, reason: string, replacement: Json): object {
  if (host === "claude") return { systemMessage: reason, hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: replacement } };
  // A blocking PostToolUse also withholds the raw result from a running code-mode script.
  // The sanitized result is the feedback, not an asynchronous review request.
  return { decision: "block", reason: JSON.stringify(replacement), systemMessage: reason };
}
export function blank(value: Json, depth = 0): Json {
  if (depth > 64) return null;
  if (typeof value === "string") return ["text", "image", "base64", "file", "resource", "tool_result"].includes(value) ? value : "";
  if (typeof value === "number") return 0;
  if (Array.isArray(value)) return value.map(item => blank(item, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item], index) => [/^[A-Za-z_$][\w$-]*$/.test(key) ? key : `hidden_${index}`, blank(item, depth + 1)]));
  return value;
}
function restore(value: Json, vault: TokenVault): Json {
  if (typeof value === "string") return vault.restore(value);
  if (Array.isArray(value)) return value.map(item => restore(item, vault));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [vault.restore(key), restore(item, vault)]));
  return value;
}
export function handleHook(host: Host, event: Event, input: HookInput, root: string, rules: readonly Rule[] = DEFAULT_RULES): object {
  let vault: TokenVault | undefined;
  const getVault = () => vault ??= new TokenVault(root, input.session_id ?? "");
  const apply = (): object => {
    if (input.hook_event_name !== event) throw new Error("Mismatched hook event");
    const sanitizer = new Sanitizer(rules, (name, text) => event === "UserPromptSubmit" ? "[redacted]" : getVault().token(name, text));
    if (event === "UserPromptSubmit") {
      sanitizer.text(input.prompt ?? "");
      if (sanitizer.count) return denied(event, "craft-datasec：输入含敏感数据，已阻止发送。请先在本地替换敏感值后重发。普通 hook 无法改写原提示词。");
      return {};
    }
    if (event === "PreToolUse") {
      const args = input.tool_input ?? {};
      const name = input.tool_name ?? "";
      if (name === "Read" && typeof args === "object" && args !== null && !Array.isArray(args) && typeof args.file_path === "string" && BINARY.test(extname(args.file_path))) {
        return denied(event, "craft-datasec：此文件不是受支持的纯文本，请先在本地导出纯文本并脱敏。");
      }
      if (!JSON.stringify(args).includes("[CRAFT_DATASEC_")) return {};
      if (!EDIT.test(name)) return denied(event, "craft-datasec：占位符只允许在本地文件编辑工具中还原，不能自动用于命令或远程调用。");
      return { hookSpecificOutput: { hookEventName: event, permissionDecision: "allow", updatedInput: restore(args, getVault()) } };
    }
    if (input.tool_response === undefined) throw new Error("Missing tool result");
    const safe = sanitizer.value(input.tool_response);
    if (!sanitizer.count) return {};
    getVault().flush();
    return hidden(host, `craft-datasec：已在本地脱敏 ${sanitizer.count} 处内容。`, safe);
  };
  let output: object;
  try { output = apply(); }
  catch {
    if (event === "PostToolUse") {
      // Preserve tool schema keys when possible. Never include exception text or the event payload.
      const replacement = input.tool_response ?? null;
      output = { ...hidden(host, FAILURE, blankResult(replacement)), continue: false, stopReason: FAILURE };
    } else {
      output = denied(event, FAILURE);
    }
  }
  vault?.close();
  return output;
}
export function blankResult(value: Json): Json {
  return blank(value);
}
