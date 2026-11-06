import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { WindowsDesktopAutomationKernel } from "../core/windows-desktop-automation.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-windows-uia-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, desktop: new WindowsDesktopAutomationKernel(store) };
}
const application = (desktop: WindowsDesktopAutomationKernel, over: Record<string, unknown> = {}) => desktop.registerApplication({ application_id: "notepad", executable: "notepad.exe", allowed_operations: ["observe", "read", "set_value", "invoke"], bypass_checker: "file_digest", ...over });
const control = (desktop: WindowsDesktopAutomationKernel, over: Record<string, unknown> = {}) => desktop.registerControl({ control_id: "editor", application_id: "notepad", locator: { automation_id: "15", control_type: "Edit" }, allowed_operations: ["read", "set_value"], ...over });
const action = (desktop: WindowsDesktopAutomationKernel, over: Record<string, unknown> = {}) => desktop.registerAction({ action_id: "read_editor", control_id: "editor", operation: "read", ...over });

test("Windows UIA automation is an explicit application/control/action allowlist", async () => {
  const f = await fixture();
  try {
    assert.equal(application(f.desktop).idempotent, false);
    assert.equal(application(f.desktop).idempotent, true);
    assert.throws(() => application(f.desktop, { allowed_operations: ["read"] }), /already registered with different scope/);
    assert.throws(() => application(f.desktop, { executable: "C:\\Windows\\notepad.exe" }), /bare .exe filename/);
    assert.throws(() => application(f.desktop, { application_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => f.desktop.registerApplication({ application_id: "open", executable: "cmd.exe", allowed_operations: [] }), /empty allowlist/);
    assert.equal(control(f.desktop).idempotent, false);
    assert.equal(control(f.desktop).idempotent, true);
    assert.throws(() => control(f.desktop, { locator: { automation_id: "different", control_type: "Edit" } }), /already registered with different scope/);
    assert.throws(() => control(f.desktop, { control_id: "pixel", locator: { name: "click at coordinate" } }), /unsafe/);
    assert.throws(() => control(f.desktop, { control_id: "none", locator: {} }), /needs automation_id or exact name/);
    assert.throws(() => control(f.desktop, { control_id: "button", allowed_operations: ["select"] }), /not permitted for this application/);
    assert.equal(f.desktop.registerControl({ control_id: "named", application_id: "notepad", locator: { name: "Save", control_type: "Button" }, allowed_operations: ["invoke"] }).idempotent, false);
    assert.equal(action(f.desktop).idempotent, false);
    assert.equal(action(f.desktop).idempotent, true);
    assert.throws(() => action(f.desktop, { operation: "set_value", value: "different" }), /already registered with different content/);
    assert.throws(() => action(f.desktop, { action_id: "wrong", operation: "invoke" }), /not permitted for this control/);
    assert.throws(() => action(f.desktop, { action_id: "mutating-read", expected: { state: "changed" } }), /read-only desktop actions/);
  } finally { f.store.close(); }
});

test("only independent R0 observations can be unattended; the adapter has no execution authority", async () => {
  const f = await fixture();
  try {
    application(f.desktop); control(f.desktop); action(f.desktop);
    const read = f.desktop.adjudicate({ action_id: "read_editor" });
    assert.equal(read.outcome, "L1");
    assert.equal(read.reason, "r0_with_independent_desktop_bypass_check");
    assert.equal(read.adapter_required, true);
    assert.equal(read.execution_authority, false);
    f.desktop.registerAction({ action_id: "write_editor", control_id: "editor", operation: "set_value", value: "safe text" });
    const write = f.desktop.adjudicate({ action_id: "write_editor" });
    assert.equal(write.outcome, "L2_prepare_release");
    assert.equal(write.reason, "desktop_external_effect_requires_prepare_and_release");
    assert.equal(f.desktop.adjudicate({ action_id: "read_editor", bypass_checker: "independent_probe" }).bypass_checker, "independent_probe");
    assert.throws(() => f.desktop.registerAction({ action_id: "empty", control_id: "editor", operation: "set_value", value: "" }), /requires a non-empty string/);
    assert.throws(() => f.desktop.registerAction({ action_id: "read-value", control_id: "editor", operation: "read", value: "x" }), /only set_value/);
  } finally { f.store.close(); }
});

test("prepared request exposes only a UIA contract and receipts keep independent verification distinct", async () => {
  const f = await fixture();
  try {
    application(f.desktop); control(f.desktop); action(f.desktop);
    const prepared = f.desktop.prepareExecution({ action_id: "read_editor", request_id: "request_1" });
    assert.deepEqual(prepared.request, { request_id: "request_1", application: { application_id: "notepad", executable: "notepad.exe" }, control: { automation_id: "15", name: null, control_type: "Edit" }, operation: "read", expected: null, value_required: false, value_stored: false });
    assert.equal(prepared.execution_authority, false);
    assert.equal(prepared.human_release_required, false);
    assert.match(String((f.desktop.prepareExecution({ action_id: "read_editor" }).request as Record<string, unknown>).request_id), /^desktop_request_/);
    f.desktop.registerAction({ action_id: "write_editor", control_id: "editor", operation: "set_value", value: "safe text" });
    assert.equal(f.desktop.prepareExecution({ action_id: "write_editor" }).human_release_required, true);
    const receipt = f.desktop.recordReceipt({ action_id: "read_editor", adapter_result: { result: "succeeded", detail: "value read" }, bypass_result: { source: "file_digest", result: "same" } });
    assert.equal((receipt.receipt as Record<string, unknown>).recomputable, true);
    assert.equal(f.desktop.recordReceipt({ action_id: "read_editor", adapter_result: { result: "succeeded", detail: "value read" }, bypass_result: { source: "file_digest", result: "same" } }).idempotent, true);
    assert.throws(() => f.desktop.recordReceipt({ action_id: "read_editor", adapter_result: { result: "bogus" } }), /unsupported/);
    assert.throws(() => f.desktop.recordReceipt({ action_id: "read_editor", adapter_result: { result: "succeeded" }, bypass_result: { source: "uia", result: "ok" } }), /independent/);
    assert.equal((f.desktop.recordReceipt({ action_id: "read_editor", receipt_id: "named", adapter_result: { result: "failed" } }).receipt as Record<string, unknown>).recomputable, false);
    assert.deepEqual(f.desktop.surface({}), { applications: 1, controls: 1, actions: 2, l1_eligible: 1, adapter: "windows_uia", uia_discovery: true, arbitrary_command_execution: false, visual_location: false });
  } finally { f.store.close(); }
});
