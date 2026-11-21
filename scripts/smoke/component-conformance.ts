import { experienceGraphTemplate } from '@craft/capability-experience/procedure-templates';
/** Isolated stdio workflow contract for any launcher consuming the shared component bundle. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseToolName } from "../../core/tool-plane.ts";
import { validateJsonSchema, type JsonValue } from "../../core/json-schema.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";

const bundle = resolve(process.argv[2] ?? "dist/plugin/craft-mcp.cjs");
const reports: JsonObject[] = [];
const selectedProduct = process.argv[3];
const products = ["context", "knowledge", "memory", "experience", "codebase", "notes", "eval", "runtime"];
if (selectedProduct && !products.includes(selectedProduct)) throw new Error("Unknown conformance product");
for (const product of selectedProduct ? [selectedProduct] : products) {
  const root = await mkdtemp(join(tmpdir(), `craft-wire-${product}-`));
  const child = spawn(process.execPath, [bundle, "--product", product], { env: { ...process.env, CRAFT_DATA_DIR: join(root, "data"), CRAFT_CONTINUOUS_LEARNING: "0" }, stdio: ["pipe", "pipe", "pipe"] });
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
    const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${product} ${method} timed out`)); }, 60_000);
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
      const tool = tools.find(item => item.name === name);
      if (!tool && product === "context") {
        const operation = parseToolName(name);
        const described = await request("tools/call", { name: "craft_describe", arguments: operation });
        assert.equal(described.structuredContent.tool, name, `${product} missing ${name}`);
        const result = await request("tools/call", { name: "craft_run", arguments: { ...operation, args } });
        assert.equal(result.isError, false, JSON.stringify(result)); calls++; return result.structuredContent;
      }
      assert(tool, `${product} missing ${name}`);
      validateJsonSchema(args as JsonValue, tool.inputSchema as JsonValue);
      const result = await request("tools/call", { name, arguments: args }); assert.equal(result.isError, false, JSON.stringify(result)); calls++; return result.structuredContent;
    };
    const asset = async (member: string, item: any, assetScope: JsonObject) => {
      const args = { ...assetScope, asset_id: item.id };
      for (const action of ["history", "read", "diff", "explain"]) await call(`craft_${member}_asset_inspect`, { ...args, action, ...(action === "read" || action === "diff" ? { version: item.version } : {}), ...(action === "diff" ? { target_version: item.version } : {}) });
      const restored = await call(`craft_${member}_asset_restore`, { ...args, version: item.version, expected_version: item.version, request_id: `restore:${item.id}`, reason: "Fixture restoration" });
      assert.equal(restored.restoration.execution_authorized, false);
    };
    const info = await call("craft_info");
    assert.equal(info.installed_artifact?.verified, true, "Installed executable must match its own build manifest");
    const fixtureProject = join(root, "project"); await mkdir(fixtureProject);
    const identity = ["knowledge", "memory", "experience"].includes(product)
      ? await call("craft_scope_identity_resolve_project", { project_root: fixtureProject }) : null;
    const canonicalScope = identity?.identity.canonical_scope;
    const scope = canonicalScope ? { scope_kind: canonicalScope.kind, scope_id: canonicalScope.id } : { scope_kind: "project", scope_id: "fixture" };
    const scopeKey = product === "experience" ? scope.scope_id : `${scope.scope_kind}:${scope.scope_id}`;
    if (["knowledge", "memory", "experience"].includes(product)) {
      if (tools.some(tool => tool.name === "craft_component_diagnose")) await call("craft_component_diagnose", { component: product, observed_tool_names: tools.map(tool => tool.name) });
      else await call("craft_component_readiness_get", { component: product });
      assert(!tools.some(tool => tool.name === "craft_context_resolution_resolve"), "Standalone owners must not depend on Context receipts");
    }
    if (product === "context") {
      const repo = join(root, "repo"); await mkdir(repo); execFileSync("git", ["-C", repo, "init", "-q"]);
      await writeFile(join(repo, "verify.ts"), "export function verify() {}\n");
      await call("craft_knowledge_bootstrap_install");
      const first = await call("craft_context_open", { project_root: repo, query: "verify code", task_kind: "code", session_id: "smoke", session_scope_id: "smoke", session_host: "codex", turn_id: "turn" });
      assert.equal(first.codebase.status, "ready", JSON.stringify(first.codebase)); assert(first.working_set.id); assert(first.codebase.references.length);
      const project = first.receipt.scope;
      await call("craft_memory_capture_user_statement", { content: "verify code before delivery", session_id: "smoke", session_host: "codex", project_scope_id: project.id, project_root: repo });
      const pack = await call("craft_context_open", { project_root: repo, query: "verify code", task_kind: "code", session_id: "smoke", session_scope_id: "smoke", session_host: "codex", turn_id: "turn" });
      assert.equal(pack.items.length, 1); assert(pack.asset_refs.some((ref: any) => ref.member === "codebase"));
      const replay = await call("craft_context_open", { project_root: repo, query: "verify code", task_kind: "code", session_id: "smoke", session_scope_id: "smoke", session_host: "codex", turn_id: "turn" }); assert.equal(replay.pack_receipt.id, pack.pack_receipt.id);
      const discovered = await call("craft_context_tools_discover", { intent: "memory" }); assert(discovered.tools.some((tool: any) => tool.name === "craft_memory_governance"));
      await call("craft_memory_governance", { action: "tasks", scope_kind: project.kind, scope_id: project.id });
      await call("craft_memory_governance", { action: "topics", content: "verify code", scope_kind: project.kind, scope_id: project.id });
      await call("craft_context_resolution_feedback", { receipt_id: pack.pack_receipt.id, outcome: "helpful", usage_stage: "used", asset_refs: pack.asset_refs });
    } else if (product === "knowledge") {
      await call("craft_knowledge_bootstrap_install");
      const evidence = await call("craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "Fixture verification observed" });
      const saved = await call("craft_knowledge_claim_save", { kind: "fact", content: "Run verification", scope: scopeKey, source_id: "builtin.evidence-wiki", evidence_ids: [evidence.id] });
      const packet = await call("craft_knowledge_semantic_review_packet", { claim_id: saved.claim.id }); assert.equal(packet.status, "unavailable");
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification" })).hits.length, 0);
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification", include_candidates: true })).hits.length, 1);
      assert.equal((await call("craft_knowledge_search", { scope_kind: "project", scope_id: "other", query: "verification", include_candidates: true })).hits.length, 0);
      const sourceFile = join(fixtureProject, "README.md"); await writeFile(sourceFile, "Run focused verification before delivery.\n");
      await call("craft_knowledge_source_register", { source_id: "fixture-source", kind: "project_note", label: "Fixture", trust: "verified", ...scope, locator: sourceFile, content_digest: "sha256:fixture-source" });
      const ingest = await call("craft_knowledge_source_ingest", { source_id: "fixture-source" }); assert.equal(ingest.status, "completed");
      const claimId = ingest.candidates[0].claim_id;
      const ready = await call("craft_knowledge_semantic_review_packet", { claim_id: claimId }); assert.equal(ready.status, "ready");
      const review = await call("craft_knowledge_host_review", { claim_id: claimId, host_kind: "conformance", host_run_key: "fixture:review", source_digest: ready.packet.source.content_digest, packet_digest: ready.packet_digest, decision: "supported" }); assert.equal(review.promoted, false); assert.equal(review.review.decision, "supported");
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification" })).hits.length, 0);
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification", include_candidates: true })).hits.length, 2);
      await writeFile(sourceFile, "Changed source requires revalidation.\n"); await call("craft_knowledge_source_ingest", { source_id: "fixture-source" });
      assert.equal((await call("craft_knowledge_search", { ...scope, query: "verification" })).hits.length, 0);
      await asset(product, saved.claim, scope);
    } else if (product === "memory") {
      await call("craft_knowledge_bootstrap_install");
      for (const session of ["fixture-one", "fixture-two"]) await call("craft_memory_capture_user_statement", {
        content: "Run verification", session_id: session, session_host: "codex", project_scope_id: scope.scope_id, project_root: fixtureProject });
      const ledger = await call("craft_memory_ledger_list", scope); assert.equal(ledger.memories.length, 1);
      await asset(product, ledger.memories[0], scope);
      assert.equal((await call("craft_memory_recall", { ...scope, query: "verification" })).items.length, 1);
      await call("craft_memory_ledger_transition", { ...scope, memory_id: ledger.memories[0].id, expected_version: ledger.memories[0].version, status: "revoked", reason: "fixture correction" });
      assert.equal((await call("craft_memory_recall", { ...scope, query: "verification" })).items.length, 0);
    } else if (product === "experience") {
      const evidence = await call("craft_evidence_record", { source_type: "observation", confidence: "bounded", claim: "Fixture outcome" });
      for (const id of ["run-a", "run-b"]) await call("craft_experience_observe", { source_kind: "fixture", source_id: id, source_digest: id, scope: scopeKey, outcome: "passed", sanitized: true, scenario_key: "fixture:verify", evidence_ids: [evidence.id] });
      const draft = await call("craft_experience_procedure_draft", { scenario_key: "fixture:verify", hypothesis: "Use focused tests", design_axes: ["orchestration"], output_contract_ref: "fixture:acceptance" });
      const submitted = await call("craft_experience_procedure_submit", { request_id: draft.request.id, workflow_id: "fixture", name: "Fixture", description: "Verify", inputs: [],
        steps: [{ id: "verify", type: "instruction", instruction: "Verify the fixture report.", side_effect: "read_only", requires: [], provides: ["report"] }],
        composition: { entries: [{ id: "verify", title: "Verify", required_inputs: [], preconditions: [], routes: [{ exit_id: "verified", step_ids: ["verify"] }] }],
          exits: [{ id: "verified", title: "Verified", required_outputs: ["report"], acceptance_ref: "fixture:verified" }] } });
      const procedure = await call("craft_procedure_create", { proposal_id: submitted.proposal.id, procedure_kind: "workflow", trigger: "fixture verification", preconditions: [] });
      assert.equal((await call("craft_procedure_list", { scope: scopeKey })).procedures.some((item: any) => item.id === procedure.procedure.id && item.routeable), false);
      const rejected = await request("tools/call", { name: "craft_procedure_gate", arguments: {
        procedure_id: procedure.procedure.id, stage: "held_out", passed: true, evidence_ids: [evidence.id] } });
      assert.equal(rejected.isError, true, "Caller-declared Evidence cannot qualify an installed Procedure");
      assert.equal((await call("craft_procedure_get", { procedure_id: procedure.procedure.id })).procedure.routeable, false);
      await asset(product, procedure.procedure, scope);
      const configuration = await call("craft_procedure_configuration_save", { procedure_id: "internet-product-engineering", scope: scopeKey,
        title: "互联网产研", procedure_kind: "graph", definition: experienceGraphTemplate("internet-product-engineering") });
      assert.equal(configuration.procedure.routeable, false);
    } else if (product === "notes") {
      const directory = join(root, "notes-project"); await mkdir(directory);
      await call("craft_notes_create_device", { id: "fixture", note: "Fixture device" });
      const observed = await call("craft_notes_observe_directory", { device_id: "fixture", path: directory, note: "Keep verified fixture notes", pin: true });
      await call("craft_notes_confirm", { id: observed.note.id, expected_version: observed.note.version });
      const resolvedNotes = (await call("craft_notes_resolve", { device_id: "fixture", path: directory })).items;
      assert.equal(resolvedNotes.filter((item: any) => item.subject_type === "directory").length, 1);
      await call("craft_notes_revoke", { id: observed.note.id, expected_version: observed.note.version + 1, revoked_by: "fixture", reason: "Fixture retired" });
      assert.equal((await call("craft_notes_resolve", { device_id: "fixture", path: directory })).items.some((item: any) => item.subject_type === "directory"), false);
    } else if (product === "eval") {
      const defined = await call("craft_evaluation_contract_define", { contract_id: "installed-contract", capability_id: "fixture", capability_version: 1, input_contract: "fixture input", output_contract: "fixture output" });
      const loaded = await call("craft_evaluation_contract_get", { contract_id: "installed-contract" });
      assert.equal(loaded.contract.contract_digest, defined.contract.contract_digest);
    } else if (product === "runtime") {
      const started = await call("craft_trace_start", { task_id: "installed-fixture", trace_id: "installed-trace" });
      const loaded = await call("craft_trace_get", { trace_id: started.trace.id });
      assert.equal(loaded.trace.id, "installed-trace");
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
    reports.push({ product, installed_artifact: info.installed_artifact, status: "passed", level: product === "experience" ? "candidate_lifecycle_and_gate_rejection_verified" : product === "knowledge" ? "source_review_candidate_lifecycle_verified" : "workflow_verified", transport: "stdio", schema_digest: fingerprint.schema_digest, entrypoint_digest: fingerprint.entrypoint_digest, protocol: initialized.protocolVersion, tool_count: tools.length, calls, host_session_verified: false });
  } finally { child.kill(); await new Promise<void>(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once("exit", () => done())); await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}
console.log(JSON.stringify({ artifact_sha256: createHash("sha256").update(await readFile(bundle)).digest("hex"), reports }, null, 2));
