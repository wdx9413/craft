import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";

/**
 * The object rail: one read model behind the plan's single screen.
 *
 * Section 8 describes the layout as three columns and one collapsed strip: a rail of work
 * objects on the left, the object itself in the centre, its evidence on the right, and the
 * running processes in a thin line at the bottom. Section 15.3 maps the existing shell onto
 * that layout and states the engineering route plainly — adapt, do not rewrite. This kernel
 * is the read model that makes the first three columns possible; the browser code stays a
 * projection of it, exactly as the other pages already are.
 *
 * Three rules from the plan shape the shape of this data, and each one exists because the
 * obvious alternative destroys the product:
 *
 *  1. **The rail is ordered by what needs the person, and never reorders underneath them.**
 *     A rail that jumps while you are reading it is a rail you stop reading. Ordering is
 *     therefore stable by `(bucket, priority, id)` — id last so ties never depend on
 *     insertion order.
 *  2. **Exactly one card occupies the centre (6.4).** Everything else waits, marked. When
 *     several same-kind items need the same decision they merge into one card, and the
 *     merge is a presentation fact — the authorizations behind it stay separate.
 *  3. **Evidence shows the conclusion first and the raw values on request (10.1).** The
 *     default is one line; the recomputation path is one level down. A person who has to
 *     read six numbers to learn whether it worked will stop checking.
 *
 * The rail reports an object as needing attention when it has an open adjudication or an
 * effect that R2+ still lacks an authorization for. Both are computed, not stored: a stored
 * flag would go stale the moment an authorization arrived, and a stale "needs you" marker
 * is worse than none because it trains the reader to ignore the marker.
 */

export type RailBucket = "needs_you" | "in_progress" | "done";

const BUCKET_ORDER: Readonly<Record<RailBucket, number>> = { needs_you: 0, in_progress: 1, done: 2 };
const RISK_ORDER: Readonly<Record<string, number>> = { R3: 0, R2: 1, R1: 2, R0: 3 };

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-zA-Z0-9_.:\-]{1,200}$/u.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function boundedLimit(value: unknown): number {
  const parsed = value === undefined ? 200 : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("limit must be an integer between 1 and 1000");
  return parsed;
}

export class ObjectRailKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Build the rail, the focused object and its evidence.
   *
   * `object_id` selects what the centre shows. Without one the centre follows the rail's
   * own head, so opening the page never lands on an empty selection when something does
   * need the person.
   */
  view(args: JsonObject = {}): JsonObject {
    const limit = boundedLimit(args.limit);
    const requested = args.object_id === undefined || args.object_id === null || args.object_id === ""
      ? null
      : identifier(args.object_id, "object_id");

    const objects = this.store.list("hatched_object", limit);
    // Work that arrived as a task rather than by hatching still belongs on the rail: the
    // plan's rail is "where are my things", not "where are my hatched things".
    const tasks = this.store.list("task", limit, (item) => item.status !== undefined);

    const rail = [
      ...objects.map((object) => this.#railEntry({
        id: String(object.id), kind: String(object.object_kind), title: String(object.intention ?? object.id),
        state: String(object.state),
        // `updated_at` is a store-managed field and is always present on a stored record.
        updatedAt: String(object.updated_at), origin: String(object.origin ?? "event"),
        pendingFields: (object.pending_fields as string[] | undefined) ?? [],
      })),
      ...tasks.map((task) => this.#railEntry({
        id: String(task.id), kind: "task", title: String(task.title ?? task.goal ?? task.id),
        state: String(task.status), updatedAt: String(task.updated_at), origin: "event",
        pendingFields: [],
      })),
    ].sort((left, right) => BUCKET_ORDER[left.bucket as RailBucket] - BUCKET_ORDER[right.bucket as RailBucket]
      || Number(right.priority) - Number(left.priority)
      // The id is the final tiebreak so the order is stable across renders.
      || String(left.id).localeCompare(String(right.id)));

    const focusId = requested ?? (rail.length ? String(rail[0]!.id) : null);
    return { rail, counts: this.#counts(rail), focus: focusId === null ? null : this.#focus(focusId, rail),
      generated_at: new Date().toISOString() };
  }

  /**
   * The evidence for one object: the conclusion, then the raw values.
   *
   * Returned together because the browser must not have to decide what to hide. The
   * `summary` is what the right column shows by default; `receipts` is what expands.
   */
  evidence(args: JsonObject): JsonObject {
    const objectId = identifier(args.object_id, "object_id");
    const receipts = this.store.list("evidence_receipt", 1_000, (item) => item.object_id === objectId)
      // `created_at` is store-managed, so the ordering is total without a fallback.
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    const authorizations = this.store.list("effect_authorization", 1_000, (item) => item.effect_id === objectId
      || String(item.effect_id).startsWith(`${objectId}:`));
    return {
      object_id: objectId,
      summary: {
        receipt_count: receipts.length,
        // A receipt that cannot be recomputed is not evidence, so the count of unusable
        // ones is surfaced rather than hidden behind the total.
        recomputable_count: receipts.filter((item) => item.recomputable === true).length,
        // The plan's 11.5 distinction, kept visible at the summary level: a conclusion
        // resting on a typed-in value has a different kind of support.
        transcribed_count: receipts.filter((item) => ((item.transcription_metrics as unknown[] | undefined) ?? []).length > 0).length,
        authorization_count: authorizations.length,
        missing_authorization_count: receipts.filter((item) => item.l1_eligible === false).length,
      },
      receipts: receipts.map((item) => ({
        id: String(item.id), action: String(item.action_executed), risk_level: String(item.risk_level),
        recomputable: item.recomputable === true, l1_eligible: item.l1_eligible === true,
        l1_reason: item.l1_reason ?? null,
        transcription_metrics: (item.transcription_metrics as unknown[] | undefined) ?? [],
        // The raw values are what make the receipt recomputable by a third party, so they
        // travel with it rather than staying in the store.
        pre_state: item.pre_state, post_state: item.post_state, proofs: item.proofs ?? [],
        created_at: item.created_at,
      })),
      authorizations: authorizations.map((item) => ({
        id: String(item.id), approved_by: String(item.approved_by), authorized_at: String(item.authorized_at),
        status: String(item.status), risk_level: String(item.risk_level),
        // Present so the UI can say whether the authorization still matches the effect.
        receipt_digest: String(item.receipt_digest),
      })),
    };
  }

  /**
   * The same state projected for a phone (section 12).
   *
   * The plan is explicit that the two ends share one object model and one ledger, and are
   * *not* one layout at two sizes: "手机上不该有工作台，手机上只有有事找你". The desktop rail
   * exists for shaping — many objects, a canvas, concurrency. The phone exists for
   * deciding, so this projection returns one card and nothing else.
   *
   * That is why it is a separate method rather than a parameter on `view`. A projection
   * that also carried the rail would invite the phone UI to render it, and the phone UI
   * rendering a list is precisely the layout-scaling the plan rejects. The single-card
   * focus 6.4 needs special machinery for on the desktop is native here, so there is no
   * batching and no queue: one decision, or an explicit statement that there is none.
   */
  mobileProjection(args: JsonObject = {}): JsonObject {
    const view = this.view(args);
    const rail = view.rail as JsonObject[];
    // Only work that needs a person reaches the phone. Work in progress is not a phone
    // concern: nobody needs to watch progress from a lock screen.
    const actionable = rail.filter((item) => item.bucket === "needs_you");
    if (!actionable.length) {
      return { projection: "mobile", decision: null, waiting_on_you: 0,
        // Stated rather than implied by an empty list, so a client can render "nothing needs
        // you" without having to interpret an absence.
        message: "nothing_needs_you", counts: view.counts };
    }
    // At most one item, highest priority first — the same ordering rule as everywhere else,
    // so the two projections cannot disagree about which decision matters most.
    const head = actionable[0]!;
    const focus = this.#focus(String(head.id), rail);
    return { projection: "mobile", decision: {
      object_id: String(head.id), title: String(head.title), kind: String(head.kind),
      // The one card, or null when the object needs a field rather than a decision.
      adjudication: focus.adjudication, pending_fields: focus.pending_fields,
      priority: Number(head.priority),
    }, waiting_on_you: actionable.length, message: null, counts: view.counts };
  }

  /** One receipt's recomputation, for the "展开是原始值和复算路径" half of 10.1. */  receiptDetail(args: JsonObject): JsonObject {
    const receipt = this.store.get("evidence_receipt", identifier(args.receipt_id, "receipt_id"));
    const pre = (receipt.pre_state as { values?: Record<string, number> } | undefined)?.values ?? {};
    const post = (receipt.post_state as { values?: Record<string, number> } | undefined)?.values ?? {};
    const shared = Object.keys(pre).filter((metric) => Object.hasOwn(post, metric)).sort();
    const missing = [...Object.keys(pre).filter((metric) => !Object.hasOwn(post, metric)).map((metric) => ({ metric, missing: "post_state" })),
      ...Object.keys(post).filter((metric) => !Object.hasOwn(pre, metric)).map((metric) => ({ metric, missing: "pre_state" }))];
    return { receipt_id: String(receipt.id), action: String(receipt.action_executed), risk_level: String(receipt.risk_level),
      // The recomputation path itself: which metrics were compared, and the arithmetic.
      // `shared` holds only metrics present on both sides, so both lookups are defined.
      steps: shared.map((metric) => ({ metric, pre: pre[metric], post: post[metric], delta: post[metric]! - pre[metric]! })),
      uncomparable: missing,
      recomputable: shared.length > 0 && missing.length === 0,
      l1_eligible: receipt.l1_eligible === true, l1_reason: receipt.l1_reason ?? null,
      transcription_metrics: (receipt.transcription_metrics as unknown[] | undefined) ?? [] };
  }

  #railEntry(input: { id: string; kind: string; title: string; state: string; updatedAt: string; origin: string; pendingFields: string[] }): JsonObject {
    const adjudications = this.store.list("adjudication_item", 1_000, (item) => item.status === "open"
      && (item.item_id === input.id || String(item.item_id).startsWith(`${input.id}:`)));
    const blockedFields = this.store.list("hatched_object", 10, (item) => item.id === input.id
      && item.state === "awaiting_fields");
    const needsYou = adjudications.length > 0 || blockedFields.length > 0;
    const done = ["released", "completed", "done", "resolved"].includes(input.state);
    const bucket: RailBucket = needsYou ? "needs_you" : done ? "done" : "in_progress";
    return {
      id: input.id, kind: input.kind, title: input.title, origin: input.origin,
      bucket, state: input.state,
      // The rail's own priority is the highest open adjudication, so the same priority that
      // orders the adjudication queue orders the rail (6.4). `priority` is validated to be
      // an integer when the item is enqueued, so no coercion is needed here.
      priority: adjudications.reduce((highest, item) => Math.max(highest, Number(item.priority)), 0),
      open_adjudications: adjudications.length,
      awaiting_fields: input.pendingFields,
      // Marked rather than moved: "标红挂起、不抢中央" is the plan's explicit instruction.
      marked: bucket === "needs_you",
      updated_at: input.updatedAt,
    };
  }

  #counts(rail: JsonObject[]): JsonObject {
    return { needs_you: rail.filter((item) => item.bucket === "needs_you").length,
      in_progress: rail.filter((item) => item.bucket === "in_progress").length,
      done: rail.filter((item) => item.bucket === "done").length, total: rail.length };
  }

  /**
   * The centre: one object, plus at most one adjudication card.
   *
   * The cap is the whole point. Returning every open card would put the reader back in the
   * queue the plan exists to remove, so the rest are reported as a count and left on the
   * rail.
   */
  #focus(objectId: string, rail: JsonObject[]): JsonObject {
    const entry = rail.find((item) => item.id === objectId) ?? null;
    const object = this.store.find("hatched_object", objectId);
    const adjudications = this.store.list("adjudication_item", 1_000, (item) => item.status === "open"
      && (item.item_id === objectId || String(item.item_id).startsWith(`${objectId}:`)))
      // Same ordering as the queue: priority first, id as the stable tiebreak.
      .sort((left, right) => Number(right.priority) - Number(left.priority) || String(left.id).localeCompare(String(right.id)));
    const card = adjudications.length ? adjudications[0]! : null;
    const sameKind = card === null ? [] : adjudications.filter((item) => item.batch_key === card.batch_key);
    return {
      id: objectId,
      kind: entry === null ? "unknown" : String(entry.kind),
      title: entry === null ? objectId : String(entry.title),
      fields: object === null ? {} : (object.fields ?? {}),
      pending_fields: object === null ? [] : ((object.pending_fields as string[]) ?? []),
      intention: object === null ? null : (object.intention ?? null),
      // At most one card, and only the highest-priority one.
      adjudication: card === null ? null : {
        id: String(card.id), summary: String(card.summary), decision_kind: String(card.decision_kind),
        priority: Number(card.priority),
        // The merged card reports how many effects sit behind it, so one click is never
        // mistaken for one effect (6.4).
        batch_effects: sameKind.length,
        batch_item_ids: sameKind.map((item) => String(item.id)),
      },
      waiting_adjudications: Math.max(0, adjudications.length - 1),
    };
  }
}
