import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { ContextWorkingSetKernel } from "../core/context-working-set.ts";
import { ContextBudgetError } from "../common/craft-common-base/src/context-assets.ts";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-working-set-budget-"));
  const store = await new CraftStore(craftPaths(root)).open(), service = new CraftService(store);
  service.knowledgeMemoryInstallBuiltins();
  service.memoryLedgerRemember({ memory_id: "m", kind: "preference", scope_kind: "project", scope_id: "p", source_id: "builtin.evidence-wiki", content: "login " + "x".repeat(394) });
  const args = { query: "login", scope_kind: "project", scope_id: "p", max_items: 3, max_chars: 500 };
  const code = { node_id: "code", version: 1, source_digest: "d", path: "code.ts", index_id: "i", checkpoint_id: "c", selection_reason: "lexical_match" };
  return { store, service, args, code, close() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("Working Set owns Host, recalled and authenticated code projection budgets", async () => {
  const f = await fixture();
  try {
    const kernel = f.service.contextWorkingSets;
    const preferred = await kernel.resolve({ ...f.args, prefer_codebase: true, codebase_candidates: [f.code], max_items: 1 });
    assert.equal((preferred.items as unknown[]).length, 0);
    assert.equal((preferred.codebase_references as unknown[]).length, 1);
    assert((preferred.asset_refs as JsonObject[]).some(ref => ref.member === "codebase"));
    assert.equal((preferred.selection_reasons as JsonObject[])[0]!.reason, "codebase_projection");
    assert.equal((preferred.working_set as JsonObject).members instanceof Array, true);
    assert(!((preferred.working_set as JsonObject).members as string[]).includes("codebase"));
    const mandatory = await kernel.resolve({ ...f.args, prefer_codebase: true, codebase_candidates: [f.code], memory_ids: ["m"] });
    assert.equal((mandatory.items as JsonObject[])[0]!.memory_id, "m");
    assert.equal((mandatory.codebase_references as unknown[]).length, 0);
    assert.equal(mandatory.codebase_budget_rebalanced, true);
    assert.equal(mandatory.total_used_chars, 400);
    const host = await kernel.resolve({ ...f.args, query: "other", history_refs: [{ id: "h", version: 1 }], max_items: 2, max_chars: 1000, codebase_candidates: [f.code], prefer_codebase: true });
    assert.equal(host.total_items, 2);
    assert((host.asset_refs as JsonObject[]).some(ref => ref.member === "history"));
    assert((host.selection_reasons as JsonObject[]).some(reason => reason.reason === "host_reference"));
    const stateOnly = await kernel.resolve({ ...f.args, members: ["state"], state_refs: [{ id: "state", version: 1 }] });
    assert.equal((stateOnly.selection_reasons as JsonObject[])[0]!.reason, "host_reference");
    const same = await kernel.resolve({ ...f.args, prefer_codebase: true, codebase_candidates: [f.code], max_items: 1 });
    assert.equal((same.working_set as JsonObject).id, (preferred.working_set as JsonObject).id);
    const general = await kernel.resolve({ ...f.args, codebase_candidates: [f.code] });
    assert.equal((general.items as unknown[]).length, 1);
    assert.equal((general.codebase_references as unknown[]).length, 0);
    const fallback = await kernel.resolve({ ...f.args, query: "unmatched", codebase_candidates: [f.code] });
    assert.equal((fallback.codebase_references as unknown[]).length, 1);
  } finally { f.close(); }
});

test("required projections fail with typed budget errors and never enter accumulative retrieval", async () => {
  const f = await fixture();
  try {
    const kernel = f.service.contextWorkingSets, required = { member: "codebase", id: "code", version: 1 };
    await assert.rejects(kernel.resolve({ ...f.args, codebase_candidates: "bad" }), /array/);
    await assert.rejects(kernel.resolve({ ...f.args, history_refs: [{ id: "h", version: 1 }], max_chars: 1000, empty_budget: true }), ContextBudgetError);
    await assert.rejects(kernel.resolve({ ...f.args, required_refs: [required] }), /unavailable/);
    await assert.rejects(kernel.resolve({ ...f.args, codebase_candidates: [f.code], required_refs: [required], max_chars: 1 }), ContextBudgetError);
    await assert.rejects(kernel.resolve({ ...f.args, codebase_candidates: [f.code], required_refs: [required], empty_budget: true }), ContextBudgetError);
    await assert.rejects(kernel.resolve({ ...f.args, codebase_candidates: [f.code], required_refs: [required], memory_ids: ["m"], max_items: 1 }), ContextBudgetError);
    await assert.rejects(kernel.resolve({ ...f.args, codebase_candidates: [f.code], required_refs: [required], memory_ids: ["m"] }), ContextBudgetError);
    await assert.rejects(kernel.resolve({ ...f.args, members: ["history"], required_refs: [{ member: "memory", id: "m" }] }), /excluded/);
    const two = { ...f.code, node_id: "other" };
    const requiredFirst = await kernel.resolve({ ...f.args, query: "unmatched", codebase_candidates: [two, f.code], required_refs: [required], max_items: 1 });
    assert.equal((requiredFirst.codebase_references as JsonObject[])[0]!.node_id, "code");
    assert.equal(requiredFirst.codebase_budget_omitted_count, 1);
    const failing = new ContextWorkingSetKernel(f.store, { resolve: async () => { throw new Error("upstream failure"); } } as never);
    await assert.rejects(failing.resolve({ ...f.args, prefer_codebase: true, codebase_candidates: [f.code] }), /upstream failure/);
  } finally { f.close(); }
});
