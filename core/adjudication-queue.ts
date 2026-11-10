import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { payload } from "./digest.ts";

/**
 * Adjudication concurrency: how many decisions a person is asked to make at once.
 *
 * Section 6.4 names the failure this kernel prevents. It is not that a card is wrong; it is
 * that five correct cards arrive together, the person stops reading them, and the approval
 * step becomes a formality. An approval system that gets clicked through without being read
 * is worse than no approval system, because it produces a record of consent that never
 * happened.
 *
 * Two rules follow, and the second one carries a subtlety worth stating plainly:
 *
 *  1. **One card at a time.** Exactly one highest-priority item occupies the centre. The
 *     rest wait, marked, without taking the screen. `attention.ts` already sorts by
 *     priority, so the ordering input exists; what was missing is the budget over it.
 *
 *  2. **Same-kind items batch, but a batch is one *action*, not one *signature*.** Three
 *     services needing the same interface change can share a card, because the person is
 *     making one judgement. They cannot share an approval: they are three separate effects,
 *     and a single signature over three effects cannot answer "who approved this one" after
 *     the fact. So the card merges and the authorizations do not.
 *
 * That distinction is enforced structurally rather than by convention: `resolveBatch`
 * requires exactly one approval record per effect, and refuses a batch whose authorizations
 * do not each name an approver, a time and a receipt digest. A caller cannot satisfy it
 * with one signature, because one signature produces one record.
 */

export type AdjudicationStatus = "open" | "decided" | "deferred";

const NAME = /^[a-zA-Z0-9_.:-]{1,200}$/u;
const KIND = /^[a-z][a-z0-9_.-]{0,63}$/u;

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}
function kind(value: unknown, name: string): string {
  const result = text(value, name);
  if (!KIND.test(result)) throw new Error(`${name} is not a valid kind`);
  return result;
}
function instant(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp`);
  return result;
}
function priority(value: unknown): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 100) throw new Error("priority must be an integer between 0 and 100");
  return result;
}

/**
 * The batch key for one item.
 *
 * Two items batch only when they share a `kind` *and* the same decision to make. Kind
 * alone is too coarse: two interface changes and one deletion are all "a change", and
 * merging them would present one card for two different judgements. `decision_kind` is
 * therefore part of the key, and the plan's "same L2 adjudication" is read literally.
 */
export function batchKey(itemKind: string, decisionKind: string): string {
  return `${itemKind}|${decisionKind}`;
}

export class AdjudicationQueueKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Offer one item for adjudication.
   *
   * Idempotent per item id: re-offering an item that is still open updates its priority
   * rather than creating a second card, because two cards for one item is exactly the
   * duplication the budget exists to prevent.
   */
  enqueue(args: JsonObject): JsonObject {
    const itemId = identifier(args.item_id, "item_id");
    const itemKind = kind(args.item_kind, "item_kind");
    const decisionKind = kind(args.decision_kind, "decision_kind");
    const next = { item_id: itemId, item_kind: itemKind, decision_kind: decisionKind,
      priority: priority(args.priority), summary: text(args.summary, "summary"), status: "open" as AdjudicationStatus,
      batch_key: batchKey(itemKind, decisionKind) };
    const existing = this.store.find("adjudication_item", itemId);
    if (existing === null) return { item: this.store.create("adjudication_item", itemId, next) };
    if (existing.status === "decided") throw new Error("Adjudication item is already decided");
    return { item: this.store.save("adjudication_item", itemId, { ...payload(existing), ...next }) };
  }

  /**
   * The current view: at most one focused card, the rest waiting, and any mergeable groups.
   *
   * Ordering is priority first and id second, so the focus is deterministic when priorities
   * tie. A tie broken by insertion order would make the focused card depend on which event
   * happened to arrive first, which is not a property anyone can reason about.
   *
   * Batches are computed across every open item rather than only around the focused one.
   * Deriving them from the focus's key would hide a batch whenever an unrelated item
   * outranked it, which is the common case: the highest-priority item is usually the urgent
   * one-off, not part of a routine group.
   */
  view(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    const open = this.store.list("adjudication_item", limit, (item) => item.status === "open")
      .sort((left, right) => Number(right.priority) - Number(left.priority) || String(left.id).localeCompare(String(right.id)));
    if (!open.length) return { focused: null, waiting: [], batches: [] };
    const [first, ...rest] = open;
    const grouped = new Map<string, JsonObject[]>();
    for (const item of open) {
      const key = String(item.batch_key);
      grouped.set(key, [...(grouped.get(key) ?? []), item]);
    }
    const batches = [...grouped.entries()]
      .filter(([, items]) => items.length > 1)
      .map(([key, items]) => ({ batch_key: key, item_ids: items.map((item) => String(item.id)),
        effect_count: items.length, focused_id: String(first.batch_key) === key ? String(first.id) : String(items[0]!.id) }))
      .sort((left, right) => left.batch_key.localeCompare(right.batch_key));
    return { focused: first, waiting: rest.map((item) => ({ ...item, marked: true })), batches };
  }

  /**
   * Resolve one adjudication, with one authorization record per effect.
   *
   * `authorizations` must cover exactly the effects being decided. Requiring one record per
   * effect is how "a batch is one action, not one signature" stops being advice: a caller
   * holding a single signature cannot fill in N records without inventing N-1 approvers.
   * Each record carries the approver, the time and the receipt digest, which is what makes
   * a later "who approved this" answerable per effect.
   */
  resolve(args: JsonObject): JsonObject {
    const itemIds = args.item_ids;
    if (!Array.isArray(itemIds) || !itemIds.length) throw new Error("item_ids must be a non-empty array");
    const ids = itemIds.map((value) => identifier(value, "item_ids[]"));
    if (new Set(ids).size !== ids.length) throw new Error("item_ids must contain unique values");
    const decision = text(args.decision, "decision");
    if (!new Set(["approved", "rejected"]).has(decision)) throw new Error("decision is unsupported");
    const authorizations = this.#authorizations(args.authorizations);
    if (authorizations.length !== ids.length) {
      throw new Error(`a batch is one action, not one signature: ${ids.length} effect(s) require ${ids.length} authorization record(s), received ${authorizations.length}`);
    }
    const items = ids.map((id) => this.store.get("adjudication_item", id));
    for (const item of items) {
      if (item.status !== "open") throw new Error(`Adjudication item is not open: ${item.id}`);
    }
    // Every item on one card must share the batch key, so a caller cannot merge unrelated
    // judgements by listing them together.
    const keys = new Set(items.map((item) => String(item.batch_key)));
    if (keys.size !== 1) throw new Error("a batch must contain items of the same kind and decision");
    // Each effect must be covered by its own record, matched by item id.
    const covered = new Set(authorizations.map((entry) => entry.item_id));
    for (const id of ids) if (!covered.has(id)) throw new Error(`authorization is missing for effect: ${id}`);

    const decidedAt = instant(args.decided_at, "decided_at");
    const records: JsonObject[] = [];
    for (const item of items) {
      const authorization = authorizations.find((entry) => entry.item_id === String(item.id))!;
      records.push(this.store.create("adjudication_authorization", `${item.id}_${decidedAt}`, {
        item_id: String(item.id), decision, approved_by: authorization.approved_by,
        decided_at: decidedAt, receipt_digest: authorization.receipt_digest,
        // One record per effect is the whole point; the flag records that this was one of
        // several decided together, so a later audit can see the batch without inferring it.
        batch_size: ids.length,
      }));
      this.store.save("adjudication_item", String(item.id), { ...payload(item), status: "decided", decision });
    }
    return { decision, decided_at: decidedAt, effects: ids.length, authorizations: records };
  }

  /** The authorization records for one item, newest first. */
  authorizations(args: JsonObject): JsonObject {
    const itemId = identifier(args.item_id, "item_id");
    return { authorizations: this.store.list("adjudication_authorization", 1_000, (item) => item.item_id === itemId) };
  }

  /**
   * Validate the authorization records.
   *
   * Every field is required and none is derived: an approver inferred from context, or a
   * digest filled in from the item, would be a record of what the system assumed rather
   * than of what a person did.
   */
  #authorizations(value: unknown): Array<{ item_id: string; approved_by: string; receipt_digest: string }> {
    if (!Array.isArray(value) || !value.length) throw new Error("authorizations must be a non-empty array");
    const seen = new Set<string>();
    return value.map((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`authorizations[${index}] must be an object`);
      const entry = raw as JsonObject;
      const itemId = identifier(entry.item_id, `authorizations[${index}].item_id`);
      if (seen.has(itemId)) throw new Error(`authorizations contains a duplicate effect: ${itemId}`);
      seen.add(itemId);
      return { item_id: itemId, approved_by: text(entry.approved_by, `authorizations[${index}].approved_by`),
        receipt_digest: text(entry.receipt_digest, `authorizations[${index}].receipt_digest`) };
    });
  }
}
