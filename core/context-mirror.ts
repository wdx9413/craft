import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ContextStorageTarget, CraftSettings } from "./settings.ts";

/**
 * Memory, knowledge and experience stay local and authoritative. A mirror target
 * is an ordinary directory — an Obsidian vault is just a folder — so the copy is
 * plain Markdown the user can read, diff and version outside Craft.
 */
export type ContextRecordKind = "memory" | "knowledge" | "experience";

export interface ContextMirrorEntry { id: string; title: string; body: string; meta: Record<string, string>; }
export interface ContextMirrorStatus { kind: ContextRecordKind; mode: ContextStorageTarget["mode"]; path: string | null; ok: boolean; detail: string | null; }
export interface ContextMirrorResult { mode: ContextStorageTarget["mode"]; written: string[]; error: string | null; }

export const CONTEXT_RECORD_KINDS: readonly ContextRecordKind[] = ["memory", "knowledge", "experience"];

function target(settings: CraftSettings, kind: ContextRecordKind): ContextStorageTarget {
  return settings.workbench.contextStorage[kind];
}

/** A mirror target is usable only when it is an absolute directory we can create. */
export function contextMirrorStatus(settings: CraftSettings, kind: ContextRecordKind): ContextMirrorStatus {
  const targetValue = target(settings, kind);
  if (targetValue.mode !== "mirror") return { kind, mode: targetValue.mode, path: targetValue.path, ok: true, detail: null };
  if (!targetValue.path) return { kind, mode: targetValue.mode, path: null, ok: false, detail: "尚未设置远端目录" };
  if (!isAbsolute(targetValue.path)) return { kind, mode: targetValue.mode, path: targetValue.path, ok: false, detail: "远端目录必须是绝对路径" };
  try {
    mkdirSync(join(resolve(targetValue.path), kind), { recursive: true });
    return { kind, mode: targetValue.mode, path: resolve(targetValue.path), ok: true, detail: null };
  } catch (error) {
    return { kind, mode: targetValue.mode, path: targetValue.path, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export function contextMirrorStatuses(settings: CraftSettings): ContextMirrorStatus[] {
  return CONTEXT_RECORD_KINDS.map((kind) => contextMirrorStatus(settings, kind));
}

function slug(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 96) || "record";
}

/** Front matter keeps the exported note greppable and dataview-friendly. */
export function contextMirrorDocument(kind: ContextRecordKind, entry: ContextMirrorEntry): string {
  const front = [`craft_kind: ${kind}`, `craft_id: ${entry.id}`];
  for (const [key, value] of Object.entries(entry.meta)) if (value) front.push(`${key}: ${value}`);
  return `---\n${front.join("\n")}\n---\n\n# ${entry.title || entry.id}\n\n${entry.body.trim()}\n`;
}

/**
 * Export every entry of one kind. A missing or unwritable directory is reported
 * as a per-kind error instead of throwing, so the local record always stands.
 */
export function contextMirrorWrite(settings: CraftSettings, kind: ContextRecordKind, entries: ContextMirrorEntry[]): ContextMirrorResult {
  const status = contextMirrorStatus(settings, kind);
  if (status.mode !== "mirror") return { mode: status.mode, written: [], error: null };
  if (!status.ok) return { mode: status.mode, written: [], error: status.detail };
  const directory = join(String(status.path), kind), written: string[] = [];
  try {
    let entryError: string | null = null;
    for (const entry of entries) {
      const result = contextMirrorEntry(settings, kind, entry);
      written.push(...result.written);
      if (result.error) entryError = result.error;
    }
    writeFileSync(join(directory, "_index.md"), `---\ncraft_kind: ${kind}\ncraft_index: true\ncraft_count: ${entries.length}\n---\n\n` +
      entries.map((entry) => `- [[${slug(entry.id)}|${entry.title || entry.id}]]`).join("\n") + "\n", "utf8");
    return { mode: status.mode, written, error: entryError };
  } catch (error) {
    return { mode: status.mode, written, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Write one record without touching the index, for write-through mirroring. */
export function contextMirrorEntry(settings: CraftSettings, kind: ContextRecordKind, entry: ContextMirrorEntry): ContextMirrorResult {
  const status = contextMirrorStatus(settings, kind);
  if (status.mode !== "mirror") return { mode: status.mode, written: [], error: null };
  if (!status.ok) return { mode: status.mode, written: [], error: status.detail };
  try {
    const file = join(String(status.path), kind, `${slug(entry.id)}.md`);
    writeFileSync(file, contextMirrorDocument(kind, entry), "utf8");
    return { mode: status.mode, written: [file], error: null };
  } catch (error) {
    return { mode: status.mode, written: [], error: error instanceof Error ? error.message : String(error) };
  }
}
