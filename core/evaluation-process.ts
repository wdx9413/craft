import { fork } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { digest, type RunOptions, type RunReport } from "craft-eval";

/** Execution may have had effects; losing its terminal receipt never authorizes replay. */
export class EvaluationOutcomeUnknownError extends Error {
  constructor() { super("Evaluation worker exited without a terminal result; inspect the saved run before retrying"); this.name = "EvaluationOutcomeUnknownError"; }
}

/** The evaluator owns files and subprocesses; Craft keeps policy and evidence admission. */
export function runEvaluationProcess(paths: [string, string, string, string, string], options: Pick<RunOptions, "trials" | "parallelism" | "max_output_bytes" | "signal" | "on_progress"> = {}): Promise<{ run: string; report: RunReport; plan_digest: string }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    // Snapshot the environment at spawn time: a caller may legitimately restore
    // NODE_OPTIONS (or other process-wide variables) as soon as this call returns,
    // and the worker must inherit the values that were in force when it was forked.
    const worker = fork(new URL(import.meta.url.endsWith(".ts") ? "../bin/craft-evaluation-worker.ts" : "../bin/craft-evaluation-worker.js", import.meta.url), [], { execArgv: import.meta.url.endsWith(".ts") ? ["--experimental-strip-types"] : [], stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env } });
    const cancel = () => { if (worker.connected) worker.send({ type: "cancel" }); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    let result: { run: string; report: RunReport; report_plan: { run_id: string; plan_digest: string } | undefined } | undefined;
    let failure: Error | undefined;
    const evidence = new Map<string, { run_id: string; result_digest: string }>();
    let planEvidence: { run_id: string; plan_digest: string } | undefined;
    worker.on("message", (message: { type: string; run: string; report: RunReport; report_plan?: { run_id: string; plan_digest: string }; message: string; event: Parameters<NonNullable<RunOptions["on_progress"]>>[0] & { result_digest: string; plan_digest: string } }) => {
      if (message.type === "result") result = { run: message.run, report: message.report, report_plan: message.report_plan };
      else if (message.type === "error") failure = new Error(message.message);
      else if (message.type === "result_digest") {
        const key = JSON.stringify([message.event.case_id, message.event.trial]);
        if (evidence.has(key)) failure = new Error("duplicate evaluation result evidence");
        else evidence.set(key, { run_id: message.event.run_id, result_digest: message.event.result_digest });
      }
      else if (message.type === "plan_digest") {
        if (planEvidence) failure = new Error("duplicate evaluation plan evidence");
        else planEvidence = { run_id: message.event.run_id, plan_digest: message.event.plan_digest };
      }
      else if (message.type === "progress") {
        try { options.on_progress?.(message.event); } catch (error) { failure = error instanceof Error ? error : new Error("Progress observer failed"); cancel(); }
      }
    });
    worker.on("error", error => { failure = error; });
    worker.on("close", async (code, signal) => {
      options.signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0 || signal !== null) reject(new EvaluationOutcomeUnknownError());
      else if (result) {
        const report = result.report;
        try {
          const plan = JSON.parse(await readFile(join(result.run, "plan.json"), "utf8")) as unknown;
          if (!planEvidence || planEvidence.run_id !== report.run_id || planEvidence.plan_digest !== digest(plan)
            || result.report_plan?.run_id !== planEvidence.run_id || result.report_plan.plan_digest !== planEvidence.plan_digest) throw new Error("evaluation plan evidence does not match report");
        } catch (error) { reject(error); return; }
        const valid = report.results.length === evidence.size && report.results.every(item => {
          const observed = evidence.get(JSON.stringify([item.case_id, item.trial]));
          return observed?.run_id === report.run_id && observed.result_digest === digest(item);
        });
        if (!valid) reject(new Error("evaluation result evidence does not match report"));
        else resolve({ run: result.run, report: result.report, plan_digest: planEvidence!.plan_digest });
      }
      else reject(new EvaluationOutcomeUnknownError());
    });
    worker.send({ type: "run", paths, options: { trials: options.trials, parallelism: options.parallelism, max_output_bytes: options.max_output_bytes } });
    if (options.signal?.aborted) cancel();
  });
}
