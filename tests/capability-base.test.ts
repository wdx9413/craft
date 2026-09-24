import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityBaseKernel } from "../core/capability-base.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-base-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, base: new CapabilityBaseKernel(store) };
}

const at = "2030-01-01T00:00:00Z";
const register = (base: CapabilityBaseKernel, over: Record<string, unknown> = {}) => base.register({
  action_id: "restart_node", input: { node_id: "string" }, required_permission: ["ops.write"],
  receipt_format: { fields: ["pre_state", "post_state", "checker"], recomputable: true },
  risk_level: "R2", scope_invariants: ["cluster_id", "node_id"], access_kind: "api_mcp",
  registered_at: at, ...over });

test("one shape covers every capability, and all five fields are required", async () => {
  const f = await fixture();
  try {
    const action = (register(f.base).action) as Record<string, unknown>;
    // 13.1's shape, complete.
    assert.deepEqual(action.input, { node_id: "string" });
    assert.deepEqual(action.required_permission, ["ops.write"]);
    assert.deepEqual(action.receipt_format, { fields: ["checker", "post_state", "pre_state"], recomputable: true });
    assert.equal(action.risk_level, "R2");
    assert.deepEqual(action.scope_invariants, ["cluster_id", "node_id"]);
    assert.equal(action.access_kind, "api_mcp");
    assert.equal(action.replacement_required, false);

    // A different shape under a new id is fine; the same id with a different shape is a
    // conflict, because two shapes for one name is how a base becomes a set of special cases.
    assert.throws(() => register(f.base, { action_id: "restart_node", risk_level: "R3" }),
      /already registered with a different shape/);
    // 6.3: an action with no stated invariant cannot have its authorization re-checked later,
    // so it cannot be registered at all.
    assert.throws(() => register(f.base, { action_id: "a1", scope_invariants: [] }), /scope_invariants must be a non-empty array/);
    // 10.1: a receipt format with no fields is a screenshot.
    assert.throws(() => register(f.base, { action_id: "a3", receipt_format: { fields: [], recomputable: true } }),
      /receipt_format.fields must be a non-empty array; a receipt with no fields is a screenshot/);
    assert.throws(() => register(f.base, { action_id: "a4", receipt_format: { fields: ["x"] } }),
      /receipt_format.recomputable must be a boolean/);
    assert.throws(() => register(f.base, { action_id: "a5", receipt_format: { fields: ["x", "x"], recomputable: true } }),
      /must contain unique values/);
    assert.throws(() => register(f.base, { action_id: "a6", required_permission: [] }), /required_permission must be a non-empty array/);
    // Invariant and receipt field names are identifiers, not free text.
    assert.throws(() => register(f.base, { action_id: "a11", scope_invariants: ["Bad Name"] }), /is not a valid field name/);
    assert.throws(() => register(f.base, { action_id: "a12", scope_invariants: ["same", "same"] }),
      /scope_invariants must contain unique values/);
    assert.throws(() => register(f.base, { action_id: "a13", receipt_format: { fields: ["Bad Name"], recomputable: true } }),
      /is not a valid field name/);
    assert.throws(() => register(f.base, { action_id: "a14", required_permission: ["bad perm!"] }), /unsupported characters/);
    assert.throws(() => register(f.base, { action_id: "a7", risk_level: "R9" }), /risk_level must be R0, R1, R2 or R3/);
    assert.throws(() => register(f.base, { action_id: "a8", access_kind: "telepathy" }), /access_kind must be api_mcp/);
    assert.throws(() => register(f.base, { action_id: "bad id!" }), /unsupported characters/);
    assert.throws(() => register(f.base, { action_id: "a9", registered_at: "nope" }), /must be an ISO timestamp/);
    assert.throws(() => register(f.base, { action_id: "a10", input: "x" }), /input must be an object/);
  } finally { f.store.close(); }
});

test("the fixed access priority decides when a GUI fallback must be replaced", async () => {
  const f = await fixture();
  try {
    register(f.base, { action_id: "scripted", access_kind: "gui_automation" });
    // 13A.7 rule 1: it starts life carrying the obligation.
    assert.equal((f.base.get({ action_id: "scripted" }).action as Record<string, unknown>).replacement_required, true);

    // 13A.7 rule 2: an upstream API appearing means the GUI adapter must go.
    const upgrade = f.base.checkAccess({ action_id: "scripted", available_access_kind: "api_mcp" });
    assert.equal(upgrade.upgrade_available, true);
    assert.equal(upgrade.replacement_required, true);
    assert.equal(upgrade.reason, "upstream_api_available_gui_adapter_must_be_replaced");

    // A CLI is stronger than a script but weaker than an API: still an upgrade, but not the
    // obligation the rule names. Reporting it as mandatory would demand work the plan does
    // not ask for.
    const cli = f.base.checkAccess({ action_id: "scripted", available_access_kind: "system_cli_db" });
    assert.equal(cli.upgrade_available, true);
    assert.equal(cli.replacement_required, false);
    assert.equal(cli.reason, "stronger_access_available");
    // A CLI-native action moving to an API is an upgrade, but again not the GUI obligation.
    register(f.base, { action_id: "cli_native", access_kind: "system_cli_db" });
    const cliToApi = f.base.checkAccess({ action_id: "cli_native", available_access_kind: "api_mcp" });
    assert.equal(cliToApi.upgrade_available, true);
    assert.equal(cliToApi.replacement_required, false);

    // Nothing stronger available: no obligation.
    const same = f.base.checkAccess({ action_id: "scripted", available_access_kind: "gui_automation" });
    assert.equal(same.upgrade_available, false);
    assert.equal(same.reason, "no_stronger_access_available");

    // An API-native action has nothing to repay.
    register(f.base, { action_id: "native", access_kind: "api_mcp" });
    assert.equal(f.base.checkAccess({ action_id: "native", available_access_kind: "api_mcp" }).upgrade_available, false);
    assert.equal(f.base.checkAccess({ action_id: "native", available_access_kind: "system_cli_db" }).upgrade_available, false);
    assert.throws(() => f.base.checkAccess({ action_id: "native", available_access_kind: "telepathy" }), /must be api_mcp/);
  } finally { f.store.close(); }
});

test("replacement is recorded and only ever moves up the priority", async () => {
  const f = await fixture();
  try {
    register(f.base, { action_id: "scripted", access_kind: "gui_automation" });
    // 13A.7 rule 3: the migration is recorded, because this is the debt that keeps working
    // and therefore keeps being forgotten.
    const replaced = f.base.replaceAdapter({ action_id: "scripted", access_kind: "api_mcp",
      replaced_at: "2030-02-01T00:00:00Z", replaced_by: "u1", reason: "upstream shipped a REST API" });
    const action = replaced.action as Record<string, unknown>;
    assert.equal(action.access_kind, "api_mcp");
    assert.equal(action.previous_access_kind, "gui_automation");
    assert.equal(action.replacement_required, false);
    assert.equal(action.replaced_at, "2030-02-01T00:00:00Z");
    const record = replaced.replacement as Record<string, unknown>;
    assert.equal(record.from_access_kind, "gui_automation");
    assert.equal(record.to_access_kind, "api_mcp");
    assert.equal(record.replaced_by, "u1");

    // A sideways or backwards move would make the debt count wrong without anyone noticing.
    register(f.base, { action_id: "scripted2", access_kind: "gui_automation" });
    assert.throws(() => f.base.replaceAdapter({ action_id: "scripted2", access_kind: "gui_automation",
      replaced_at: at, replaced_by: "u1", reason: "same" }), /must move to a higher-priority access kind/);
    // An API-native action cannot be "replaced" downward onto a script.
    register(f.base, { action_id: "native2", access_kind: "api_mcp" });
    assert.throws(() => f.base.replaceAdapter({ action_id: "native2", access_kind: "gui_automation",
      replaced_at: at, replaced_by: "u1", reason: "down" }), /must move to a higher-priority/);
    assert.throws(() => f.base.replaceAdapter({ action_id: "scripted2", access_kind: "telepathy",
      replaced_at: at, replaced_by: "u1", reason: "x" }), /must be api_mcp/);
    assert.throws(() => f.base.replaceAdapter({ action_id: "scripted2", access_kind: "api_mcp",
      replaced_at: "nope", replaced_by: "u1", reason: "x" }), /must be an ISO timestamp/);
  } finally { f.store.close(); }
});

test("the debt is a queryable number, not a feeling", async () => {
  const f = await fixture();
  try {
    // 13.3: three scripts are a fallback, thirty are a self-built brittle layer.
    for (let index = 0; index < 3; index += 1) register(f.base, { action_id: `gui_${index}`, access_kind: "gui_automation" });
    register(f.base, { action_id: "cli_0", access_kind: "system_cli_db" });
    register(f.base, { action_id: "api_0", access_kind: "api_mcp" });
    const small = f.base.debt({});
    assert.equal(small.total_actions, 5);
    assert.deepEqual(small.by_access_kind, { api_mcp: 1, system_cli_db: 1, gui_automation: 3 });
    assert.equal(small.gui_fallback_count, 3);
    assert.equal(small.gui_awaiting_replacement, 3);
    assert.equal(small.scale, "fallback");
    assert.deepEqual(small.replaced_actions, []);

    // Paying one off moves it out of the count and into the replacement log.
    f.base.replaceAdapter({ action_id: "gui_0", access_kind: "api_mcp", replaced_at: "2030-03-01T00:00:00Z",
      replaced_by: "u1", reason: "api shipped" });
    f.base.replaceAdapter({ action_id: "gui_1", access_kind: "api_mcp", replaced_at: "2030-02-01T00:00:00Z",
      replaced_by: "u2", reason: "api shipped earlier" });
    const paid = f.base.debt({});
    assert.equal(paid.gui_fallback_count, 1);
    assert.equal(paid.gui_awaiting_replacement, 1);
    assert.equal(paid.replaced_count, 2);
    // Oldest first, so the log reads as a migration history rather than a recent-changes list.
    assert.deepEqual(paid.replaced_actions, [
      { action_id: "gui_1", from: "gui_automation", to: "api_mcp", at: "2030-02-01T00:00:00Z" },
      { action_id: "gui_0", from: "gui_automation", to: "api_mcp", at: "2030-03-01T00:00:00Z" }]);
    assert.equal((paid.by_access_kind as Record<string, number>).api_mcp, 3);

    // Growing past the threshold is reported rather than judged. Two of the original three
    // were paid off above, and 27 more are added here.
    for (let index = 3; index < 30; index += 1) register(f.base, { action_id: `gui_${index}`, access_kind: "gui_automation" });
    const many = f.base.debt({});
    assert.equal(many.gui_fallback_count, 28);
    assert.equal(many.scale, "growing");
    register(f.base, { action_id: "gui_30", access_kind: "gui_automation" });
    assert.equal(f.base.debt({}).gui_fallback_count, 29);
    assert.equal(f.base.debt({}).scale, "growing");
    register(f.base, { action_id: "gui_31", access_kind: "gui_automation" });
    assert.equal(f.base.debt({}).scale, "brittle_layer");
  } finally { f.store.close(); }
});

test("the projection feeds the gate and the receipt engine the fields they check", async () => {
  const f = await fixture();
  try {
    register(f.base);
    const projected = f.base.project({ action_id: "restart_node" });
    // 6.1 reads risk_level; 11.1 reads receipt_format; 6.3 reads scope_invariants. Keeping
    // them in one place is what makes the base a base.
    assert.equal(projected.risk_level, "R2");
    assert.deepEqual(projected.receipt_format, { fields: ["checker", "post_state", "pre_state"], recomputable: true });
    assert.deepEqual(projected.scope_invariants, ["cluster_id", "node_id"]);
    assert.deepEqual(projected.required_permission, ["ops.write"]);
    assert.equal(projected.access_kind, "api_mcp");

    assert.throws(() => f.base.project({ action_id: "missing" }), /Unknown capability_action/);
    assert.throws(() => f.base.get({ action_id: "missing" }), /Unknown capability_action/);
    assert.throws(() => f.base.replaceAdapter({ action_id: "missing", access_kind: "api_mcp",
      replaced_at: at, replaced_by: "u", reason: "r" }), /Unknown capability_action/);
    assert.throws(() => f.base.checkAccess({ action_id: "missing", available_access_kind: "api_mcp" }), /Unknown capability_action/);

    // Re-registering the identical shape is idempotent; a different shape is a conflict,
    // because two shapes for one name is how a base becomes a set of special cases.
    assert.equal(register(f.base).idempotent, true);
    assert.throws(() => register(f.base, { risk_level: "R3" }), /already registered with a different shape/);

    assert.equal((f.base.list({}).actions as unknown[]).length, 1);
    assert.equal((f.base.list({ access_kind: "api_mcp" }).actions as unknown[]).length, 1);
    assert.deepEqual(f.base.list({ access_kind: "gui_automation" }).actions, []);
    assert.throws(() => f.base.list({ access_kind: "telepathy" }), /access_kind is unsupported/);
  } finally { f.store.close(); }
});
