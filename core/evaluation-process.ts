import { fork } from "node:child_process";
import type { RunOptions, RunReport } from "craft-eval";

/** Execution may have had effects; losing its terminal receipt never authorizes replay. */
export class EvaluationOutcomeUnknownError extends Error {
  constructor() { super("Evaluation worker exited without a terminal result; inspect the saved run before retrying"); this.name = "EvaluationOutcomeUnknownError"; }
}

/** The evaluator owns files and subprocesses; Craft keeps policy and evidence admission. */
export function runEvaluationProcess(paths: [string, string, string, string, string], options: Pick<RunOptions, "trials" | "parallelism" | "max_output_bytes" | "signal" | "on_progress"> = {}): Promise<{ run: string; report: RunReport }> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = fork(new URL(import.meta.url.endsWith(".ts") ? "../bin/craft-evaluation-worker.ts" : "../bin/craft-evaluation-worker.js", import.meta.url), [], { execArgv: import.meta.url.endsWith(".ts") ? ["--experimental-strip-types"] : [], stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const cancel = () => { if (worker.connected) worker.send({ type: "cancel" }); };
    options.signal?.addEventListener("abort", cancel, { once: true });
    let result: { run: string; report: RunReport } | undefined;
    let failure: Error | undefined;
    worker.on("message", (message: { type: string; run: string; report: RunReport; message: string; event: Parameters<NonNullable<RunOptions["on_progress"]>>[0] }) => {
      if (message.type === "result") result = { run: message.run, report: message.report };
      else if (message.type === "error") failure = new Error(message.message);
      else if (message.type === "progress") {
        try { options.on_progress?.(message.event); } catch (error) { failure = error instanceof Error ? error : new Error("Progress observer failed"); cancel(); }
      }
    });
    worker.on("error", error => { failure = error; });
    worker.on("close", () => {
      options.signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (result) resolve(result);
      else reject(new EvaluationOutcomeUnknownError());
    });
    worker.send({ type: "run", paths, options: { trials: options.trials, parallelism: options.parallelism, max_output_bytes: options.max_output_bytes } });
    if (options.signal?.aborted) cancel();
  });
}
