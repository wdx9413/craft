import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../src/infrastructure/store.ts";
import { diffWorkflowCatalog, discoverWorkflows, isWorkflowFile, normalizeWorkflowDefinition, planWorkflowRetirement, describeWorkflow } from "../src/workflow-registry.ts";

test("normalizeWorkflowDefinition validates shape", () => {
  const ok = normalizeWorkflowDefinition({ id: "test.wf", version: 2, title: "Test", steps: [{ type: "command", command: ["echo", "hi"] }] });
  assert.equal(ok.id, "test.wf");
  assert.equal(ok.status, "active");
  assert.throws(() => normalizeWorkflowDefinition({}), /workflow id/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "bad id!", title: "x", steps: [{ type: "command", command: ["x"] }] }), /Unsupported workflow id/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [], version: 0 }), /positive integer/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], version: 1.5 }), /positive integer/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], version: "bad" as never }), /positive integer/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], status: "unknown" }), /Unsupported workflow status/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], inputs: [1] }), /must be an object/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], inputs: [[]] }), /must be an object/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], inputs: [{ bad: "no name" }] }), /input name/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [] }), /at least one step/);
  // valid inputs path
  const withInputs = normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], inputs: [{ name: "arg1" }] });
  assert.equal((withInputs.inputs as JsonObject[]).length, 1);
  assert.equal((withInputs.inputs as JsonObject[])[0].name, "arg1");
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: [{ type: "command", command: ["x"] }], inputs: "bad" as never }), /array/);
  assert.throws(() => normalizeWorkflowDefinition({ id: "x", title: "x", steps: "bad" as never }), /array/);
  // valid domain passes through
  const withDomain = normalizeWorkflowDefinition({ id: "x", title: "x", domain: "research", steps: [{ type: "command", command: ["x"] }] });
  assert.equal(withDomain.domain, "research");
});

test("describeWorkflow produces a descriptor", () => {
  const def = normalizeWorkflowDefinition({ id: "a", title: "A", steps: [{ type: "command", command: ["echo"], side_effect: "read_only" }] });
  const d = describeWorkflow("a/b.workflow.json", def);
  assert.equal(d.workflow_id, "a");
  assert.equal(d.step_count, 1);
  assert.deepEqual(d.side_effects, ["read_only"]);
  // domain passed through as string
  const withDomain = describeWorkflow("a/c.workflow.json", normalizeWorkflowDefinition({ id: "c", title: "C", domain: "research", steps: [{ type: "command", command: ["echo"], side_effect: "read_only" }] }));
  assert.equal(withDomain.domain, "research");
  // multiple side effects are deduplicated and sorted
  const multi = describeWorkflow("a/d.workflow.json", normalizeWorkflowDefinition({ id: "d", title: "D", steps: [
    { type: "command", command: ["x"], side_effect: "read_only" },
    { type: "command", command: ["y"], side_effect: "external_write" },
    { type: "command", command: ["z"], side_effect: "read_only" },
  ] }));
  assert.deepEqual(multi.side_effects, ["external_write", "read_only"]);
  // raw descriptor without the normalized domain field still resolves to null
  const raw = describeWorkflow("a/e.workflow.json", { id: "e", version: 1, title: "E", domain: undefined, status: "active", steps: [], inputs: [] });
  assert.equal(raw.domain, null);
});

test("discoverWorkflows scans and validates files", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-wf-"));
  try {
    await mkdir(join(root, "sub"), { recursive: true });
    await writeFile(join(root, "a.workflow.json"), JSON.stringify({ id: "a", title: "A", steps: [{ type: "command", command: ["echo"] }] }));
    await writeFile(join(root, "sub", "b.workflow.json"), JSON.stringify({ id: "b", title: "B", steps: [{ type: "assertion", evaluator: "file_exists", path: "x" }] }));
    await writeFile(join(root, "readme.txt"), "ignored");
    const found = discoverWorkflows(root);
    assert.equal(found.length, 2);
    assert.ok(found.some((d) => d.workflow_id === "a"));
    assert.throws(() => discoverWorkflows(join(root, "missing")), /does not exist/);
    await writeFile(join(root, "bad.workflow.json"), "not json");
    assert.throws(() => discoverWorkflows(root), /not valid JSON/);
    assert.throws(() => discoverWorkflows(root, { limit: 0 }), /positive integer/);
    assert.throws(() => discoverWorkflows(root, { limit: 1.5 }), /positive integer/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discoverWorkflows rejects duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-wf-dup-"));
  try {
    await writeFile(join(root, "a.workflow.json"), JSON.stringify({ id: "a", title: "A", steps: [{ type: "command", command: ["echo"] }] }));
    await writeFile(join(root, "b.workflow.json"), JSON.stringify({ id: "a", title: "A2", steps: [{ type: "command", command: ["echo"] }] }));
    assert.throws(() => discoverWorkflows(root), /duplicate/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discoverWorkflows enforces the file limit", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-wf-cap-"));
  try {
    await writeFile(join(root, "a.workflow.json"), JSON.stringify({ id: "a", title: "A", steps: [{ type: "command", command: ["echo"] }] }));
    await writeFile(join(root, "b.workflow.json"), JSON.stringify({ id: "b", title: "B", steps: [{ type: "command", command: ["echo"] }] }));
    assert.throws(() => discoverWorkflows(root, { limit: 1 }), /exceeds/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("discoverWorkflows skips symlinked directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-wf-junction-"));
  const other = await mkdtemp(join(tmpdir(), "craft-wf-junction-other-"));
  try {
    await writeFile(join(other, "x.workflow.json"), JSON.stringify({ id: "x", title: "X", steps: [{ type: "command", command: ["echo"] }] }));
    // Use a junction (works without admin); lstat reports it as a symlink so the walker skips it.
    await symlink(other, join(root, "linked"), "junction");
    const found = discoverWorkflows(root);
    assert.equal(found.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});

test("diffWorkflowCatalog categorizes changes", () => {
  const a = describeWorkflow("a", normalizeWorkflowDefinition({ id: "a", title: "A", steps: [{ type: "command", command: ["echo"] }] }));
  const b = describeWorkflow("b", normalizeWorkflowDefinition({ id: "b", title: "B", steps: [{ type: "command", command: ["echo"] }] }));
  const b2 = { ...b, digest: "changed" };
  const diff = diffWorkflowCatalog([a, b], [a, b2]);
  assert.equal((diff.added as unknown[]).length, 0);
  assert.equal((diff.changed as unknown[]).length, 1);
  assert.equal((diff.removed as unknown[]).length, 0);
  assert.equal(diff.unchanged, 1);
});

test("planWorkflowRetirement produces deterministic recommendations", () => {
  const now = new Date().toISOString();
  const usage = [
    { workflow_id: "stale", uses: 2, successes: 1, last_used_at: "2020-01-01T00:00:00Z" },
    { workflow_id: "bad", uses: 10, successes: 1, last_used_at: now },
    { workflow_id: "active", uses: 10, successes: 9, last_used_at: now },
    { workflow_id: "never", uses: 0, successes: 0, last_used_at: null },
  ];
  const decisions = planWorkflowRetirement(usage, { now });
  const map = new Map(decisions.map((d) => [d.workflow_id, d]));
  assert.equal(map.get("stale")?.recommendation, "retire");
  assert.equal(map.get("bad")?.recommendation, "retire");
  assert.equal(map.get("active")?.recommendation, "keep");
  assert.equal(map.get("never")?.recommendation, "retire");
});

test("planWorkflowRetirement deprecates stale but proven workflows", () => {
  const now = new Date().toISOString();
  const usage = [{ workflow_id: "old-but-proven", uses: 10, successes: 10, last_used_at: "2020-01-01T00:00:00Z" }];
  const decisions = planWorkflowRetirement(usage, { now });
  assert.equal(decisions[0].recommendation, "deprecate");
  assert.ok((decisions[0].reasons as string[]).includes("stale"));
});

test("planWorkflowRetirement marks fresh workflow as keep", () => {
  const now = new Date().toISOString();
  const usage = [{ workflow_id: "fresh", uses: 6, successes: 6, last_used_at: now }];
  const decisions = planWorkflowRetirement(usage, { now });
  assert.equal(decisions[0].recommendation, "keep");
  assert.ok((decisions[0].reasons as string[]).includes("in_use"));
});

test("planWorkflowRetirement with zero min_uses keeps a fresh untested workflow", () => {
  const now = new Date().toISOString();
  const usage = [{ workflow_id: "fresh-zero", uses: 0, successes: 0, last_used_at: now }];
  const decisions = planWorkflowRetirement(usage, { now, policy: { min_uses: 0 } });
  // uses=0, not stale, successRate=null → never_proven_and_stale branch isn't hit,
  // low_success_rate branch requires successRate !== null → fall through to "keep"
  assert.equal(decisions[0].recommendation, "keep");
  assert.equal(decisions[0].success_rate, null);
});

test("planWorkflowRetirement rejects non-ISO last_used_at", () => {
  const now = new Date().toISOString();
  assert.throws(() => planWorkflowRetirement(
    [{ workflow_id: "x", uses: 1, successes: 1, last_used_at: "not-a-date" }],
    { now },
  ), /not a timestamp/);
});

test("isWorkflowFile accepts the right kinds of entries", () => {
  const file = { isSymbolicLink: () => false, isDirectory: () => false };
  const dir = { isSymbolicLink: () => false, isDirectory: () => true };
  const link = { isSymbolicLink: () => true, isDirectory: () => false };
  assert.equal(isWorkflowFile("a.workflow.json", file), true);
  assert.equal(isWorkflowFile("ignored.txt", file), false);
  assert.equal(isWorkflowFile("a.workflow.json", dir), false);
  assert.equal(isWorkflowFile("a.workflow.json", link), false);
});

test("planWorkflowRetirement validates policy and usage", () => {
  assert.throws(() => planWorkflowRetirement([], { now: "bad" }), /ISO/);
  assert.throws(() => planWorkflowRetirement([{ workflow_id: "x", uses: -1, successes: 0, last_used_at: null }], { now: new Date().toISOString() }), /non-negative/);
  assert.throws(() => planWorkflowRetirement([{ workflow_id: "x", uses: 1, successes: 2, last_used_at: null }], { now: new Date().toISOString() }), /successes must be between/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { min_uses: -1 } }), /non-negative/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { min_uses: 1.5 } }), /non-negative/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { stale_days: 0 } }), /positive/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { stale_days: 1.5 } }), /positive/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { min_success_rate: 1.5 } }), /between 0 and 1/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { min_success_rate: -0.1 } }), /between 0 and 1/);
  assert.throws(() => planWorkflowRetirement([], { now: new Date().toISOString(), policy: { min_success_rate: Number.NaN } }), /between 0 and 1/);
});
