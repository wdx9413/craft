import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { CraftStore, type JsonObject } from "../../infrastructure/store.ts";

const KIND = "workbench_agent_session_link";
const PROVIDERS = new Set(["codex", "claude"]);
const PERMISSIONS = new Set(["read_only", "ask", "auto", "full"]);

function field(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

/** Only a provider adapter may call bind after it has obtained a native ID. */
export class WorkbenchAgentSessionLinks {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  bind(args: JsonObject): JsonObject {
    const taskId = field(args.task_id, "task_id", 256);
    this.store.get("task", taskId);
    const provider = field(args.provider, "provider", 32);
    if (!PROVIDERS.has(provider)) throw new Error("provider is unsupported");
    const nativeId = field(args.native_session_id, "native_session_id", 512);
    const workspace = field(args.workspace, "workspace", 4096);
    if (!isAbsolute(workspace)) throw new Error("workspace must be absolute");
    const canonicalWorkspace = realpathSync(workspace);
    if (!statSync(canonicalWorkspace).isDirectory()) throw new Error("workspace must be a directory");
    const model = args.model === null || args.model === undefined ? null : field(args.model, "model", 256);
    const permission = field(args.permission, "permission", 32);
    if (!PERMISSIONS.has(permission)) throw new Error("permission is unsupported");
    const identity = { task_id: taskId, provider, native_session_id: nativeId, workspace: canonicalWorkspace, model, permission };
    const id = `agent_session_${createHash("sha256").update(JSON.stringify([provider, nativeId])).digest("hex")}`;
    const existing = this.store.find(KIND, id);
    if (existing) return this.existing(existing, identity);
    try { return { link: this.store.create(KIND, id, { ...identity, turn_state: "idle", operation_id: null, turn_id: null }), idempotent: false }; }
    catch (error) {
      const raced = this.store.find(KIND, id);
      if (!raced) throw error;
      return this.existing(raced, identity);
    }
  }

  private existing(record: JsonObject, identity: JsonObject): JsonObject {
    if (Object.entries(identity).some(([key, value]) => record[key] !== value)) throw new Error("native session is already linked with different metadata");
    return { link: record, idempotent: true };
  }

  list(taskId: unknown): JsonObject {
    const task = field(taskId, "task_id", 256);
    this.store.get("task", task);
    const links = this.store.list(KIND, 101, item => item.task_id === task);
    return { links: links.slice(0, 100), truncated: links.length > 100 };
  }

  projectPage(limit = 50, cursor?: string | null, workspace?: string | null): JsonObject {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1..100");
    let after = ["", ""];
    if (cursor) {
      if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/u.test(cursor)) throw new Error("invalid session cursor");
      try {
        const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== "string" || !item || item.length > 512)) throw new Error();
        after = value;
      } catch { throw new Error("invalid session cursor"); }
    }
    if (workspace !== undefined && workspace !== null) field(workspace, "workspace", 4096);
    return this.store.readSnapshot(() => {
      const rows = this.store.database.prepare(`SELECT r.id, r.updated_at FROM records r
        JOIN (SELECT id, MAX(version) version FROM records WHERE kind=? GROUP BY id) latest ON latest.id=r.id AND latest.version=r.version
        WHERE r.kind=? AND (?='' OR r.updated_at<? OR (r.updated_at=? AND r.id<?))
        AND (?='' OR json_extract(r.payload_json,'$.workspace')=?)
        ORDER BY r.updated_at DESC,r.id DESC LIMIT ?`).all(KIND, KIND, after[0], after[0], after[0], after[1], workspace ?? "", workspace ?? "", limit + 1) as Array<{ id: string; updated_at: string }>;
      const page = rows.slice(0, limit);
      const links = page.map(row => {
        const link = this.store.get(KIND, row.id);
        const task = this.store.find("task", String(link.task_id));
        return { ...link, title: typeof task?.title === "string" ? task.title : "工作会话" };
      });
      const last = page.at(-1);
      return { links, next_cursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.updated_at, last.id])).toString("base64url") : null };
    });
  }

  get(taskId: unknown, linkId: unknown): JsonObject {
    const task = field(taskId, "task_id", 256);
    const link = this.store.get(KIND, field(linkId, "link_id", 256));
    if (link.task_id !== task) throw new Error("session link does not belong to task");
    return link;
  }

  configure(taskId: unknown, linkId: unknown, modelValue: unknown, permissionValue: unknown): JsonObject {
    return this.store.transaction(() => {
      const link = this.get(taskId, linkId);
      if (link.turn_state !== "idle") throw new Error("会话运行中或状态未确认，无法切换配置");
      if (this.store.list("workbench_message_queue", 1, row => row.task_id === taskId && row.link_id === linkId && row.state !== "sent").length) throw new Error("请先处理或撤回排队消息");
      const model = field(modelValue, "model", 256), permission = field(permissionValue, "permission", 32);
      if (!PERMISSIONS.has(permission) || (link.provider === "claude" && permission === "read_only")) throw new Error("permission is unsupported");
      return this.update(link, { model, permission });
    });
  }

  unlink(taskId: unknown, linkId: unknown): void {
    this.store.transaction(() => {
      const link = this.get(taskId, linkId);
      if (link.turn_state !== "idle" && link.turn_state !== undefined) throw new Error("cannot unlink a session with an unsettled turn");
      this.store.remove(KIND, String(link.id));
    });
  }

  /** Claim a turn before dispatch. A crash after this point leaves an explicitly uncertain turn. */
  reserveTurn(taskId: unknown, linkId: unknown, operationId: unknown): JsonObject {
    const link = this.get(taskId, linkId);
    const operation = field(operationId, "operation_id", 256);
    if (link.turn_state !== "idle" && link.turn_state !== undefined) throw new Error("session has an unsettled turn");
    return this.update(link, { turn_state: "starting", operation_id: operation, turn_id: null });
  }

  acknowledgeTurn(taskId: unknown, linkId: unknown, operationId: unknown, turnId: unknown): JsonObject {
    const link = this.get(taskId, linkId);
    const operation = field(operationId, "operation_id", 256);
    const turn = field(turnId, "turn_id", 512);
    if (link.turn_state !== "starting" || link.operation_id !== operation) throw new Error("turn reservation does not match");
    return this.update(link, { turn_state: "running", turn_id: turn });
  }

  markTurnUnknown(taskId: unknown, linkId: unknown, operationId: unknown): JsonObject {
    const link = this.get(taskId, linkId);
    const operation = field(operationId, "operation_id", 256);
    if (!["starting", "running"].includes(String(link.turn_state)) || link.operation_id !== operation) throw new Error("turn reservation does not match");
    return this.update(link, { turn_state: "unknown" });
  }

  /** A late native acknowledgement identifies the turn without claiming it is still running. */
  identifyUnknownTurn(taskId: unknown, linkId: unknown, operationId: unknown, turnId: unknown): JsonObject {
    const link = this.get(taskId, linkId);
    const operation = field(operationId, "operation_id", 256);
    const turn = field(turnId, "turn_id", 512);
    if (link.turn_state !== "unknown" || link.operation_id !== operation || link.turn_id !== null) throw new Error("unknown turn reservation does not match");
    return this.update(link, { turn_id: turn });
  }

  completeTurn(taskId: unknown, linkId: unknown, operationId: unknown, turnId: unknown, status: unknown): JsonObject {
    const link = this.get(taskId, linkId);
    const operation = field(operationId, "operation_id", 256);
    const turn = field(turnId, "turn_id", 512);
    if (!["completed", "failed", "interrupted"].includes(String(status))) throw new Error("terminal turn status is invalid");
    if (!["running", "unknown"].includes(String(link.turn_state)) || link.operation_id !== operation || link.turn_id !== turn) throw new Error("turn identity does not match");
    return this.update(link, { turn_state: "idle", operation_id: null, turn_id: null, last_turn_id: turn, last_turn_status: status });
  }

  private update(link: JsonObject, change: JsonObject): JsonObject {
    return this.store.updateIfVersion(KIND, String(link.id), Number(link.version), { ...link, ...change });
  }
}
