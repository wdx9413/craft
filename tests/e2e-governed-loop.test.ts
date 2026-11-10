/**
 * End-to-end governed loop against the real local gateway.
 *
 * The unit gates prove each kernel; this suite proves the seam between them:
 * Pilot intake -> Task -> dispatch -> internal host -> the real model ->
 * receipt -> acceptance gate, over the real HTTP API a Host would call.
 *
 * The gateway address comes from the environment (`.env.local` via
 * `scripts/dev/load-env.ts`, or an explicit export). Without a reachable
 * gateway every case records a skip, so the suite stays green on machines that
 * only run the unit gates while still failing loudly here when the loop breaks.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalWorkbenchServer } from "../core/interfaces/workbench-server.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { saveSettingsSync } from "../core/settings.ts";
import { providerFromConfig } from "../core/model-gateway.ts";

const BASE_URL = process.env.CRAFT_EVAL_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "";
const MODEL = process.env.CRAFT_EVAL_MODEL ?? "group/free";
const API_KEY_ENV = process.env.CRAFT_EVAL_API_KEY_ENV ?? "OPENAI_API_KEY";
const gatewayReachable = Boolean(BASE_URL && process.env[API_KEY_ENV]);

interface Fixture { root: string; store: CraftStore; service: CraftService; paths: ReturnType<typeof craftPaths> }

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "craft-e2e-loop-"));
  const paths = craftPaths(join(root, "data"));
  const store = await new CraftStore(paths).open();
  const service = new CraftService(store);
  const provider = providerFromConfig({
    protocol: "openai-compatible", name: "e2e-local", baseUrl: BASE_URL || "http://127.0.0.1:1/v1",
    model: MODEL, apiKeyEnv: API_KEY_ENV,
  });
  saveSettingsSync({
    models: [{ id: "e2e-model", name: "E2E", protocol: "openai-compatible", baseUrl: BASE_URL || "http://127.0.0.1:1/v1",
      model: MODEL, apiKeyEnv: API_KEY_ENV, supportsTools: false }],
  }, paths);
  return { root, store, service, paths };
}

test("pilot model split creates ordinary tasks through the real gateway", { skip: !gatewayReachable }, async () => {
  const f = await fixture();
  try {
    const session = f.service.pilotSessionOpen({ input: "Divide 306 by 9 and then compute 12 squared." }).session as { id: string };
    const turn = await f.service.pilotTurnWithModel({ session_id: session.id, input: "Divide 306 by 9 and then compute 12 squared.", model_id: "e2e-model" });
    assert.equal(turn.status, "created");
    assert.ok(Number(turn.tasks_created) >= 1, `expected real tasks, got ${JSON.stringify(turn)}`);
    assert.equal(turn.model, MODEL);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("craft run --goal drives task -> dispatch -> real model -> receipt over the CLI", { skip: !gatewayReachable }, async (t) => {
  const f = await fixture();
  try {
    // The CLI reads the user-level config; init it against the local gateway.
    const env = { ...process.env, [API_KEY_ENV]: String(process.env[API_KEY_ENV]), CRAFT_DATA_DIR: join(f.root, "cli-data") };
    const run = (args: string[]) => spawnSync(process.execPath, ["--experimental-strip-types", "core/cli.ts", ...args],
      { cwd: process.cwd(), env, timeout: 240_000, encoding: "utf8", windowsHide: true });
    const init = run(["init", "--mode", "agent", "--runtime", "direct-api", "--provider-protocol", "openai-compatible",
      "--provider-name", "e2e-local", "--base-url", BASE_URL, "--model", MODEL, "--api-key-env", API_KEY_ENV]);
    assert.equal(init.status, 0, `craft init failed: ${init.stderr}`);
    const result = run(["run", "--goal", "What is 17 * 23? Reply with the number only.", "--max-steps", "2"]);
    assert.equal(result.status, 0, `craft run failed: ${result.stderr || result.stdout}`);
    const payload = JSON.parse(result.stdout) as { receipt: { status: string; final_message: string; loop: { verdict: string } } };
    assert.equal(payload.receipt.status, "completed");
    assert.match(payload.receipt.final_message, /391/u);
    assert.equal(payload.receipt.loop.verdict, "model_final_message");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("pilot HTTP surface serves the same intake the UI would call", { skip: !gatewayReachable }, async () => {
  const f = await fixture();
  const server = new LocalWorkbenchServer(f.service, "e2e-token");
  try {
    const { url } = await server.start(0);
    const base = new URL(url).origin;
    const opened = await fetch(`${base}/api/pilot/sessions`, {
      method: "POST", headers: { authorization: "Bearer e2e-token", "content-type": "application/json" },
      body: JSON.stringify({ input: "summarize the 17*23 arithmetic rule" }),
    });
    assert.equal(opened.status, 201);
    const { session } = await opened.json() as { session: { id: string } };
    // The UI submits a deterministic split (`/turns/auto`); a raw `/turns`
    // requires a caller-supplied split array, which is a different contract.
    const turn = await fetch(`${base}/api/pilot/sessions/${encodeURIComponent(session.id)}/turns/auto`, {
      method: "POST", headers: { authorization: "Bearer e2e-token", "content-type": "application/json" },
      body: JSON.stringify({ input: "summarize the 17*23 arithmetic rule", executor: "craft" }),
    });
    assert.equal(turn.status, 201);
    const body = await turn.json() as { status: string; tasks_created: number; review: { verdict: string } };
    assert.equal(body.status, "created");
    assert.ok(body.tasks_created >= 1, `expected tasks from deterministic intake, got ${JSON.stringify(body)}`);
    assert.equal(body.review.verdict, "pass");
  } finally {
    await server.close();
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
});
