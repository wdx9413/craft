import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_INTERNAL_TOOLS, INTERNAL_ONLY_TOOLS } from "../src/internal-host-driver.ts";
import { DEFAULT_INTERNAL_AUTHORIZATION, authorizedTools, classifyTool } from "../src/internal-tool-authorization.ts";
import { TOOLS } from "../src/mcp.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/infrastructure/store.ts";

/**
 * B2: the wiring gap was that the loop could write memories but never read
 * them, and that the governed memory tools were reachable only by an external
 * host. These tests hold the loop's actual mounted surface to that standard:
 * a tool is only "wired" if the loop is authorized to call it AND the service
 * can dispatch it.
 */

test("v0.12.35 the internal loop can read and propose memories", () => {
  const names = DEFAULT_INTERNAL_TOOLS.map((definition) => definition.function.name);
  assert.equal(names.includes("memory_search"), true);
  assert.equal(names.includes("memory_capture_propose"), true);
  // The pre-existing surface is not disturbed.
  for (const name of ["capability_search", "knowledge_search", "task_checkpoint", "evidence_record", "artifact_register", "workspace_read", "workspace_write"]) {
    assert.equal(names.includes(name), true, `${name} disappeared from the loop surface`);
  }
});

test("v0.12.35 memory tools land in tiers the loop actually mounts", () => {
  // A tool whose tier is outside DEFAULT_INTERNAL_AUTHORIZATION is invisible to
  // the loop no matter how good it is. This is the exact failure mode the
  // assessment described, so it is asserted rather than assumed.
  const mounted = new Set(DEFAULT_INTERNAL_AUTHORIZATION);
  assert.equal(classifyTool("craft_memory_search"), "read");
  assert.equal(classifyTool("craft_memory_capture_propose"), "candidate");
  assert.equal(classifyTool("craft_memory_usage_record"), "candidate");
  assert.equal(classifyTool("craft_memory_decay_get"), "read");
  assert.equal(classifyTool("craft_memory_promotion_preview"), "read");
  for (const name of ["craft_memory_search", "craft_memory_capture_propose", "craft_memory_decay_get"]) {
    assert.equal(mounted.has(classifyTool(name)), true, `${name} is not in a mounted tier`);
  }

  // A write that could create a durable memory must never be reachable as a
  // read, and the ledger write itself stays governed.
  assert.equal(classifyTool("craft_memory_ledger_remember"), "candidate");
  assert.equal(classifyTool("craft_credential_resolve"), "forbidden");
  assert.equal(mounted.has("governed"), false);
});

test("v0.12.35 the projection exposes loop tools that are actually authorized", () => {
  const projected = authorizedTools(TOOLS, DEFAULT_INTERNAL_AUTHORIZATION).map((tool) => tool.name);
  // The projection must be a filter, not a pass-through: governed and forbidden
  // tools stay out.
  for (const name of projected) {
    assert.notEqual(classifyTool(name), "forbidden", `${name} leaked into the loop projection`);
  }
  // And the memory read path is genuinely in it.
  assert.equal(projected.includes("craft_memory_search"), true);
  // workspace_read/write stay loop-only and outside the public catalog.
  for (const definition of INTERNAL_ONLY_TOOLS) {
    assert.equal(TOOLS.some((tool) => tool.name === `craft_${definition.function.name}`), false);
  }
});

test("v0.12.35 the loop's memory tools dispatch against a real store", async (t) => {
  const root = join(tmpdir(), `craft-v01235-loop-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const service = new CraftService(store);

  // Register a source and a memory the way the governed path requires.
  service.knowledgeSourceRegister({
    source_id: "src-1", kind: "project_note", label: "Project notes", trust: "verified",
    scope_kind: "project", scope_id: "proj-1", locator: "docs/notes.md", content_digest: "sha256:" + "a".repeat(64),
  });
  // Record evidence first: a decision must be attributable, and the ledger
  // refuses a procedural or confirmed memory that carries no evidence.
  // `evidenceRecord` returns the record itself rather than a wrapper.
  const evidence = service.evidenceRecord({ claim: "port confirmed by the operator", source_type: "observation", confidence: "confirmed" });

  // Only the governed ledger is written here. Note that the *workbench* memory
  // reachable via `service.memoryRemember` uses scopes user|workspace|task and
  // demands a workspace_id, while the ledger accepts user|project|workspace|task.
  // That divergence between the two memory systems is real, and bridging it is
  // what `planLegacyPromotion` is for; the loop's read tool consults the ledger.
  service.memoryLedgerRemember({
    memory_id: "mem-ledger", source_id: "src-1", kind: "working",
    scope_kind: "project", scope_id: "proj-1", content: "the ledger port is 8080",
    evidence_ids: [String(evidence.id)],
  });

  // The read path returns the memory with its provenance intact.
  const found = await service.memorySearch({ query: "ledger port", scope_id: "proj-1", scope_kind: "project" });
  const memories = found.memories as JsonObject[];
  assert.equal(memories.length, 1);
  assert.equal(memories[0]!.memory_id, "mem-ledger");
  assert.equal(memories[0]!.reason, "keyword_overlap");
  // A receipt is still produced, so reading did not cost the audit trail.
  assert.equal(found.content_free_receipt, true);
  assert.match(String(found.receipt_id), /^standalone-ctx-|^context_resolution_/u);

  // A query that matches nothing is an empty result with a real receipt.
  const miss = await service.memorySearch({ query: "nothing matches this", scope_id: "proj-1", scope_kind: "project" });
  assert.equal((miss.memories as JsonObject[]).length, 0);
  assert.equal(miss.count, 0);

  // The propose path is deliberately gated: a `craft_agent` proposal requires an
  // active Agent Work Runtime mode, so an agent cannot propose memories unless
  // the operator has put it in agent mode with a model selected. That gate is
  // upstream of the candidate approval, not a replacement for it.
  assert.throws(
    () => service.knowledgeMemoryCandidatePropose({ source_id: "src-1", kind: "working", scope: "project", scope_id: "proj-1", content: "the build takes 40s" }),
    /requires an active Agent Work Runtime mode/u);
  service.workRuntimeModeConfigure({ profile_id: "agent-mode", mode: "agent", allowed_hosts: ["codex-cli"], default_host: "codex-cli", default_model: "gpt-5-codex" });

  // The propose path creates a proposal, never a durable memory.
  const proposed = service.knowledgeMemoryCandidatePropose({ source_id: "src-1", kind: "working", scope: "project", scope_id: "proj-1", content: "the build takes 40s" });
  assert.equal(proposed.durable, false);
  assert.equal(proposed.requires_approval, true);
  assert.equal(proposed.execution_authority, false);
  assert.match(String(proposed.proposal_id), /^turn_proposal_/u);

  // Secrets are refused at the loop boundary. The service's own guard reports
  // "sensitive assignments", so the assertion matches the real message rather
  // than the ledger's phrasing.
  assert.throws(
    () => service.knowledgeMemoryCandidatePropose({ source_id: "src-1", kind: "working", scope: "project", content: "api_key: sk-live-123" }),
    /must not contain sensitive assignments/u);
});