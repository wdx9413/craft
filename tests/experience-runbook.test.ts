import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExperienceContribution } from '@craft/capability-experience/contribution';
import { ProcedureStore } from '@craft/capability-experience/procedure-projection';
import { stableDigest } from 'craft-common-base/digest';
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

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


test("Runbook script is recalled in project scope and marked changed", async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "p", "check.sh");
    writeFileSync(path, "echo first");
    const { ProcedureStore: SourceProcedureStore } = await import("../../craft-capability/capability/craft-experience/procedure-projection.ts");
    const { ExperienceContribution: SourceContribution } = await import("../../craft-capability/capability/craft-experience/contribution.ts");
    const saved = new SourceProcedureStore(f.store).runbookCapture({ observation_id: "obs-p", decision: "capture", ...runbook, script_path: path });
    const original = f.store.get("workflow_evolution_observation", "obs-other");
    const { scenario_signature: _signature, ...withoutSignature } = original;
    f.store.create("workflow_evolution_observation", "obs-no-signature", withoutSignature);
    assert.equal(new SourceProcedureStore(f.store).runbookCapture({ observation_id: "obs-no-signature", decision: "capture", ...runbook }).advisory_only, true);
    const procedure = saved.procedure as Record<string, unknown>;
    assert.ok(procedure.script_ref);
    const query = { query: "browser inherits page", scope_kind: "project", scope_id: "p", max_items: 5, max_chars: 10_000, domain: "coding" } as const;
    const contribution = new SourceContribution(f.store);
    assert.equal((await contribution.contribute(query)).items[0]?.script_status, "current");
    writeFileSync(path, "echo changed");
    assert.equal((await contribution.contribute(query)).items[0]?.script_status, "changed");
    rmSync(path);
    assert.equal((await contribution.contribute(query)).items[0]?.script_status, "unavailable");
  } finally { f.close(); }
});


test("caller-declared global script stays advisory and detects changes", async () => {
  const f = await fixture();
  try {
    const globalScripts = join(f.root, "experience", "scripts"); mkdirSync(globalScripts, { recursive: true });
    const path = join(globalScripts, "global.sh"); writeFileSync(path, "echo global");
    const { ProcedureStore: SourceProcedureStore } = await import("../../craft-capability/capability/craft-experience/procedure-projection.ts");
    const { ExperienceContribution: SourceContribution } = await import("../../craft-capability/capability/craft-experience/contribution.ts");
    const procedures = new SourceProcedureStore(f.store);
    const privateEnvelope = { audience: { mode: "private", principal_ids: ["owner"] } };
    assert.throws(() => procedures.runbookCapture({ decision: "capture_global_script", ...runbook, script_path: path, scope_envelope: privateEnvelope }), /audience denied/u);
    const outside = join(f.root, "outside.sh"); writeFileSync(outside, "echo outside");
    assert.throws(() => procedures.runbookCapture({ decision: "capture_global_script", ...runbook, script_path: outside }), /global scripts directory/u);
    const saved = procedures.runbookCapture({ decision: "capture_global_script", ...runbook, script_path: path });
    assert.equal(procedures.runbookCapture({ decision: "capture_global_script", ...runbook, script_path: path }).idempotent, true);
    assert.throws(() => procedures.runbookCapture({ decision: "capture_global_script", ...runbook, script_path: path, title: "x".repeat(121) }), /unsafe or too long/u);
    assert.throws(() => procedures.runbookCapture({ decision: "capture_global_script", ...runbook, script_path: path, pitfall: "token=secretsecret" }), /unsafe or exceeds/u);
    assert.equal(saved.advisory_only, true);
    assert.equal((saved.procedure as Record<string, unknown>).scope, "global:global");
    assert.equal((saved.procedure as Record<string, unknown>).provenance, "caller_declared");
    assert.equal((saved.procedure as Record<string, unknown>).routeable, false);
    const query = { query: "browser inherits page", scope_kind: "global", scope_id: "global", max_items: 5, max_chars: 10_000 } as const;
    const contribution = new SourceContribution(f.store);
    const item = (await contribution.contribute(query)).items[0];
    assert.equal(item?.provenance, "caller_declared");
    assert.equal(item?.script_status, "current");
    writeFileSync(path, "changed");
    assert.equal((await contribution.contribute(query)).items[0]?.script_status, "changed");
    assert.equal((await contribution.contribute({ ...query, scope_kind: "project", scope_id: "p" })).items.length, 0);
  } finally { f.close(); }
});


test("document candidates preserve exact source and detect stale revisions", async () => {
  const f = await fixture();
  try {
    const { ProcedureStore: SourceProcedureStore } = await import("../../craft-capability/capability/craft-experience/procedure-projection.ts");
    const { ExperienceContribution: SourceContribution } = await import("../../craft-capability/capability/craft-experience/contribution.ts");
    const procedures = new SourceProcedureStore(f.store);
    const contribution = new SourceContribution(f.store);
    for (const item of [
      { id: "p", excerpt: "接口返回成功只代表请求已受理" },
      { id: "other", excerpt: "Fitan `/flow/checkFlow` 会调用状态更新和画布同步逻辑" },
    ]) {
      const path = join(f.root, item.id, "manual.md"); writeFileSync(path, `来源说明：${item.excerpt}。`);
      const args = { decision: "capture_document", scope: `project:${item.id}`, source_path: path, source_excerpt: item.excerpt, ...runbook };
      const saved = procedures.runbookCapture(args);
      assert.equal((saved.procedure as Record<string, unknown>).provenance, "caller_declared");
      assert.equal(saved.advisory_only, true);
      assert.throws(() => procedures.runbookCapture({ ...args, source_excerpt: "不存在的片段" }), /not present/u);
      const query = { query: "browser inherits page", scope_kind: "project", scope_id: item.id, max_items: 5, max_chars: 10_000 } as const;
      assert.equal((await contribution.contribute(query)).items[0]?.source_status, "current");
      writeFileSync(path, "changed");
      assert.equal((await contribution.contribute(query)).items[0]?.source_status, "changed");
    }
  } finally { f.close(); }
});

test("unverified Host work creates a scoped advisory candidate or an idempotent no-learning decision", async () => {
  const f = await fixture();
  try {
    const { ProcedureStore: SourceProcedureStore } = await import("../../craft-capability/capability/craft-experience/procedure-projection.ts");
    const procedures = new SourceProcedureStore(f.store);
    const source = { scope: "project:p", host: "codex", session_id: "session-u", turn_id: "turn-u", context_receipt_id: "receipt-u" };
    f.store.create("context_resolution_receipt", "receipt-u", { scope: { kind: "project", id: "project:p" }, execution_context: true, host_turn: { host: "codex", session_id: "session-u", turn_id: "turn-u" } });
    f.store.create("context_resolution_receipt", "receipt-other", { scope: { kind: "project", id: "project:other" }, execution_context: true, host_turn: { host: "codex", session_id: "session-u", turn_id: "turn-u" } });
    f.store.create("context_resolution_receipt", "receipt-skip", { scope: { kind: "project", id: "project:p" }, execution_context: true, host_turn: { host: "codex", session_id: "session-u", turn_id: "turn-no-learning" } });
    const args = { decision: "capture_unverified", ...source, ...runbook };
    assert.throws(() => procedures.runbookCapture({ ...args, host: "BAD HOST" }), /identity is invalid/u);
    for (const [id, turn, status, expires] of [
      ["wrong-turn", { host: "codex", session_id: "session-u", turn_id: "other" }, "active", undefined],
      ["revoked", { host: "codex", session_id: "session-u", turn_id: "turn-u" }, "revoked", undefined],
      ["expired", { host: "codex", session_id: "session-u", turn_id: "turn-u" }, "active", 1],
      ["invalid-expiry", { host: "codex", session_id: "session-u", turn_id: "turn-u" }, "active", "invalid"],
    ] as const) {
      f.store.create("context_resolution_receipt", id, { scope: { kind: "project", id: "project:p" }, host_turn: turn, status, ...(expires === undefined ? {} : { expires_at_ms: expires }) });
      assert.throws(() => procedures.runbookCapture({ ...args, context_receipt_id: id }), /receipt Host turn/u);
    }
    assert.throws(() => procedures.runbookCapture({ ...args, context_receipt_id: "missing" }), /not found|missing/u);
    assert.throws(() => procedures.runbookCapture({ ...args, context_receipt_id: "receipt-other" }), /scope does not match/u);
    assert.throws(() => procedures.runbookCapture(args), /trusted Host project authorization/u);
    procedures.setUnverifiedAuthorization(() => true);
    const saved = procedures.runbookCapture(args);
    const procedure = saved.procedure as Record<string, unknown>;
    assert.equal(procedure.routeable, false);
    assert.equal(procedure.publication_allowed, false);
    assert.equal(procedure.execution_visible, false);
    assert.deepEqual(procedure.evidence_ids, []);
    assert.equal((procedure.source_ref as Record<string, unknown>).kind, "caller_declared_host_turn");
    assert.equal(procedures.runbookCapture(args).idempotent, true);
    assert.throws(() => procedures.runbookCapture({ ...args, title: "Different" }), /different unverified candidate/u);
    assert.throws(() => procedures.runbookCapture({ ...source, decision: "no_new_learning_unverified", reason: "no_reusable_learning" }), /candidate already exists/u);
    const read = procedures.get({ procedure_id: String(procedure.id) });
    assert.equal((read.runbook as Record<string, unknown>).executable, false);
    const { ExperienceContribution: SourceContribution } = await import("../../craft-capability/capability/craft-experience/contribution.ts");
    const recalled = await new SourceContribution(f.store).contribute({ query: "browser inherits page", scope_kind: "project", scope_id: "p", max_items: 5, max_chars: 10_000 });
    assert.equal(recalled.items[0]?.source_status, undefined);
    assert.equal((recalled.items[0]?.source_ref as Record<string, unknown>).kind, "caller_declared_host_turn");
    const skip = { ...source, context_receipt_id: "receipt-skip", turn_id: "turn-no-learning", decision: "no_new_learning_unverified", reason: "no_reusable_learning" };
    assert.throws(() => procedures.runbookCapture({ ...skip, reason: "invalid" }), /reason is unsupported/u);
    assert.equal(procedures.runbookCapture(skip).idempotent, false);
    assert.equal(procedures.runbookCapture(skip).idempotent, true);
    assert.throws(() => procedures.runbookCapture({ ...skip, reason: "other" }), /different no-learning/u);
    assert.throws(() => procedures.runbookCapture({ ...args, context_receipt_id: "receipt-skip", turn_id: "turn-no-learning" }), /no-learning decision/u);
    assert.throws(() => procedures.runbookCapture({ ...args, scope: "global:global" }), /project scope/u);
  } finally { f.close(); }
});

test("Runbook recall stays available when the scan has more than one hundred candidates", async () => {
  const f = await fixture();
  try {
    const { ProcedureStore: SourceProcedureStore } = await import("../../craft-capability/capability/craft-experience/procedure-projection.ts");
    const { ExperienceContribution: SourceContribution } = await import("../../craft-capability/capability/craft-experience/contribution.ts");
    const path = join(f.root, "p", "guide.md"); writeFileSync(path, "source excerpt");
    const procedures = new SourceProcedureStore(f.store);
    for (let i = 0; i < 101; i++) procedures.runbookCapture({ decision: "capture_document", scope: "project:p", source_path: path, source_excerpt: "source excerpt", ...runbook, title: `Browser task ${i}` });
    const result = await new SourceContribution(f.store).contribute({ query: "browser task", scope_kind: "project", scope_id: "p", max_items: 5, max_chars: 20_000 });
    assert(result.items.length > 0); assert.equal((result.diagnostics as Record<string, unknown>).partial, true);
    assert.equal((result.diagnostics as Record<string, unknown>).partial_reason, "runbook_candidate_scan_limit");
    assert(result.omitted_count > 0);
  } finally { f.close(); }
});

test("Context MCP recalls same-project coding Runbooks and explicitly included global scripts", async () => {
  const f = await fixture();
  try {
    const project = join(f.root, "mcp-project"); mkdirSync(project);
    const service = await CraftService.open(f.store);
    const identity = service.scopeIdentityResolveProject({ project_root: project }).identity as Record<string, unknown>;
    const scope = String((identity.canonical_scope as Record<string, unknown>).id);
    f.store.create("evidence", "mcp-evidence", { confidence: "bounded", metadata: { provenance: "host_completion_signal", verification_outcome: "passed", project_scope_id: scope,
      source_session_id: "mcp-session", task_id: "mcp-task", turn_id: "mcp-turn", content_stored: false, context_receipt_id: "mcp-receipt" } });
    f.store.create("workflow_evolution_observation", "mcp-observation", { lifecycle: "accepted", outcome: "passed", source: { kind: "host:codex", id: "mcp-task", session_id: "mcp-session", scope },
      evidence_ids: ["mcp-evidence"], scenario_signature: { domain: "coding" } });
    const { ProcedureStore: SourceProcedureStore } = await import("../../craft-capability/capability/craft-experience/procedure-projection.ts");
    const procedures = new SourceProcedureStore(f.store);
    const short = { title: "projectbrowser", applies_when: "projectbrowser", exclude_when: "none", pitfall: "issue", cause: "cause", correct_method: "check", synthetic_example: "example", done_criteria: "done", failure_handling: "stop" };
    const candidate = procedures.runbookCapture({ observation_id: "mcp-observation", decision: "capture", ...short }).procedure as Record<string, unknown>;
    const { ExperienceContribution: SourceContribution } = await import("../../craft-capability/capability/craft-experience/contribution.ts");
    const contribution = new SourceContribution(f.store);
    const scopedQuery = { query: "projectbrowser", scope_kind: "project" as const, scope_id: scope, max_items: 5, max_chars: 20_000 };
    assert((await contribution.contribute({ ...scopedQuery, domain: "coding" })).items.some(item => item.procedure_id === candidate.id));
    assert(!(await contribution.contribute({ ...scopedQuery, domain: "writing" })).items.some(item => item.procedure_id === candidate.id));
    const scripts = join(f.root, "experience", "scripts"); mkdirSync(scripts, { recursive: true });
    const path = join(scripts, "global.sh"); writeFileSync(path, "echo useful");
    const global = procedures.runbookCapture({ decision: "capture_global_script", script_path: path, ...short, title: "globalbrowser", applies_when: "globalbrowser" }).procedure as Record<string, unknown>;
    const server = new McpServer(service, "component-context-agent");
    const call = async (root: string, includeGlobal: boolean, query = "projectbrowser") => server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "craft_context_open",
      arguments: { project_root: root, query, include_global: includeGlobal, include_codebase: false, response_detail: "full", max_tokens: 4000 } } });
    const recalled = JSON.stringify(await call(project, true));
    assert(recalled.includes(String(candidate.id)), recalled);
    assert(JSON.stringify(await call(project, true, "globalbrowser")).includes(String(global.id)));
    const other = JSON.stringify(await call(join(f.root, "other"), true));
    assert(!other.includes(String(candidate.id)));
    assert(!JSON.stringify(await call(project, false, "globalbrowser")).includes(String(global.id)));
    const source = join(project, "manual.md"); writeFileSync(source, "source excerpt");
    for (let i = 0; i < 101; i++) procedures.runbookCapture({ decision: "capture_document", scope, source_path: source, source_excerpt: "source excerpt", ...runbook, title: `Browser source ${i}` });
    const partial = await call(project, false);
    const payload = ((partial?.result as Record<string, unknown>).structuredContent as Record<string, unknown>);
    const pack = payload.pack_receipt as Record<string, unknown>;
    assert.equal(pack.partial, true);
    assert((pack.partial_reasons as string[]).includes("experience_runbook_candidate_scan_limit"));
  } finally { f.close(); }
});
