import { spawn } from "node:child_process";
import type { JsonObject } from "../../core/infrastructure/store.ts";

/** The configured evaluator owns isolated Host execution and signing; Craft still verifies its report. */
export async function runHeldOutAdapter(dispatch: JsonObject, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject | null> {
  if (!env.CRAFT_HELD_OUT_ADAPTER_COMMAND) return null;
  const command: unknown = JSON.parse(env.CRAFT_HELD_OUT_ADAPTER_COMMAND);
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== "string" || !value))
    throw new Error("HeldOutAdapterConfigurationError");
  const configured = Number(env.CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS ?? 300_000);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 3_600_000) throw new Error("HeldOutAdapterConfigurationError");
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ["pipe", "pipe", "ignore"], shell: false });
    let output = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, value?: JsonObject) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error("HeldOutAdapterTimeout")), configured);
    child.on("error", () => finish(new Error("HeldOutAdapterUnavailable")));
    child.stdin.on("error", () => finish(new Error("HeldOutAdapterInputError")));
    child.stdout.on("data", chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 1024 * 1024) finish(new Error("HeldOutAdapterOutputLimit"));
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) { finish(new Error("HeldOutAdapterFailed")); return; }
      try {
        const report: unknown = JSON.parse(output.toString("utf8"));
        if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error();
        finish(undefined, report as JsonObject);
      } catch { finish(new Error("HeldOutAdapterInvalidReport")); }
    });
    child.stdin.end(JSON.stringify({ schema_version: 1, dispatch }));
  });
}
