import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject, type SaveEntry } from "./infrastructure/store.ts";
import { WorkbenchKernel } from "./workbench.ts";
import { text } from "./validation.ts";
import { payload } from "./digest.ts";

type Patch = { object_id: string; base_version: number; op: "set" | "remove"; path: string; value?: unknown };

function id(value: unknown, name: string, prefix: string): string {
  const result = value === undefined ? `${prefix}_${randomUUID().replaceAll("-", "")}` : String(value).trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`${name} must contain only letters, numbers, _ or -`);
  return result;
}

function pointer(value: unknown): string[] {
  const path = text(value, "patch.path");
  if (!path.startsWith("/") || path === "/" || path.includes("//")) throw new Error("patch.path must be a non-root JSON Pointer");
  if (/~(?:[^01]|$)/u.test(path)) throw new Error("patch.path contains an invalid JSON Pointer escape");
  const parts = path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (parts.some(part => ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("patch.path contains an unsafe property");
  return parts;
}

function patches(value: unknown): Patch[] {
  if (!Array.isArray(value) || !value.length) throw new Error("patches must be a non-empty array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`patches[${index}] must be an object`);
    const raw = item as JsonObject; const op = String(raw.op);
    if (!new Set(["set", "remove"]).has(op)) throw new Error(`patches[${index}].op is unsupported`);
    const baseVersion = Number(raw.base_version);
    if (!Number.isInteger(baseVersion) || baseVersion < 1) throw new Error(`patches[${index}].base_version must be a positive integer`);
    pointer(raw.path);
    if (op === "set" && !Object.hasOwn(raw, "value")) throw new Error(`patches[${index}].value is required for set`);
    return { object_id: id(raw.object_id, `patches[${index}].object_id`, "work_object"), base_version: baseVersion,
      op: op as Patch["op"], path: String(raw.path), ...(op === "set" ? { value: raw.value } : {}) };
  });
}

function valueAt(root: unknown, parts: string[]): unknown {
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) return undefined;
    current = (current as JsonObject)[part];
  }
  return current;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

function apply(root: JsonObject, patch: Patch): JsonObject {
  const result = structuredClone(root); const parts = pointer(patch.path); let parent: JsonObject = result;
  for (const part of parts.slice(0, -1)) {
    const existing = parent[part];
    if (existing === undefined && patch.op === "remove") return result;
    if (existing === undefined) parent[part] = {};
    else if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error(`patch path crosses a non-object value: ${patch.path}`);
    parent = parent[part] as JsonObject;
  }
  const leaf = parts.at(-1)!;
  if (patch.op === "remove") delete parent[leaf]; else parent[leaf] = patch.value;
  return result;
}

export class ChangeSetKernel {
  readonly store: CraftStore; readonly workbench: WorkbenchKernel;
  constructor(store: CraftStore, workbench: WorkbenchKernel) { this.store = store; this.workbench = workbench; }

  create(args: JsonObject): JsonObject {
    const workspaceId = id(args.workspace_id, "workspace_id", "workspace");
    const workspace = this.store.get("workspace", workspaceId); const normalized = patches(args.patches);
    for (const patch of normalized) {
      const object = this.store.get("work_object", patch.object_id);
      if (object.workspace_id !== workspaceId) throw new Error("Patched objects must belong to the workspace");
      if (!this.store.find("work_object", patch.object_id, patch.base_version)) throw new Error("Patch base object version does not exist");
    }
    const changeSet = this.store.create("change_set", id(args.change_set_id, "change_set_id", "change_set"), {
      workspace_id: workspaceId, base_state_revision: Number(workspace.state_revision), summary: text(args.summary, "summary"),
      author: text(args.author, "author"), intent: args.intent ?? null, patches: normalized, status: "draft" });
    return { change_set: changeSet, preview: this.preview({ change_set_id: changeSet.id }) };
  }

  preview(args: JsonObject): JsonObject {
    const changeSet = this.store.get("change_set", text(args.change_set_id, "change_set_id"));
    const applied = new Set(Array.isArray(changeSet.applied_patch_indices) ? changeSet.applied_patch_indices as number[]
      : changeSet.status === "applied" ? (changeSet.patches as Patch[]).map((_, index) => index) : []);
    const results = (changeSet.patches as Patch[]).map((patch, patch_index) => {
      const base = this.store.find("work_object", patch.object_id, patch.base_version)!;
      const current = this.store.get("work_object", patch.object_id); const parts = pointer(patch.path);
      const baseValue = valueAt(base.data, parts); const currentValue = valueAt(current.data, parts);
      const deletedParent = parts.slice(0, -1).some((_, index) => {
        const path = parts.slice(0, index + 1);
        const before = valueAt(base.data, path); const now = valueAt(current.data, path);
        return before !== undefined && (now === undefined || (before !== null && typeof before === "object" && !Array.isArray(before)
          && (now === null || typeof now !== "object" || Array.isArray(now))));
      });
      return { ...patch, patch_index, current_version: current.version, classification: applied.has(patch_index) ? "applied" : !deletedParent && same(baseValue, currentValue) ? "auto_apply" : "conflict",
        base_value: baseValue ?? null, current_value: currentValue ?? null };
    });
    const rootIds = [...new Set(results.map((item) => item.object_id))];
    return { change_set_id: changeSet.id, workspace_id: changeSet.workspace_id, patches: results,
      conflicts: results.filter((item) => item.classification === "conflict"),
      impact: this.workbench.impact({ workspace_id: changeSet.workspace_id, object_ids: rootIds }) };
  }

  apply(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
    const changeSet = this.store.get("change_set", text(args.change_set_id, "change_set_id"));
    const allPatches = changeSet.patches as Patch[];
    const applied = new Set(Array.isArray(changeSet.applied_patch_indices) ? changeSet.applied_patch_indices as number[] : changeSet.status === "applied" ? allPatches.map((_, index) => index) : []);
    const requested = args.patch_indices === undefined ? allPatches.map((_, index) => index).filter(index => !applied.has(index)) : args.patch_indices;
    if (!Array.isArray(requested) || (args.patch_indices !== undefined && requested.length === 0)
      || requested.some(index => !Number.isSafeInteger(index) || index < 0 || index >= allPatches.length)
      || new Set(requested).size !== requested.length) throw new Error("patch_indices must contain unique valid patch indices");
    if (changeSet.status !== "draft" && changeSet.status !== "applied") throw new Error("Only a draft ChangeSet can be applied");
    const selected = requested.filter(index => !applied.has(index)).sort((a, b) => a - b);
    if (selected.length === 0) return { change_set: changeSet, idempotent: true };
    const workspace = this.store.get("workspace", String(changeSet.workspace_id));
    const expected = Number(args.expected_state_revision ?? workspace.state_revision);
    if (!Number.isInteger(expected) || expected !== Number(workspace.state_revision)) throw new Error("Workspace state changed; refresh before applying ChangeSet");
    const preview = this.preview({ change_set_id: changeSet.id });
    if ((preview.conflicts as JsonObject[]).some(patch => selected.includes(patch.patch_index))) throw new Error("ChangeSet has field conflicts that require resolution");
    const grouped = new Map<string, Patch[]>();
    for (const index of selected) { const patch = allPatches[index]!; grouped.set(patch.object_id, [...(grouped.get(patch.object_id) ?? []), patch]); }
    const nextRevision = expected + 1;
    const roots = new Set(grouped.keys()); const entries: SaveEntry[] = [];
    const impact = this.workbench.impact({ workspace_id: changeSet.workspace_id, object_ids: [...roots] });
    for (const objectId of impact.impacted_object_ids as string[]) {
      const object = this.store.get("work_object", objectId); let data = object.data as JsonObject;
      for (const patch of grouped.get(objectId) ?? []) data = apply(data, patch);
      entries.push({ kind: "work_object", id: objectId, payload: { ...payload(object), data,
        status: roots.has(objectId) ? "draft" : "needs_review", accepted_evidence_ids: [], state_revision: nextRevision } });
    }
    const changeId = applied.size === 0 ? `${changeSet.id}_change` : `${changeSet.id}_change_${nextRevision}`;
    if (this.store.find("workspace_change", changeId)) throw new Error("Workspace change receipt already exists");
    entries.push({ kind: "workspace_change", id: changeId, payload: { workspace_id: workspace.id,
      summary: changeSet.summary, source: "change_set", change_set_id: changeSet.id, affected_object_ids: [...roots],
      impacted_object_ids: impact.impacted_object_ids, patch_indices: selected, state_revision: nextRevision } });
    const appliedIndices = [...new Set([...applied, ...selected])].sort((a, b) => a - b);
    entries.push({ kind: "change_set", id: String(changeSet.id), payload: { ...payload(changeSet), status: appliedIndices.length === allPatches.length ? "applied" : "draft",
      applied_patch_indices: appliedIndices, applied_state_revision: nextRevision } });
    entries.push({ kind: "workspace", id: String(workspace.id), payload: { ...payload(workspace), state_revision: nextRevision,
      latest_human_change_id: changeId } });
    const saved = this.store.saveBatch(entries);
    return { change_set: saved.at(-2), workspace: saved.at(-1), objects: saved.slice(0, -3), impact, idempotent: false };
    });
  }
}
