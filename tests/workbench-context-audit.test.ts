import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdir, mkdtemp, open as openReader, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { WorkbenchEvaluations } from "../core/workbench-evaluations.ts";
import { WorkbenchContextAudits } from "../core/workbench-context-audit.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "workbench-context-audit-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  const evaluations = new WorkbenchEvaluations(store);
  const packPath = join(root, "context-pack.json"), expectationsPath = join(root, "expectations.json");
  const pack = {
    asset_refs: [{ member: "knowledge", id: "claim-a", version: 2 }],
    items: [],
    contributions: [{ member: "knowledge", items: [{ content: "sensitive claim body must not be persisted" }] }],
    pack_receipt: { partial: false, max_items: 3, max_chars: 1200, total_items: 1, total_used_chars: 40 },
    injection_measurement: { estimated_tokens: 20, host_measured_tokens: null },
  };
  const expectations = { schema: "craft-eval.context-audit.v1", case_id: "workbench-context", required_refs: [{ member: "knowledge", id: "claim-a", version: 2 }], max_items: 3 };
  await writeFile(packPath, JSON.stringify(pack));
  await writeFile(expectationsPath, JSON.stringify(expectations));
  return { root, store, evaluations, packPath, expectationsPath, pack, expectations };
}

test("Workbench Context audit persists only digests and a verifiable content-free report", async () => {
  const f = await fixture();
  try {
    const result = await f.evaluations.auditContextReceipt({ operation_id: "audit-one", pack_path: f.packPath, expectations_path: f.expectationsPath });
    assert.equal(result.audit.state, "completed");
    assert.equal(result.audit.evaluator_version, "0.2.0");
    assert.equal(result.report.status, "passed");
    assert.equal(result.integrity, "verified_against_saved_report");
    assert.equal(JSON.stringify(result).includes("sensitive claim body"), false);
    const stored = f.store.find("workbench_context_audit", String(result.audit.id));
    assert.ok(stored);
    assert.equal(JSON.stringify(stored).includes("sensitive claim body"), false);
    assert.match(String(stored.input_digest), /^[a-f0-9]{64}$/u);
    assert.match(String(stored.report_digest), /^sha256:[a-f0-9]{64}$/u);
    const reopened = await f.evaluations.contextAuditReport(String(result.audit.id));
    assert.deepEqual(reopened.report, result.report);
  } finally { await f.evaluations.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workbench Context audit is idempotent for one operation and rejects changed input", async () => {
  const f = await fixture();
  try {
    const args = { operation_id: "audit-repeat", pack_path: f.packPath, expectations_path: f.expectationsPath };
    const [first, repeated] = await Promise.all([f.evaluations.auditContextReceipt(args), f.evaluations.auditContextReceipt(args)]);
    assert.equal(repeated.audit.id, first.audit.id);
    await writeFile(f.expectationsPath, JSON.stringify({ ...f.expectations, max_chars: 500 }));
    await assert.rejects(f.evaluations.auditContextReceipt(args), /operation_id already bound/u);
  } finally { await f.evaluations.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workbench Context audit validates operation paths and input size before reading", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.evaluations.auditContextReceipt({ operation_id: "bad id", pack_path: f.packPath, expectations_path: f.expectationsPath }), /operation_id/u);
    await assert.rejects(f.evaluations.auditContextReceipt({ operation_id: "relative", pack_path: "context.json", expectations_path: f.expectationsPath }), /absolute path/u);
    await assert.rejects(f.evaluations.auditContextReceipt({ operation_id: "missing", pack_path: join(f.root, "missing.json"), expectations_path: f.expectationsPath }));
    const directory = join(f.root, "directory"); await mkdir(directory);
    await assert.rejects(f.evaluations.auditContextReceipt({ operation_id: "directory", pack_path: directory, expectations_path: f.expectationsPath }), /regular file/u);
    const oversized = join(f.root, "oversized.json"); await writeFile(oversized, " ".repeat(1_000_001));
    await assert.rejects(f.evaluations.auditContextReceipt({ operation_id: "oversized", pack_path: oversized, expectations_path: f.expectationsPath }), /1 MB/u);
    const invalid = join(f.root, "invalid.json"); await writeFile(invalid, "{");
    await assert.rejects(f.evaluations.auditContextReceipt({ operation_id: "invalid", pack_path: invalid, expectations_path: f.expectationsPath }), /valid JSON/u);
    await assert.rejects(f.evaluations.contextAuditReport("unknown"), /audit id/u);
    await assert.rejects(f.evaluations.contextAuditReport("a".repeat(64)), /not found/u);
  } finally { await f.evaluations.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workbench Context audit report rejects tampering and remains unknown until its report is complete", async () => {
  const f = await fixture();
  try {
    const result = await f.evaluations.auditContextReceipt({ operation_id: "audit-tamper", pack_path: f.packPath, expectations_path: f.expectationsPath });
    const record = f.store.find("workbench_context_audit", String(result.audit.id))!;
    const reportPath = String(record.report_path);
    const original = await readFile(reportPath, "utf8");
    const changed = { ...result.report, metrics: { ...result.report.metrics, selected_chars: result.report.metrics.selected_chars + 1 } };
    await writeFile(reportPath, JSON.stringify(changed));
    await assert.rejects(f.evaluations.contextAuditReport(String(result.audit.id)), /report changed/u);
    await writeFile(reportPath, original);
    f.store.save("workbench_context_audit", String(result.audit.id), { ...record, state: "writing" });
    await assert.rejects(f.evaluations.contextAuditReport(String(result.audit.id)), /not complete/u);
  } finally { await f.evaluations.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("Workbench Context audit rejects file growth and source changes during bounded reads", async () => {
  for (const change of ["growth", "size", "mtime", "short-read"] as const) {
    const f = await fixture();
    try {
      const target = await import("node:fs/promises").then(({ realpath }) => realpath(f.packPath));
      const openFile: typeof openReader = async (path, flags) => {
        const handle = await openReader(path, flags);
        if (path !== target) return handle;
        const current = await handle.stat(); let statCalls = 0, reads = 0;
        const initialSize = change === "growth" ? 1_000_000 : 2;
        const changedSize = change === "size" ? 3 : initialSize;
        return {
          stat: async () => ({ size: statCalls++ === 0 ? initialSize : changedSize, mtimeMs: statCalls === 1 ? current.mtimeMs : change === "mtime" ? current.mtimeMs + 1 : current.mtimeMs, isFile: () => true }),
          read: async (buffer: Buffer, offset: number, length: number) => {
            if (reads++ > 0) return { bytesRead: 0, buffer };
            const bytesRead = change === "growth" ? length : change === "short-read" ? 1 : 2;
            buffer.fill(65, offset, offset + bytesRead);
            return { bytesRead, buffer };
          },
          close: () => handle.close(),
        } as Awaited<ReturnType<typeof openReader>>;
      };
      const auditor = new WorkbenchContextAudits(f.store, openFile);
      await assert.rejects(auditor.audit({ operation_id: `change-${change}`, pack_path: f.packPath, expectations_path: f.expectationsPath }), change === "growth" ? /1 MB/u : /changed while being read/u);
    } finally { await f.evaluations.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  }
});

test("Workbench Context audit rejects changed record bindings and recovery reservations", async () => {
  const f = await fixture();
  try {
    const args = { operation_id: "audit-binding", pack_path: f.packPath, expectations_path: f.expectationsPath };
    const result = await f.evaluations.auditContextReceipt(args);
    const id = String(result.audit.id), record = f.store.find("workbench_context_audit", id)!;
    f.store.save("workbench_context_audit", id, { ...record, report_digest: "sha256:" + "0".repeat(64) });
    await assert.rejects(f.evaluations.auditContextReceipt(args), /result changed/u);
    f.store.save("workbench_context_audit", id, { ...record, report_path: record.report_path + ".changed" });
    await assert.rejects(f.evaluations.auditContextReceipt(args), /binding changed/u);
    f.store.save("workbench_context_audit", id, { ...record, input_digest: "invalid" });
    await assert.rejects(f.evaluations.contextAuditReport(id), /binding is invalid/u);
    f.store.save("workbench_context_audit", id, { ...record, report_digest: "invalid" });
    await assert.rejects(f.evaluations.contextAuditReport(id), /binding is invalid/u);
    f.store.save("workbench_context_audit", id, { ...record, report_path: record.report_path + ".changed" });
    await assert.rejects(f.evaluations.contextAuditReport(id), /binding changed/u);
    f.store.save("workbench_context_audit", id, record);
    const reportFile = String(record.report_path), original = await readFile(reportFile, "utf8");
    await writeFile(reportFile, "{");
    await assert.rejects(f.evaluations.contextAuditReport(id), /changed or unavailable/u);
    await writeFile(reportFile, original);

    const second = { ...args, operation_id: "audit-reservation" };
    const transaction = f.store.transactionWithRetry.bind(f.store); let count = 0;
    f.store.transactionWithRetry = (async <T>(action: Parameters<typeof f.store.transactionWithRetry>[0], options?: Parameters<typeof f.store.transactionWithRetry>[1]) => {
      const value = await transaction(action, options);
      if (++count === 1) {
        const reservedId = createHash("sha256").update(second.operation_id).digest("hex");
        const reserved = f.store.find("workbench_context_audit", reservedId)!;
        f.store.save("workbench_context_audit", reservedId, { ...reserved, report_digest: "sha256:" + "f".repeat(64) });
      }
      return value;
    }) as typeof f.store.transactionWithRetry;
    await assert.rejects(f.evaluations.auditContextReceipt(second), /reservation changed/u);
  } finally { await f.evaluations.close(); f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
