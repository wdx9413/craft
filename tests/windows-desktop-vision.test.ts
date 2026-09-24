import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { WindowsDesktopVisionKernel } from "../core/windows-desktop-vision.ts";

const SCREENSHOT = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = "2026-09-24T08:00:00.000Z";
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-windows-vision-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, vision: new WindowsDesktopVisionKernel(store) };
}
function session(vision: WindowsDesktopVisionKernel) { return vision.beginSession({ session_id: "paint", executable: "mspaint.exe", window_title: "Untitled - Paint" }); }
function observation(vision: WindowsDesktopVisionKernel, over: Record<string, unknown> = {}) {
  return vision.recordObservation({ observation_id: "paint-save", session_id: "paint", screenshot_digest: SCREENSHOT, image_width: 1280, image_height: 720, observed_at: NOW,
    matches: [{ target_text: "Save", bounds: { x: 100, y: 40, width: 52, height: 24 }, confidence: 0.94 }], ...over });
}

test("visual fallback records OCR evidence without retaining a screenshot or transcript", async () => {
  const f = await fixture();
  try {
    assert.equal(session(f.vision).idempotent, false);
    assert.equal(session(f.vision).idempotent, true);
    assert.throws(() => f.vision.beginSession({ session_id: "paint", executable: "other.exe" }), /different scope/);
    assert.throws(() => f.vision.beginSession({ session_id: "bad", executable: "C:\\Windows\\mspaint.exe" }), /bare .exe/);
    const recorded = observation(f.vision).observation as Record<string, unknown>;
    assert.equal(recorded.raw_screenshot_stored, false);
    assert.equal(recorded.raw_ocr_stored, false);
    assert.equal(((recorded.matches as Array<Record<string, unknown>>)[0]?.target_text), undefined);
    assert.equal(observation(f.vision).idempotent, true);
    assert.throws(() => observation(f.vision, { observation_id: "offscreen", matches: [{ target_text: "Save", bounds: { x: 1270, y: 710, width: 20, height: 20 }, confidence: 0.94 }] }), /within the screenshot/);
    assert.throws(() => observation(f.vision, { observation_id: "weak", matches: [{ target_text: "Save", bounds: { x: 10, y: 10, width: 20, height: 20 }, confidence: 0.84 }] }), /0.85 to 1/);
  } finally { f.store.close(); }
});

test("visual clicks require a fresh unique OCR match and an explicit human release", async () => {
  const f = await fixture();
  try {
    session(f.vision); observation(f.vision);
    const prepared = f.vision.prepareClick({ action_id: "save", observation_id: "paint-save", target_text: " save ", now: "2026-09-24T08:00:10.000Z" });
    assert.equal(prepared.human_release_required, true);
    assert.equal(prepared.execution_authority, false);
    assert.deepEqual(prepared.request, {
      request_id: (prepared.request as Record<string, unknown>).request_id,
      application: { executable: "mspaint.exe", window_title: "Untitled - Paint" }, operation: "click", target_text: "save",
      observation: { observation_id: "paint-save", screenshot_digest: SCREENSHOT, bounds: { x: 100, y: 40, width: 52, height: 24 }, confidence: 0.94 }, recapture_required: true,
    });
    assert.throws(() => f.vision.prepareClick({ action_id: "late", observation_id: "paint-save", target_text: "Save", now: "2026-09-24T08:00:31.000Z" }), /stale/);
    assert.throws(() => f.vision.prepareClick({ action_id: "missing", observation_id: "paint-save", target_text: "Open", now: "2026-09-24T08:00:10.000Z" }), /exactly one/);
    assert.throws(() => f.vision.recordReceipt({ action_id: "save", adapter_result: { result: "succeeded" } }), /human_release/);
    const receipt = f.vision.recordReceipt({ action_id: "save", adapter_result: { result: "succeeded", detail: "fresh match" }, human_release: true });
    assert.equal((receipt.receipt as Record<string, unknown>).raw_screenshot_stored, false);
    assert.equal(f.vision.recordReceipt({ action_id: "save", adapter_result: { result: "succeeded", detail: "fresh match" }, human_release: true }).idempotent, true);
    assert.equal(f.vision.recordReceipt({ action_id: "save", receipt_id: "drift", adapter_result: { result: "drift" } }).idempotent, false);
  } finally { f.store.close(); }
});
