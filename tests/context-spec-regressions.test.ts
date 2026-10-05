import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import { repositoryFiles } from "../capability/craft-codebase/repository-files.ts";
import { ProcedureStore } from "../capability/craft-experience/procedure-projection.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { stableDigest } from "../core/digest.ts";

test("tracked paths obey ignore rules before source reads and invalidate a previously published index", async () => {
  const f = await fixture();
  try {
    const root = join(f.root, "repo"); mkdirSync(root);
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
    git("init", "-q");
    for (const path of ["keep.ts", "private.ts", "private\ntracked.ts", "space tracked.ts", "info.ts", "global.ts"])
      writeFileSync(join(root, path), "export const indexedBeforeIgnore = 1;\n");
    git("add", ".");
    const before = f.service.codebaseRepositoryEnsure({ project_root: root });
    writeFileSync(join(root, ".gitignore"), "*.ts\n!keep.ts\n!info.ts\n!global.ts\n");
    writeFileSync(join(root, ".git/info/exclude"), "info.ts\n");
    const globalExcludes = join(f.root, "git-ignore"); writeFileSync(globalExcludes, "global.ts\n");
    git("config", "core.excludesFile", globalExcludes);
    assert.deepEqual(repositoryFiles(root).files.map(file => file.path), ["keep.ts", "info.ts", "global.ts"].sort());
    // Per-repository negations override lower-precedence info/global excludes.
    writeFileSync(join(root, ".gitignore"), "private*\nspace*\n");
    assert.deepEqual(repositoryFiles(root).files.map(file => file.path), ["keep.ts"]);
    const after = f.service.codebaseRepositoryEnsure({ project_root: root });
    assert.notEqual(after.checkpoint_id, before.checkpoint_id);
    assert.throws(() => f.service.codebaseSymbolFind({ ...before, query: "indexedBeforeIgnore" }), /stale/);
    assert.equal(f.service.codebaseRepositoryEnsure({ project_root: root }).index_id, after.index_id);
    const badGit = join(f.root, "bin"); mkdirSync(badGit);
    writeFileSync(join(badGit, "git"), '#!/bin/sh\ncase "$*" in *check-ignore*) exit 2;; esac\nexec /usr/bin/git "$@"\n', { mode: 0o700 });
    const previousPath = process.env.PATH;
    try { process.env.PATH = `${badGit}:${previousPath}`; assert.throws(() => repositoryFiles(root), /Command failed/); }
    finally { process.env.PATH = previousPath; }
  } finally { await f.close(); }
});

test("Graph rework restores the previous accepted version of a refined artifact name", async () => {
  const f = await fixture();
  const definition = {
    nodes: [
      { id: "prepare", type: "action", side_effect: "read_only", requires: ["request"], provides: ["report"], acceptance_ref: "prepare" },
      { id: "refine", type: "action", side_effect: "read_only", requires: ["report"], provides: ["report"], acceptance_ref: "refine" },
      { id: "done", type: "action", side_effect: "read_only", requires: ["report"], provides: [], acceptance_ref: "done" },
    ],
    edges: [
      { id: "start", from: "prepare", to: "refine", kind: "success", max_traversals: 3 },
      { id: "repeat", from: "refine", to: "refine", kind: "condition", predicate_ref: "refine_again", rework: true, max_traversals: 3 },
      { id: "finish", from: "refine", to: "done", kind: "success", max_traversals: 3 },
    ],
    graph_control: { scenario_id: "review", title: "Review",
      entries: [{ id: "start", node_id: "prepare", required_inputs: ["request"], preconditions: [] }],
      exits: [{ id: "done", node_id: "done", required_outputs: ["report"], acceptance_ref: "done" }],
      subscenarios: [{ id: "review", title: "Review", entry_id: "start", exit_id: "done", allowed_nodes: ["prepare", "refine", "done"], allowed_edges: ["start", "repeat", "finish"], allowed_effects: ["read_only"], max_transitions: 10, max_visits: 3 }],
    },
  };
  try {
    let p = f.service.procedureConfigurationSave({ procedure_id: "refinement", scope, title: "Review", procedure_kind: "graph", definition }).procedure as JsonObject;
    for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
      const id = `qualify:${stage}`;
      f.store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest, entry_id: "start", exit_id: "done", subscenario_id: "review", stage, status: "passed" } });
      p = new ProcedureStore(f.store).gate({ procedure_id: p.id, stage, passed: true, evidence_ids: [id] }).procedure as JsonObject;
    }
    f.service.procedureInvocationBind({ ...f.args(p), entry_id: "start", exit_id: "done", subscenario_id: "review", input_refs: { request: "artifact:request" } });
    let decision = 0;
    const transition = (edge: string, extra: JsonObject = {}) => {
      const run = f.store.get("procedure_invocation", "invoke"), loop = f.store.get("durable_action_loop", String(run.action_loop_id));
      const snapshot = f.store.get("state_snapshot", String(loop.latest_snapshot_id)), id = `decision:${++decision}`;
      f.store.create("evidence", id, { source_type: "program", confidence: "confirmed", metadata: { scope, invocation_id: run.id, receipt_id: run.last_receipt_id, graph_state_digest: stableDigest(run.graph_state), snapshot_digest: snapshot.snapshot_digest, workspace_state_revision: snapshot.workspace_state_revision, expires_at: new Date(Date.now() + 60_000).toISOString(), matched_edge_ids: [edge], result: true, safe_to_retry: true, predicate_ref: "refine_again" } });
      return f.service.procedureInvocationTransition({ ...f.params(), transition_id: id, edge_id: edge, receipt_id: run.last_receipt_id, snapshot_id: snapshot.id, evidence_id: id, ...extra });
    };
    const initial = f.service.procedureInvocationReport(f.proof(f.dispatch())).receipt as JsonObject;
    transition("start");
    const originalRef = (initial.output_refs as JsonObject).report;
    const first = f.dispatch(); assert.equal(((first.dispatch as JsonObject).input_refs as JsonObject).report, originalRef);
    const staleReceipt = f.service.procedureInvocationReport(f.proof(first)).receipt as JsonObject;
    transition("repeat");
    await f.reopen();
    const retry = f.dispatch();
    assert.equal(((retry.dispatch as JsonObject).input_refs as JsonObject).report, originalRef);
    const latest = f.service.procedureInvocationReport(f.proof(retry)).receipt as JsonObject;
    assert.throws(() => transition("finish", { receipt_id: staleReceipt.id }), /current-attempt/);
    transition("finish");
    const ending = f.dispatch();
    assert.equal(((ending.dispatch as JsonObject).input_refs as JsonObject).report, (latest.output_refs as JsonObject).report);
    const finalProof = f.proof(ending);
    assert.throws(() => f.service.procedureInvocationReport({ ...finalProof, output_refs: staleReceipt.output_refs }), /replace/);
    f.service.procedureInvocationReport(finalProof);
    assert.equal(f.store.get("procedure_invocation", "invoke").lifecycle, "completed");
  } finally { await f.close(); }
});

test("configured Workflow and Graph export checked definitions as disabled Skills after promotion", async () => {
  const f = await fixture();
  try {
    const procedures = new ProcedureStore(f.store);
    const graph = JSON.parse(readFileSync(new URL("../skills/craft-experience/references/internet-product-engineering.json", import.meta.url), "utf8"));
    for (const [kind, definition] of [["workflow", spec()], ["graph", graph]] as const) {
      let p = f.service.procedureConfigurationSave({ procedure_id: `configured-${kind}`, scope, scenario_id: "review", title: "Configured Review", procedure_kind: kind, definition }).procedure as JsonObject;
      assert.equal(p.content_ref, undefined);
      assert.throws(() => procedures.skillExport({ procedure_id: p.id }), /Only routeable/);
      for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
        const evidence_ids: string[] = [];
        for (const entry of p.entrypoints as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
          const id = `${p.id}:${stage}:${entry.id}:${route.exit_id}:${route.subscenario_id}`;
          f.store.create("evidence", id, { confidence: "confirmed", metadata: { procedure_definition_digest: p.definition_digest, entry_id: entry.id, exit_id: route.exit_id, subscenario_id: route.subscenario_id, stage, status: "passed" } }); evidence_ids.push(id);
        }
        p = procedures.gate({ procedure_id: p.id, stage, passed: true, evidence_ids }).procedure as JsonObject;
      }
      const result = procedures.skillExport({ procedure_id: p.id });
      const exported = result.export as JsonObject;
      assert.equal(exported.enabled, false); assert.equal(exported.status, "draft");
      const markdown = readFileSync(String(exported.path), "utf8");
      assert.match(markdown, /enabled: false/); assert.match(markdown, /Entry \/ Exit contracts/);
      assert.deepEqual(JSON.parse(readFileSync(String(exported.definition_path), "utf8")).definition, definition);
      assert.equal(procedures.skillExport({ procedure_id: p.id }).idempotent, true);
      writeFileSync(String((p.definition_ref as JsonObject).path), "{}\n");
      assert.throws(() => procedures.skillExport({ procedure_id: p.id }), /definition is invalid/);
    }
    f.store.create("experience_procedure", "missing-content", { routeable: true, lifecycle: "routeable" });
    assert.throws(() => procedures.skillExport({ procedure_id: "missing-content" }), /no checked export content/);
  } finally { await f.close(); }
});
