import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCapabilityService } from "../core/interfaces/mcp/runtime.ts";
import type { CraftStore } from "../core/infrastructure/store.ts";

type Envelope = { payload: Record<string, unknown>; prose_refs: Record<string, { path: string }> };
function prosePath(envelope: Envelope, field: string): string { const ref = envelope.prose_refs[field]; assert(ref); return ref.path; }
function document(store: CraftStore, kind: string, id: string): Envelope {
  const row = store.database.prepare("SELECT payload_json FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1").get(kind, id)!;
  const projection = JSON.parse(String(row.payload_json));
  return JSON.parse(readFileSync(join(store.paths.root, projection._record_file.path), "utf8"));
}

test("Notes, Context and Runtime normal SDK entries retain prose in Markdown and read it after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-owner-prose-entry-"));
  const text = "Use the focused fixture to verify the intended engineering change.";
  try {
    let notes = await openCapabilityService("notes", { CRAFT_DATA_DIR: root });
    let candidateId = "";
    try {
      notes.service.craftNotesCreateDevice({ id: "fixture-device", kind: "local", note: text });
      const device = document(notes.store, "device", "fixture-device");
      assert.equal(device.payload.device_note, undefined); assert.equal(device.payload.note, undefined);
      assert.equal(readFileSync(join(root, prosePath(device, "device_note")), "utf8"), text);
      assert.equal(prosePath(device, "device_note"), prosePath(device, "note"));
      const note = notes.store.list("craft_note", 20)[0]!;
      assert.equal(document(notes.store, "craft_note", String(note.id)).payload.text, undefined);
    } finally { notes.close(); }
    notes = await openCapabilityService("notes", { CRAFT_DATA_DIR: root });
    try { assert.equal(notes.store.get("device", "fixture-device").device_note, text); }
    finally { notes.close(); }
    const context = await openCapabilityService("context", { CRAFT_DATA_DIR: root });
    try {
      const captured = context.service.evolutionProgramMemoryCapture({ statement: text, scenario_key: "fixture", domain: "general", scope: { kind: "project", id: "project:fixture" } });
      candidateId = String(captured.id);
      const stored = document(context.store, "program_memory_candidate", candidateId);
      assert.equal(stored.payload.statement, undefined);
      assert.equal(readFileSync(join(root, prosePath(stored, "statement")), "utf8"), text);
    } finally { context.close(); }
    const reopened = await openCapabilityService("context", { CRAFT_DATA_DIR: root });
    try { assert.equal(reopened.store.get("program_memory_candidate", candidateId).statement, text); }
    finally { reopened.close(); }
    const runtime = await openCapabilityService("runtime", { CRAFT_DATA_DIR: root });
    try {
      const saved = runtime.service.taskOpen({ task_id: "fixture", title: "Fixture task", goal: text }).task as { id: string };
      const task = document(runtime.store, "task", saved.id);
      assert.equal(task.payload.goal, undefined);
      assert.equal(readFileSync(join(root, prosePath(task, "goal")), "utf8"), text);
      assert.equal(runtime.store.get("task", saved.id).goal, text);
    } finally { runtime.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
