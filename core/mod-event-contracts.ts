import type { JsonObject } from "./infrastructure/store.ts";

export type ModEventContract = {
  event: string;
  hosts: readonly string[];
  platforms: readonly string[];
  input_fields: readonly string[];
  patch_fields: readonly string[];
  capabilities: readonly string[];
  failure_policy: "fail_closed" | "fail_open";
  scope: "invocation_scope";
  ordering: "declared_order_then_mod_id";
  timeout_max_ms: 30_000;
  reentrant: false;
};

const SUPPORTED_PLATFORMS = ["darwin", "linux", "win32"] as const;

const contractDefinitions = [
  { event: "craft.input.receive@1", hosts: ["codex"], input_fields: ["text", "session_id", "task_id"], patch_fields: [], capabilities: ["event.observe"], failure_policy: "fail_open", reentrant: false },
  { event: "craft.input.submit@1", hosts: ["codex"], input_fields: ["text", "session_id", "task_id"], patch_fields: ["text"], capabilities: ["event.observe", "event.patch", "event.reject"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.context.assemble@1", hosts: ["codex"], input_fields: ["query", "scope_kind", "scope_id", "session_id", "task_id"], patch_fields: ["query", "context_additions"], capabilities: ["event.observe", "event.patch"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.model.request@1", hosts: ["workbench"], input_fields: ["provider", "model", "messages", "task_id"], patch_fields: ["messages"], capabilities: ["event.observe", "event.patch"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.model.response@1", hosts: ["workbench"], input_fields: ["provider", "model", "content", "task_id"], patch_fields: ["content"], capabilities: ["event.observe", "event.patch"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.tool.call@1", hosts: ["workbench", "craft-runtime"], input_fields: ["tool", "arguments", "task_id", "session_id"], patch_fields: ["arguments"], capabilities: ["event.observe", "event.patch", "event.reject", "event.takeover"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.tool.result@1", hosts: ["workbench", "craft-runtime"], input_fields: ["tool", "result", "task_id", "session_id"], patch_fields: ["result"], capabilities: ["event.observe", "event.patch"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.task.lifecycle@1", hosts: ["workbench"], input_fields: ["task_id", "task_run_id", "delivery_id", "status", "action", "scope_kind", "scope_id"], patch_fields: [], capabilities: ["event.observe"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.session.lifecycle@1", hosts: ["codex"], input_fields: ["session_id", "status", "scope_kind", "scope_id"], patch_fields: [], capabilities: ["event.observe"], failure_policy: "fail_open", reentrant: false },
  { event: "craft.asset.lifecycle@1", hosts: ["craft-runtime"], input_fields: ["asset_id", "kind", "status", "scope_kind", "scope_id"], patch_fields: [], capabilities: ["event.observe"], failure_policy: "fail_open", reentrant: false },
  { event: "craft.channel.receive@1", hosts: ["workbench"], input_fields: ["channel", "content", "session_id", "task_id"], patch_fields: ["content"], capabilities: ["event.observe", "event.patch", "event.reject"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.channel.send@1", hosts: ["workbench"], input_fields: ["channel", "content", "session_id", "task_id"], patch_fields: ["content"], capabilities: ["event.observe", "event.patch", "event.reject"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.approval.decide@1", hosts: ["craft-runtime", "workbench"], input_fields: ["action", "effect", "input_digest"], patch_fields: [], capabilities: ["approval.strategy"], failure_policy: "fail_closed", reentrant: false },
  { event: "craft.ui.interaction@1", hosts: ["workbench"], input_fields: ["contribution_id", "action_id", "workspace_id", "task_id"], patch_fields: [], capabilities: ["event.observe"], failure_policy: "fail_closed", reentrant: false },
] as const;
const contracts: readonly ModEventContract[] = contractDefinitions.map((contract) => ({
  ...contract, platforms: SUPPORTED_PLATFORMS, scope: "invocation_scope", ordering: "declared_order_then_mod_id", timeout_max_ms: 30_000,
}));

export function modEventContract(event: string): ModEventContract | null {
  return contracts.find((item) => item.event === event) ?? null;
}

export function modEventCatalog(host?: string, platform?: string): JsonObject {
  const selected = contracts.filter((item) => (host === undefined || item.hosts.includes(host))
    && (platform === undefined || item.platforms.includes(platform)));
  return { events: selected.map((item) => ({ ...item, hosts: [...item.hosts], platforms: [...item.platforms], input_fields: [...item.input_fields], patch_fields: [...item.patch_fields], capabilities: [...item.capabilities] })) };
}
