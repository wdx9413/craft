import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { stableDigest } from "../core/digest.ts";
import { WorkbenchEvaluations } from "../core/workbench-evaluations.ts";

const root = resolve(import.meta.dirname, "..");
type Variant = { name: string; args: string[]; routed?: boolean };
async function variants(directory: string): Promise<Variant[]> {
  const runtime = process.env.CRAFT_TEST_MCP_RUNTIME_ROOT || root;
  const standalone = join(directory, "standalone"); await mkdir(standalone);
  for (const file of ["craft-mcp.cjs", "craft-typescript.cjs", "craft-typescript-version.json"])
    await copyFile(join(runtime, "dist/plugin", file), join(standalone, file));
  return [
    { name: "compiled ESM", args: [join(runtime, "dist/bin/craft-mcp-full.js")] },
    { name: "bundled CJS", args: [join(runtime, "dist/plugin/craft-mcp-full.cjs")] },
    { name: "isolated Context CJS without node_modules", args: [join(standalone, "craft-mcp.cjs"), "--product", "context"], routed: true },
  ];
}
async function withClient(variant: Variant, data: string, action: (call: (operation: string, args: JsonObject) => Promise<any>) => Promise<void>) {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !["NODE_PATH", "NODE_OPTIONS"].includes(entry[0])));
  const transport = new StdioClientTransport({ command: process.execPath, args: variant.args, cwd: data, env: { ...env, CRAFT_DATA_DIR: data, CRAFT_CONTINUOUS_LEARNING: "0" }, stderr: "ignore" });
  const client = new Client({ name: "isolated-bundle-contract", version: "1" });
  try {
    await client.connect(transport);
    const routes = new Map<string, { tool: string; arguments: JsonObject }>();
    if (variant.routed) {
      const discovery = await client.callTool({ name: "craft_context_tools_discover", arguments: { intent: "knowledge" } });
      assert.equal(discovery.isError, false);
      for (const tool of (discovery.structuredContent as any).tools) routes.set(tool.name, tool.syscall_route);
    }
    await action((operation, args) => {
      const name = `craft_knowledge_task_effect_${operation}`;
      const route = routes.get(name);
      return client.callTool(variant.routed
        ? { name: route!.tool, arguments: { ...route!.arguments, args } }
        : { name, arguments: args });
    });
  } finally { await client.close(); }
}
const text = (response: any): string => response.content.map((item: { text?: string }) => item.text || "").join("\n");

test("packaged Knowledge task-effect routes return domain errors rather than module-loading failures", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-effect-bundle-errors-")), data = join(directory, "data"); await mkdir(data);
  try {
    for (const variant of await variants(directory)) await withClient(variant, data, async call => {
      for (const operation of ["context", "assess"]) {
        const result = await call(operation, { retrieval_run_id: "missing-bundle-fixture", ...(operation === "assess" ? { baseline_id: "a", candidate_id: "b" } : {}) });
        assert.equal(result.isError, true, variant.name);
        assert.equal(text(result), "Unknown knowledge_evaluation_run: missing-bundle-fixture", variant.name);
      }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

/** Synthetic policy records only; these never prove independent live-model benefit. */
function material(store: CraftStore) {
  const source = store.create("knowledge_source", "source", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified", content_digest: stableDigest("source") });
  store.create("evidence", "claim-evidence", { confidence: "confirmed", metadata: { source_session_id: "claim-session", task_id: "claim-task", source_ref_digest: stableDigest("claim") } });
  const claim = store.create("knowledge_claim", "claim", { status: "candidate", scope: "global", source_id: source.id, content: "Synthetic bundled contract knowledge", identity_digest: stableDigest("claim"), content_digest: stableDigest("body"), evidence_ids: ["claim-evidence"] });
  const refs = [{ claim_id: claim.id, claim_version: claim.version, identity_digest: claim.identity_digest, content_digest: claim.content_digest }];
  const contract = { checks: [{ id: "answer", kind: "stdout_contains", value: "correct" }], safety_checks: [{ id: "safe", kind: "exit_code", equals: 0 }] };
  const cases = Array.from({ length: 21 }, (_, index) => {
    const id = `task-${index}`, evidenceId = `task-evidence-${index}`, adjudicationId = `adjudication-${index}`;
    store.create("evidence", evidenceId, { confidence: "confirmed", metadata: { source_session_id: `heldout-${index}`, task_id: id, source_ref_digest: stableDigest(id) } });
    const item = store.create("knowledge_evaluation_case", id, { query: `Synthetic task ${index}`, identity_digest: stableDigest(id), scope: "global", expected_claim_ids: index === 20 ? [] : [claim.id], candidate_claim_refs: refs,
      source_session_id: `heldout-${index}`, source_task_id: id, source_evidence_ids: [evidenceId], evaluation_channel: "real_session", dataset_partition: "held_out", sanitized: true, label_source: "host_adjudicated", adjudication_id: adjudicationId, task_contract: contract });
    store.create("knowledge_evaluation_adjudication", adjudicationId, { scope: "global", execution_origin: "managed_codex_cli", case_id: id, status: "adjudicated", result_case_version: item.version,
      result_case_identity_digest: item.identity_digest, decision: "accepted", expected_claim_ids: item.expected_claim_ids, task_contract_digest: stableDigest(contract) });
    return item;
  });
  store.create("knowledge_evaluation_run", "retrieval", { mode: "candidate_shadow", status: "eligible", metrics: { provenance_eligible: true }, candidate_claim_refs: refs,
    candidate_source_refs: [{ claim_id: claim.id, source_id: source.id, source_version: source.version, source_digest: source.content_digest, source_status: source.status, source_trust: source.trust }],
    case_ids: cases.map(item => item.id), case_refs: cases.map(item => ({ case_id: item.id, case_version: item.version, identity_digest: item.identity_digest })) });
}

test("bundled Knowledge routes prepare bounded context and re-read real controlled reports without granting software runs admission", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-effect-bundle-reports-")), data = join(directory, "data"), workspace = join(directory, "project"); await mkdir(workspace);
  let store: CraftStore | undefined, evaluations: WorkbenchEvaluations | undefined;
  try {
    store = await new CraftStore(craftPaths(data)).open(); material(store); evaluations = new WorkbenchEvaluations(store);
    const expected = evaluations.knowledgeContext("retrieval");
    const suite = join(directory, "suite.json"), subject = join(directory, "subject.json"), runtime = join(directory, "runtime.json");
    await writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "bundled-software-reports", subject_kind: "software", partition: "development", sanitized: true,
      cases: [{ id: "one", argv: [process.execPath, "-e", "process.exit(0)"], checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
    await writeFile(subject, JSON.stringify({ kind: "software", id: "synthetic-software", version: "1" }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "isolated-bundle-fixture"]))));
    const runs = await Promise.all(["baseline", "candidate"].map(operation_id => evaluations!.submit({ operation_id, suite, subject, runtime, workspace })));
    const until = Date.now() + 10_000;
    while (runs.some(run => ["starting", "running"].includes(String(evaluations!.get(String(run.id)).state))) && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 10));
    const records = runs.map(run => evaluations!.get(String(run.id)));
    const installedVersion = JSON.parse(await readFile(new URL(import.meta.resolve("craft-eval/package.json")), "utf8")).version;
    for (const record of records) { assert.equal(record.state, "completed", String(record.error)); assert.equal(record.evaluator_version, installedVersion); }
    await evaluations.close(); evaluations = undefined; store.close(); store = undefined;
    for (const variant of await variants(directory)) await withClient(variant, data, async call => {
      const prepared = await call("context", { retrieval_run_id: "retrieval" }); assert.equal(prepared.isError, false, text(prepared));
      const { trace_correlation, ...business } = prepared.structuredContent;
      assert.deepEqual(business, expected, variant.name);
      if (variant.routed) { assert.equal(trace_correlation.operation, "craft_run"); assert.equal(typeof trace_correlation.trace_id, "string"); }
      const rejected = await call("assess", { retrieval_run_id: "retrieval", baseline_id: records[0]!.id, candidate_id: records[1]!.id });
      assert.equal(rejected.isError, true); assert.match(text(rejected), /Knowledge effect suites and runtime contracts must match/, `${variant.name}: ${text(rejected)}`);
      const report = join(String(records[1]!.report_root), "controlled-report.json"), original = await readFile(report);
      try {
        await writeFile(report, "{}");
        const tampered = await call("assess", { retrieval_run_id: "retrieval", baseline_id: records[0]!.id, candidate_id: records[1]!.id });
        assert.equal(tampered.isError, true); assert.match(text(tampered), /controlled evaluation report changed/);
      } finally { await writeFile(report, original); }
    });
    store = await new CraftStore(craftPaths(data)).open(); assert.equal(store.list("knowledge_task_effect", 10).length, 0); assert.equal(store.list("task_message", 10).length, 0);
    assert.equal(store.get("knowledge_claim", "claim").status, "candidate");
  } finally { await evaluations?.close(); store?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("evaluation validation and shutdown refuse unsafe reservations before execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-evaluation-reservation-"));
  const store = await new CraftStore(craftPaths(join(directory, "data"))).open(), evaluations = new WorkbenchEvaluations(store);
  try {
    const workspace = join(directory, "project"); await mkdir(workspace);
    const args = { operation_id: "safe", workspace, suite: join(directory, "suite.json"), subject: join(directory, "subject.json"), runtime: join(directory, "runtime.json") };
    for (const file of [args.suite, args.subject, args.runtime]) await writeFile(file, "{}");
    for (const operation_id of [undefined, "", "../bad", "x".repeat(129)]) await assert.rejects(evaluations.submit({ ...args, operation_id }), /operation_id is invalid/);
    for (const value of [null, "relative.json"]) await assert.rejects(evaluations.submit({ ...args, suite: value }), /suite must be an absolute path/);
    await assert.rejects(evaluations.submit({ ...args, workspace: args.subject }), /workspace must be a directory/);
    await writeFile(args.suite, " ".repeat(1024 * 1024 + 1)); await assert.rejects(evaluations.submit(args), /config exceeds 1 MiB/);
    await writeFile(args.suite, JSON.stringify({ cases: [{ in_place: true }] })); await assert.rejects(evaluations.submit(args), /require isolated workspaces/);
    await writeFile(args.suite, "{"); await assert.rejects(evaluations.submit(args), SyntaxError);
    assert.equal(store.list("workbench_evaluation", 10).length, 0);
    await writeFile(args.suite, "{}");
    // Closing during asynchronous preflight must prevent a later reservation.
    const pending = evaluations.submit(args); await evaluations.close();
    await assert.rejects(pending, /evaluation service is closed/); await assert.rejects(evaluations.submit(args), /evaluation service is closed/);
    assert.equal(store.list("workbench_evaluation", 10).length, 0);
  } finally { await evaluations.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a fresh manager observes unresolved records without overwriting another owner's state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-evaluation-observation-"));
  const store = await new CraftStore(craftPaths(directory)).open(), evaluations = new WorkbenchEvaluations(store);
  try {
    assert.throws(() => evaluations.get("missing"), { code: "EVALUATION_NOT_FOUND" });
    for (const state of ["starting", "running", "cancelling"]) {
      const record = store.create("workbench_evaluation", state, { state });
      assert.equal(evaluations.get(state).state, "unknown"); assert.deepEqual(evaluations.events(state).events, []);
      assert.deepEqual(store.get("workbench_evaluation", state), record);
      assert.throws(() => evaluations.cancel(state), /not running in this process/);
      await assert.rejects(evaluations.report(state), /report is not available/);
      store.save("workbench_evaluation", state, { ...record, run_directory: "/not-read-without-a-report-digest" });
      await assert.rejects(evaluations.report(state), /report is not available/);
    }
    await assert.rejects(evaluations.assessKnowledgeEffect("missing", "a", "b"), /Unknown knowledge_evaluation_run/);
    await assert.rejects(evaluations.compare("starting", "running"), /requires completed controlled runs/);
    assert.equal(store.list("knowledge_task_effect", 10).length, 0);
  } finally { await evaluations.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("terminal persistence failure never reports success or creates an unhandled rejection", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "craft-evaluation-persistence-"));
  const store = await new CraftStore(craftPaths(join(directory, "data"))).open(), evaluations = new WorkbenchEvaluations(store);
  const save = store.save.bind(store);
  try {
    const workspace = join(directory, "project"); await mkdir(workspace);
    const suite = join(directory, "suite.json"), subject = join(directory, "subject.json"), runtime = join(directory, "runtime.json");
    await writeFile(suite, JSON.stringify({ schema: "craft-eval.eval.v1", suite_id: "storage-failure", subject_kind: "software", partition: "development", sanitized: true,
      cases: [{ id: "one", argv: [process.execPath, "-e", "process.exit(0)"], checks: [{ id: "exit", kind: "exit_code", equals: 0 }] }] }));
    await writeFile(subject, JSON.stringify({ kind: "software", id: "storage-failure", version: "1" }));
    await writeFile(runtime, JSON.stringify(Object.fromEntries(["environment_digest", "budget_digest", "host_digest", "model_digest", "tools_digest"].map(key => [key, "fixed"]))));
    let failures = 0;
    store.save = (kind, id, record) => {
      if (kind === "workbench_evaluation" && ["completed", "failed"].includes(String(record.state))) { failures++; throw new Error("injected terminal storage failure"); }
      return save(kind, id, record);
    };
    const record = await evaluations.submit({ operation_id: "write-failure-once", suite, subject, runtime, workspace });
    const deadline = Date.now() + 8_000;
    while (evaluations.get(String(record.id)).state !== "unknown" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(failures, 2); assert.equal(evaluations.get(String(record.id)).state, "unknown");
    assert.equal(store.get("workbench_evaluation", String(record.id)).state, "running");
    await assert.rejects(evaluations.report(String(record.id)), /report is not available/);
    const existing = await evaluations.submit({ operation_id: "write-failure-once", suite, subject, runtime, workspace });
    assert.equal(existing.id, record.id); assert.equal(existing.state, "unknown");
  } finally { store.save = save; await evaluations.close(); store.close(); await rm(directory, { recursive: true, force: true }); }
});
