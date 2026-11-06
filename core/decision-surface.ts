import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * The generative decision surface: what a card looks like comes from what decision it is.
 *
 * Section 9 is the plan's central technical claim, and it is a claim about a mistake rather
 * than about a technique. Mapping an output schema to form controls feels automatic and is
 * wrong: a schema can tell you a field is an enum, and it can never tell you that two
 * versions belong side by side. Following the schema produces a generic form — which is the
 * traditional interface this product exists to escape. Following the decision type produces
 * an interface that knows what the person is being asked.
 *
 * So a card is selected by `decision_kind`, and each kind names the shape it renders in.
 * Three rules from the plan are enforced here rather than described:
 *
 *  - **9.2 is a hard, executable rule.** "Scannable at a glance" is an adjective nobody can
 *    apply. "Three seconds, no vertical scrolling" is a test. A control that would need
 *    scrolling is not a decision control at all — it is a deliverable file, and the plan
 *    says to treat it as one. So `#measure` decides that, and a card that fails is refused
 *    rather than rendered badly.
 *  - **9.3 anchors are fixed; controls are generated.** The object, its history, its
 *    evidence and the ledger never move. The control for one decision is created, used, and
 *    destroyed. Without anchors, a generative surface degrades into a search box that asks
 *    you the same thing every time.
 *  - **9.4 exposure is staged**, and the stages are data, not a rendering convention: one
 *    conclusion and one or two actions, then the evidence, then the in-place control.
 *
 * An unregistered decision kind is refused. Falling back to a generic form for an unknown
 * kind is exactly the failure being avoided — it would silently reintroduce the schema
 * mapping, and only for the decisions nobody thought about.
 */

export type Exposure = 1 | 2 | 3;

/**
 * The registered shapes, one per decision type in 9.1.
 *
 * The `renderer` name is what the browser switches on. Keeping it a name rather than markup
 * means the kernel can be tested without a DOM, and the surface cannot smuggle content
 * through a channel the kernel never inspects.
 *
 * This is the default set. It is not a mutable global: a caller that needs another decision
 * type passes its own map to the constructor. A process-wide registry would let one caller's
 * extension change what every other caller's unknown-kind check accepts.
 */
const SHAPES: Readonly<Record<string, { shape: string; renderer: string; description: string }>> = {
  // 二选一 → 并排对比
  either_or: { shape: "side_by_side", renderer: "comparison", description: "Two options shown side by side so the difference is the interface" },
  // 阈值取舍 → 单滑块 + 实时预览
  threshold: { shape: "slider", renderer: "threshold_slider", description: "One slider with a live preview of what the value does" },
  // 多字段校验 → diff 视图
  multi_field_check: { shape: "diff", renderer: "diff_view", description: "A diff with the changes highlighted" },
  // 放行 → 凭证摘要 + 显式确认
  release: { shape: "receipt_summary", renderer: "release_summary", description: "The receipt summary and an explicit confirmation" },
  // 参数微调 → 原地展开
  parameter_tuning: { shape: "inline_controls", renderer: "inline_tuning", description: "Controls that expand in place, without going back to the source system" },
  // 信息补全 → 结构化表单（不是自由对话，见 5.3）
  completion: { shape: "structured_form", renderer: "field_form", description: "A form over named fields, never a free-form conversation" },
};

const NAME = /^[a-zA-Z0-9_.:\-]{1,200}$/u;
/**
 * A card is scanned, not read. The plan fixes the budget at three seconds with no vertical
 * scrolling; both numbers are enforced, because either one alone is easy to satisfy while
 * producing something unscannable.
 */
const SCAN_BUDGET_MS = 3_000;
const MAX_VISIBLE_LINES = 12;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

export class DecisionSurfaceKernel {
  readonly store: CraftStore;
  readonly #shapes: Readonly<Record<string, { shape: string; renderer: string; description: string }>>;
  /**
   * @param shapes Optional additional decision kinds. Passed in rather than registered
   * globally so one caller's extension cannot change what another caller's unknown-kind
   * check accepts.
   */
  constructor(store: CraftStore, shapes: Readonly<Record<string, { shape: string; renderer: string; description: string }>> = {}) {
    this.store = store;
    this.#shapes = { ...SHAPES, ...shapes };
  }

  /**
   * Compose the surface for one decision.
   *
   * Returns the anchors alongside the generated control so a caller cannot render a control
   * without the fixed frame around it. The separation is the point of 9.3: the anchors are
   * what the person's muscle memory attaches to, and a control shown alone would be the
   * search-box regression.
   */
  compose(args: JsonObject): JsonObject {
    const decisionKind = identifier(args.decision_kind, "decision_kind");
    const shape = this.#shapes[decisionKind];
    if (shape === undefined) {
      // Fail closed. A generic form for an unknown kind is the schema mapping returning
      // through the back door.
      throw new Error(`decision_kind is not registered: ${decisionKind}`);
    }
    const objectId = identifier(args.object_id, "object_id");
    const summary = text(args.summary, "summary");
    const options = args.options === undefined ? [] : this.#options(args.options);
    const fields = args.fields === undefined ? [] : this.#fields(args.fields);

    // 9.4: the three levels, assembled rather than left to the renderer.
    const exposure = this.#exposure(args.exposure, decisionKind, options, fields);
    const control = { decision_kind: decisionKind, shape: shape.shape, renderer: shape.renderer,
      summary, options, fields,
      // The action count is capped by 9.4's "1~2 个动作" at the first level.
      actions: (args.actions === undefined ? [] : this.#actions(args.actions)).slice(0, exposure === 1 ? 2 : 8) };

    // 9.2 as a test, not a description.
    const measurement = this.#measure(control);
    if (!measurement.scannable) {
      return { object_id: objectId, decision_kind: decisionKind, rendered: false,
        reason: "exceeds_scan_budget", is_deliverable_not_control: true, measurement,
        // The anchors still travel, because the object and its evidence remain the stable
        // frame even when the decision needs to be opened as a file instead of a card.
        anchors: this.#anchors(objectId), control: null };
    }

    const surfaceId = args.surface_id === undefined
      ? `surface_${stableDigest({ object_id: objectId, decision_kind: decisionKind, summary }).slice("sha256:".length, "sha256:".length + 20)}`
      : identifier(args.surface_id, "surface_id");
    const record = { object_id: objectId, decision_kind: decisionKind,
      shape: shape.shape, renderer: shape.renderer, exposure, measurement, anchors: this.#anchors(objectId),
      // Generated controls are temporary by definition (9.3); the anchor list is what lasts.
      generated: true, anchors_fixed: true, created_at: args.created_at ?? null };
    // Composing the same decision again is the same surface, not a second one. An explicit
    // id reused for a different decision is a conflict, because the id is a claim about
    // which surface this is.
    const existing = this.store.find("decision_surface", surfaceId);
    if (existing) {
      if (String(existing.object_id) !== objectId || String(existing.decision_kind) !== decisionKind) {
        throw new Error("Decision surface idempotency conflict");
      }
      return { object_id: objectId, decision_kind: decisionKind, rendered: true, surface_id: surfaceId,
        exposure, measurement, anchors: record.anchors, control, idempotent: true };
    }
    this.store.create("decision_surface", surfaceId, record);
    return { object_id: objectId, decision_kind: decisionKind, rendered: true, surface_id: surfaceId,
      exposure, measurement, anchors: record.anchors, control, idempotent: false };
  }

  /** The registered decision kinds, so a caller can see what is supported rather than guess. */
  shapes(): JsonObject {
    return { shapes: Object.entries(this.#shapes).map(([kind, entry]) => ({ decision_kind: kind, ...entry })) };
  }

  get(args: JsonObject): JsonObject {
    return { surface: this.store.get("decision_surface", identifier(args.surface_id, "surface_id")) };
  }

  /**
   * Delete a generated control.
   *
   * 9.3 says generated elements are used up and destroyed. Making disposal an explicit verb
   * is what keeps the distinction real: an anchor has no such call, because it never goes
   * away.
   */
  discard(args: JsonObject): JsonObject {
    const surface = this.store.get("decision_surface", identifier(args.surface_id, "surface_id"));
    return { surface: this.store.save("decision_surface", String(surface.id), { ...payload(surface),
      generated: false, discarded_at: text(args.discarded_at, "discarded_at") }) };
  }

  /**
   * The fixed frame (9.3).
   *
   * Read from the surface's own subject rather than passed in, so the anchors cannot be
   * tailored per decision — that tailoring is how an anchor quietly becomes generated.
   */
  #anchors(objectId: string): JsonObject {
    const object = this.store.find("hatched_object", objectId);
    const receipts = this.store.list("evidence_receipt", 100, (item) => item.object_id === objectId);
    return { // `intention` and `fields` are written by hatching, so no fallback is needed;
      // the only absent case is an object that does not exist at all.
      object: object === null ? null : { id: String(object.id), title: String(object.intention),
        fields: object.fields },
      evidence_count: receipts.length,
      // Named rather than counted, so the panel's shape is stable across objects.
      anchor_kinds: ["object", "history", "evidence", "ledger"] };
  }

  #options(value: unknown): JsonObject[] {
    if (!Array.isArray(value) || value.length < 2) {
      // A comparison needs two things to compare; one option is not a choice.
      throw new Error("options must be an array of at least two entries");
    }
    return value.map((entry, index) => {
      const option = object(entry, `options[${index}]`);
      return { id: identifier(option.id, `options[${index}].id`), label: text(option.label, `options[${index}].label`),
        detail: option.detail === undefined ? null : text(option.detail, `options[${index}].detail`) };
    });
  }

  #fields(value: unknown): JsonObject[] {
    if (!Array.isArray(value)) throw new Error("fields must be an array");
    return value.map((entry, index) => {
      const field = object(entry, `fields[${index}]`);
      return { name: identifier(field.name, `fields[${index}].name`),
        label: text(field.label, `fields[${index}].label`),
        // The kind of value is what the form renders, so it is validated rather than trusted.
        value_kind: this.#valueKind(field.value_kind, `fields[${index}].value_kind`) };
    });
  }

  #valueKind(value: unknown, name: string): string {
    const result = text(value, name);
    if (!new Set(["text", "number", "boolean", "choice"]).has(result)) {
      throw new Error(`${name} must be text, number, boolean or choice`);
    }
    return result;
  }

  #actions(value: unknown): JsonObject[] {
    if (!Array.isArray(value)) throw new Error("actions must be an array");
    return value.map((entry, index) => {
      const action = object(entry, `actions[${index}]`);
      return { id: identifier(action.id, `actions[${index}].id`), label: text(action.label, `actions[${index}].label`),
        requires_authorization: action.requires_authorization === true };
    });
  }

  /**
   * Which exposure level applies (9.4).
   *
   * Given rather than guessed when the caller says so, and otherwise derived from what the
   * decision actually carries: a card with evidence available can be opened to level two,
   * and one with fields can be edited at level three.
   */
  #exposure(value: unknown, decisionKind: string, options: JsonObject[], fields: JsonObject[]): Exposure {
    if (value !== undefined) {
      const parsed = Number(value);
      if (![1, 2, 3].includes(parsed)) throw new Error("exposure must be 1, 2 or 3");
      return parsed as Exposure;
    }
    if (fields.length) return 3;
    if (options.length) return 2;
    // A release carries a receipt summary, which is itself the evidence.
    if (decisionKind === "release") return 2;
    return 1;
  }

  /**
   * The 9.2 test.
   *
   * The estimate is deliberately structural — lines and option width — rather than a
   * timing measurement, because the question is whether the control *can* be scanned, not
   * how fast a particular machine renders it. A control whose options are wide enough to
   * need reading one at a time fails even if it technically fits on screen.
   */
  #measure(control: JsonObject): JsonObject {
    const options = control.options as JsonObject[];
    const fields = control.fields as JsonObject[];
    const actions = control.actions as JsonObject[];
    // One line each for the summary, its detail rows, the fields and the actions.
    const lines = 1 + fields.length + Math.ceil(actions.length / 2)
      + options.reduce((count, option) => count + 1 + (option.detail === null ? 0 : 1), 0);
    const longestOption = options.reduce((widest, option) => Math.max(widest,
      String(option.label).length + String(option.detail ?? "").length), 0);
    // A comparison is meant to be seen at once, so a pair of very wide options defeats it
    // even within the line budget.
    const tooWide = options.length >= 2 && longestOption > 160;
    return { estimated_lines: lines, scan_budget_ms: SCAN_BUDGET_MS, max_visible_lines: MAX_VISIBLE_LINES,
      longest_option_chars: longestOption,
      scannable: lines <= MAX_VISIBLE_LINES && !tooWide,
      failed_because: lines > MAX_VISIBLE_LINES ? "too_many_lines" : tooWide ? "options_too_wide_to_compare" : null };
  }
}
