/** Isolated stdio workflow contract for any launcher consuming the shared component bundle. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { validateJsonSchema, type JsonValue } from "../../core/json-schema.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

const bundle = resolve(process.argv[2] ?? "dist/plugin/craft-mcp.cjs");
const reports: JsonObject[] = [];
for (const product of ["knowledge", "memory", "experience", "codebase"]) {
  const root = await mkdtemp(join(tmpdir(), `craft-wire-${product}-`));
  const child = spawn(process.execPath, [bundle, "--product", product], { env: { ...process.env, CRAFT_DATA_DIR: join(root, "data") }, stdio: ["pipe", "pipe", "pipe"] });
  let sequence = 0, output = "", calls = 0; const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  child.stderr.on("data", () => {});
  child.stdout.on("data", chunk => {
    output += chunk;
    let newline: number;
    while ((newline = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, newline); output = output.slice(newline + 1); if (!line.trim()) continue;
      try { const response = JSON.parse(line); const waiter = pending.get(response.id); if (waiter) { pending.delete(response.id); response.error ? waiter.reject(new Error(JSON.stringify(response.error))) : waiter.resolve(response.result); } }
      catch (error) { for (const waiter of pending.values()) waiter.reject(error as Error); pending.clear(); }
    }
  });
  const fail = (error: Error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
  child.on("error", fail); child.on("exit", () => fail(new Error("MCP exited before response"))); child.stdin.on("error", fail);
  const request = (method: string, params: object = {}) => new Promise<any>((resolveRequest, reject) => {
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${product} ${method} timed out`)); }, 15_000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolveRequest(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    const initialized = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "craft-conformance", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await request("tools/list");
    const tools = listed.tools as JsonObject[];
    const fingerprint = initialized.capabilities.experimental?.["craft/runtime-fingerprint"];
    assert(fingerprint, "Stale runtime: initialize lacks craft/runtime-fingerprint; rebuild and update the installed bundle before Host verification");
    assert.equal(fingerprint.schema_digest, listed._meta["craft/runtime-fingerprint"].schema_digest);
    const call = async (name: string, args: JsonObject = {}) => {
      const tool = tools.find(item => item.name === name); assert(tool, `${product} missing ${name}`);
      validateJsonSchema(args as JsonValue, tool.inputSchema as JsonValue);
      const result = await request("tools/call", { name, arguments: args }); assert.equal(result.isError, false, JSON.stringify(result)); calls++; return result.structuredContent;
    };
    const asset = async (member: string, item: any, assetScope: JsonObject) => {
      const args = { ...assetScope, asset_id: item.id };
      for (const action of ["history", "read", "diff", "explain"]) await call(`craft_${member}_asset_inspect`, { ...args, action, ...(action === "read" || action === "diff" ? { version: item.version } : {}), ...(action === "diff" ? { target_version: item.version } : {}) });
      const restored = await call(`craft_${member}_asset_restore`, { ...args, version: item.version, expected_version: item.version, request_id: `restore:${item.id}`, reason: "Fixture restoration" });
      assert.equal(restored.restoration.execution_authorized, false);
    };
    if (product === "codebase") await call("craft_info");
    const scope = { scope_kind: "project", scope_id: "fixture" };
    if (product !== "codebase") {
      await call("craft_component_diagnose", { component: product, observed_tool_names: tools.map(tool => tool.name) });
      const context = await call("craft_context_resolution_resolve", { ...scope, query: "verification" });
      assert.deepEqual(context.receipt.members, [product]);
      await call("craft_context_resolution_feedback", { receipt_id: context.receipt.id, outcome: "irrelevant" });
    }
    if (product === "knowledge") {
      await call("craft_knowledge_bootstrap_install");
      const evidence = await call("craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "Fixture verification observed" });
      const saved = await call("craft_knowledge_claim_save", { kind: "fact", content: "Run verification", scope: "project:fixture", source_id: "builtin.evidence-wiki", evidence_ids: [evidence.id] });
      const packet = await call("craft_knowledge_semantic_review_packet", { claim_id: saved.claim.id }); assert.equal(packet.status, "unavailable");
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification" })).hits.length, 0);
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification", include_candidates: true })).hits.length, 1);
      assert.equal((await call("craft_knowledge_search", { scope_kind: "project", scope_id: "other", query: "verification", include_candidates: true })).hits.length, 0);
      const sourceFile = join(root, "README.md"); await writeFile(sourceFile, "Run focused verification before delivery.\n");
      await call("craft_knowledge_source_register", { source_id: "fixture-source", kind: "project_note", label: "Fixture", trust: "verified", ...scope, locator: sourceFile, content_digest: "sha256:fixture-source" });
      const ingest = await call("craft_knowledge_source_ingest", { source_id: "fixture-source" }); assert.equal(ingest.status, "completed");
      const claimId = ingest.candidates[0].claim_id;
      const ready = await call("craft_knowledge_semantic_review_packet", { claim_id: claimId }); assert.equal(ready.status, "ready");
      const review = await call("craft_knowledge_host_review", { claim_id: claimId, host_kind: "conformance", host_run_key: "fixture:review", source_digest: ready.packet.source.content_digest, packet_digest: ready.packet_digest, decision: "supported" }); assert.equal(review.promoted, true);
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification" })).hits.length, 1);
      await writeFile(sourceFile, "Changed source requires revalidation.\n"); await call("craft_knowledge_source_ingest", { source_id: "fixture-source" });
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification" })).hits.length, 0);
      await asset(product, saved.claim, scope);
    } else if (product === "memory") {
      await call("craft_knowledge_bootstrap_install");
      await call("craft_memory_capture_user_statement", { ...scope, content: "Run verification", explicit_consent: true, auto_accept: true });
      const ledger = await call("craft_memory_ledger_list", scope); assert.equal(ledger.memories.length, 1);
      await asset(product, ledger.memories[0], scope);
      assert.equal((await call("craft_context_resolution_resolve", { ...scope, query: "verification" })).items.length, 1);
      await call("craft_memory_ledger_transition", { memory_id: ledger.memories[0].id, expected_version: ledger.memories[0].version, status: "revoked", reason: "fixture correction" });
      assert.equal((await call("craft_context_resolution_resolve", { ...scope, query: "verification" })).items.length, 0);
    } else if (product === "experience") {
      const evidence = await call("craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "Fixture outcome" });
      for (const id of ["run-a", "run-b"]) await call("craft_experience_observe", { source_kind: "fixture", source_id: id, source_digest: id, scope: "project:fixture", outcome: "passed", sanitized: true, scenario_key: "fixture:verify", evidence_ids: [evidence.id] });
      const draft = await call("craft_experience_procedure_draft", { scenario_key: "fixture:verify", hypothesis: "Use focused tests", design_axes: ["orchestration"], output_contract_ref: "fixture:acceptance" });
      const submitted = await call("craft_experience_procedure_submit", { request_id: draft.request.id, workflow_id: "fixture", name: "Fixture", description: "Verify", inputs: [], steps: [{ type: "assertion" }] });
      const procedure = await call("craft_procedure_create", { proposal_id: submitted.proposal.id, procedure_kind: "workflow", trigger: "fixture verification", preconditions: [] });
      assert.deepEqual((await call("craft_context_resolution_resolve", { ...scope, query: "verification" })).contributions.flatMap((item: any) => item.items), []);
      for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
        const gateEvidence = await call("craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: `Fixture gate ${stage}` });
        const gateArgs = { procedure_id: procedure.procedure.id, stage, passed: true, evidence_ids: [gateEvidence.id] };
        const firstGate = await call("craft_procedure_gate", gateArgs), retryGate = await call("craft_procedure_gate", gateArgs);
        assert.equal(retryGate.idempotent, true); assert.equal(retryGate.procedure.version, firstGate.procedure.version);
      }
      assert.equal((await call("craft_context_resolution_resolve", { ...scope, query: "verification" })).contributions.flatMap((item: any) => item.items).length, 1);
      await call("craft_procedure_gate", { procedure_id: procedure.procedure.id, stage: "canary", passed: false, evidence_ids: [evidence.id], verdict: "fixture regression" });
      assert.equal((await call("craft_context_resolution_resolve", { ...scope, query: "verification" })).contributions.flatMap((item: any) => item.items).length, 0);
      // Exercise the portable Entry/Exit contract over actual JSON-RPC, not only handlers.
      for (const id of ["composition-a", "composition-b"]) await call("craft_experience_observe", { source_kind: "fixture", source_id: id, source_digest: id, scope: "project:fixture", outcome: "passed", sanitized: true, scenario_key: "fixture:composition", evidence_ids: [evidence.id] });
      const composedDraft = await call("craft_experience_procedure_draft", { scenario_key: "fixture:composition", hypothesis: "Review can be entered with a diff", design_axes: ["orchestration"], output_contract_ref: "fixture:review-report" });
      const composed = await call("craft_experience_procedure_submit", { request_id: composedDraft.request.id, workflow_id: "review-process", name: "Review process", description: "Review entry fixture", inputs: [],
        steps: [{ id: "review", type: "instruction", instruction: "Review diff", side_effect: "read_only", requires: ["diff"], provides: ["report"] }],
        composition: { entries: [{ id: "review", title: "Code Review", required_inputs: ["diff"], preconditions: [], routes: [{ exit_id: "reviewed", step_ids: ["review"] }] }], exits: [{ id: "reviewed", title: "Review complete", required_outputs: ["report"], acceptance_ref: "fixture:review-report" }] } });
      assert.equal(composed.workflow, null);
      for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
        const proof = await call("craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "Fixture route gate", metadata: { procedure_definition_digest: composed.procedure.definition_digest, entry_id: "review", exit_id: "reviewed", stage, status: "passed" } });
        await call("craft_procedure_gate", { procedure_id: composed.procedure.id, stage, passed: true, evidence_ids: [proof.id] });
      }
      assert((await call("craft_procedure_list", { scope: "project:fixture" })).procedures.some((item: any) => item.id === composed.procedure.id));
      const current = (await call("craft_procedure_get", { procedure_id: composed.procedure.id })).procedure;
      await asset(product, current, scope);
      const configuration = await call("craft_procedure_configuration_save", { procedure_id: "internet-product-engineering", scope: "project:fixture", title: "互联网产研", procedure_kind: "graph", definition: JSON.parse(await readFile(new URL("../../skills/craft-experience/references/internet-product-engineering.json", import.meta.url), "utf8")) });
      assert.equal(configuration.procedure.routeable, false);
      const planned = await call("craft_procedure_plan", { procedure_id: current.id, procedure_version: current.version, scope: "project:fixture", entry_id: "review", exit_id: "reviewed", input_refs: { diff: "fixture:diff" }, allowed_effects: ["read_only"] });
      assert.equal(planned.execution_authorized, false); assert.equal(planned.plan.acceptance_status, "not_evaluated"); assert.equal(planned.expanded_step_count, 1);
    } else {
      const repo = join(root, "repo"); await mkdir(repo); await writeFile(join(repo, "a.ts"), "export function verify() {}\nverify();\n");
      await call("craft_codebase_workspace_open", { workspace_id: "fixture", root_path: repo, include_paths: ["a.ts"] });
      await call("craft_codebase_activate", { workspace_id: "fixture" });
      const built = await call("craft_codebase_refresh", { workspace_id: "fixture" });
      await asset(product, built.index, { scope_kind: "workspace", scope_id: "fixture" });
      const query = { workspace_id: "fixture", index_id: built.index.id };
      const found = await call("craft_codebase_symbol_find", { ...query, query: "verify" }); assert(found.symbols.length);
      await call("craft_codebase_context_slice", { ...query, node_ids: [found.symbols[0].id] });
      await writeFile(join(repo, "a.ts"), "export function changed() {}\n");
      assert.equal((await call("craft_codebase_status", { workspace_id: "fixture" })).working_tree.status, "changed");
      await call("craft_codebase_refresh", { workspace_id: "fixture" });
    }
    reports.push({ product, status: "passed", level: "workflow_verified", transport: "stdio", schema_digest: fingerprint.schema_digest, entrypoint_digest: fingerprint.entrypoint_digest, protocol: initialized.protocolVersion, tool_count: tools.length, calls, host_session_verified: false });
  } finally { child.kill(); await new Promise<void>(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())); await rm(root, { recursive: true, force: true }); }
}
console.log(JSON.stringify({ artifact_sha256: createHash("sha256").update(await readFile(bundle)).digest("hex"), reports }, null, 2));
