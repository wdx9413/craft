#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { initializeConfig, loadConfig, setMode, type CraftMode, type DirectProvider,
  type InitInput, type RuntimeKind, configureSemanticSearch } from "./config.ts";
import { type EmbeddingProviderConfig } from "./semantic.ts";
import { craftPaths } from "./paths.ts";
import { CraftService } from "./service.ts";
import { CraftStore, type JsonObject } from "./store.ts";
import { LocalMaintenanceWorker, MaintenanceKernel } from "./maintenance.ts";
import { runBuiltinAcceptanceTicks } from "./acceptance-worker.ts";
import { LocalWorkbenchServer } from "./workbench-server.ts";
import { LocalSupervisor, SupervisorClient } from "./supervisor.ts";
import { openBrowser } from "./browser.ts";
import { VERSION } from "./service.ts";
import { credentialStatus, createFetchTransport, providerFromConfig } from "./model-gateway.ts";

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

const HELP = `Craft

Usage:
  craft                         Start onboarding or open the active mode
  craft init [options]          Configure Craft
  craft config show             Print redacted configuration
  craft doctor                  Check runtime, credentials, storage, and adapters
  craft version                 Print the Craft product version
  craft run --goal <text>       Run a governed standalone Agent task
  craft run --project <id> ...  Attach the run to a durable Project Brain
  craft run --resume <dispatch> Resume a crashed/running dispatch with the exact goal
  craft mode <name>             Switch agent, supervisor, or provider mode
  craft paths                   Print the ~/.craft_data layout
  craft settings show           Show redacted GUI settings
  craft settings reset          Reset GUI settings without deleting data
  craft usage                   Show daily/weekly/monthly/yearly token usage
  craft source add <path>       Add and scan a capability directory
  craft source list             List capability directories
  craft source scan [id]        Incrementally scan sources
  craft capability search <q>   Search indexed capabilities
  craft semantic configure ...  Configure optional OpenAI-compatible embeddings
  craft semantic disable         Disable semantic retrieval and use keywords only
  craft semantic status          Show semantic retrieval health
  craft task list               List durable tasks
  craft codex prepare ...       Prepare a digest-bound Codex CLI dispatch
  craft codex execute ...       Execute a prepared Codex CLI dispatch
  craft claude prepare ...      Prepare a bounded Claude Code dispatch
  craft claude execute ...      Execute a prepared Claude Code dispatch
  craft host-run get <id>       Inspect a background Host run
  craft host-run cancel <id>    Cancel a live Host run
  craft host-run start ...      Start through the local Supervisor
  craft host-run recover --owner <id> --confirmed
                                Mark confirmed orphaned runs interrupted
  craft supervisor run [--port 0]
                                Run the authenticated local Supervisor
  craft supervisor status       Check the local Supervisor
  craft home                    Show the unified Workbench Home projection
  craft serve [--port 4173]     Start the local-only Workbench web app
  craft gui [--port 4173]       Alias for serve; open the local Workbench
  craft inbox refresh           Refresh the unified attention inbox
  craft inbox list [options]    List prioritized attention cards
  craft inbox ack <id>          Acknowledge a card without resolving its source
  craft inbox defer <id> ...    Hide a card until --until <ISO time>
  craft worker tick             Run one safe local maintenance cycle
  craft worker run [options]    Run the persistent local maintenance worker
  craft worker status           Read the last local worker heartbeat

Init options:
  --mode <agent|supervisor|provider>
  --runtime <direct-api|codex-cli|claude-code|unconfigured>
  --provider-protocol <openai-compatible|anthropic>
  --provider-name <name> --base-url <url> --model <model>
  --api-key-env <ENV_NAME>
  --hosts <codex-cli,claude-code,generic-mcp>

Semantic options:
  --provider-name <name> --base-url <url> --model <model>
  --api-key-env <ENV_NAME> [--timeout-ms <100-30000>]

  Worker options:
  --interval-ms <100-3600000>

Run options:
  --goal <text> --tier <small|standard|frontier> [--max-steps <n>]
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function promptChoice(question: string, choices: string[]): Promise<number> {
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(`${question}\n${choices.map((item, i) => `  ${i + 1}. ${item}`).join("\n")}\n`);
    const answer = Number.parseInt(await terminal.question("> "), 10);
    if (!Number.isInteger(answer) || answer < 1 || answer > choices.length) {
      throw new Error("Invalid selection.");
    }
    return answer - 1;
  } finally {
    terminal.close();
  }
}

async function interactiveInit(): Promise<InitInput> {
  const modes: CraftMode[] = ["agent", "supervisor", "provider"];
  const mode = modes[await promptChoice("How do you want to use Craft?", [
    "Agent - Run a governed standalone model runtime",
    "Supervisor - Configure execution hosts (automatic host drivers are not included yet)",
    "Provider - Craft supplies capabilities to another Agent",
  ])];
  if (mode === "provider") return { mode };
  if (mode === "supervisor") {
    const selected = await promptChoice("Choose the first execution host:", [
      "Codex CLI", "Claude Code", "Generic MCP host", "Configure later",
    ]);
    const hosts: InitInput["supervisorHosts"] = selected === 3 ? []
      : [["codex-cli", "claude-code", "generic-mcp"][selected] as "codex-cli"];
    return { mode, supervisorHosts: hosts };
  }
  const kinds: RuntimeKind[] = ["direct-api", "codex-cli", "claude-code", "unconfigured"];
  const runtimeKind = kinds[await promptChoice("How should Craft Agent run models?", [
    "Direct model API", "Use Codex CLI", "Use Claude Code", "Configure later",
  ])];
  if (runtimeKind !== "direct-api") return { mode, runtimeKind };
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const protocolAnswer = await terminal.question("Protocol (openai-compatible/anthropic): ");
    const protocol = protocolAnswer.trim() as DirectProvider["protocol"];
    if (!["openai-compatible", "anthropic"].includes(protocol)) {
      throw new Error("Unsupported provider protocol.");
    }
    const provider = {
      protocol,
      name: (await terminal.question("Provider name: ")).trim(),
      baseUrl: (await terminal.question("Base URL: ")).trim(),
      model: (await terminal.question("Model: ")).trim(),
      apiKeyEnv: (await terminal.question("API key environment variable (optional): ")).trim() || undefined,
    };
    return { mode, runtimeKind, provider };
  } finally {
    terminal.close();
  }
}

function nonInteractiveInit(args: string[]): InitInput {
  const mode = option(args, "--mode") as CraftMode | undefined;
  if (!mode) throw new Error("Non-interactive init requires --mode.");
  const runtimeKind = option(args, "--runtime") as RuntimeKind | undefined;
  const hosts = option(args, "--hosts")?.split(",").filter(Boolean) as InitInput["supervisorHosts"];
  let provider: DirectProvider | undefined;
  if (runtimeKind === "direct-api") {
    provider = {
      protocol: option(args, "--provider-protocol") as DirectProvider["protocol"],
      name: option(args, "--provider-name") || "",
      baseUrl: option(args, "--base-url") || "",
      model: option(args, "--model") || "",
      apiKeyEnv: option(args, "--api-key-env"),
    };
  }
  return { mode, runtimeKind, provider, supervisorHosts: hosts };
}

function embeddingProvider(args: string[]): EmbeddingProviderConfig {
  const timeout = option(args, "--timeout-ms");
  return { protocol: "openai-compatible", name: option(args, "--provider-name") || "", baseUrl: option(args, "--base-url") || "",
    model: option(args, "--model") || "", apiKeyEnv: option(args, "--api-key-env"),
    ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }) };
}

function publicConfig(config: Awaited<ReturnType<typeof loadConfig>>): unknown {
  if (!config) return null;
  const semanticSearch = config.semanticSearch ? { provider: { ...config.semanticSearch.provider,
    apiKeyConfiguredBy: config.semanticSearch.provider.apiKeyEnv || null } } : undefined;
  return {
    ...config,
    runtime: config.runtime.provider
      ? { ...config.runtime, provider: { ...config.runtime.provider, apiKeyConfiguredBy: config.runtime.provider.apiKeyEnv || null } }
      : config.runtime,
    ...(semanticSearch ? { semanticSearch } : {}),
  };
}

async function doctor(paths: ReturnType<typeof craftPaths>): Promise<JsonObject> {
  const config = await loadConfig(paths);
  const result: JsonObject = {
    version: VERSION,
    node: process.versions.node,
    node_supported: Number(process.versions.node.split(".")[0]) >= 23,
    initialized: Boolean(config),
    data_root: paths.root,
  };
  if (!config) return { ...result, status: "needs_init", next: "craft init --mode agent --runtime direct-api ..." };
  const runtime = config.runtime;
  const provider = runtime.provider ? providerFromConfig(runtime.provider) : null;
  return { ...result, runtime: runtime.kind, provider: provider ? { ...credentialStatus(provider), model: runtime.provider?.model } : null,
    storage: { database: paths.databaseFile, exists: await fileExists(paths.databaseFile) },
    status: runtime.kind === "direct-api" && provider && credentialStatus(provider).configured ? "ready" : "needs_configuration",
    next: runtime.kind === "direct-api" ? "craft run --goal \"...\"" : "craft init --mode agent --runtime direct-api ..." };
}

async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

async function runStandalone(args: string[], paths: ReturnType<typeof craftPaths>): Promise<JsonObject> {
  const config = await loadConfig(paths);
  if (!config) throw new Error("Craft is not initialized; run `craft init --mode agent --runtime direct-api ...` first.");
  if (config.runtime.kind !== "direct-api" || !config.runtime.provider) throw new Error("`craft run` currently requires a direct-api runtime; configure it with `craft init`.");
  const resumeId = option(args, "--resume");
  const goal = option(args, "--goal");
  const projectId = option(args, "--project") ?? "local";
  if (!resumeId && !goal?.trim()) throw new Error("run requires --goal <text> or --resume <dispatch_id> with --goal");
  const provider = providerFromConfig(config.runtime.provider);
  const store = await new CraftStore(paths).open();
  const service = new CraftService(store, undefined, undefined, undefined, undefined, undefined, [], [provider], createFetchTransport());
  try {
    const existingDispatch = resumeId ? store.get("internal_dispatch", resumeId) : null;
    const existingTask = existingDispatch ? store.get("task", String(existingDispatch.task_id)) : null;
    const effectiveProjectId = existingTask?.project_id === null || existingTask?.project_id === undefined ? projectId : String(existingTask.project_id);
    service.projectBrainOpen({ project_id: effectiveProjectId, name: effectiveProjectId });
    const task = existingDispatch
      ? existingTask as JsonObject
      : service.taskOpen({ title: option(args, "--title") ?? goal!.slice(0, 80), goal, project_id: effectiveProjectId }).task as JsonObject;
    if (!existingDispatch) service.projectBrainGoalSave({ project_id: effectiveProjectId, title: task.title, metric: "acceptance" });
    const existingSessionId = existingDispatch?.session_id === undefined || existingDispatch.session_id === null ? null : String(existingDispatch.session_id);
    const session = existingSessionId
      ? service.workSessionGet({ session_id: existingSessionId }).session as JsonObject
      : service.workSessionPrepare({ project_id: effectiveProjectId, task_id: task.id, goal: task.goal, model: provider.provider, host: "internal", selection_rationale: ["default internal runtime", "bounded read-only Craft tool surface"] }).session as JsonObject;
    const driver = service.hostDriver("internal");
    if (!driver) throw new Error("Internal Host Driver is unavailable");
    const prompt = goal ?? String(task.goal);
    const prepared = existingDispatch ? { dispatch: existingDispatch } : driver.prepare({ task_id: task.id, prompt, provider: provider.provider, session_id: session.id, context_digest: session.context_digest, tier: option(args, "--tier") ?? "standard",
      ...(option(args, "--max-steps") ? { limits: { max_steps: Number(option(args, "--max-steps")) } } : {}) }) as JsonObject;
    const dispatch = prepared.dispatch as JsonObject;
    service.workSessionBindDispatch({ session_id: session.id, dispatch_id: dispatch.id });
    const context = service.contextManifestSave({ manifest_id: `context-${dispatch.id}`, project_id: effectiveProjectId, task_id: task.id, model: config.runtime.provider.model, host: "internal", acceptance_ref: `acceptance:${task.id}`, knowledge_refs: [], capability_refs: [], workflow_refs: [], excluded_refs: [], selection_rationale: ["standalone runtime context"] }).manifest as JsonObject;
    const verified = service.verifiedWorkPrepare({ work_id: `verified-${dispatch.id}`, task_id: task.id, context_manifest_id: context.id, host: "internal", model: config.runtime.provider.model, effect: "read_only", workspace_digest: digest(paths.root), action_digest: digest({ prompt, dispatch_id: dispatch.id }), acceptance_ref: `acceptance:${task.id}` });
    service.verifiedWorkAuthorize({ work_id: (verified.work as JsonObject).id, authorization_ref: "local-read" });
    const executed = await driver.execute({ dispatch_id: dispatch.id, prompt, ...(existingDispatch ? { resume: true } : {}) });
    const receipt = executed.receipt as JsonObject;
    const hostStatus = receipt.status === "completed" ? "completed" : "failed";
    const evidence = service.evidenceRecord({ evidence_id: `standalone-evidence-${dispatch.id}`, source_type: "program", confidence: hostStatus === "completed" ? "bounded" : "confirmed", claim: `Internal Host returned ${hostStatus}; independent acceptance is still required.`, locator: `internal-dispatch:${dispatch.id}` });
    const artifact = service.artifactRegister({ artifact_id: `standalone-artifact-${dispatch.id}`, kind: "host_receipt", name: `Internal Host receipt ${dispatch.id}`, uri: String(receipt.uri ?? `craft://internal/${dispatch.id}`), digest: receipt.digest ?? null, producer_type: "internal_host", producer_id: dispatch.id });
    service.verifiedWorkAction({ work_id: (verified.work as JsonObject).id, action_contract: { operation: "model_loop", dispatch_id: dispatch.id }, idempotency_key: "host-receipt", input_digest: digest(prompt), result_digest: digest(receipt) });
    service.verifiedWorkReobserve({ work_id: (verified.work as JsonObject).id, observed_digest: digest(paths.root), expected_digest: digest(paths.root) });
    const gate = service.acceptanceGatePrepare({ gate_id: `standalone-gate-${dispatch.id}`, task_id: task.id, work_id: (verified.work as JsonObject).id, acceptance_ref: `acceptance:${task.id}`, required_artifact_ids: [artifact.id], required_evidence_ids: [evidence.id] });
    const completedSession = service.workSessionComplete({ session_id: session.id, status: hostStatus === "completed" ? "needs_review" : "failed", summary: hostStatus === "completed" ? "Host finished; independent acceptance is pending." : String(receipt.failure ?? "Host failed") });
    return { version: VERSION, project_id: effectiveProjectId, session: completedSession.session, task, ...executed, acceptance: gate, outcome: null } as JsonObject;
  } finally { store.close(); }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const paths = craftPaths();
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(HELP);
    return;
  }
  if (args[0] === "paths") {
    stdout.write(`${JSON.stringify(paths, null, 2)}\n`);
    return;
  }
  if (args[0] === "version") {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (args[0] === "doctor") {
    stdout.write(`${JSON.stringify(await doctor(paths), null, 2)}\n`);
    return;
  }
  if (args[0] === "run") {
    stdout.write(`${JSON.stringify(await runStandalone(args.slice(1), paths), null, 2)}\n`);
    return;
  }
  if (args[0] === "config" && args[1] === "show") {
    stdout.write(`${JSON.stringify(publicConfig(await loadConfig(paths)), null, 2)}\n`);
    return;
  }
  if (args[0] === "mode") {
    if (!args[1]) throw new Error("mode requires agent, supervisor, or provider.");
    stdout.write(`${JSON.stringify(await setMode(args[1] as CraftMode, paths), null, 2)}\n`);
    return;
  }
  if (args[0] === "semantic") {
    if (args[1] === "configure") {
      stdout.write(`${JSON.stringify(publicConfig(await configureSemanticSearch({ provider: embeddingProvider(args.slice(2)) }, paths)), null, 2)}\n`);
      return;
    }
    if (args[1] === "disable") {
      stdout.write(`${JSON.stringify(publicConfig(await configureSemanticSearch(undefined, paths)), null, 2)}\n`);
      return;
    }
    if (args[1] === "status") {
      const store = await new CraftStore(paths).open();
      try { stdout.write(`${JSON.stringify((await CraftService.open(store)).semanticSearchStatus(), null, 2)}\n`); }
      finally { store.close(); }
      return;
    }
    throw new Error("semantic requires configure, disable, or status.");
  }
  if (["source", "capability", "task", "worker", "inbox", "home", "serve", "gui", "usage", "settings", "codex", "claude", "host-run", "supervisor"].includes(args[0] ?? "")) {
    const store = await new CraftStore(paths).open();
    const service = await CraftService.open(store);
    try {
      let result: unknown;
      if (args[0] === "source" && args[1] === "add") result = await service.sourceAdd({ path: args[2] });
      else if (args[0] === "source" && args[1] === "list") result = service.sourceList();
      else if (args[0] === "source" && args[1] === "scan") result = await service.sourceScan({ source_id: args[2] });
      else if (args[0] === "capability" && args[1] === "search") result = await service.capabilitySearch({ query: args.slice(2).join(" ") });
      else if (args[0] === "task" && args[1] === "list") result = service.taskList({});
      else if (args[0] === "codex" && args[1] === "prepare") result = service.codexDispatchPrepare({ task_id: option(args, "--task"), workspace: option(args, "--workspace"), prompt: option(args, "--prompt"), dispatch_id: option(args, "--id"), sandbox: option(args, "--sandbox"), model: option(args, "--model"), timeout_ms: option(args, "--timeout-ms"), output_limit: option(args, "--output-limit") });
      else if (args[0] === "codex" && args[1] === "execute") result = await service.codexDispatchExecute({ dispatch_id: option(args, "--id"), prompt: option(args, "--prompt"), authorization_request_id: option(args, "--authorization"), notification_ref: option(args, "--notification-ref") });
      else if (args[0] === "claude" && args[1] === "prepare") result = service.claudeDispatchPrepare({ task_id: option(args, "--task"), workspace: option(args, "--workspace"), prompt: option(args, "--prompt"), dispatch_id: option(args, "--id"), sandbox: option(args, "--sandbox"), model: option(args, "--model"), max_turns: option(args, "--max-turns"), max_budget_usd: option(args, "--max-budget-usd"), timeout_ms: option(args, "--timeout-ms"), output_limit: option(args, "--output-limit") });
      else if (args[0] === "claude" && args[1] === "execute") result = await service.claudeDispatchExecute({ dispatch_id: option(args, "--id"), prompt: option(args, "--prompt"), authorization_request_id: option(args, "--authorization"), notification_ref: option(args, "--notification-ref") });
      else if (args[0] === "host-run" && args[1] === "start") result = await new SupervisorClient(paths).call("POST", "/runs/start", { host: option(args, "--host"), dispatch_id: option(args, "--dispatch"), prompt: option(args, "--prompt"), run_id: option(args, "--id"), authorization_request_id: option(args, "--authorization"), notification_ref: option(args, "--notification-ref") });
      else if (args[0] === "host-run" && args[1] === "get") result = await new SupervisorClient(paths).call("GET", `/runs/${encodeURIComponent(String(args[2] ?? ""))}`);
      else if (args[0] === "host-run" && args[1] === "cancel") result = await new SupervisorClient(paths).call("POST", `/runs/${encodeURIComponent(String(args[2] ?? ""))}/cancel`, { reason: option(args, "--reason") ?? "user_requested" });
      else if (args[0] === "host-run" && args[1] === "recover") result = service.hostRunRecover({ owner_id: option(args, "--owner"), confirmed_original_runner_stopped: args.includes("--confirmed") });
      else if (args[0] === "home" && args.length === 1) result = service.homeView({ limit: option(args, "--limit") });
      else if (args[0] === "supervisor" && args[1] === "status") result = await new SupervisorClient(paths).status();
      else if (args[0] === "supervisor" && args[1] === "run") {
        const supervisor = new LocalSupervisor(service, paths); const started = await supervisor.start(option(args, "--port") === undefined ? 0 : Number(option(args, "--port")));
        stdout.write(`Craft Supervisor: ${String(started.url)}\n`); await new Promise<void>((resolve) => { const stop = () => resolve(); process.once("SIGINT", stop); process.once("SIGTERM", stop); }); await supervisor.close(); return;
      }
      else if (args[0] === "usage") result = service.usageReport({ from: option(args, "--from"), to: option(args, "--to") });
      else if (args[0] === "settings" && args[1] === "show") result = service.settingsGet();
      else if (args[0] === "settings" && args[1] === "reset") result = service.settingsReset();
      else if (args[0] === "settings" && args[1] === "update") result = service.settingsUpdate(JSON.parse(option(args, "--json") ?? "{}") as JsonObject);
      else if (args[0] === "serve" || args[0] === "gui") {
        const supervisor = new LocalSupervisor(service, paths); const supervisorRun = await supervisor.startOrReuse(0); const server = new LocalWorkbenchServer(service);
        try { const started = await server.start(option(args, "--port") === undefined ? 4173 : Number(option(args, "--port"))); stdout.write(`Craft Workbench: ${started.url}\n`); if (args[0] === "gui") openBrowser(started.url); await new Promise<void>((resolve) => { const stop = () => resolve(); process.once("SIGINT", stop); process.once("SIGTERM", stop); }); }
        finally { await server.close(); if (supervisorRun.owned) await supervisor.close(); } return;
      }
      else if (args[0] === "inbox" && args[1] === "refresh") result = service.attentionRefresh({ limit: option(args, "--limit") });
      else if (args[0] === "inbox" && args[1] === "list") result = service.attentionList({ audience: option(args, "--audience"), limit: option(args, "--limit") });
      else if (args[0] === "inbox" && args[1] === "ack") result = service.attentionDecide({ item_id: args[2], decision: "acknowledge", decided_by: option(args, "--by") ?? "local-user", reason: option(args, "--reason") });
      else if (args[0] === "inbox" && args[1] === "defer") result = service.attentionDecide({ item_id: args[2], decision: "defer", decided_by: option(args, "--by") ?? "local-user", deferred_until: option(args, "--until"), reason: option(args, "--reason") });
      else if (args[0] === "worker") {
        const runFileAcceptance = () => runBuiltinAcceptanceTicks(service); const worker = new LocalMaintenanceWorker(new MaintenanceKernel(service), paths, { afterTick: runFileAcceptance });
        if (args[1] === "tick") result = { maintenance: new MaintenanceKernel(service).tick(), acceptance: await runFileAcceptance() };
        else if (args[1] === "status") result = await worker.status();
        else if (args[1] === "run") {
          const controller = new AbortController(); const stop = () => controller.abort(); process.once("SIGINT", stop); process.once("SIGTERM", stop);
          try { result = await worker.run({ intervalMs: option(args, "--interval-ms") === undefined ? undefined : Number(option(args, "--interval-ms")), signal: controller.signal }); }
          finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
        } else throw new Error("worker requires tick, run, or status.");
      }
      else throw new Error(`Unknown command: ${args.join(" ")}`);
      stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally { store.close(); }
    return;
  }
  if (args[0] === "init") {
    const input = args.length === 1 ? await interactiveInit() : nonInteractiveInit(args.slice(1));
    stdout.write(`${JSON.stringify(await initializeConfig(input, paths), null, 2)}\n`);
    return;
  }
  if (args.length > 0) throw new Error(`Unknown command: ${args[0]}`);
  const config = await loadConfig(paths);
  if (!config) {
    stdout.write("Craft is not initialized. Let's configure it first.\n");
    stdout.write(`${JSON.stringify(await initializeConfig(await interactiveInit(), paths), null, 2)}\n`);
    return;
  }
  stdout.write(`Craft mode: ${config.activeMode}\n`);
  stdout.write(config.activeMode === "agent"
    ? "Agent mode is ready; run `craft run --goal \"...\"` to start the governed model loop.\n"
    : config.activeMode === "supervisor"
      ? `Configured hosts: ${config.supervisor.hosts.join(", ") || "none"}\n`
      : "Provider mode is configured; connect through the Craft plugin or MCP server.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`craft: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
