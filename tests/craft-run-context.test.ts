import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { resolveStandaloneContext } from "../core/cli.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

/**
 * `craft run` used to hand the Host a hardcoded, empty context and call it a
 * day. These tests pin the replacement: a real knowledge/memory resolution
 * whose manifest records *why* each piece was selected, and — when nothing
 * matches or a capability is missing — says so explicitly instead of quietly
 * looking healthy.
 */

async function fixture(): Promise<{ store: CraftStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), `craft-run-context-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, root };
}

test("a standalone run resolves real knowledge refs instead of an empty placeholder", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "README.md"), "# Overview\n\nInvoices are generated per workspace on a billing cadence.\n");
    await mkdir(join(f.root, "docs"), { recursive: true });
    await writeFile(join(f.root, "docs", "billing.md"), "# Billing rules\n\nInvoices must carry an acceptance digest before billing closes.\n");
    const service = new CraftService(f.store);
    const resolved = await resolveStandaloneContext(service, { goal: "billing invoices acceptance", projectRoot: f.root, contextScope: "project", scopeId: "local" });
    const knowledge = resolved.knowledge_refs as string[];
    assert.ok(knowledge.length > 0, "knowledge refs must not be empty when the knowledge base has matches");
    assert.ok(knowledge.every((ref) => ref.startsWith("knowledge://")));
    assert.ok(knowledge.every((ref) => ref.includes("@sha256:")), "every knowledge ref must be digest-bound");
    const rationale = resolved.selection_rationale as string[];
    assert.ok(rationale.some((entry) => entry.startsWith("knowledge_index_sync:")), "the sync outcome must be recorded");
    assert.ok(rationale.some((entry) => entry.startsWith("knowledge:bm25_top")), "the retrieval mode that produced the refs must be recorded");
    assert.ok(!rationale.includes("standalone runtime context"), "the old placeholder rationale must be gone");
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("an empty knowledge base records no_match rather than faking context", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    const resolved = await resolveStandaloneContext(service, { goal: "a goal with no indexed material", projectRoot: f.root, contextScope: "project", scopeId: "local" });
    assert.deepEqual(resolved.knowledge_refs, []);
    const rationale = resolved.selection_rationale as string[];
    assert.ok(rationale.includes("knowledge:no_match"), "an empty knowledge base must be visible in the rationale");
    assert.ok(rationale.includes("memory:project_no_match"), "an empty memory scope must be visible in the rationale");
    assert.ok(rationale.includes("degraded:no_embedding_provider"), "a missing embedding provider must be declared, not hidden");
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});

test("seed memories in scope are carried into the resolution as digest refs", async () => {
  const f = await fixture();
  try {
    const service = new CraftService(f.store);
    service.knowledgeSourceRegister({ source_id: "src", kind: "project_note", label: "Project notes", scope_kind: "project", scope_id: "local", locator: ".notes", content_digest: "digest:notes:v1", trust: "bounded", access: "read_only" });
    service.memoryLedgerRemember({ memory_id: "mem", source_id: "src", kind: "preference", scope_kind: "project", scope_id: "local", content: "Invoices prefer weekly billing cadence.", confidence: "bounded" });
    const resolved = await resolveStandaloneContext(service, { goal: "billing cadence", projectRoot: f.root, contextScope: "project", scopeId: "local" });
    const memory = resolved.memory_refs as string[];
    assert.ok(memory.some((ref) => ref.startsWith("memory://mem@")), "in-scope memories must be carried as memory refs");
    const rationale = resolved.selection_rationale as string[];
    assert.ok(rationale.some((entry) => entry.startsWith("memory:project_top")), "a non-empty memory scope must be recorded");
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
