import assert from "node:assert/strict";
import test from "node:test";
import { digestJson } from "../core/digest.ts";
import { resolveWorkbenchApprovalPrompt } from "../core/workbench-approval.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

function fixture(task: JsonObject = { id: "task-1", goal: "edit safely", version: 3 }, dispatch: JsonObject = {}) {
  const launch: JsonObject = { id: "launch-1", task_id: "task-1", dispatch_id: "dispatch-1", dispatch_kind: "codex_dispatch",
    workspace: "/workspace", sandbox: "workspace-write", prompt_digest: digestJson("edit safely") };
  const savedDispatch: JsonObject = { id: "dispatch-1", task_id: "task-1", task_version: 3, workspace: "/workspace",
    sandbox: "workspace-write", prompt_digest: digestJson("edit safely"), ...dispatch };
  const store = { get: (kind: string, id: string) => {
    if (kind === "task" && id === "task-1") return task;
    if (kind === "codex_dispatch" && id === "dispatch-1") return savedDispatch;
    throw new Error(`missing ${kind}/${id}`);
  } };
  return { launch, store, task, dispatch: savedDispatch };
}

test("approval prompt comes from the exact task goal and bound saved dispatch", () => {
  const f = fixture();
  assert.equal(resolveWorkbenchApprovalPrompt(f.store, f.launch, "codex_dispatch"), "edit safely");
});

test("approval prompt fails closed for empty or changed task goals", () => {
  const missing = fixture({ id: "task-1", version: 3 });
  assert.throws(() => resolveWorkbenchApprovalPrompt(missing.store, missing.launch, "codex_dispatch"), /goal no longer matches/u);
  assert.throws(() => resolveWorkbenchApprovalPrompt(fixture({ id: "task-1", goal: "", version: 3 }).store,
    fixture().launch, "codex_dispatch"), /goal no longer matches/u);
  const changed = fixture({ id: "task-1", goal: "changed", version: 3 });
  assert.throws(() => resolveWorkbenchApprovalPrompt(changed.store, changed.launch, "codex_dispatch"), /goal no longer matches/u);
});

test("approval prompt fails closed when dispatch kind or identity changes", () => {
  const wrongKind = fixture();
  assert.throws(() => resolveWorkbenchApprovalPrompt(wrongKind.store, wrongKind.launch, "claude_dispatch"), /dispatch identity changed/u);
  for (const [field, value] of [
    ["id", "other-dispatch"], ["task_id", "other-task"], ["task_version", 4], ["workspace", "/elsewhere"],
    ["sandbox", "read-only"], ["prompt_digest", "sha256:other"],
  ] as const) {
    const drift = fixture(undefined, { [field]: value });
    assert.throws(() => resolveWorkbenchApprovalPrompt(drift.store, drift.launch, "codex_dispatch"), /dispatch identity changed/u, field);
  }
});
