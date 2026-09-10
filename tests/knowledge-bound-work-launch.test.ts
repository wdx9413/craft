import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { KnowledgeBoundLaunchKernel } from "../src/knowledge-bound-launch.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService, VERSION } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

function record(result: JsonObject, key: string): JsonObject { return result[key] as JsonObject; }
function contextDigest(context: string): string { return `sha256:${createHash("sha256").update(JSON.stringify(context)).digest("hex")}`; }

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-launch-")); const store = await new CraftStore(craftPaths(join(root, "data"))).open(); const service = new CraftService(store);
  const task = record(service.taskOpen({ title: "Brief", goal: "Prepare an accurate brief" }), "task");
  const evidence = service.evidenceRecord({ evidence_id: "evidence", source_type: "program", claim: "Program observation." });
  const claim = record(service.knowledgeClaimSave({ claim_id: "claim", kind: "rule", content: "Use the approved project facts.", scope: "project:brief", valid_until: "2027-01-01T00:00:00.000Z", evidence_ids: [evidence.id] }), "claim");
  service.knowledgeClaimReview({ claim_id: claim.id, status: "reviewed", reviewer: "reviewer", reason: "checked" });
  const compiled = service.wikiContextCompile({ bundle_id: "bundle", query: "approved facts", scope: "project:brief", max_items: 2, max_chars: 1_000, now: "2026-09-10T00:00:00.000Z" });
  return { root, store, service, task, evidence, claim: service.knowledgeClaimGet({ claim_id: claim.id }).claim as JsonObject, bundle: record(compiled, "bundle") };
}

test("Knowledge-bound Work Launch pins reviewed Wiki knowledge across Dispatch, Trial, and Outcome", async () => {
  const f = await fixture(); let receivedPrompt = "";
  try {
    f.service.codexHost.executor = async (request) => { receivedPrompt = request.stdin; return { exitCode: 0, signal: null, stdout: "", stderr: "", timedOut: false, cancelled: false, outputLimited: false }; };
    const args = { task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "Prepare the brief", bundle_id: f.bundle.id, bundle_version: f.bundle.version, sandbox: "workspace-write", now: "2026-09-10T00:00:00.000Z" };
    const prepared = await f.service.knowledgeContextWorkLaunchPrepare(args); const launch = record(prepared, "launch"); const dispatch = record(prepared, "dispatch"); const binding = record(prepared, "knowledge_binding");
    assert.equal(binding.bundle_id, f.bundle.id); assert.equal(binding.bundle_version, f.bundle.version); assert.match(String(binding.context_digest), /^sha256:/); assert.match(String(binding.context), /Evidence: evidence/);
    const trial = record(f.service.trialGet({ trial_id: launch.trial_id }), "trial"); assert.deepEqual((trial.environment as JsonObject).knowledge_binding, binding); assert.deepEqual(launch.knowledge_binding, binding); assert.deepEqual(dispatch.knowledge_binding, binding);
    assert.throws(() => f.service.hostRunStart({ host: "codex-cli", dispatch_id: dispatch.id, prompt: "ignored" }), /Knowledge-bound/);
    await assert.rejects(f.service.codexDispatchExecute({ dispatch_id: dispatch.id, prompt: "ignored" }), /Knowledge-bound/);
    assert.throws(() => f.service.workLaunchDecide({ launch_id: launch.id, actor: "human", approved: true, prompt: "Prepare the brief" }), /Knowledge-bound/);
    const decided = await f.service.knowledgeContextWorkLaunchDecide({ launch_id: launch.id, actor: "human", approved: true, prompt: "Prepare the brief", now: "2026-09-10T00:00:00.000Z" }); const running = record(decided, "launch");
    await f.service.hostRuns.wait(String(running.run_id)); assert.match(receivedPrompt, /craft-read-only-evidence-knowledge/); assert.match(receivedPrompt, /Use the approved project facts/);
    const outcome = f.store.get("outcome", `outcome_${launch.trial_id}`); assert.deepEqual(outcome.knowledge_binding, binding);
    const mcp = new McpServer(f.service, "full"); const mcpPrepared = await mcp.handle({ id: "mcp", method: "tools/call", params: { name: "craft_knowledge_context_work_launch_prepare", arguments: { ...args, launch_id: "mcp-launch" } } }); assert.equal((mcpPrepared?.result as JsonObject).isError, false);
    const mcpDecided = await mcp.handle({ id: "mcp-decide", method: "tools/call", params: { name: "craft_knowledge_context_work_launch_decide", arguments: { launch_id: "mcp-launch", actor: "human", approved: false, prompt: args.prompt, now: args.now } } }); assert.equal((mcpDecided?.result as JsonObject).isError, false);
    assert.equal(VERSION, "0.11.36");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Knowledge-bound Work Launch fails closed on Claim, Bundle, Evidence, expiry, and retry drift", async () => {
  const f = await fixture();
  try {
    const args = { task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "Prepare", bundle_id: f.bundle.id, sandbox: "workspace-write", now: "2026-09-10T00:00:00.000Z" };
    await assert.rejects(f.service.knowledgeContextWorkLaunchPrepare({ ...args, now: "2027-01-01T00:00:00.000Z" }), /expired/);
    f.store.remove("evidence", String(f.evidence.id)); await assert.rejects(f.service.knowledgeContextWorkLaunchPrepare(args), /Unknown evidence/);
    f.store.create("evidence", String(f.evidence.id), { source_type: "program", claim: "Restored." });
    const prepared = await f.service.knowledgeContextWorkLaunchPrepare({ ...args, launch_id: "changed" }); const launch = record(prepared, "launch");
    f.service.knowledgeClaimReview({ claim_id: f.claim.id, status: "disputed", reviewer: "reviewer", reason: "changed" });
    await assert.rejects(f.service.knowledgeContextWorkLaunchDecide({ launch_id: launch.id, actor: "human", approved: true, prompt: args.prompt, now: args.now }), /version changed/);
    const other = await fixture();
    try {
      const second = await other.service.knowledgeContextWorkLaunchPrepare({ ...args, task_id: other.task.id, workspace: other.root, bundle_id: other.bundle.id, launch_id: "bundle-changed" }); const secondLaunch = record(second, "launch");
      other.store.save("wiki_context_bundle", String(other.bundle.id), { ...other.bundle, context_digest: "sha256:changed" });
      await assert.rejects(other.service.knowledgeContextWorkLaunchDecide({ launch_id: secondLaunch.id, actor: "human", approved: true, prompt: args.prompt, now: args.now }), /bundle changed/);
    } finally { other.store.close(); await rm(other.root, { recursive: true, force: true }); }
    assert.throws(() => f.service.workLaunchRetry({ launch_id: launch.id, prompt: "Retry" }), /Knowledge-bound/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Knowledge-bound Work Launch retries only through the revalidating protocol", async () => {
  const f = await fixture();
  try {
    f.service.codexHost.executor = async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "failed", timedOut: false, cancelled: false, outputLimited: false });
    const pending = await f.service.knowledgeContextWorkLaunchPrepare({ task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "Pending", bundle_id: f.bundle.id, sandbox: "workspace-write", launch_id: "pending" });
    await assert.rejects(f.service.knowledgeContextWorkLaunchRetry({ launch_id: record(pending, "launch").id, prompt: "Retry" }), /Only a failed/);
    assert.equal(record(await f.service.knowledgeContextWorkLaunchDecide({ launch_id: "pending", actor: "human", approved: false, prompt: "Pending" }), "launch").status, "denied");
    const args = { task_id: f.task.id, host: "codex-cli", workspace: f.root, prompt: "Prepare", bundle_id: f.bundle.id, sandbox: "read-only", now: "2026-09-10T00:00:00.000Z", acceptance_name: "Proof", acceptance_criteria: [{ id: "proof", name: "Proof", method: "program", required: true }] };
    const first = await f.service.knowledgeContextWorkLaunchPrepare(args); const launch = record(first, "launch"); await f.service.hostRuns.wait(String(launch.run_id));
    const retried = await f.service.knowledgeContextWorkLaunchRetry({ launch_id: launch.id, prompt: "Retry", new_launch_id: "retry", now: args.now }); assert.equal(record(retried, "launch").retry_of, launch.id); await f.service.hostRuns.wait(String(record(retried, "launch").run_id));
    const defaultRetry = await f.service.knowledgeContextWorkLaunchRetry({ launch_id: "retry", prompt: "Retry default", now: args.now }); await f.service.hostRuns.wait(String(record(defaultRetry, "launch").run_id));
    const mcp = new McpServer(f.service, "full"); const mcpRetry = await mcp.handle({ id: "retry", method: "tools/call", params: { name: "craft_knowledge_context_work_launch_retry", arguments: { launch_id: "retry", prompt: "Retry again", new_launch_id: "retry-mcp", now: args.now } } }); assert.equal((mcpRetry?.result as JsonObject).isError, false); await f.service.hostRuns.wait(String(f.store.get("work_launch", "retry-mcp").run_id));
    f.service.claudeHost.executor = async () => ({ exitCode: 1, signal: null, stdout: "", stderr: "failed", timedOut: false, cancelled: false, outputLimited: false });
    const claude = await f.service.knowledgeContextWorkLaunchPrepare({ ...args, host: "claude-code", launch_id: "claude", acceptance_criteria: undefined }); const claudeLaunch = record(claude, "launch"); const claudeDispatch = record(claude, "dispatch"); await f.service.hostRuns.wait(String(claudeLaunch.run_id)); await assert.rejects(f.service.claudeDispatchExecute({ dispatch_id: claudeDispatch.id, prompt: args.prompt }), /Knowledge-bound/);
    const claudeRetry = await f.service.knowledgeContextWorkLaunchRetry({ launch_id: claudeLaunch.id, prompt: "Retry Claude", new_launch_id: "claude-retry", now: args.now }); await f.service.hostRuns.wait(String(record(claudeRetry, "launch").run_id));
    assert.throws(() => f.service.hostRunStart({ host: "unknown", dispatch_id: "none", prompt: "No" }), /unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Knowledge binding validator rejects malformed or no-longer-safe receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-validator-")); const store = await new CraftStore(craftPaths(root)).open(); const kernel = new KnowledgeBoundLaunchKernel(store);
  try {
    store.create("evidence", "e", { claim: "Observed." });
    const add = (id: string, claim: JsonObject = {}, bundle: JsonObject = {}) => {
      const content = String(claim.content ?? "Fact."); const evidenceIds = (claim.evidence_ids ?? ["e"]) as string[];
      store.create("knowledge_claim", id, { status: "reviewed", scope: "project:a", content, evidence_ids: evidenceIds, ...claim });
      const context = `[Knowledge ${id}]\n${content}\nEvidence: ${evidenceIds.join(", ")}\n`;
      store.create("wiki_context_bundle", `b-${id}`, { scope: "project:a", max_chars: 500, used_chars: context.length, claim_refs: [{ claim_id: id, claim_version: 1 }], context_digest: contextDigest(context), ...bundle });
      return `b-${id}`;
    };
    const normal = add("normal"); const binding = kernel.bind({ bundle_id: normal }); assert.equal(kernel.revalidate(binding).bundle_id, normal); assert.throws(() => kernel.prompt({ ...binding, context: " " }, "Prompt"), /context/);
    assert.throws(() => kernel.bind({ bundle_id: normal, now: "bad" }), /ISO/); assert.throws(() => kernel.bind({ bundle_id: normal, bundle_version: 0 }), /positive/); assert.throws(() => kernel.bind({ bundle_id: " " }), /empty/);
    const duplicate = add("duplicate", {}, { claim_refs: [{ claim_id: "duplicate", claim_version: 1 }, { claim_id: "duplicate", claim_version: 1 }] }); assert.throws(() => kernel.bind({ bundle_id: duplicate }), /unique/);
    const candidate = add("candidate", { status: "candidate" }); assert.throws(() => kernel.bind({ bundle_id: candidate }), /reviewed/);
    const global = add("global", { scope: "global", valid_until: null }); assert.equal(kernel.bind({ bundle_id: global }).scope, "project:a");
    const foreign = add("foreign", { scope: "project:b", valid_until: null }); assert.throws(() => kernel.bind({ bundle_id: foreign }), /scope/);
    const malformedExpiry = add("bad-expiry", { valid_until: "bad" }); assert.throws(() => kernel.bind({ bundle_id: malformedExpiry }), /ISO/);
    const noEvidence = add("no-evidence", { evidence_ids: [] }); assert.throws(() => kernel.bind({ bundle_id: noEvidence }), /requires Evidence/);
    const tooSmall = add("too-small", {}, { max_chars: 1 }); assert.throws(() => kernel.bind({ bundle_id: tooSmall }), /character budget/);
    const badDigest = add("bad-digest", {}, { context_digest: "sha256:wrong" }); assert.throws(() => kernel.bind({ bundle_id: badDigest }), /digest/);
    assert.throws(() => kernel.revalidate({ ...binding, context: "changed" }), /binding changed/);
    store.create("wiki_context_bundle", "bad-array", { scope: "project:a", max_chars: 10, claim_refs: "bad", context_digest: "sha256:x" }); assert.throws(() => kernel.bind({ bundle_id: "bad-array" }), /array/);
    store.create("wiki_context_bundle", "bad-object", { scope: "project:a", max_chars: 10, claim_refs: [[]], context_digest: "sha256:x" }); assert.throws(() => kernel.bind({ bundle_id: "bad-object" }), /object/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
