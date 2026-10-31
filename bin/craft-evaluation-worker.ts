import { runSuite, reportRun, type RunOptions } from "craft-eval";

const controller = new AbortController();
let started = false;
function send(message: object): void {
  if (!process.connected) return;
  try { process.send?.(message, error => { if (error) controller.abort(); }); }
  catch { controller.abort(); }
}
process.on("message", async (message: { type: string; paths?: [string, string, string, string, string]; options?: Pick<RunOptions, "trials" | "parallelism" | "max_output_bytes"> }) => {
  if (message.type === "cancel") { controller.abort(); return; }
  if (message.type !== "run" || started || !message.paths || message.paths.length !== 5) return;
  started = true;
  try {
    const run = await runSuite(...message.paths, { ...message.options, signal: controller.signal,
      on_progress: event => send({ type: "progress", event }) });
    send({ type: "result", run, report: await reportRun(run) });
  } catch (error) {
    send({ type: "error", message: error instanceof Error ? error.message : "Evaluation failed" });
  } finally { if (process.connected) process.disconnect?.(); }
});
process.on("disconnect", () => controller.abort());
