import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const capabilities = { filesystem: "workspace_overlay", network: "denied", network_allowlist: [],
  features: ["cancel", "process_isolation", "snapshot"], limits: { memory_mb: 256, timeout_ms: 30_000, cpu_ms: 10_000 } };
async function fixture(name: string): Promise<{ root: string; store: CraftStore; service: CraftService }> {
  const root = join(tmpdir(), `craft-${name}-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, service: new CraftService(store) };
}

test("verified Sandbox Profiles issue exact tickets and close with evidence-backed receipts", async () => {
  const { root, store, service } = await fixture("sandbox");
  try {
    const task = service.taskOpen({ title: "Sandbox", goal: "Execute with proved boundaries" }).task as JsonObject;
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Sandbox boundary probe passed" });
    const declared = service.sandboxProfileSave({ profile_id: "docker", name: "Docker adapter", backend: "container",
      adapter_id: "docker-host", capabilities });
    assert.equal(declared.lifecycle, "declared"); assert.equal(declared.version, 1);
    const mismatch = service.sandboxProfileVerify({ profile_id: "docker", profile_version: 1, verifier: "probe-v1",
      observed_capabilities: { ...capabilities, network: "unrestricted" }, evidence_ids: [evidence.id] });
    assert.equal(mismatch.verified, false); assert.equal((mismatch.assessment as JsonObject).status, "failed");
    const verified = service.sandboxProfileVerify({ profile_id: "docker", profile_version: 1, verifier: "probe-v1",
      observed_capabilities: { ...capabilities, features: ["snapshot", "process_isolation", "cancel"] }, evidence_ids: [evidence.id] });
    const profile = verified.profile as JsonObject;
    assert.equal(verified.verified, true); assert.equal(profile.lifecycle, "verified"); assert.equal(profile.version, 2);
    const requirements = { filesystem: "workspace_overlay", network: "denied", features: ["process_isolation", "cancel"],
      limits: { memory_mb: 128, timeout_ms: 20_000 } };
    const plan = service.sandboxPlan({ task_id: task.id, profile_id: "docker", profile_version: 2,
      requirements, request_digest: "sha256:request", ticket_id: "ticket_pass" });
    assert.equal(plan.compatible, true); assert.deepEqual(plan.missing, []);
    const receipt = service.sandboxReceipt({ ticket_id: "ticket_pass", receipt_id: "receipt_pass", adapter_id: "docker-host",
      profile_version: 2, status: "passed", observed_capabilities: capabilities, evidence_ids: [evidence.id] });
    assert.equal((receipt.receipt as JsonObject).boundary_matches, true); assert.equal(receipt.idempotent, false);
    assert.equal(service.sandboxReceipt({ ticket_id: "ticket_pass", receipt_id: "receipt_pass", adapter_id: "docker-host",
      profile_version: 2, status: "passed", observed_capabilities: capabilities, evidence_ids: [evidence.id] }).idempotent, true);
    assert.throws(() => service.sandboxReceipt({ ticket_id: "ticket_pass", receipt_id: "receipt_pass", adapter_id: "docker-host",
      profile_version: 2, status: "failed", observed_capabilities: capabilities, evidence_ids: [evidence.id] }), /idempotency/);
    const incompatible = service.sandboxPlan({ task_id: task.id, profile_id: "docker", profile_version: 2,
      requirements: { filesystem: "read_only", network: "allowlist", features: ["credential_broker"],
        limits: { memory_mb: 512, gpu_count: 1 } }, request_digest: "sha256:no" });
    assert.equal(incompatible.compatible, false); assert.equal(incompatible.ticket, null);
    assert.deepEqual(incompatible.missing, ["filesystem:read_only", "network:allowlist", "feature:credential_broker", "limit:memory_mb", "limit:gpu_count"]);
    service.sandboxPlan({ task_id: task.id, profile_id: "docker", profile_version: 2, requirements,
      request_digest: "sha256:failed", ticket_id: "ticket_failed" });
    const failed = service.sandboxReceipt({ ticket_id: "ticket_failed", receipt_id: "receipt_failed", adapter_id: "docker-host",
      profile_version: 2, status: "failed", observed_capabilities: { ...capabilities, network: "unrestricted" }, evidence_ids: [evidence.id] });
    assert.equal((failed.receipt as JsonObject).boundary_matches, false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Sandbox contracts reject unverifiable capabilities, requirements, identities, and receipts", async () => {
  const { root, store, service } = await fixture("sandbox-errors");
  try {
    const task = service.taskOpen({ title: "Policy", goal: "Fail closed" }).task as JsonObject;
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Probe" });
    const save = (extra: JsonObject) => service.sandboxProfileSave({ profile_id: "profile", name: "Profile", backend: "local_process",
      adapter_id: "host", capabilities, ...extra });
    assert.match(String(service.sandboxProfileSave({ name: "Generated", backend: "remote", adapter_id: "remote", capabilities }).id), /^sandbox_/);
    assert.throws(() => save({ name: " " }), /name/);
    assert.throws(() => save({ backend: "magic" }), /backend/);
    assert.throws(() => save({ capabilities: [] }), /must be an object/);
    assert.throws(() => save({ capabilities: { ...capabilities, filesystem: "full" } }), /mode/);
    assert.throws(() => save({ capabilities: { ...capabilities, network: "magic" } }), /mode/);
    assert.throws(() => save({ capabilities: { ...capabilities, features: "bad" } }), /must be an array/);
    assert.throws(() => save({ capabilities: { ...capabilities, features: ["cancel", "cancel"] } }), /unique/);
    assert.throws(() => save({ capabilities: { ...capabilities, features: ["root"] } }), /feature/);
    assert.throws(() => save({ capabilities: { ...capabilities, network: "allowlist", network_allowlist: [] } }), /Network allowlist/);
    assert.throws(() => save({ capabilities: { ...capabilities, network: "denied", network_allowlist: ["x"] } }), /Network allowlist/);
    for (const limits of [{ memory_mb: 0 }, { Memory: 1 }, { memory_mb: Number.POSITIVE_INFINITY }, []]) {
      assert.throws(() => save({ capabilities: { ...capabilities, limits } }), /limits/);
    }
    save({});
    service.sandboxProfileSave({ profile_id: "minimal", name: "Minimal", backend: "local_process", adapter_id: "minimal-host",
      capabilities: { filesystem: "none", network: "denied" } });
    service.sandboxProfileVerify({ profile_id: "minimal", profile_version: 1, verifier: "probe",
      observed_capabilities: { filesystem: "none", network: "denied" }, evidence_ids: [evidence.id] });
    const generatedTicket = service.sandboxPlan({ task_id: task.id, profile_id: "minimal",
      requirements: { filesystem: "none", network: "denied" }, request_digest: "minimal" }).ticket as JsonObject;
    assert.match(String(generatedTicket.id), /^sandbox_ticket_/);
    const verify = (extra: JsonObject) => service.sandboxProfileVerify({ profile_id: "profile", profile_version: 1,
      verifier: "probe", observed_capabilities: capabilities, evidence_ids: [evidence.id], ...extra });
    assert.throws(() => verify({ profile_version: 0 }), /positive integer/); assert.throws(() => verify({ profile_version: 1.5 }), /positive integer/);
    assert.throws(() => verify({ evidence_ids: [] }), /requires evidence/); assert.throws(() => verify({ evidence_ids: ["missing"] }), /Unknown evidence/);
    verify({});
    assert.throws(() => service.sandboxProfileVerify({ profile_id: "profile", profile_version: 2,
      verifier: "probe", observed_capabilities: capabilities, evidence_ids: [evidence.id] }), /Only a declared/);
    const requirements = { filesystem: "workspace_overlay", network: "denied", features: [], limits: {} };
    assert.throws(() => service.sandboxPlan({ task_id: "missing", profile_id: "profile", profile_version: 2, requirements, request_digest: "x" }), /Unknown task/);
    assert.throws(() => service.sandboxPlan({ task_id: task.id, profile_id: "profile", profile_version: 0, requirements, request_digest: "x" }), /positive integer/);
    assert.throws(() => service.sandboxPlan({ task_id: task.id, profile_id: "profile", profile_version: 1, requirements, request_digest: "x" }), /verified/);
    assert.throws(() => service.sandboxPlan({ task_id: task.id, profile_id: "profile", profile_version: 2,
      requirements: { ...requirements, filesystem: "full" }, request_digest: "x" }), /requirement mode/);
    assert.throws(() => service.sandboxPlan({ task_id: task.id, profile_id: "profile", profile_version: 2,
      requirements: { ...requirements, features: ["root"] }, request_digest: "x" }), /requirement feature/);
    service.sandboxPlan({ task_id: task.id, profile_id: "profile", requirements, request_digest: "x", ticket_id: "ticket" });
    const receipt = (extra: JsonObject) => service.sandboxReceipt({ ticket_id: "ticket", receipt_id: "receipt", adapter_id: "host",
      profile_version: 2, status: "passed", observed_capabilities: capabilities, evidence_ids: [evidence.id], ...extra });
    assert.throws(() => receipt({ adapter_id: "other" }), /does not match/); assert.throws(() => receipt({ profile_version: 1 }), /does not match/);
    assert.throws(() => receipt({ status: "unknown" }), /unsupported/);
    assert.throws(() => receipt({ observed_capabilities: { ...capabilities, network: "unrestricted" } }), /exact profile/);
    assert.throws(() => receipt({ evidence_ids: [] }), /requires evidence/); assert.throws(() => receipt({ evidence_ids: ["missing"] }), /Unknown evidence/);
    receipt({});
    assert.throws(() => service.sandboxReceipt({ ticket_id: "ticket", receipt_id: "second", adapter_id: "host", profile_version: 2,
      status: "passed", observed_capabilities: capabilities, evidence_ids: [evidence.id] }), /not active/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Sandbox Profile lifecycle is available through the full MCP surface", async () => {
  const { root, store, service } = await fixture("sandbox-mcp");
  try {
    const task = service.taskOpen({ title: "MCP Sandbox", goal: "Use portable contract" }).task as JsonObject;
    const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "MCP probe" });
    const server = new McpServer(service, "full");
    const call = async (name: string, arguments_: JsonObject): Promise<JsonObject> => {
      const response = await server.handle({ id: name, method: "tools/call", params: { name, arguments: arguments_ } });
      assert.equal((response?.result as JsonObject).isError, false, name); return (response?.result as JsonObject).structuredContent as JsonObject;
    };
    await call("craft_sandbox_profile_save", { profile_id: "mcp_profile", name: "MCP", backend: "container", adapter_id: "mcp-host", capabilities });
    await call("craft_sandbox_profile_verify", { profile_id: "mcp_profile", profile_version: 1,
      observed_capabilities: capabilities, evidence_ids: [evidence.id], verifier: "mcp-probe" });
    await call("craft_sandbox_plan", { task_id: task.id, profile_id: "mcp_profile", profile_version: 2,
      requirements: { filesystem: "workspace_overlay", network: "denied", features: [], limits: {} },
      request_digest: "sha256:mcp", ticket_id: "mcp_ticket" });
    await call("craft_sandbox_receipt", { ticket_id: "mcp_ticket", receipt_id: "mcp_receipt", adapter_id: "mcp-host",
      profile_version: 2, status: "passed", observed_capabilities: capabilities, evidence_ids: [evidence.id] });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
