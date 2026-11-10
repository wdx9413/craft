/**
 * 自进化路径 C：插件发现（Tooling Evolution）。
 *
 * NEEDREAD.md：归因发现「由于缺少 Web-Search 工具导致信息对齐失败」时，
 * Mainer 触发插件发现，向注册中心请求并安装。这里保持安全红线：自动部分只
 * 做「归因 -> 匹配已登记能力 -> 生成提案」，安装/挂载必须人工批准；提案永
 * 不写 Codex/Claude/DSH 宿主配置，也不执行外部命令。
 */
import { randomUUID } from "node:crypto";
import { type CraftStore, type JsonObject } from "./infrastructure/store.ts";

/** 归因类别 -> 建议补齐的能力标签。未列出的类别不猜测，避免乱装插件。 */
const REMEDY_BY_FAILURE: Readonly<Record<string, { capability: string; reason: string }>> = {
  coverage_gap: { capability: "search", reason: "源材料缺少答案，需要检索/搜索类能力补齐信息" },
  retrieval_gap: { capability: "search", reason: "相关事实存在但未被召回，需要更强的检索能力" },
  synthesis_gap: { capability: "model", reason: "证据齐备但答案仍错，需要复核模型/推理配置" },
};

export class PluginDiscovery {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /** 从一条已归因的失败生成插件发现提案；unattributed 不产生提案。 */
  propose(args: JsonObject): JsonObject {
    const failureClass = text(args.failure_class, "failure_class");
    if (failureClass === "unattributed") throw new Error("an unattributed failure cannot produce a plugin proposal");
    const remedy = REMEDY_BY_FAILURE[failureClass];
    if (!remedy) throw new Error(`no plugin remedy is registered for ${failureClass}`);
    const catalog = Array.isArray(args.capabilities) ? args.capabilities as JsonObject[] : [];
    // Only already-registered capabilities are candidates; discovery never
    // invents a package name or downloads anything.
    const matches = catalog.filter((item) => String(item.kind ?? item.id ?? "").toLowerCase().includes(remedy.capability)
      || String(item.name ?? "").toLowerCase().includes(remedy.capability));
    const evidenceId = args.evidence_id === undefined || args.evidence_id === null ? null : text(args.evidence_id, "evidence_id");
    const now = new Date().toISOString();
    const id = String(args.id ?? `plugin_discovery_${randomUUID()}`);
    const payload = { id, failure_class: failureClass, capability: remedy.capability, reason: remedy.reason,
      candidates: matches.map((item) => ({ id: String(item.id ?? item.name), name: String(item.name ?? item.id) })),
      candidate_count: matches.length, evidence_id: evidenceId,
      status: "proposed", approved_by: null, approved_at: null,
      writes_host_config: false, auto_installed: false,
      created_at: now, updated_at: now };
    this.store.save("plugin_discovery_proposal", id, payload);
    return payload;
  }

  /** 人工批准后仅把提案置为 approved；不触发任何安装或宿主写入。 */
  approve(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const actor = text(args.approved_by, "approved_by");
    const existing = this.store.find("plugin_discovery_proposal", id);
    if (!existing) throw new Error(`Unknown plugin discovery proposal: ${id}`);
    if (existing.status === "approved") return { ...existing, idempotent: true };
    if (existing.status !== "proposed") throw new Error("only a proposed discovery can be approved");
    const now = new Date().toISOString();
    const payload = { ...existing, status: "approved", approved_by: actor, approved_at: now, updated_at: now };
    this.store.save("plugin_discovery_proposal", id, payload);
    return payload;
  }

  list(args: JsonObject = {}): JsonObject {
    const status = args.status === "proposed" || args.status === "approved" ? args.status : null;
    const items = this.store.list("plugin_discovery_proposal", 1_000,
      (item) => status === null || item.status === status);
    return { items };
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}
