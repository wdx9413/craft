/**
 * Mod 最小内核 (cognitive overlays / 认知约束).
 *
 * A Mod is a structured Markdown or YAML block that constrains how Workers and
 * Reviewers behave — the "智力药水 / 工作手册" layer from NEEDREAD.md, distinct
 * from Plugins (the "电动螺丝刀 / 器官"). Mods live through a governed lifecycle:
 * a draft is proposed, an operator approves it (or the self-evolution loop
 * promotes a candidate), and only `active` Mods are injected into Worker context.
 *
 * Injection contract: `modSystemOverlay(scope)` returns the concatenated body of
 * every active Mod whose `applies_to` matches and whose scope is in effect for
 * the given scope. Any prompt builder calls this to assemble the cognitive
 * overlay; nothing is injected unless it has been approved and enabled.
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { type CraftStore, type JsonObject } from "./infrastructure/store.ts";

/** Content-addressed identity of a real regression run, bound to the candidate body. */
function regressionDigest(id: string, body: string, cases: JsonObject[]): string {
  return createHash("sha256").update(JSON.stringify({ id, body, cases })).digest("hex");
}

/**
 * Pinned invariants a self-evolved rule must not break. These are deliberately
 * byte-level and model-free: a rule that tells the Worker to ignore safety,
 * disable approvals or exfiltrate secrets is rejected before it can ever reach
 * a Worker's system prompt. Adding a phrase to this list changes the suite.
 */
const FORBIDDEN_MOD_PHRASES: readonly { id: string; pattern: RegExp }[] = [
  { id: "mod.shadow.no_ignore_safety", pattern: /ignore\s+(all\s+)?(safety|security|rules|instructions)/iu },
  { id: "mod.shadow.no_disable_approval", pattern: /(disable|skip|bypass)\s+(human\s+)?(approval|authorization|review)/iu },
  { id: "mod.shadow.no_secret_exfiltration", pattern: /(exfiltrat|send\s+.*(secret|credential|api.?key)\s+.*(out|external)|upload\s+.*(secret|credential))/iu },
];

export type ModStatus = "draft" | "pending" | "active" | "revoked";
export type ModAppliesTo = "worker" | "reviewer" | "all";
export type ModScopeKind = "global" | "project" | "task";

export interface ModRecord {
  id: string;
  name: string;
  body: string;
  scopeKind: ModScopeKind;
  scopeId: string;
  appliesTo: ModAppliesTo;
  status: ModStatus;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  rolledBackFrom: number | null;
  rolledBackTo: number | null;
  pluginId: string | null;
  selfEvolved: boolean;
  failureClass: string | null;
  evidenceId: string | null;
  shadowTest: string | null;
  shadowRegressionSet: string | null;
}

const STATUS_RANK: Record<ModStatus, number> = { draft: 0, pending: 1, active: 2, revoked: 3 };

function normalizeScopeKind(value: unknown): ModScopeKind {
  if (value === "project") return "project";
  if (value === "task") return "task";
  if (value === undefined || value === null || value === "global") return "global";
  throw new Error("scope_kind must be global, project or task");
}

function normalizeAppliesTo(value: unknown): ModAppliesTo {
  if (value === "reviewer") return "reviewer";
  if (value === "all") return "all";
  if (value === undefined || value === null || value === "worker") return "worker";
  throw new Error("applies_to must be worker, reviewer or all");
}

function normalizeStatus(value: unknown): ModStatus {
  if (value === "draft" || value === "pending" || value === "active" || value === "revoked") return value;
  if (value === undefined || value === null) return "draft";
  throw new Error("status must be draft, pending, active or revoked");
}

function toRecord(payload: JsonObject): ModRecord {
  return {
    id: String(payload.id),
    name: String(payload.name ?? payload.id),
    body: String(payload.body ?? ""),
    scopeKind: (payload.scope_kind === "project" ? "project" : payload.scope_kind === "task" ? "task" : "global") as ModScopeKind,
    scopeId: String(payload.scope_id ?? "global"),
    appliesTo: (payload.applies_to === "reviewer" ? "reviewer" : payload.applies_to === "all" ? "all" : "worker") as ModAppliesTo,
    status: normalizeStatus(payload.status),
    enabled: payload.enabled === true,
    version: Number(payload.version ?? 1),
    createdAt: String(payload.created_at),
    updatedAt: String(payload.updated_at),
    approvedBy: payload.approved_by === undefined || payload.approved_by === null ? null : String(payload.approved_by),
    approvedAt: payload.approved_at === undefined || payload.approved_at === null ? null : String(payload.approved_at),
    rolledBackFrom: payload.rolled_back_from === undefined || payload.rolled_back_from === null ? null : Number(payload.rolled_back_from),
    rolledBackTo: payload.rolled_back_to === undefined || payload.rolled_back_to === null ? null : Number(payload.rolled_back_to),
    pluginId: payload.plugin_id === undefined || payload.plugin_id === null ? null : String(payload.plugin_id),
    selfEvolved: payload.self_evolved === true,
    failureClass: payload.failure_class === undefined || payload.failure_class === null ? null : String(payload.failure_class),
    evidenceId: payload.evidence_id === undefined || payload.evidence_id === null ? null : String(payload.evidence_id),
    shadowTest: payload.shadow_test === undefined || payload.shadow_test === null ? null : String(payload.shadow_test),
    shadowRegressionSet: payload.shadow_regression_set === undefined || payload.shadow_regression_set === null ? null : String(payload.shadow_regression_set),
  };
}

export class ModRegistry {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * 自进化：把一条已归因的失败蒸馏为 Mod 候选。
   *
   * Honest boundary: this is pure engineering (no model call). The attribution
   * already named a cause + remedy; we turn that into a structured rule draft,
   * attach the evidence, and hold it as `pending` until a shadow test passes.
   * An `unattributed` failure can never produce a rule — guessing a cause is
   * worse than admitting we do not know one.
   */
  proposeFromAttribution(args: JsonObject): ModRecord {
    const failureClass = text(args.failure_class, "failure_class");
    if (failureClass === "unattributed") throw new Error("an unattributed failure cannot produce a Mod rule");
    const remedy = bodyText(args.remedy ?? "");
    const evidenceId = args.evidence_id === undefined || args.evidence_id === null ? null : text(args.evidence_id, "evidence_id");
    const scopeKind = normalizeScopeKind(args.scope_kind ?? "global");
    const scopeId = scopeKind === "global" ? "global" : text(args.scope_id, "scope_id");
    const now = new Date().toISOString();
    const id = String(args.id ?? `mod_${randomUUID()}`);
    const rule = [
      `# Rule ${failureClass}`,
      `When a ${failureClass} failure is attributed, apply this remedy:`,
      remedy || "consult the failure attribution evidence before repeating the action.",
    ].join("\n");
    const payload = { id, name: `auto:${failureClass}`, body: rule,
      scope_kind: scopeKind, scope_id: scopeId, applies_to: "worker",
      status: "pending", enabled: false, version: 1,
      created_at: now, updated_at: now, approved_by: null, approved_at: null,
      self_evolved: true, failure_class: failureClass, evidence_id: evidenceId,
      shadow_test: "pending" };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  /**
   * Run the fixed, model-free regression set against a candidate Mod.
   *
   * The four checks answer the only questions a cognitive overlay can break:
   * is the candidate still inert while pending, is its body usable, does a
   * plugin-bound rule leak in without that plugin, and did the shadow run
   * leave the real Worker context untouched? Nothing calls a model, so the
   * gate costs 0 tokens and cannot be flattered by a good answer.
   */
  runShadowRegression(id: string): JsonObject {
    const candidate = this.store.find("mod", id);
    if (!candidate) throw new Error(`Unknown mod: ${id}`);
    const body = String(candidate.body ?? "");
    const pluginId = candidate.plugin_id === undefined || candidate.plugin_id === null ? null : String(candidate.plugin_id);
    const scopeKind = String(candidate.scope_kind ?? "global");
    const scopeId = String(candidate.scope_id ?? "global");
    // Snapshot the pre-existing active overlay, then restore it: a shadow run
    // must never leave a candidate active in the real store.
    const before = this.modSystemOverlay({ kind: scopeKind as ModScopeKind, id: scopeId }, "worker", []);
    const cases: JsonObject[] = [];
    const inert = candidate.status !== "active";
    cases.push({ case_id: "mod.shadow.inert_while_pending", verdict: inert ? "passed" : "failed",
      detail: inert ? "候选在影子测试期间未生效" : "候选已生效，影子测试无法验证注入前状态" });
    // A plugin-bound rule must stay out when no plugin is mounted; candidates
    // are pending here, so the overlay should never contain their body.
    const simulated = this.modSystemOverlay({ kind: scopeKind as ModScopeKind, id: scopeId }, "worker", []);
    cases.push({ case_id: "mod.shadow.body_non_empty", verdict: body.trim() ? "passed" : "failed",
      detail: body.trim() ? "规则正文非空" : "规则正文为空" });
    cases.push({ case_id: "mod.shadow.no_plugin_leak", verdict: simulated.includes(body) ? "failed" : "passed",
      detail: pluginId ? "插件绑定规则未在未挂载时泄漏" : "无插件绑定，候选正文仍未注入" });
    cases.push({ case_id: "mod.shadow.overlay_unchanged", verdict: simulated === before ? "passed" : "failed",
      detail: simulated === before ? "影子运行未改变现有 Worker 上下文" : "影子运行污染了现有上下文" });
    // Non-vacuous checks: actually evaluate the candidate body against pinned
    // invariants and its own injection behaviour. Without these, the gate is a
    // structurally always-true assertion about a store we never mutated.
    for (const invariant of FORBIDDEN_MOD_PHRASES) {
      cases.push({ case_id: invariant.id,
        verdict: invariant.pattern.test(body) ? "failed" : "passed",
        detail: invariant.pattern.test(body) ? `候选正文违反固定不变量 ${invariant.id}` : `候选正文未违反 ${invariant.id}` });
    }
    // Simulate injecting the candidate and verify the resulting overlay really
    // contains its body: this observes the candidate rather than comparing two
    // identical overlays that never included it.
    const projected = `${before}\n# Mod: ${String(candidate.name ?? id)}\n${body}`.trim();
    cases.push({ case_id: "mod.shadow.candidate_is_observable",
      verdict: body.trim() && projected.includes(body.trim()) && projected !== before ? "passed" : "failed",
      detail: body.trim() && projected.includes(body.trim()) ? "候选正文在影子注入中确实可观测" : "候选正文无法在影子注入中被观测" });
    const failed = cases.filter((item) => item.verdict === "failed");
    return { verdict: failed.length ? "failed" : "passed", cases, failed: failed.length,
      model_calls: 0, suite: "mod.shadow.v2",
      candidate_digest: regressionDigest(id, body, cases) };
  }

  /** Gate entry: only a real run may mark the candidate as passing. */
  evaluateShadowTest(args: JsonObject): ModRecord & { regression: JsonObject } {
    const id = text(args.id, "id");
    const existing = this.store.find("mod", id);
    if (!existing) throw new Error(`Unknown mod: ${id}`);
    if (existing.self_evolved !== true) throw new Error("shadow tests apply only to self-evolved Mod candidates");
    const result = this.runShadowRegression(id);
    const now = new Date().toISOString();
    const saved = this.store.save("mod", id, { ...existing,
      shadow_test: result.verdict, shadow_regression_set: String(result.suite),
      shadow_cases: result.cases, shadow_failed: result.failed,
      shadow_model_calls: 0, shadow_tested_at: now,
      // Provenance: a passing gate is only ever written by a real run and is
      // bound to the exact candidate body + case outcomes it graded.
      shadow_provenance: result.verdict === "passed" ? String(result.candidate_digest) : null,
      shadow_body_digest: regressionDigest(id, String(existing.body ?? ""), []),
      updated_at: now });
    return { ...toRecord(saved), regression: result };
  }

  recordShadowTest(args: JsonObject): ModRecord {
    const id = text(args.id, "id");
    const existing = this.store.find("mod", id);
    if (!existing) throw new Error(`Unknown mod: ${id}`);
    if (existing.self_evolved !== true) throw new Error("shadow tests apply only to self-evolved Mod candidates");
    const verdict = text(args.verdict, "verdict");
    if (verdict !== "passed" && verdict !== "failed") throw new Error("verdict must be passed or failed");
    // A client may never *claim* a pass. Only `evaluateShadowTest` can grant one,
    // because it is the sole path that actually ran the regression set. This
    // keeps the legacy write-route for recording a failure or an external
    // verdict without letting it open the approval gate.
    if (verdict === "passed") throw new Error("a passing shadow test must come from a real regression run; use /mods/shadow-test/run");
    const regressionSet = text(args.regression_set, "regression_set");
    const now = new Date().toISOString();
    const payload = { ...existing, shadow_test: verdict, shadow_regression_set: regressionSet,
      shadow_provenance: null, shadow_tested_at: now, updated_at: now };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  create(args: JsonObject): ModRecord {
    const name = text(args.name, "name");
    const body = bodyText(args.body);
    const scopeKind = normalizeScopeKind(args.scope_kind);
    const scopeId = scopeKind === "global" ? "global" : text(args.scope_id, "scope_id");
    const appliesTo = normalizeAppliesTo(args.applies_to);
    // A complex Plugin may ship its own Mod; binding it here lets activation
    // inject the rule without a separate manual step (NEEDREAD.md Mod/Plugin 协同).
    const pluginId = args.plugin_id === undefined || args.plugin_id === null ? null : text(args.plugin_id, "plugin_id");
    const now = new Date().toISOString();
    const id = String(args.id ?? `mod_${randomUUID()}`);
    const payload = { id, name, body, scope_kind: scopeKind, scope_id: scopeId, applies_to: appliesTo,
      status: "draft", enabled: false, version: 1, created_at: now, updated_at: now, approved_by: null, approved_at: null,
      ...(pluginId === null ? {} : { plugin_id: pluginId }) };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  update(args: JsonObject): ModRecord {
    const id = text(args.id, "id");
    const existing = this.store.find("mod", id);
    if (!existing) throw new Error(`Unknown mod: ${id}`);
    if (existing.status === "active") throw new Error("cannot edit an active mod; revoke and recreate it");
    const now = new Date().toISOString();
    const payload = { ...existing,
      ...(args.name !== undefined ? { name: text(args.name, "name") } : {}),
      ...(args.body !== undefined ? { body: bodyText(args.body) } : {}),
      ...(args.scope_kind !== undefined ? { scope_kind: normalizeScopeKind(args.scope_kind) } : {}),
      ...(args.scope_id !== undefined && normalizeScopeKind(args.scope_kind === undefined ? existing.scope_kind : args.scope_kind) !== "global" ? { scope_id: text(args.scope_id, "scope_id") } : {}),
      ...(args.applies_to !== undefined ? { applies_to: normalizeAppliesTo(args.applies_to) } : {}),
      version: Number(existing.version ?? 1) + 1, updated_at: now };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  /** Move a draft/pending Mod to active; only an operator-signed approval lands. */
  approve(args: JsonObject): ModRecord {
    const id = text(args.id, "id");
    const actor = boundedActor(args.approved_by, "approved_by");
    const existing = this.store.find("mod", id);
    if (!existing) throw new Error(`Unknown mod: ${id}`);
    // A self-evolved rule must pass the shadow regression set before it can be
    // applied to real Workers; prompt drift is exactly what this gate stops.
    if (existing.self_evolved === true && existing.shadow_test !== "passed") {
      throw new Error("a self-evolved Mod requires a passing shadow test before approval");
    }
    if (existing.self_evolved === true) {
      // A pass is only valid when it came from a real run AND the body has not
      // been edited since that run. Otherwise "run on a safe body, then rewrite
      // to an unsafe one" would still pass the gate.
      const expected = regressionDigest(id, String(existing.body ?? ""), []);
      const bodyDigest = existing.shadow_body_digest === undefined || existing.shadow_body_digest === null ? null : String(existing.shadow_body_digest);
      const provenance = existing.shadow_provenance === undefined || existing.shadow_provenance === null ? null : String(existing.shadow_provenance);
      if (!provenance || !bodyDigest || bodyDigest !== expected) {
        throw new Error("a self-evolved Mod requires a passing shadow test bound to its current body");
      }
    }
    const now = new Date().toISOString();
    const payload = { ...existing, status: "active", enabled: true, approved_by: actor, approved_at: now, updated_at: now };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  enable(args: JsonObject): ModRecord { return this.#setEnabled(args, true); }
  disable(args: JsonObject): ModRecord { return this.#setEnabled(args, false); }

  #setEnabled(args: JsonObject, enabled: boolean): ModRecord {
    const id = text(args.id, "id");
    const existing = this.store.find("mod", id);
    if (!existing) throw new Error(`Unknown mod: ${id}`);
    const now = new Date().toISOString();
    const payload = { ...existing, enabled, updated_at: now };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  revoke(args: JsonObject): ModRecord {
    const id = text(args.id, "id");
    const existing = this.store.find("mod", id);
    if (!existing) throw new Error(`Unknown mod: ${id}`);
    const now = new Date().toISOString();
    const payload = { ...existing, status: "revoked", enabled: false, updated_at: now };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  /**
   * Git 风格回滚：把一条 Mod 恢复到某个历史稳定版本，写为一个新版本而不是
   * 抹掉历史。审批签名与影子测试状态一并恢复，回滚本身留痕（rolled_back_from）。
   */
  rollback(args: JsonObject): ModRecord {
    const id = text(args.id, "id");
    const target = Number(args.to_version);
    if (!Number.isInteger(target) || target < 1) throw new Error("to_version must be a positive integer");
    const current = this.store.find("mod", id);
    if (!current) throw new Error(`Unknown mod: ${id}`);
    const historical = this.store.find("mod", id, target);
    if (!historical) throw new Error(`Mod ${id} has no version ${target}`);
    if (Number(historical.version) >= Number(current.version)) throw new Error("to_version must be older than the current version");
    const now = new Date().toISOString();
    const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...body } = historical;
    const payload = { ...body, id, version: Number(current.version) + 1,
      created_at: String(current.created_at), updated_at: now,
      rolled_back_from: Number(current.version), rolled_back_to: target, rolled_back_at: now };
    this.store.save("mod", id, payload);
    return toRecord(payload);
  }

  list(args: JsonObject = {}): JsonObject {
    const status = args.status === undefined || args.status === null ? null : normalizeStatus(args.status);
    const appliesTo = args.applies_to === undefined || args.applies_to === null ? null : normalizeAppliesTo(args.applies_to);
    const items = this.store
      .list("mod", 1_000, (item) => (status === null || item.status === status)
        && (appliesTo === null || item.applies_to === appliesTo || item.applies_to === "all"))
      .map(toRecord)
      .sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || (a.updatedAt < b.updatedAt ? 1 : -1));
    return { items };
  }

  /**
   * Cognitive overlay for a scope: the concatenation of every active, enabled
   * Mod whose applies_to matches and whose scope is in effect for `scope`.
   * Global Mods always apply; project/task Mods apply only when their scope id
   * matches the requested scope id of the same kind.
   */
  modSystemOverlay(scope: { kind: ModScopeKind; id: string }, appliesTo: ModAppliesTo = "worker",
    activePluginIds: readonly string[] = []): string {
    const active = new Set(activePluginIds);
    const matching = this.store.list("mod", 1_000, (item) => {
      if (item.status !== "active" || item.enabled !== true) return false;
      if (!(item.applies_to === appliesTo || item.applies_to === "all")) return false;
      if (item.plugin_id !== undefined && item.plugin_id !== null) return active.has(String(item.plugin_id));
      if (item.scope_kind === "global") return true;
      return item.scope_kind === scope.kind && String(item.scope_id) === String(scope.id);
    });
    return matching
      .map((item) => `# Mod: ${String(item.name)}\n${String(item.body)}`)
      .join("\n\n");
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function bodyText(value: unknown): string {
  if (typeof value !== "string") throw new Error("body must be a string");
  if (value.length > 20_000) throw new Error("body must be 20000 characters or fewer");
  return value;
}

function boundedActor(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must name the approving operator`);
  const trimmed = value.trim();
  if (trimmed.length > 120 || /[\r\n\0]/.test(trimmed)) throw new Error(`${name} must be a single line, 120 chars or fewer`);
  return trimmed;
}
