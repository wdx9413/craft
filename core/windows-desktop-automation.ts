import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { stableDigest } from "./digest.ts";

/**
 * Windows desktop automation is deliberately an adapter contract, not an unrestricted
 * PowerShell escape hatch.  The core records the applications and UI Automation controls
 * a user has allowed; a local UIA adapter may execute only a prepared request for that
 * registered surface.  It never uses pixels, OCR, screen coordinates or model judgement to
 * decide where to act.
 */

export type DesktopOperation = "observe" | "read" | "set_value" | "invoke" | "select" | "toggle";
export type DesktopOutcome = "L1" | "L2_prepare_release" | "L2_prepare_release_with_approval_chain";

const OPERATION_RISK: Readonly<Record<DesktopOperation, string>> = {
  observe: "R0", read: "R0", set_value: "R1", select: "R1", toggle: "R1", invoke: "R2",
};
const OPERATIONS = new Set<string>(Object.keys(OPERATION_RISK));
const CONTROL_TYPES = new Set(["Button", "CheckBox", "ComboBox", "Edit", "ListItem", "MenuItem", "RadioButton", "TabItem", "Text", "TreeItem", "Window"]);
const IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,200}$/u;
const EXECUTABLE = /^[a-zA-Z0-9_.-]{1,120}\.exe$/iu;
const UNSAFE_LOCATION = /(?:vision|vlm|screenshot|ocr|image|template|pixel|coordinate|bounding|cursor|mouse|keyboard|sendkeys|shell|powershell|cmd)/iu;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!IDENTIFIER.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function operation(value: unknown, name: string): DesktopOperation {
  const result = text(value, name);
  if (!OPERATIONS.has(result)) throw new Error(`${name} is not a known desktop operation`);
  return result as DesktopOperation;
}
function allowedOperations(value: unknown, name: string): DesktopOperation[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${name} must be a non-empty array; an empty allowlist permits everything`);
  return [...new Set(value.map((entry, index) => operation(entry, `${name}[${index}]`)))].sort();
}

/** A governed UIA surface for one installed Windows application. */
export class WindowsDesktopAutomationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  registerApplication(args: JsonObject): JsonObject {
    const applicationId = identifier(args.application_id, "application_id");
    const executable = text(args.executable, "executable");
    if (!EXECUTABLE.test(executable)) throw new Error("executable must be a bare .exe filename, not a path or command");
    const allowed = allowedOperations(args.allowed_operations, "allowed_operations");
    const identityDigest = stableDigest({ application_id: applicationId, executable: executable.toLowerCase(), allowed_operations: allowed });
    const existing = this.store.find("windows_desktop_application", applicationId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Desktop application is already registered with different scope");
      return { application: existing, idempotent: true };
    }
    return { application: this.store.create("windows_desktop_application", applicationId, {
      application_id: applicationId, executable: executable.toLowerCase(), allowed_operations: allowed,
      bypass_checker: args.bypass_checker === undefined ? null : identifier(args.bypass_checker, "bypass_checker"),
      identity_digest: identityDigest,
    }), idempotent: false };
  }

  registerControl(args: JsonObject): JsonObject {
    const controlId = identifier(args.control_id, "control_id");
    const application = this.store.get("windows_desktop_application", identifier(args.application_id, "application_id"));
    const locator = object(args.locator, "locator");
    const automationId = locator.automation_id === undefined ? null : identifier(locator.automation_id, "locator.automation_id");
    const name = locator.name === undefined ? null : text(locator.name, "locator.name");
    if (name !== null && (name.length > 200 || UNSAFE_LOCATION.test(name))) throw new Error("locator.name is unsafe or too long");
    const controlType = locator.control_type === undefined ? null : text(locator.control_type, "locator.control_type");
    if (controlType !== null && !CONTROL_TYPES.has(controlType)) throw new Error("locator.control_type is unsupported");
    if (automationId === null && name === null) throw new Error("locator needs automation_id or exact name; coordinates and visual location are forbidden");
    const allowed = allowedOperations(args.allowed_operations, "allowed_operations");
    for (const entry of allowed) if (!(application.allowed_operations as string[]).includes(entry)) {
      throw new Error(`control operation is not permitted for this application: ${entry}`);
    }
    const identityDigest = stableDigest({ control_id: controlId, application_id: String(application.id), locator: { automation_id: automationId, name, control_type: controlType }, allowed_operations: allowed });
    const existing = this.store.find("windows_desktop_control", controlId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Desktop control is already registered with different scope");
      return { control: existing, idempotent: true };
    }
    return { control: this.store.create("windows_desktop_control", controlId, {
      control_id: controlId, application_id: String(application.id), locator: { automation_id: automationId, name, control_type: controlType },
      allowed_operations: allowed, identity_digest: identityDigest,
    }), idempotent: false };
  }

  registerAction(args: JsonObject): JsonObject {
    const actionId = identifier(args.action_id, "action_id");
    const control = this.store.get("windows_desktop_control", identifier(args.control_id, "control_id"));
    const action = operation(args.operation, "operation");
    if (!(control.allowed_operations as string[]).includes(action)) throw new Error(`operation is not permitted for this control: ${action}`);
    const expected = args.expected === undefined ? null : object(args.expected, "expected");
    if ((action === "observe" || action === "read") && expected !== null) throw new Error("read-only desktop actions cannot declare an expected mutation");
    if (action === "set_value" && (typeof args.value !== "string" || !args.value.length || args.value.length > 10_000)) {
      throw new Error("set_value requires a non-empty string value no longer than 10000 characters");
    }
    if (action !== "set_value" && args.value !== undefined) throw new Error("only set_value may carry a value");
    const identityDigest = stableDigest({ action_id: actionId, control_id: String(control.id), operation: action, value_digest: args.value === undefined ? null : stableDigest(args.value), expected });
    const existing = this.store.find("windows_desktop_action", actionId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Desktop action is already registered with different content");
      return { action: existing, idempotent: true };
    }
    return { action: this.store.create("windows_desktop_action", actionId, {
      action_id: actionId, control_id: String(control.id), operation: action, risk_level: OPERATION_RISK[action],
      value_digest: args.value === undefined ? null : stableDigest(args.value), expected, identity_digest: identityDigest,
    }), idempotent: false };
  }

  adjudicate(args: JsonObject): JsonObject {
    const action = this.store.get("windows_desktop_action", identifier(args.action_id, "action_id"));
    const control = this.store.get("windows_desktop_control", String(action.control_id));
    const application = this.store.get("windows_desktop_application", String(control.application_id));
    const risk = String(action.risk_level);
    const bypass = args.bypass_checker === undefined
      ? (application.bypass_checker === null ? null : String(application.bypass_checker))
      : identifier(args.bypass_checker, "bypass_checker");
    const outcome: DesktopOutcome = risk === "R0" && bypass !== null ? "L1" : "L2_prepare_release";
    return { action_id: String(action.id), control_id: String(control.id), application_id: String(application.id), operation: String(action.operation),
      risk_level: risk, bypass_checker: bypass, has_bypass_check: bypass !== null, outcome,
      approval_chain_required: false,
      reason: risk === "R0" && bypass !== null ? "r0_with_independent_desktop_bypass_check" : risk === "R0" ? "r0_without_bypass_check_prepare_and_release" : "desktop_external_effect_requires_prepare_and_release",
      adapter_required: true, execution_authority: false };
  }

  prepareExecution(args: JsonObject): JsonObject {
    const action = this.store.get("windows_desktop_action", identifier(args.action_id, "action_id"));
    const control = this.store.get("windows_desktop_control", String(action.control_id));
    const application = this.store.get("windows_desktop_application", String(control.application_id));
    const decision = this.adjudicate({ action_id: String(action.id) });
    return { request: { request_id: identifier(args.request_id ?? `desktop_request_${stableDigest({ action_id: String(action.id), prepared_at: String(args.prepared_at ?? "") }).slice(-20)}`, "request_id"),
      application: { application_id: String(application.id), executable: String(application.executable) }, control: control.locator,
      operation: action.operation, expected: action.expected, value_required: action.operation === "set_value", value_stored: false },
      decision, adapter_required: true, execution_authority: false,
      // L2 is a prepared choice, never a background side effect. The local adapter requires
      // a separate, interactive `-HumanRelease` switch before it will mutate a control.
      human_release_required: decision.outcome !== "L1" };
  }

  recordReceipt(args: JsonObject): JsonObject {
    const action = this.store.get("windows_desktop_action", identifier(args.action_id, "action_id"));
    const decision = this.adjudicate({ action_id: String(action.id) });
    const adapter = object(args.adapter_result, "adapter_result");
    const result = text(adapter.result, "adapter_result.result");
    if (!new Set(["succeeded", "failed", "not_found", "blocked"]).has(result)) throw new Error("adapter_result.result is unsupported");
    const bypass = args.bypass_result === undefined ? null : object(args.bypass_result, "bypass_result");
    if (bypass !== null) {
      const source = text(bypass.source, "bypass_result.source");
      if (source === "uia" || source === "desktop" || source === "adapter") throw new Error("bypass_result.source must be independent of the desktop adapter");
      text(bypass.result, "bypass_result.result");
    }
    const receiptId = args.receipt_id === undefined ? `desktop_receipt_${stableDigest({ action_id: String(action.id), adapter_result: adapter }).slice(-20)}` : identifier(args.receipt_id, "receipt_id");
    const existing = this.store.find("windows_desktop_receipt", receiptId);
    if (existing) return { receipt: existing, idempotent: true };
    return { receipt: this.store.create("windows_desktop_receipt", receiptId, {
      action_id: String(action.id), operation: action.operation, risk_level: action.risk_level, outcome: decision.outcome,
      adapter_result: adapter, bypass_result: bypass, recomputable: bypass !== null, adapter_required: true, execution_authority: false,
    }), idempotent: false };
  }

  surface(args: JsonObject = {}): JsonObject {
    const applications = this.store.list("windows_desktop_application", 1_000);
    const controls = this.store.list("windows_desktop_control", 1_000);
    const actions = this.store.list("windows_desktop_action", 1_000);
    return { applications: applications.length, controls: controls.length, actions: actions.length,
      l1_eligible: actions.filter((action) => String(action.risk_level) === "R0" && applications.some((app) => String(app.id) === String(controls.find((control) => String(control.id) === String(action.control_id))?.application_id) && app.bypass_checker !== null)).length,
      adapter: "windows_uia", uia_discovery: true, arbitrary_command_execution: false, visual_location: false };
  }
}
