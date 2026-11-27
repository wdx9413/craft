import { spawn } from "node:child_process";
import type { JsonObject } from "../../core/infrastructure/store.ts";

/** The configured evaluator owns isolated Host execution and signing; Craft still verifies its report. */
export async function runHeldOutAdapter(dispatch: JsonObject, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject | null> {
  return runJsonAdapter(dispatch, env, "CRAFT_HELD_OUT_ADAPTER_COMMAND", "CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS", "HeldOutAdapter");
}

/** Run the separate signed Shadow/Canary evaluator; Craft verifies its receipt. */
export async function runTrustedExperienceEvaluatorAdapter(request: JsonObject, env: NodeJS.ProcessEnv = process.env): Promise<JsonObject | null> {
  return runJsonAdapter(request, env, "CRAFT_EXPERIENCE_EVALUATOR_COMMAND", "CRAFT_EXPERIENCE_EVALUATOR_TIMEOUT_MS", "ExperienceEvaluatorAdapter");
}

async function runJsonAdapter(input: JsonObject, env: NodeJS.ProcessEnv, commandName: string, timeoutName: string,
  errorPrefix: string): Promise<JsonObject | null> {
  if (!env[commandName]) return null;
  let command: unknown;
  try { command = JSON.parse(env[commandName]!); } catch { throw new Error(`${errorPrefix}ConfigurationError`); }
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== "string" || !value))
    throw new Error(`${errorPrefix}ConfigurationError`);
  const configured = Number(env[timeoutName] ?? 300_000);
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 3_600_000) throw new Error(`${errorPrefix}ConfigurationError`);
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { env, stdio: ["pipe", "pipe", "ignore"], shell: false });
    let output = Buffer.alloc(0), settled = false;
    const finish = (error?: Error, value?: JsonObject) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { child.kill(); reject(error); } else resolve(value!);
    };
    const timer = setTimeout(() => finish(new Error(`${errorPrefix}Timeout`)), configured);
    child.on("error", () => finish(new Error(`${errorPrefix}Unavailable`)));
    child.stdin.on("error", () => finish(new Error(`${errorPrefix}InputError`)));
    child.stdout.on("data", chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 1024 * 1024) finish(new Error(`${errorPrefix}OutputLimit`));
    });
    child.on("close", code => {
      if (settled) return;
      if (code !== 0) { finish(new Error(`${errorPrefix}Failed`)); return; }
      try {
        const report: unknown = JSON.parse(output.toString("utf8"));
        if (!report || typeof report !== "object" || Array.isArray(report)) throw new Error();
        finish(undefined, report as JsonObject);
      } catch { finish(new Error(`${errorPrefix}InvalidReport`)); }
    });
    child.stdin.end(JSON.stringify({ schema_version: 1, ...(errorPrefix === "ExperienceEvaluatorAdapter" ? { request: input } : { dispatch: input }) }));
  });
}
