import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { PluginDiscovery } from "../core/plugin-discovery.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-plugin-disc-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, discovery: new PluginDiscovery(store) };
}

test("plugin discovery proposes a remedy from a registered capability, never invents one", async () => {
  const { store, discovery } = await fixture();
  try {
    assert.throws(() => discovery.propose({ failure_class: "unattributed" }), /unattributed/);
    assert.throws(() => discovery.propose({ failure_class: "scope_gap" }), /no plugin remedy/);
    const proposal = discovery.propose({ failure_class: "coverage_gap", evidence_id: "ev-1",
      capabilities: [{ id: "web-search", name: "Web Search", kind: "search" }, { id: "db", name: "Database" }] });
    assert.equal(proposal.status, "proposed");
    assert.equal(proposal.capability, "search");
    assert.equal(proposal.candidate_count, 1);
    assert.equal(proposal.auto_installed, false);
    assert.equal(proposal.writes_host_config, false);
    assert.throws(() => discovery.approve({ id: proposal.id }), /non-empty string/);
    const approved = discovery.approve({ id: proposal.id, approved_by: "user:alex" });
    assert.equal(approved.status, "approved");
    assert.equal(approved.approved_by, "user:alex");
    // Idempotent, and still no host write.
    const repeat = discovery.approve({ id: proposal.id, approved_by: "user:alex" }) as Record<string, unknown>;
    assert.equal(repeat.idempotent, true);
    assert.equal(repeat.writes_host_config, false);
    const listed = discovery.list({ status: "approved" }) as { items: unknown[] };
    assert.equal(listed.items.length, 1);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});

test("plugin discovery tolerates a missing catalog, maps sparse candidates and refuses non-proposed rows", async () => {
  const { store, discovery } = await fixture();
  try {
    // A non-array catalog is empty, not an exception; a null evidence id stays null.
    const empty = discovery.propose({ failure_class: "coverage_gap", evidence_id: null, capabilities: "not-a-list" });
    assert.equal(empty.candidate_count, 0);
    assert.equal(empty.evidence_id, null);
    // Matches may come from id, kind or name; sparse rows fall back to whichever field exists.
    const proposal = discovery.propose({ failure_class: "coverage_gap", capabilities: [
      { id: "db", name: "Database" },
      { id: "x1", name: "Web Search" },
      { id: "search-x" },
      { name: "OnlyName", kind: "search" },
      { id: "only-id-search" },
      { id: "db2" },
      { name: "Search Only" },
    ] });
    assert.equal(proposal.candidate_count, 5);
    assert.deepEqual(proposal.candidates, [
      { id: "x1", name: "Web Search" },
      { id: "search-x", name: "search-x" },
      { id: "OnlyName", name: "OnlyName" },
      { id: "only-id-search", name: "only-id-search" },
      { id: "Search Only", name: "Search Only" },
    ]);
    assert.equal((discovery.list({ status: "proposed" }) as { items: unknown[] }).items.length, 2);
    assert.equal((discovery.list() as { items: unknown[] }).items.length, 2);
    assert.throws(() => discovery.approve({ id: "missing", approved_by: "u" }), /Unknown plugin discovery/u);
    // A row that is no longer proposed can never be approved again.
    store.save("plugin_discovery_proposal", "rejected-1", { id: "rejected-1", status: "rejected" });
    assert.throws(() => discovery.approve({ id: "rejected-1", approved_by: "u" }), /only a proposed/u);
  } finally { await store.close(); await rm(store.paths.root, { recursive: true, force: true }); }
});
