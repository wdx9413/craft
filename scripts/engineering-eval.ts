#!/usr/bin/env node
/** Explicit local/approved-CI entrypoint for Engineering Profile Codex trials. */
import { mkdir } from "node:fs/promises";
import { platform, versions } from "node:process";
import { resolve } from "node:path";
import { EngineeringEvaluationRunner } from "../capability/engineering-evaluation-runner.ts";
import { digestJson } from "../src/digest.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { CraftService } from "../src/service.ts";
import { executeHostProcess } from "../src/host-driver.ts";

const required = new Set(["model", "fixtures", "store", "archive", "timeout-ms", "output-limit", "trials"]);

function argumentsMap(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || !required.has(key.slice(2))) throw new Error("Usage: pnpm engineering:eval -- --model <model> --fixtures <dir> --store <dir> --archive <dir> --timeout-ms <n> --output-limit <n> --trials 5");
    if (values[key.slice(2)] !== undefined || !value.trim()) throw new Error(`Option ${key} must appear once with a value`); values[key.slice(2)] = value;
  }
  for (const key of required) if (values[key] === undefined) throw new Error(`Missing required --${key}`);
  return values;
}
function positive(value: string, name: string): number { const result = Number(value); if (!Number.isInteger(result) || result < 1) throw new Error(`--${name} must be a positive integer`); return result; }

async function codexVersion(): Promise<string> {
  const result = await executeHostProcess({ executable: "codex", argv: ["--version"], cwd: process.cwd(), stdin: "", timeoutMs: 10_000, outputLimit: 4_096 });
  if (result.exitCode !== 0 || result.timedOut || result.outputLimited) throw new Error("Unable to determine the current Codex CLI version");
  return result.stdout.trim();
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = argumentsMap(argv); const timeout = positive(args["timeout-ms"]!, "timeout-ms"); const output = positive(args["output-limit"]!, "output-limit"); const trials = positive(args.trials!, "trials");
  if (trials !== 5) throw new Error("--trials must be exactly 5"); const storeRoot = resolve(args.store!); const archive = resolve(args.archive!); await mkdir(storeRoot, { recursive: true });
  const store = await new CraftStore(craftPaths(storeRoot)).open();
  try {
    const version = await codexVersion(); const runner = new EngineeringEvaluationRunner(store, new CraftService(store), { fixture_root: resolve(args.fixtures!), archive_root: archive, model: args.model!, timeout_ms: timeout, output_limit: output, trials_per_pair: trials, codex_version: version, environment_fingerprint: digestJson({ platform, node: versions.node, codex: version }) });
    const result = await runner.run(); process.stdout.write(`${JSON.stringify({ plan_id: result.plan.id, evaluation: result.evaluation.status, archive: result.archive })}\n`);
  } finally { store.close(); }
}

if (import.meta.url === new URL(process.argv[1]!, "file:").href) void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
