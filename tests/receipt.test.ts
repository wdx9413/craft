import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { NON_REMEDIATION_EXITS, ReceiptKernel, REMEDIATION } from "../core/receipt.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-receipt-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, receipts: new ReceiptKernel(store) };
}

const machine = (at = "2030-01-01T00:00:00Z", checker = "sql_query") => ({ source: "machine_observed", at, checker });
const human = (at = "2030-01-01T00:00:00Z") => ({ source: "human_transcription", at, by: "u1", origin: "portal://eval3/offset" });

const base = {
  object_id: "OBJ-CDC-OFFSET",
  action_executed: "SYNC_AND_VERIFY_OFFSET",
  risk_level: "R0",
  pre_state: { offset_delay: 1200, provenance: machine("2030-01-01T00:00:00Z") },
  post_state: { offset_delay: 0, provenance: machine("2030-01-01T00:00:30Z") },
};

test("a machine-observed receipt is recomputable and eligible to support L1", async () => {
  const f = await fixture();
  try {
    const issued = f.receipts.issue(base);
    const receipt = issued.receipt as Record<string, unknown>;
    assert.equal(issued.idempotent, false);
    assert.equal(receipt.recomputable, true);
    assert.equal(receipt.l1_eligible, true);
    assert.equal(receipt.l1_reason, "machine_observed");
    assert.deepEqual(receipt.metrics, ["offset_delay"]);
    assert.deepEqual(receipt.transcription_metrics, []);
    assert.equal(receipt.content_stored, false);

    // Recomputable means a third party re-derives it from the stored raw values.
    const assessed = f.receipts.assess({ receipt_id: receipt.id });
    assert.equal(assessed.recomputable, true);
    assert.deepEqual(assessed.compared_metrics, [{ metric: "offset_delay", pre: 1200, post: 0, delta: -1200 }]);
    assert.deepEqual(assessed.uncomparable_metrics, []);
  } finally { f.store.close(); }
});

test("a transcribed value blocks L1 unless a machine observation confirms the same value", async () => {
  const f = await fixture();
  try {
    // This is the failure section 11.5 exists for: the receipt is faithful and
    // recomputable, but one number was read off a screen by a person.
    const issued = f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1200, provenance: human("2030-01-01T00:00:00Z") },
      post_state: { offset_delay: 0, provenance: human("2030-01-01T00:00:30Z") } });
    const receipt = issued.receipt as Record<string, unknown>;
    assert.equal(receipt.recomputable, true, "recomputability is independent of who typed the value");
    assert.equal(receipt.l1_eligible, false);
    assert.equal(receipt.l1_reason, "human_transcription_requires_cross_check");
    // Both readings are named, so a reader can see which side is unverified rather than
    // only that something is.
    assert.deepEqual(receipt.transcription_metrics, ["post_state.offset_delay", "pre_state.offset_delay"]);

    // A machine observation of the same value removes the dependency for that reading.
    const confirmed = f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1200, provenance: human("2030-01-01T00:00:00Z") },
      post_state: { offset_delay: 0, provenance: human("2030-01-01T00:00:30Z") },
      cross_checks: [{ metric: "offset_delay", value: 0, provenance: machine("2030-01-01T00:00:31Z") }] });
    const partial = confirmed.receipt as Record<string, unknown>;
    assert.equal(partial.l1_eligible, false);
    assert.deepEqual(partial.unconfirmed_metrics, ["pre_state.offset_delay"]);

    // Confirming both readings clears it.
    const both = f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1200, provenance: human("2030-01-01T00:00:00Z") },
      post_state: { offset_delay: 0, provenance: human("2030-01-01T00:00:30Z") },
      cross_checks: [
        { metric: "offset_delay", value: 1200, provenance: machine("2030-01-01T00:00:01Z") },
        { metric: "offset_delay", value: 0, provenance: machine("2030-01-01T00:00:31Z") }] });
    const cleared = both.receipt as Record<string, unknown>;
    assert.equal(cleared.l1_eligible, true);
    assert.deepEqual(cleared.transcription_metrics, []);
  } finally { f.store.close(); }
});

test("a cross-check that disagrees does not launder a mistyped value", async () => {
  const f = await fixture();
  try {
    // The machine says 1210 where the person wrote 1200. That is a contradiction, not a
    // confirmation, and treating it as one is how a transcription error becomes a
    // "verified" receipt.
    const issued = f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1200, provenance: human() },
      post_state: { offset_delay: 0, provenance: machine("2030-01-01T00:00:30Z") },
      cross_checks: [{ metric: "offset_delay", value: 1210, provenance: machine("2030-01-01T00:00:01Z") }] });
    const receipt = issued.receipt as Record<string, unknown>;
    assert.equal(receipt.l1_eligible, false);
    assert.deepEqual(receipt.unconfirmed_metrics, ["pre_state.offset_delay"]);
  } finally { f.store.close(); }
});

test("a receipt with no machine observation at all is not eligible, even without a transcription", async () => {
  const f = await fixture();
  try {
    // Neither state names a machine and no cross-check exists, so nothing provides the
    // deterministic basis L1 needs. "Nobody transcribed it" is not the same as "a machine
    // measured it".
    const issued = f.receipts.issue({ ...base,
      pre_state: { offset_delay: 5, provenance: human() },
      post_state: { offset_delay: 5, provenance: human("2030-01-01T00:00:30Z") } });
    assert.equal((issued.receipt as Record<string, unknown>).l1_eligible, false);
  } finally { f.store.close(); }
});

test("provenance is mandatory and each source requires its own auditable fields", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.receipts.issue({ ...base, pre_state: { offset_delay: 1 } }), /pre_state\.provenance is required/);
    assert.throws(() => f.receipts.issue({ ...base, post_state: { offset_delay: 1 } }), /post_state\.provenance is required/);
    assert.throws(() => f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1, provenance: { source: "guessed", at: "2030-01-01T00:00:00Z" } } }),
      /must be machine_observed or human_transcription/);
    // A machine observation must name its checker; a transcription must name the person
    // and the screen. Those are the two facts a later audit asks for.
    assert.throws(() => f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1, provenance: { source: "machine_observed", at: "2030-01-01T00:00:00Z" } } }),
      /pre_state\.provenance\.checker must not be empty/);
    assert.throws(() => f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1, provenance: { source: "human_transcription", at: "2030-01-01T00:00:00Z", by: "u1" } } }),
      /pre_state\.provenance\.origin must not be empty/);
    assert.throws(() => f.receipts.issue({ ...base,
      pre_state: { offset_delay: 1, provenance: { source: "machine_observed", at: "not-a-date", checker: "c" } } }),
      /must be an ISO timestamp/);
    // A state must carry at least one metric, and `provenance` is reserved.
    assert.throws(() => f.receipts.issue({ ...base, pre_state: { provenance: machine() } }), /at least one metric/);
    assert.throws(() => f.receipts.issue({ ...base, pre_state: { "bad name": 1, provenance: machine() } }), /not a valid metric name/);
    assert.throws(() => f.receipts.issue({ ...base, pre_state: { offset_delay: "many", provenance: machine() } }), /must be a finite number/);
  } finally { f.store.close(); }
});

test("cross-checks must be machine observations to count as independent", async () => {
  const f = await fixture();
  try {
    // A second person reading the same screen shares the failure mode that matters, so
    // it is not an independent source.
    assert.throws(() => f.receipts.issue({ ...base, cross_checks: [{ metric: "offset_delay", value: 1, provenance: human() }] }),
      /must come from a machine observation to be independent/);
    assert.throws(() => f.receipts.issue({ ...base, cross_checks: "nope" }), /cross_checks must be an array/);
    assert.throws(() => f.receipts.issue({ ...base, cross_checks: [{ metric: "bad name", value: 1, provenance: machine() }] }),
      /not a valid metric name/);
    assert.throws(() => f.receipts.issue({ ...base, proofs: "nope" }), /proofs must be an array/);
    assert.throws(() => f.receipts.issue({ ...base, proofs: [{ type: "T", value: "v", observed_at: "nope" }] }),
      /must be an ISO timestamp/);
  } finally { f.store.close(); }
});

test("the verdict needs two observations, and a lag that is not shrinking is stuck", async () => {
  const f = await fixture();
  try {
    const receipt = f.receipts.issue(base).receipt as Record<string, unknown>;
    const settled = f.receipts.trend({ receipt_id: receipt.id, metric: "offset_delay" });
    assert.equal(settled.verdict, "settled");
    assert.equal(settled.observations, 2);
    assert.equal(settled.first_observed_at, "2030-01-01T00:00:00Z");
    assert.equal(settled.last_observed_at, "2030-01-01T00:00:30Z");
    assert.deepEqual(settled.remediation, REMEDIATION.settled);

    // Shrinking but not yet zero: waiting is cheap and correct.
    const catching = f.receipts.issue({ ...base, post_state: { offset_delay: 300, provenance: machine("2030-01-01T00:00:30Z") } });
    assert.equal(f.receipts.trend({ receipt_id: (catching.receipt as Record<string, unknown>).id, metric: "offset_delay" }).verdict, "catching_up");

    // Unchanged and growing both call for intervention, which is why they share a verdict.
    const unchanged = f.receipts.issue({ ...base, post_state: { offset_delay: 1200, provenance: machine("2030-01-01T00:00:30Z") } });
    assert.equal(f.receipts.trend({ receipt_id: (unchanged.receipt as Record<string, unknown>).id, metric: "offset_delay" }).verdict, "stuck");
    const grown = f.receipts.issue({ ...base, post_state: { offset_delay: 9000, provenance: machine("2030-01-01T00:00:30Z") } });
    const stuck = f.receipts.trend({ receipt_id: (grown.receipt as Record<string, unknown>).id, metric: "offset_delay" });
    assert.equal(stuck.verdict, "stuck");
    assert.deepEqual(stuck.remediation, REMEDIATION.stuck);
  } finally { f.store.close(); }
});

test("every verdict offers a real remediation, and a one-sided metric is not compared", async () => {
  const f = await fixture();
  try {
    // Section 10: "reject" and "retry" are exits, not remediation. Every verdict must
    // offer at least one action that changes the situation.
    for (const [verdict, actions] of Object.entries(REMEDIATION)) {
      assert.ok(actions.length > 0, `${verdict} must offer at least one action`);
      assert.deepEqual(actions.filter((a) => NON_REMEDIATION_EXITS.includes(a)), [],
        `${verdict} must not rest on a placeholder exit`);
      assert.deepEqual(f.receipts.remediation({ verdict }).actions, actions);
    }
    assert.throws(() => f.receipts.remediation({ verdict: "unknown" }), /verdict is unsupported/);

    // A metric seen in only one state cannot be compared; reading the absent side as 0 is
    // how "not measured" becomes "measured as zero".
    const partial = f.receipts.issue({ ...base, pre_state: { offset_delay: 1200, partition_count: 8, provenance: machine() } });
    const assessed = f.receipts.assess({ receipt_id: (partial.receipt as Record<string, unknown>).id });
    assert.equal(assessed.recomputable, false);
    assert.deepEqual(assessed.uncomparable_metrics, [{ metric: "partition_count", missing: "post_state" }]);
    // Asking for a trend on a one-sided metric is refused rather than reporting a delta
    // against nothing.
    assert.throws(() => f.receipts.trend({ receipt_id: String((partial.receipt as Record<string, unknown>).id), metric: "partition_count" }),
      /post_state does not observe metric/);

    // The mirror case: a metric the action introduced and only the second reading saw.
    const introduced = f.receipts.issue({ ...base, post_state: { offset_delay: 0, retry_queue: 3, provenance: machine("2030-01-01T00:00:30Z") } });
    const other = f.receipts.assess({ receipt_id: (introduced.receipt as Record<string, unknown>).id });
    assert.equal(other.recomputable, false);
    assert.deepEqual(other.uncomparable_metrics, [{ metric: "retry_queue", missing: "pre_state" }]);
  } finally { f.store.close(); }
});

test("a receipt records a check, is idempotent, and chains to its predecessor", async () => {
  const f = await fixture();
  try {
    const first = f.receipts.issue({ ...base, check: { checker: "tsc", result: "passed", independent: true },
      proofs: [{ type: "BINLOG_POSITION", value: "mysql-bin.000142:49012", observed_at: "2030-01-01T00:00:30Z" }] });
    const receipt = first.receipt as Record<string, unknown>;
    assert.deepEqual(receipt.check, { checker: "tsc", result: "passed", independent: true });
    assert.equal((receipt.proofs as unknown[]).length, 1);
    assert.equal(receipt.prev_receipt_digest, null);

    const again = f.receipts.issue({ ...base, check: { checker: "tsc", result: "passed", independent: true },
      proofs: [{ type: "BINLOG_POSITION", value: "mysql-bin.000142:49012", observed_at: "2030-01-01T00:00:30Z" }] });
    assert.equal(again.idempotent, true);
    // A different conclusion is a different receipt, not a replay of this one.
    const other = f.receipts.issue({ ...base, post_state: { offset_delay: 10, provenance: machine("2030-01-01T00:00:30Z") } });
    assert.notEqual((other.receipt as Record<string, unknown>).id, receipt.id);

    // The chain link is what a later receipt cites as its predecessor.
    const chained = f.receipts.issue({ ...base, prev_receipt_digest: String(receipt.receipt_digest) });
    assert.equal((chained.receipt as Record<string, unknown>).prev_receipt_digest, receipt.receipt_digest);
    // Reusing an id for different content is a conflict, not a silent overwrite: the id
    // is a claim about which receipt this is.
    assert.throws(() => f.receipts.issue({ ...base, receipt_id: String(receipt.id),
      post_state: { offset_delay: 999, provenance: machine("2030-01-01T00:00:30Z") } }),
      /idempotency conflict/);
    assert.equal((f.receipts.get({ receipt_id: String(receipt.id) }).receipt as Record<string, unknown>).id, receipt.id);
    // Three distinct receipts: the first, the different conclusion, and the chained one.
    // The replay above added no row.
    assert.equal((f.receipts.list({ object_id: "OBJ-CDC-OFFSET" }).receipts as unknown[]).length, 3);
    assert.deepEqual(f.receipts.list({ object_id: "other" }).receipts, []);
  } finally { f.store.close(); }
});

test("malformed identifiers, limits and checks are refused by name", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.receipts.issue({ ...base, object_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => f.receipts.issue({ ...base, action_executed: "bad action!" }), /unsupported characters/);
    assert.throws(() => f.receipts.issue({ ...base, risk_level: undefined }), /risk_level must not be empty/);
    assert.throws(() => f.receipts.issue({ ...base, check: { checker: "c", result: "maybe" } }), /check\.result is unsupported/);
    assert.throws(() => f.receipts.issue({ ...base, check: { result: "passed" } }), /check\.checker must not be empty/);
    assert.throws(() => f.receipts.issue({ ...base, pre_state: "nope" }), /pre_state must be an object/);
    const receipt = f.receipts.issue(base).receipt as Record<string, unknown>;
    assert.throws(() => f.receipts.list({ object_id: "o", limit: 0 }), /between 1 and 1000/);
    assert.throws(() => f.receipts.trend({ receipt_id: String(receipt.id), metric: "bad name" }), /not a valid metric name/);
    assert.throws(() => f.receipts.trend({ receipt_id: String(receipt.id), metric: "absent" }), /pre_state does not observe metric/);
    // A metric observed before but not after is refused at trend time too, rather than
    // silently reporting a delta against nothing.
    const partial = f.receipts.issue({ ...base, pre_state: { offset_delay: 1, extra: 2, provenance: machine() } });
    assert.throws(() => f.receipts.trend({ receipt_id: String((partial.receipt as Record<string, unknown>).id), metric: "extra" }),
      /post_state does not observe metric/);
    assert.throws(() => f.receipts.get({ receipt_id: "missing" }), /Unknown evidence_receipt/);
  } finally { f.store.close(); }
});
