import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import { object, text } from "./validation.ts";

/**
 * Vision is a fallback for native applications whose UIA tree is absent or incomplete.
 * It is intentionally separate from UIA: OCR can nominate a rectangle, but it never turns
 * that rectangle into an unattended action.  The adapter re-observes immediately before an
 * interactive human release and stores only digests/geometry in Craft, never screenshots or
 * an OCR transcript.
 */
export type VisualDesktopOperation = "observe" | "click";

const IDENTIFIER = /^[a-zA-Z0-9_.:-]{1,200}$/u;
const EXECUTABLE = /^[a-zA-Z0-9_.-]{1,120}\.exe$/iu;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const MAX_OBSERVATION_AGE_MS = 30_000;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!IDENTIFIER.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function executable(value: unknown): string {
  const result = text(value, "executable");
  if (!EXECUTABLE.test(result)) throw new Error("executable must be a bare .exe filename, not a path or command");
  return result.toLowerCase();
}
function sha256(value: unknown, name: string): string {
  const result = text(value, name);
  if (!SHA256.test(result)) throw new Error(`${name} must be a sha256 digest`);
  return result;
}
function positiveInteger(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return value;
}
function coordinate(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= maximum) throw new Error(`${name} must be an integer from 0 to ${maximum - 1}`);
  return value;
}
function observedAt(value: unknown, name: string): string {
  const result = text(value, name);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function targetText(value: unknown, name = "target_text"): string {
  const result = text(value, name).trim().replace(/\s+/gu, " ");
  if (!result || result.length > 120) throw new Error(`${name} must contain 1 to 120 characters`);
  return result;
}
function targetDigest(value: string): string { return stableDigest({ target_text: value.normalize("NFKC").toLocaleLowerCase("en-US") }); }
function bounds(value: unknown, name: string, imageWidth: number, imageHeight: number): JsonObject {
  const input = object(value, name);
  const x = coordinate(input.x, `${name}.x`, imageWidth);
  const y = coordinate(input.y, `${name}.y`, imageHeight);
  const width = positiveInteger(input.width, `${name}.width`, imageWidth);
  const height = positiveInteger(input.height, `${name}.height`, imageHeight);
  if (x + width > imageWidth || y + height > imageHeight) throw new Error(`${name} must stay within the screenshot`);
  return { x, y, width, height };
}
function confidence(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0.85 || value > 1) throw new Error(`${name} must be from 0.85 to 1`);
  return Math.round(value * 10_000) / 10_000;
}
function matches(value: unknown, imageWidth: number, imageHeight: number): JsonObject[] {
  if (!Array.isArray(value) || !value.length || value.length > 20) throw new Error("matches must contain 1 to 20 OCR matches");
  return value.map((entry, index) => {
    const match = object(entry, `matches[${index}]`);
    const rawText = targetText(match.target_text, `matches[${index}].target_text`);
    return { target_digest: targetDigest(rawText), bounds: bounds(match.bounds, `matches[${index}].bounds`, imageWidth, imageHeight), confidence: confidence(match.confidence, `matches[${index}].confidence`) };
  });
}

export class WindowsDesktopVisionKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  beginSession(args: JsonObject): JsonObject {
    const sessionId = identifier(args.session_id, "session_id");
    const app = executable(args.executable);
    const title = args.window_title === undefined ? null : targetText(args.window_title, "window_title");
    const identityDigest = stableDigest({ session_id: sessionId, executable: app, window_title: title });
    const existing = this.store.find("windows_desktop_vision_session", sessionId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Visual desktop session is already registered with different scope");
      return { session: existing, idempotent: true };
    }
    return { session: this.store.create("windows_desktop_vision_session", sessionId, { session_id: sessionId, executable: app, window_title: title, identity_digest: identityDigest, adapter: "windows_vision_ocr", unattended_execution: false }), idempotent: false };
  }

  recordObservation(args: JsonObject): JsonObject {
    const observationId = identifier(args.observation_id, "observation_id");
    const session = this.store.get("windows_desktop_vision_session", identifier(args.session_id, "session_id"));
    const imageWidth = positiveInteger(args.image_width, "image_width", 32_768);
    const imageHeight = positiveInteger(args.image_height, "image_height", 32_768);
    const imageDigest = sha256(args.screenshot_digest, "screenshot_digest");
    const at = observedAt(args.observed_at, "observed_at");
    const found = matches(args.matches, imageWidth, imageHeight);
    const identityDigest = stableDigest({ observation_id: observationId, session_id: String(session.id), image_width: imageWidth, image_height: imageHeight, screenshot_digest: imageDigest, observed_at: at, matches: found });
    const existing = this.store.find("windows_desktop_vision_observation", observationId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Visual observation is already recorded with different evidence");
      return { observation: existing, idempotent: true };
    }
    return { observation: this.store.create("windows_desktop_vision_observation", observationId, {
      session_id: String(session.id), screenshot_digest: imageDigest, image_width: imageWidth, image_height: imageHeight, observed_at: at,
      matches: found, raw_screenshot_stored: false, raw_ocr_stored: false, identity_digest: identityDigest,
    }), idempotent: false };
  }

  prepareClick(args: JsonObject): JsonObject {
    const actionId = identifier(args.action_id, "action_id");
    const observation = this.store.get("windows_desktop_vision_observation", identifier(args.observation_id, "observation_id"));
    const session = this.store.get("windows_desktop_vision_session", String(observation.session_id));
    const now = args.now === undefined ? Date.now() : Date.parse(observedAt(args.now, "now"));
    if (now - Date.parse(String(observation.observed_at)) > MAX_OBSERVATION_AGE_MS || now < Date.parse(String(observation.observed_at))) throw new Error("Visual observation is stale; capture the window again before preparing a click");
    const requestedText = targetText(args.target_text);
    const candidates = (observation.matches as JsonObject[]).filter((match) => String(match.target_digest) === targetDigest(requestedText));
    if (candidates.length !== 1) throw new Error("Visual click needs exactly one fresh OCR match for the requested target");
    const candidate = candidates[0]!;
    const identityDigest = stableDigest({ action_id: actionId, observation_id: String(observation.id), target_digest: candidate.target_digest, bounds: candidate.bounds, confidence: candidate.confidence });
    const existing = this.store.find("windows_desktop_vision_action", actionId);
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Visual desktop action is already registered with different evidence");
      return { action: existing, idempotent: true, human_release_required: true };
    }
    const action = this.store.create("windows_desktop_vision_action", actionId, {
      action_id: actionId, session_id: String(session.id), observation_id: String(observation.id), target_digest: candidate.target_digest,
      bounds: candidate.bounds, confidence: candidate.confidence, risk_level: "R2", outcome: "L2_prepare_release", human_release_required: true,
      identity_digest: identityDigest,
    });
    // The requested text is intentionally returned only in the short-lived adapter request.
    return { action, request: { request_id: `vision_request_${stableDigest({ action_id: String(action.id), observation: observation.identity_digest }).slice(-20)}`,
      application: { executable: session.executable, window_title: session.window_title }, operation: "click", target_text: requestedText,
      observation: { observation_id: observation.id, screenshot_digest: observation.screenshot_digest, bounds: candidate.bounds, confidence: candidate.confidence },
      recapture_required: true }, human_release_required: true, execution_authority: false };
  }

  recordReceipt(args: JsonObject): JsonObject {
    const action = this.store.get("windows_desktop_vision_action", identifier(args.action_id, "action_id"));
    const adapter = object(args.adapter_result, "adapter_result");
    const result = text(adapter.result, "adapter_result.result");
    if (!new Set(["succeeded", "failed", "not_found", "blocked", "drift"]).has(result)) throw new Error("adapter_result.result is unsupported");
    if (result === "succeeded" && args.human_release !== true) throw new Error("Visual click receipts require explicit human_release");
    const receiptId = args.receipt_id === undefined ? `vision_receipt_${stableDigest({ action_id: String(action.id), adapter }).slice(-20)}` : identifier(args.receipt_id, "receipt_id");
    const existing = this.store.find("windows_desktop_vision_receipt", receiptId);
    if (existing) return { receipt: existing, idempotent: true };
    return { receipt: this.store.create("windows_desktop_vision_receipt", receiptId, { action_id: String(action.id), adapter_result: adapter, human_release: args.human_release === true, adapter: "windows_vision_ocr", raw_screenshot_stored: false, raw_ocr_stored: false }), idempotent: false };
  }

  surface(args: JsonObject = {}): JsonObject {
    return { sessions: this.store.list("windows_desktop_vision_session", 1_000).length, observations: this.store.list("windows_desktop_vision_observation", 1_000).length,
      actions: this.store.list("windows_desktop_vision_action", 1_000).length, adapter: "windows_vision_ocr", primary_adapter: "windows_uia",
      fallback_only: true, unattended_execution: false, human_release_required_for_click: true, raw_screenshot_stored: false, raw_ocr_stored: false };
  }
}
