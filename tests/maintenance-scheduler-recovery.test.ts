import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { MaintenanceScheduler } from "../core/maintenance-scheduler.ts";

test("maintenance scheduler supports default expiry and requires all review prerequisites", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-maintenance-default-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = await CraftService.open(store);
    const scheduler = new MaintenanceScheduler(store, service.memoryMaintenance);
    const generated = scheduler.tick();
    assert.equal(generated.status, "completed");
    assert.equal((generated.receipt as { expired_memory: number }).expired_memory, 0);
    const noCount = new MaintenanceScheduler(store, service.memoryMaintenance, () => ({})).tick({ lease_id: "missing-count" });
    assert.equal((noCount.receipt as { expired_memory: number | null }).expired_memory, null);
    const invalidCount = new MaintenanceScheduler(store, service.memoryMaintenance, () => ({ count: -1 })).tick({ lease_id: "invalid-count" });
    assert.equal((invalidCount.receipt as { expired_memory: number | null }).expired_memory, null);
    for (const missing of ["idle", "budget_available", "model_available"] as const) {
      const prerequisites = { idle: true, budget_available: true, model_available: true, [missing]: false };
      assert.equal(scheduler.tick({ stage: "review", ...prerequisites }).status, "skipped");
    }
    assert.equal(scheduler.tick({ stage: "review", idle: true, budget_available: true, model_available: true }).status, "completed");
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("maintenance validates stage, requires idle budget and protects lease identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-maintenance-schedule-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = await CraftService.open(store);
    assert.throws(() => service.memoryMaintenanceSchedule({ stage: "bad" }), /unsupported/u);
    assert.equal(service.memoryMaintenanceSchedule({ stage: "review" }).status, "skipped");
    const first = service.memoryMaintenanceSchedule({ stage: "light", lease_id: "lease" });
    assert.equal(first.status, "completed");
    assert.equal(service.memoryMaintenanceSchedule({ stage: "light", lease_id: "lease" }).idempotent, true);
    assert.throws(() => service.memoryMaintenanceSchedule({ stage: "light", lease_id: "lease", cursor: 1 }), /idempotency conflict/u);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("maintenance reconstructs its receipt after a completed run and preserves unknown expiry", async () => {
  const root = mkdtempSync(join(tmpdir(), "craft-maintenance-receipt-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const service = await CraftService.open(store);
    service.memoryMaintenanceRun({ stage: "light", maintenance_id: "scheduled_recovered" });
    const recovered = service.memoryMaintenanceSchedule({ stage: "light", lease_id: "recovered" });
    assert.equal(recovered.recovered, true);
    assert.equal((recovered.receipt as { expired_memory: unknown }).expired_memory, null);
    assert.equal(service.memoryMaintenanceSchedule({ stage: "light", lease_id: "recovered" }).idempotent, true);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const invalid of ["stage", "scope", "status", "request_scope", "request_cursor", "request_stage"] as const) {
  test(`maintenance recovery rejects conflicting ${invalid}`, async () => {
    const root = mkdtempSync(join(tmpdir(), "craft-maintenance-identity-"));
    const store = await new CraftStore(craftPaths(root)).open();
    try {
      const service = await CraftService.open(store);
      const run = { stage: invalid === "stage" ? "deep" : "light", status: invalid === "status" ? "candidate" : "completed",
        scope: invalid === "scope" ? { kind: "global", id: "other" } : { kind: "global", id: "global" } };
      store.create("memory_maintenance_run", "scheduled_lease", run);
      const args = { lease_id: "lease", stage: invalid === "request_stage" ? "review" : "light", idle: true, budget_available: true, model_available: true,
        ...(invalid === "request_scope" ? { scope: { kind: "project", id: "project:other" } } : {}),
        ...(invalid === "request_cursor" ? { cursor: 1 } : {}) };
      assert.throws(() => service.memoryMaintenanceSchedule(args), /Maintenance schedule recovery identity conflict/u);
      assert.equal(store.find("maintenance_schedule_receipt", "lease"), null);
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  });
}
