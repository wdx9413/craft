import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open as openReader, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { auditContextPack, type ContextAuditReport } from "craft-eval";
import evaluationPackage from "craft-eval/package.json" with { type: "json" };
import { stableDigest } from "./digest.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";

const KIND = "workbench_context_audit";
const MAX_INPUT_BYTES = 1_000_000;
const evaluatorVersion = String(evaluationPackage.version);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface WorkbenchContextAuditResult extends JsonObject { audit: JsonObject; report: ContextAuditReport; integrity: "verified_against_saved_report" }

async function boundedFile(pathValue: unknown, name: string, openFile: typeof openReader = openReader): Promise<Buffer> {
  if (typeof pathValue !== "string" || !isAbsolute(pathValue)) throw new Error(`${name} must be an absolute path`);
  const canonical = await realpath(pathValue);
  const file = await openFile(canonical, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new Error(`${name} must be a regular file`);
    if (before.size > MAX_INPUT_BYTES) throw new Error(`${name} exceeds 1 MB`);
    const bytes = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_INPUT_BYTES) throw new Error(`${name} exceeds 1 MB`);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) throw new Error(`${name} changed while being read`);
    return Buffer.from(bytes.subarray(0, length));
  } finally { await file.close(); }
}

async function jsonInput(pathValue: unknown, name: string, openFile: typeof openReader): Promise<{ value: unknown; digest: string }> {
  const bytes = await boundedFile(pathValue, name, openFile);
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error(`${name} must be valid JSON`); }
  return { value, digest: sha256(bytes) };
}

function auditId(value: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error("context audit id is invalid");
  return value;
}

function reportPath(root: string, id: string, inputDigest: string): string {
  return join(root, "context-audits", id, `${inputDigest}.json`);
}

function view(record: JsonObject): JsonObject {
  return {
    id: record.id,
    state: record.state,
    case_id: record.case_id,
    status: record.status,
    evaluator_version: record.evaluator_version,
    input_digest: record.input_digest,
    report_digest: record.report_digest,
  };
}

/** Local receipt audit. Source JSON is read in bounded memory and never persisted. */
export class WorkbenchContextAudits {
  readonly store: CraftStore;
  readonly openFile: typeof openReader;

  constructor(store: CraftStore, openFile: typeof openReader = openReader) { this.store = store; this.openFile = openFile; }

  async audit(args: JsonObject): Promise<WorkbenchContextAuditResult> {
    if (typeof args.operation_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(args.operation_id)) throw new Error("operation_id is invalid");
    const [pack, expectations] = await Promise.all([
      jsonInput(args.pack_path, "context pack", this.openFile),
      jsonInput(args.expectations_path, "context expectations", this.openFile),
    ]);
    const id = sha256(args.operation_id);
    const inputDigest = sha256(JSON.stringify({ pack: pack.digest, expectations: expectations.digest }));
    const report = auditContextPack(pack.value, expectations.value);
    const reportDigest = stableDigest(report);
    const path = reportPath(this.store.paths.root, id, inputDigest);
    const operation = await this.store.transactionWithRetry(() => {
      const existing = this.store.find(KIND, id);
      if (existing) {
        if (existing.input_digest !== inputDigest) throw new Error("operation_id already bound to different inputs");
        if (existing.report_digest !== reportDigest) throw new Error("context audit result changed for the same inputs");
        return existing;
      }
      return this.store.create(KIND, id, {
        state: "writing",
        input_digest: inputDigest,
        report_digest: reportDigest,
        report_path: path,
        case_id: report.case_id,
        status: report.status,
        evaluator_version: evaluatorVersion,
        node_version: process.versions.node,
        platform: process.platform,
      });
    });
    if (operation.report_path !== path) throw new Error("context audit report binding changed");
    if (operation.state !== "completed") {
      await mkdir(join(this.store.paths.root, "context-audits", id), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
        await rename(temporary, path);
      } finally { await rm(temporary, { force: true }); }
      await this.store.transactionWithRetry(() => {
        const current = this.store.find(KIND, id);
        if (!current || current.input_digest !== inputDigest || current.report_digest !== reportDigest) throw new Error("context audit reservation changed before completion");
        if (current.state !== "completed") this.store.save(KIND, id, { ...current, state: "completed" });
      });
    }
    const result = await this.report(id);
    return { audit: result.audit, report: result.report, integrity: result.integrity };
  }

  async report(rawId: string): Promise<WorkbenchContextAuditResult> {
    const id = auditId(rawId);
    const record = this.store.find(KIND, id);
    if (!record) throw Object.assign(new Error("context audit not found"), { code: "CONTEXT_AUDIT_NOT_FOUND" });
    if (record.state !== "completed") throw new Error("context audit report is not complete");
    if (typeof record.input_digest !== "string" || !/^[a-f0-9]{64}$/u.test(record.input_digest)
      || typeof record.report_digest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(record.report_digest)) throw new Error("context audit report binding is invalid");
    const path = reportPath(this.store.paths.root, id, record.input_digest);
    if (record.report_path !== path) throw new Error("context audit report binding changed");
    let report: unknown;
    try {
      const bytes = await boundedFile(path, "context audit report");
      report = JSON.parse(bytes.toString("utf8"));
    } catch { throw new Error("context audit report changed or unavailable"); }
    if (stableDigest(report) !== record.report_digest) throw new Error("context audit report changed; evidence cannot be trusted");
    return { audit: view(record), report: report as ContextAuditReport, integrity: "verified_against_saved_report" };
  }
}
