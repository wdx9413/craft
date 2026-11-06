import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { runEvaluationProcess, EvaluationOutcomeUnknownError } from "./evaluation-process.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";
import evaluationPackage from "craft-eval/package.json" with { type: "json" };
import { evaluationEngineIdentity } from "./evaluation-engine-identity.ts";
import { KnowledgeTaskEffects } from "./knowledge-task-effects.ts";
const evaluationVersion = evaluationPackage.version;

const KIND = "workbench_evaluation";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const CONFIG_BYTES = 1024 * 1024;

/** Read from one regular-file descriptor, including when its contents grow after stat. */
async function configurationBytes(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("evaluation config must be a regular file");
    if (info.size > CONFIG_BYTES) throw new Error("evaluation config exceeds 1 MiB");
    const bytes = Buffer.alloc(CONFIG_BYTES + 1); let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > CONFIG_BYTES) throw new Error("evaluation config exceeds 1 MiB");
    return Buffer.from(bytes.subarray(0, length));
  } finally { await file.close(); }
}

/** Controlled execution records are not automatic Knowledge or release approval. */
export class WorkbenchEvaluations {
  readonly store: CraftStore;
  private active = new Map<string, { abort: AbortController; done: Promise<void>; events: JsonObject[] }>();
  private closed = false;
  constructor(store: CraftStore) { this.store = store; }
  knowledgeContext(runId: string): JsonObject { return new KnowledgeTaskEffects(this.store, this).context(runId); }
  assessKnowledgeEffect(runId: string, baselineId: string, candidateId: string): Promise<JsonObject> { return new KnowledgeTaskEffects(this.store, this).assess(runId, baselineId, candidateId); }

  get(id: string): JsonObject {
    const record = this.store.find(KIND, id);
    if (!record) throw Object.assign(new Error("evaluation not found"), { code: "EVALUATION_NOT_FOUND" });
    return ["starting", "running", "cancelling"].includes(String(record.state)) && !this.active.has(id)
      ? { ...record, state: "unknown", reason: "runtime_restarted; inspect saved report before retrying" } : record;
  }

  async submit(args: JsonObject): Promise<JsonObject> {
    if (this.closed) throw new Error("evaluation service is closed");
    if (typeof args.operation_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(args.operation_id)) throw new Error("operation_id is invalid");
    const keys = ["suite", "subject", "runtime", "workspace"] as const;
    const paths = await Promise.all(keys.map(async key => {
      const value = args[key];
      if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${key} must be an absolute path`);
      return realpath(value);
    }));
    if (!(await stat(paths[3]!)).isDirectory()) throw new Error("workspace must be a directory");
    const inputs = await Promise.all(paths.slice(0, 3).map(configurationBytes));
    const suite = JSON.parse(inputs[0]!.toString("utf8")) as { cases?: Array<{ in_place?: boolean }> };
    if (Array.isArray(suite?.cases) && suite.cases.some(item => item.in_place === true)) throw new Error("Workbench evaluations require isolated workspaces; in_place is only available through the developer CLI");
    const binding = hash(JSON.stringify({ paths, digests: inputs.map(hash) }));
    const id = hash(args.operation_id);
    const existing = this.store.find(KIND, id);
    if (existing) {
      if (existing.input_digest !== binding) throw new Error("operation_id already bound to different inputs");
      return this.get(id);
    }
    if (this.closed) throw new Error("evaluation service is closed");
    if (this.active.size >= 4) throw new Error("evaluation capacity reached");
    const directory = join(this.store.paths.root, "evaluations", id);
    this.store.create(KIND, id, { state: "starting", input_digest: binding, workspace: paths[3], input_paths: paths.slice(0, 3), report_root: directory,
      evaluator_version: evaluationVersion, node_version: process.versions.node, platform: process.platform, architecture: process.arch });
    const abort = new AbortController();
    const live = { abort, done: Promise.resolve(), events: [] as JsonObject[] };
    this.active.set(id, live);
    live.done = (async () => {
      try {
        await mkdir(directory, { recursive: true });
        const frozen = inputs.map((_, index) => join(directory, `${keys[index]}.json`));
        await Promise.all(frozen.map((file, index) => writeFile(file, inputs[index]!)));
        const subject = JSON.parse(inputs[1]!.toString("utf8")) as Record<string, unknown>;
        const engine = await evaluationEngineIdentity(subject);
        this.store.save(KIND, id, { ...this.store.get(KIND, id), state: abort.signal.aborted ? "cancelling" : "running", execution_engine: engine });
        const result = await runEvaluationProcess([frozen[0]!, frozen[1]!, frozen[2]!, paths[3]!, join(directory, "runs")], {
          signal: abort.signal,
          on_progress: event => { live.events.push(event); if (live.events.length > 256) live.events.shift(); },
        });
        if (stableDigest(await evaluationEngineIdentity(subject)) !== stableDigest(engine)) throw new Error("evaluation engine or environment changed during execution");
        const reportDigest = stableDigest(result.report);
        const planDigest = hash(await readFile(join(result.run, "plan.json")));
        await writeFile(join(directory, "controlled-report.json"), JSON.stringify(result.report));
        this.store.save(KIND, id, { ...this.store.get(KIND, id), state: abort.signal.aborted ? "cancelled" : "completed", run_directory: result.run, report_digest: reportDigest, plan_digest: planDigest, summary: { expected: result.report.expected, passed: result.report.passed, failed: result.report.failed, missing: result.report.missing, inconclusive: result.report.inconclusive } });
      } catch (error) {
        this.store.save(KIND, id, { ...this.store.get(KIND, id), state: abort.signal.aborted ? "cancelled" : error instanceof EvaluationOutcomeUnknownError ? "unknown" : "failed", error: error instanceof Error ? error.message : "evaluation failed" });
      } finally { this.active.delete(id); }
    })();
    // A persistence failure must not create an unhandled rejection or imply success.
    void live.done.catch(() => undefined);
    return this.get(id);
  }

  events(id: string): JsonObject { return { evaluation: this.get(id), events: this.active.get(id)?.events ?? [] }; }
  cancel(id: string): JsonObject {
    const record = this.get(id), live = this.active.get(id);
    if (!live) throw new Error("evaluation is not running in this process");
    live.abort.abort();
    return this.store.save(KIND, id, { ...record, state: "cancelling" });
  }
  async report(id: string): Promise<JsonObject> {
    const record = this.get(id);
    if (typeof record.run_directory !== "string" || typeof record.report_digest !== "string") throw new Error("controlled evaluation report is not available");
    const inputs = await this.inputs(id);
    const snapshot: unknown = JSON.parse(await readFile(join(String(record.report_root), "controlled-report.json"), "utf8"));
    if (stableDigest(snapshot) !== record.report_digest) throw new Error("controlled evaluation report changed; evidence cannot be trusted");
    const { reportRun, digest } = await import("craft-eval");
    const planBytes = await readFile(join(record.run_directory, "plan.json"));
    if (hash(planBytes) !== record.plan_digest) throw new Error("evaluation execution plan changed after completion");
    const plan = JSON.parse(planBytes.toString("utf8")) as { subject: { digest: string }; suite_digest: string; runtime: unknown };
    if (plan.subject.digest !== digest(inputs.subject) || plan.suite_digest !== digest(inputs.suite) || stableDigest(plan.runtime) !== stableDigest(inputs.runtime)) throw new Error("evaluation execution plan does not match reserved inputs");
    const report = await reportRun(record.run_directory);
    if (stableDigest(report) !== record.report_digest) throw new Error("evaluation result files changed after completion; evidence cannot be trusted");
    return { evaluation: record, report, integrity: "verified_against_controlled_run" };
  }

  /** Frozen input bytes must still match the binding reserved before the worker started. */
  async inputs(id: string): Promise<{ suite: JsonObject; subject: JsonObject; runtime: JsonObject }> {
    const record = this.get(id);
    const bytes = await Promise.all(["suite", "subject", "runtime"].map(key => configurationBytes(join(String(record.report_root), `${key}.json`))));
    if (!Array.isArray(record.input_paths) || hash(JSON.stringify({ paths: [...record.input_paths, record.workspace], digests: bytes.map(hash) })) !== record.input_digest) throw new Error("controlled evaluation inputs changed after reservation");
    return { suite: JSON.parse(bytes[0]!.toString("utf8")), subject: JSON.parse(bytes[1]!.toString("utf8")), runtime: JSON.parse(bytes[2]!.toString("utf8")) };
  }

  async compare(baselineId: string, candidateId: string): Promise<JsonObject> {
    if (baselineId === candidateId) throw new Error("comparison requires two independent runs");
    const records = [this.get(baselineId), this.get(candidateId)];
    if (records.some(record => record.state !== "completed")) throw new Error("comparison requires completed controlled runs");
    for (const key of ["evaluator_version", "node_version", "platform", "architecture"]) {
      if (typeof records[0]![key] !== "string" || records[0]![key] !== records[1]![key]) throw new Error("observed evaluator environments are not comparable");
    }
    const root = await mkdtemp(join(tmpdir(), "craft-controlled-compare-"));
    try {
      const { reportRun, compareRuns } = await import("craft-eval");
      const frozen: string[] = [];
      for (const [index, record] of records.entries()) {
        await this.report(String(record.id));
        const directory = join(root, String(index)); await mkdir(join(directory, "results"), { recursive: true });
        await copyFile(join(String(record.run_directory), "plan.json"), join(directory, "plan.json"));
        if (hash(await readFile(join(directory, "plan.json"))) !== record.plan_digest) throw new Error("comparison plan changed while freezing");
        const controlled = JSON.parse(await readFile(join(String(record.report_root), "controlled-report.json"), "utf8")) as { results: Array<{ case_id: string; trial: number }> };
        for (const item of controlled.results) {
          if (!/^[A-Za-z0-9_.-]+$/u.test(item.case_id) || !Number.isSafeInteger(item.trial) || item.trial < 1) throw new Error("invalid controlled comparison result key");
          const name = `${item.case_id}-${item.trial}.json`;
          await copyFile(join(String(record.run_directory), "results", name), join(directory, "results", name));
        }
        if (stableDigest(await reportRun(directory)) !== record.report_digest) throw new Error("comparison results changed while freezing");
        frozen.push(directory);
      }
      const comparison = await compareRuns(frozen[0]!, frozen[1]!);
      const binding = { baseline_id: baselineId, candidate_id: candidateId, report_digests: records.map(record => record.report_digest), plan_digests: records.map(record => record.plan_digest) };
      const id = hash(JSON.stringify(binding));
      const existing = this.store.find("workbench_evaluation_comparison", id);
      if (existing) return { comparison: existing, idempotent: true };
      const receipt = await this.store.transactionWithRetry(() => this.store.find("workbench_evaluation_comparison", id) ?? this.store.create("workbench_evaluation_comparison", id, {
        ...binding, metrics: comparison, decision: "diagnostic_only", knowledge_promotion_authorized: false,
      }));
      return { comparison: receipt };
    } finally { await rm(root, { recursive: true, force: true }); }
  }
  async close(): Promise<void> {
    this.closed = true;
    const runs = [...this.active.values()];
    for (const run of runs) run.abort.abort();
    await Promise.allSettled(runs.map(run => run.done));
  }
}
