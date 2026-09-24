import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createWorker } from "tesseract.js";

type Bounds = { x: number; y: number; width: number; height: number };
type Match = { target_text: string; bounds: Bounds; confidence: number };
type Capture = { result: string; detail: string; screenshot_path?: string; screenshot_digest?: string; image_width?: number; image_height?: number; observed_at?: string };
const executablePattern = /^[a-zA-Z0-9_.-]{1,120}\.exe$/u;

function argument(name: string): string | undefined { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; }
function required(value: string | undefined, name: string): string { if (!value?.trim()) throw new Error(`${name} is required`); return value.trim(); }
function executable(value: string): string { if (!executablePattern.test(value)) throw new Error("--executable must be a bare .exe filename"); return value; }
function target(value: string): string { const result = value.trim().replace(/\s+/gu, " "); if (!result || result.length > 120) throw new Error("--target-text must be 1 to 120 characters"); return result; }
function normalized(value: string): string { return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US"); }
function appRoot(): string { return dirname(dirname(fileURLToPath(import.meta.url))); }
function nativeScript(): string { return join(dirname(fileURLToPath(import.meta.url)), "windows-vision-native.ps1"); }
function shell(): string { return process.env.SystemRoot ? join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe"; }
async function native(args: string[]): Promise<Capture> {
  if (process.platform !== "win32") throw new Error("Windows visual adapter only runs on Windows");
  return new Promise((resolve, reject) => {
    const child = spawn(shell(), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", nativeScript(), ...args], { windowsHide: true });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (data) => { stdout += String(data); }); child.stderr.on("data", (data) => { stderr += String(data); });
    child.once("error", reject);
    child.once("close", () => { try { resolve(JSON.parse(stdout.trim()) as Capture); } catch { reject(new Error(stderr.trim() || stdout.trim() || "Windows native adapter returned invalid JSON")); } });
  });
}
function lines(blocks: unknown): Array<{ text: string; confidence: number; bbox: Bounds }> {
  if (!Array.isArray(blocks)) return [];
  const found: Array<{ text: string; confidence: number; bbox: Bounds }> = [];
  for (const block of blocks as Array<{ paragraphs?: Array<{ lines?: unknown[] }> }>) for (const paragraph of block.paragraphs ?? []) for (const rawLine of paragraph.lines ?? []) {
    const line = rawLine as { text?: unknown; confidence?: unknown; bbox?: { x0?: unknown; y0?: unknown; x1?: unknown; y1?: unknown } };
    const box = line.bbox;
    if (typeof line.text !== "string" || typeof line.confidence !== "number" || !box) continue;
    const { x0, y0, x1, y1 } = box;
    // The engine's own typings leave the box coordinates `unknown`. A coordinate that is not a
    // number is a line this adapter cannot place, so it is skipped rather than coerced to 0 --
    // `Number.isInteger` alone already rejects every non-number value.
    if (typeof x0 !== "number" || typeof y0 !== "number" || typeof x1 !== "number" || typeof y1 !== "number"
      || !Number.isInteger(x0) || !Number.isInteger(y0) || !Number.isInteger(x1) || !Number.isInteger(y1)
      || x1 <= x0 || y1 <= y0) continue;
    found.push({ text: line.text, confidence: line.confidence, bbox: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } });
  }
  return found;
}
export async function localOcr(imagePath: string, targetText: string, root = appRoot()): Promise<Match[]> {
  const langPath = join(root, "assets", "ocr");
  if (!existsSync(join(langPath, "eng.traineddata")) || !existsSync(join(langPath, "chi_sim.traineddata"))) throw new Error("Craft bundled OCR models are missing; repair the Craft installation");
  const worker = await createWorker("eng+chi_sim", undefined, { langPath, gzip: false, cacheMethod: "none", logger: () => undefined });
  try {
    const result = await worker.recognize(imagePath, {}, { blocks: true });
    const requested = normalized(targetText);
    return lines(result.data.blocks).filter((line) => line.confidence >= 85 && normalized(line.text) === requested).map((line) => ({ target_text: targetText, bounds: line.bbox, confidence: Math.round((line.confidence / 100) * 10_000) / 10_000 }));
  } finally { await worker.terminate(); }
}
async function observe(app: string, text: string): Promise<Record<string, unknown>> {
  const capture = await native(["-Mode", "capture", "-Executable", app]);
  if (capture.result !== "captured" || !capture.screenshot_path) return capture;
  try {
    const matches = await localOcr(capture.screenshot_path, text);
    return { result: "observed", detail: "Window captured and recognized with Craft bundled offline OCR", adapter: "windows_vision_ocr", screenshot_digest: capture.screenshot_digest, image_width: capture.image_width, image_height: capture.image_height, observed_at: capture.observed_at, matches, raw_screenshot_stored: false, raw_ocr_stored: false };
  } finally { await rm(capture.screenshot_path, { force: true }); }
}
async function click(app: string, text: string, humanRelease: boolean): Promise<Record<string, unknown>> {
  if (!humanRelease) return { result: "blocked", detail: "Visual click requires an explicit interactive HumanRelease", adapter: "windows_vision_ocr" };
  const observation = await observe(app, text);
  const matches = observation.matches as Match[] | undefined;
  if (observation.result !== "observed" || matches?.length !== 1) return { result: "drift", detail: "Fresh local OCR did not find exactly one high-confidence target", adapter: "windows_vision_ocr", screenshot_digest: observation.screenshot_digest, match_count: matches?.length ?? 0 };
  const match = matches[0]!;
  const result = await native(["-Mode", "click", "-Executable", app, "-X", String(match.bounds.x + Math.floor(match.bounds.width / 2)), "-Y", String(match.bounds.y + Math.floor(match.bounds.height / 2)), "-HumanRelease"]);
  return { ...result, adapter: "windows_vision_ocr", raw_screenshot_stored: false, raw_ocr_stored: false };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = required(argument("--mode"), "--mode");
  const app = executable(required(argument("--executable"), "--executable"));
  const text = target(required(argument("--target-text"), "--target-text"));
  try {
    const result = mode === "observe" ? await observe(app, text) : mode === "click" ? await click(app, text, process.argv.includes("--human-release")) : (() => { throw new Error("--mode must be observe or click"); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.result !== "observed" && result.result !== "succeeded") process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
