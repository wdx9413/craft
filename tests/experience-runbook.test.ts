import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExperienceContribution } from '@craft/capability-experience/contribution';
import { ProcedureStore } from '@craft/capability-experience/procedure-projection';
import { stableDigest } from 'craft-common-base/digest';
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

const runbook = { title: "Reliable browser task handoff", applies_when: "Changing tasks in the shared browser",
  exclude_when: "The page is already isolated to a dedicated tab", pitfall: "The next task inherits the previous page",
  cause: "The Host reuses the active tab", correct_method: "Navigate to about:blank before starting the next task",
  synthetic_example: "await page.goto('about:blank'); await page.goto(targetUrl);", done_criteria: "The new task starts from the expected page",
  failure_handling: "Stop and recreate the tab if navigation does not complete" };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-runbook-"));
  const store = await new CraftStore(craftPaths(root)).open();
  for (const id of ["p", "other"]) {
    const projectRoot = join(root, id); mkdirSync(projectRoot);
    store.create("scope_alias", `alias-${id}`, { status: "active", alias_kind: "path", alias: projectRoot,
      alias_digest: stableDigest(projectRoot), scope: { kind: "project", id: `project:${id}` } });
    const evidenceId = `e-${id}`;
    store.create("evidence", evidenceId, { confidence: "bounded", metadata: { provenance: "host_completion_signal", verification_outcome: "passed",
      project_scope_id: `project:${id}`, source_session_id: `session-${id}`, task_id: `task-${id}`, turn_id: `turn-${id}`,
      content_stored: false, context_receipt_id: `receipt-${id}` } });
    store.create("workflow_evolution_observation", `obs-${id}`, { lifecycle: "accepted", outcome: "passed", scenario_key: "coding.browser",
      source: { kind: "host:codex", id: `task-${id}`, session_id: `session-${id}`, scope: `project:${id}` }, evidence_ids: [evidenceId],
      scenario_signature: { project: `project:${id}`, domain: "coding" } });
  }
  return { root, store, procedures: new ProcedureStore(store), close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Runbook capture creates same-project advisory content and cannot enter execution gates", async () => {
  const f = await fixture();
  try {
    const saved = f.procedures.runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook });
    const procedure = saved.procedure as Record<string, unknown>;
    assert.equal(saved.advisory_only, true);
    assert.equal(procedure.scope, "project:p");
    assert.equal(procedure.runbook_candidate, true);
    assert.equal(procedure.routeable, false);
    assert.equal(procedure.publication_allowed, false);
    assert.equal(procedure.execution_visible, false);
    assert.equal((f.procedures.runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook })).idempotent, true);
    const read = f.procedures.get({ procedure_id: procedure.id as string });
    assert.equal((read.runbook as Record<string, unknown>).executable, false);
    assert.match(String((read.runbook as Record<string, unknown>).body), /The next task inherits the previous page/u);
    assert.throws(() => f.procedures.gate({ procedure_id: procedure.id, stage: "shadow", passed: true, evidence_ids: ["e-p"] }), /cannot pass Procedure gates directly/u);
    assert.throws(() => f.procedures.skillExport({ procedure_id: procedure.id }), /Only routeable/u);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "no_new_learning", reason: "no_reusable_learning" }), /candidate already exists/u);
    const items = await new ExperienceContribution(f.store).contribute({ query: "browser inherits page", scope_kind: "project", scope_id: "p", max_items: 5, max_chars: 10_000, domain: "coding" });
    assert.equal(items.items.length, 1);
    assert.equal(items.items[0]?.kind, "experience_runbook_candidate");
    assert.equal(items.items[0]?.executable, false);
    assert.equal(items.items[0]?.routeable, false);
    assert.equal((await new ExperienceContribution(f.store).contribute({ query: "browser inherits page", scope_kind: "project", scope_id: "other", max_items: 5, max_chars: 10_000, domain: "coding" })).items.length, 0);
    const revoked = f.procedures.runbookRevoke({ procedure_id: String(procedure.id), expected_version: 1, reason: "duplicate" });
    assert.equal(revoked.revoked, true);
    assert.equal((await new ExperienceContribution(f.store).contribute({ query: "browser inherits page", scope_kind: "project", scope_id: "p", max_items: 5, max_chars: 10_000, domain: "coding" })).items.length, 0);
    assert.throws(() => f.procedures.runbookRevoke({ procedure_id: String(procedure.id), expected_version: 1, reason: "duplicate" }), /Only an unpromoted/u);
  } finally { f.close(); }
});

test("Runbook capture requires accepted, passing, scoped Host evidence and sanitized bounded fields", async () => {
  const f = await fixture();
  try {
    const bad = f.store.create("workflow_evolution_observation", "bad", { lifecycle: "accepted", outcome: "failed", source: { kind: "host:codex", id: "x", session_id: "s", scope: "project:p" }, evidence_ids: ["e-p"] });
    assert.throws(() => f.procedures.runbookCapture({ observation_id: bad.id, decision: "capture", ...runbook }), /accepted, passing project-scoped Host/u);
    f.store.create("workflow_evolution_observation", "foreign-evidence", { lifecycle: "accepted", outcome: "passed", source: { kind: "host:codex", id: "x", session_id: "s", scope: "project:p" }, evidence_ids: ["e-other"] });
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "foreign-evidence", decision: "capture", ...runbook }), /matching verified Host/u);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook, pitfall: "token=supersecretvalue" }), /unsafe or exceeds/u);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook, synthetic_example: "x".repeat(3001) }), /unsafe or exceeds/u);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "unknown" }), /decision must be capture/u);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "no_new_learning", reason: "free text" }), /reason is unsupported/u);
    const skipped = f.procedures.runbookCapture({ observation_id: "obs-p", decision: "no_new_learning", reason: "no_reusable_learning" });
    assert.equal(skipped.idempotent, false);
    assert.equal((f.procedures.runbookCapture({ observation_id: "obs-p", decision: "no_new_learning", reason: "no_reusable_learning" })).idempotent, true);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "no_new_learning", reason: "too_sensitive" }), /different no_new_learning/u);
    assert.throws(() => f.procedures.runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook }), /no_new_learning decision already exists/u);
  } finally { f.close(); }
});

test("Runbook revocation checks version, reason and asset type", async () => {
  const f = await fixture();
  try {
    const candidate = f.procedures.runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook }).procedure as Record<string, unknown>;
    assert.throws(() => f.procedures.runbookRevoke({ procedure_id: String(candidate.id), expected_version: 2, reason: "duplicate" }), /version is stale/u);
    assert.throws(() => f.procedures.runbookRevoke({ procedure_id: String(candidate.id), expected_version: 1, reason: "free text" }), /reason is unsupported/u);
    assert.throws(() => f.procedures.runbookRevoke({ procedure_id: "missing", expected_version: 1, reason: "other" }), /Unknown experience_procedure/u);
    f.store.create("experience_procedure", "not-runbook", { lifecycle: "candidate", routeable: false });
    assert.throws(() => f.procedures.runbookRevoke({ procedure_id: "not-runbook", expected_version: 1, reason: "other" }), /Only an unpromoted Runbook/u);
  } finally { f.close(); }
});
