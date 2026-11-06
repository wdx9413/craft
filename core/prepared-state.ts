import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { payload, stableDigest } from "./digest.ts";

/**
 * Prepared state: the thing a person actually approved, so a stale approval cannot execute.
 *
 * The plan's "prepare then release" flow has a window between showing a state and acting on
 * it (13A.3.2). In that window the page can change — a session can expire, data can
 * refresh, another actor can move the record. A release that does not re-check is not
 * approving the state the person saw; it is approving the *action*, which they may never
 * have seen at all. This kernel makes the approved state explicit and re-verifies it.
 *
 * The plan is specific about what the digest is taken over (13A.3.3), and the reason is a
 * trap worth restating because the obvious implementation walks into it:
 *
 * > A session token changes on every render, so "filter the non-deterministic nodes out of
 * > the DOM" looks like the right way to get a stable digest. But a token *expiring* is
 * > exactly the change most worth catching, and filtering it removes the only signal that
 * > would have caught it. Cleaning a noisy tree still leaves a tree.
 *
 * So the digest is taken over three things that are all constructed rather than scraped:
 *
 *  1. **The submit payload** — built by us, structured, clean, recomputable.
 *  2. **The page identity** — which page this is, not what it currently renders.
 *  3. **Explicit assertions** — a small set of named checks, including at least one
 *     *liveness* assertion that answers "is this session/page still usable at all".
 *
 * Liveness is required rather than optional for the same reason: a payload can match
 * perfectly while the session behind it is gone, and without a liveness assertion that
 * case is indistinguishable from success.
 *
 * When a mismatch is found the reason decides the response. A changed payload means the
 * person approved something that no longer exists, so the state must be re-presented. A
 * failed liveness assertion means the session is gone, and re-presenting the same page
 * would just show the same dead state — that needs re-authentication. Collapsing the two
 * into "re-prepare" sends an expired session into a loop.
 */

export type AssertionKind = "liveness" | "identity" | "content";
export type MismatchReason = "payload_changed" | "page_identity_changed" | "liveness_failed" | "assertion_changed";

const ASSERTION_KINDS = new Set<string>(["liveness", "identity", "content"]);
const NAME = /^[a-zA-Z0-9_.:-]{1,200}$/u;
const ASSERTION_NAME = /^[a-z][a-z0-9_.-]{0,63}$/u;

/**
 * How each mismatch is answered.
 *
 * `re_authenticate` is separate from `re_prepare` because the recovery differs: one needs
 * a new session, the other needs the person to look again. A single "retry" would leave an
 * expired session retrying forever.
 */
export const MISMATCH_RECOVERY: Readonly<Record<MismatchReason, string>> = {
  payload_changed: "re_prepare",
  page_identity_changed: "re_prepare",
  assertion_changed: "re_prepare",
  liveness_failed: "re_authenticate",
};

function identifier(value: unknown, name: string): string {
  const result = text(value, name);
  if (!NAME.test(result)) throw new Error(`${name} contains unsupported characters`);
  return result;
}

/**
 * A page identity, which is a URL-like string rather than a bare id.
 *
 * Kept separate from {@link identifier} because a page identity legitimately contains
 * `://`, `/` and `?`, all of which a bare id must not. Folding them together would either
 * reject every real page or loosen the id check that protects record keys.
 */
const PAGE_IDENTITY = /^[a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/[^\s]{1,400}$/u;
function pageIdentity(value: unknown): string {
  const result = text(value, "page_identity");
  if (!PAGE_IDENTITY.test(result)) throw new Error("page_identity must be a scheme-qualified location without whitespace");
  return result;
}

function scalar(value: unknown, name: string): string | number | boolean {
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`${name} must be a string, number or boolean`);
}

/**
 * The payload: flat named values that will be submitted.
 *
 * Flat and scalar on purpose. A nested structure would need a canonicalization rule to
 * digest reproducibly, and every rule added there is a way for two callers to disagree
 * about whether they prepared the same thing. Flat values cannot disagree.
 */
function submitPayload(value: unknown): Record<string, string | number | boolean> {
  const raw = object(value, "submit_payload");
  const entries = Object.entries(raw);
  if (!entries.length) throw new Error("submit_payload must carry at least one field");
  const payloadFields: Record<string, string | number | boolean> = {};
  for (const [key, field] of entries) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key)) throw new Error(`submit_payload.${key} is not a valid field name`);
    payloadFields[key] = scalar(field, `submit_payload.${key}`);
  }
  return payloadFields;
}

/**
 * Assertions: named observations about the page at prepare time.
 *
 * Each assertion carries the value that was observed, not just a pass/fail. Storing the
 * observed value is what lets a later release say *what* changed — "the confirm step moved"
 * rather than "something differs".
 */
function assertions(value: unknown): JsonObject[] {
  if (value === undefined) throw new Error("assertions are required; a prepared state with no assertions cannot detect a stale page");
  if (!Array.isArray(value) || !value.length) throw new Error("assertions must be a non-empty array");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const entry = object(raw, `assertions[${index}]`);
    const name = text(entry.name, `assertions[${index}].name`);
    if (!ASSERTION_NAME.test(name)) throw new Error(`assertions[${index}].name is not a valid assertion name`);
    if (seen.has(name)) throw new Error(`assertions contains a duplicate name: ${name}`);
    seen.add(name);
    const kind = text(entry.kind, `assertions[${index}].kind`);
    if (!ASSERTION_KINDS.has(kind)) throw new Error(`assertions[${index}].kind must be liveness, identity or content`);
    return { name, kind, observed: scalar(entry.observed, `assertions[${index}].observed`) };
  });
}

export class PreparedStateKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Record a prepared state and its digest.
   *
   * The digest covers payload, page identity and every assertion together, so a change to
   * any of them is a change to what was approved. It is computed here rather than accepted
   * from the caller: a digest supplied by the caller would let a release verify against a
   * value the caller chose, which is the circularity the whole mechanism exists to avoid.
   */
  prepare(args: JsonObject): JsonObject {
    const preparedId = identifier(args.prepared_id, "prepared_id");
    const currentPage = pageIdentity(args.page_identity);
    const submit = submitPayload(args.submit_payload);
    const observed = assertions(args.assertions);
    if (!observed.some((entry) => entry.kind === "liveness")) {
      throw new Error("prepared state requires at least one liveness assertion; without it an expired session is indistinguishable from success");
    }
    const digest = stableDigest({ page_identity: currentPage, submit_payload: submit, assertions: observed });
    const existing = this.store.find("prepared_state", preparedId);
    if (existing) {
      if (existing.prepared_state_digest !== digest) throw new Error("Prepared state idempotency conflict");
      return { prepared_state: existing, idempotent: true };
    }
    const prepared = this.store.create("prepared_state", preparedId, {
      page_identity: currentPage, submit_payload: submit, assertions: observed,
      prepared_state_digest: digest, status: "prepared",
      // The payload is the person's data; the digest is what protects it. Neither is a
      // credential, but the record is marked content-free to match the rest of the store.
      content_stored: false,
    });
    return { prepared_state: prepared, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    return { prepared_state: this.store.get("prepared_state", identifier(args.prepared_id, "prepared_id")) };
  }

  /**
   * Re-verify the prepared state at release time (13A.3.2 rule 2).
   *
   * The caller re-states the whole thing — payload, page identity and assertions as they
   * are *now* — and the digest is recomputed and compared. Re-stating the payload rather
   * than reusing the stored one is what makes `payload_changed` reachable: if the release
   * only ever hashed the stored payload, a form whose values silently reset would pass
   * verification and submit the wrong thing.
   *
   * The first failing check decides the reason, in a deliberate order: missing assertions,
   * then page identity, then liveness, then other assertions, then the payload digest.
   * Liveness precedes content because an expired session invalidates every other
   * observation on the page — a content assertion that "passed" on a login screen is not
   * evidence about the page the person saw.
   */
  release(args: JsonObject): JsonObject {
    const prepared = this.store.get("prepared_state", identifier(args.prepared_id, "prepared_id"));
    const currentPage = pageIdentity(args.page_identity);
    const submit = submitPayload(args.submit_payload);
    const current = assertions(args.observed);
    const declared = prepared.assertions as JsonObject[];
    const byName = new Map(declared.map((entry) => [String(entry.name), entry]));

    // An assertion the release does not re-state is a failure, not a pass. The plan calls
    // this fail-closed (13A.3.3 rule 2): what cannot be checked may not be assumed.
    const missing = declared.filter((entry) => !current.some((item) => item.name === entry.name)).map((entry) => String(entry.name)).sort();
    const unexpected = current.filter((entry) => !byName.has(String(entry.name))).map((entry) => String(entry.name)).sort();
    const currentDigest = stableDigest({ page_identity: currentPage, submit_payload: submit, assertions: current });

    let reason: MismatchReason | null = null;
    if (missing.length || unexpected.length) reason = "assertion_changed";
    else if (currentPage !== String(prepared.page_identity)) reason = "page_identity_changed";
    else {
      // Liveness is checked before content so an expired session is reported as such even
      // when a content assertion also moved.
      const failedLiveness = current.find((entry) => {
        const declaredEntry = byName.get(String(entry.name))!;
        return declaredEntry.kind === "liveness" && declaredEntry.observed !== entry.observed;
      });
      const failedOther = current.find((entry) => {
        const declaredEntry = byName.get(String(entry.name))!;
        return declaredEntry.kind !== "liveness" && declaredEntry.observed !== entry.observed;
      });
      if (failedLiveness) reason = "liveness_failed";
      else if (failedOther) reason = "assertion_changed";
    }
    // The digest comparison catches a payload that changed while every assertion held,
    // which is the case a form reset produces.
    if (reason === null && currentDigest !== String(prepared.prepared_state_digest)) reason = "payload_changed";

    if (reason !== null) {
      // A refusal does not consume the prepared state: the person may re-prepare and
      // release again, and recording a failed attempt as terminal would force a new
      // prepare for a transient refresh.
      return { released: false, reason, recovery: MISMATCH_RECOVERY[reason],
        prepared_state_digest: prepared.prepared_state_digest, current_digest: currentDigest,
        missing_assertions: missing, unexpected_assertions: unexpected };
    }

    // The release binds to the digest it verified (13A.3.2 rule 3), so a later audit can
    // tell which state the approval was given against.
    const releaseId = identifier(args.release_id, "release_id");
    const existing = this.store.find("prepared_release", releaseId);
    if (existing) {
      if (existing.prepared_id !== prepared.id) throw new Error("Prepared release idempotency conflict");
      return { released: true, release: existing, idempotent: true };
    }
    const release = this.store.create("prepared_release", releaseId, {
      prepared_id: prepared.id, approved_by: text(args.approved_by, "approved_by"),
      bound_digest: prepared.prepared_state_digest, submit_payload: submit,
      released_at: text(args.released_at, "released_at"), content_stored: false,
    });
    const consumed = this.store.save("prepared_state", String(prepared.id), { ...payload(prepared), status: "released" });
    return { released: true, release, prepared_state: consumed, idempotent: false };
  }
}
