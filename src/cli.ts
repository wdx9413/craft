#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { initializeConfig, loadConfig, setMode, type CraftMode, type DirectProvider,
  type InitInput, type RuntimeKind, configureSemanticSearch } from "./config.ts";
import { type EmbeddingProviderConfig } from "./semantic.ts";
import { craftPaths } from "./paths.ts";
import { CraftService } from "./service.ts";
import { CraftStore } from "./store.ts";
import { LocalMaintenanceWorker, MaintenanceKernel } from "./maintenance.ts";
import { runBuiltinAcceptanceTicks } from "./acceptance-worker.ts";
import { LocalWorkbenchServer } from "./workbench-server.ts";
import { LocalSupervisor, SupervisorClient } from "./supervisor.ts";

const HELP = `Craft

Usage:
  craft                         Start onboarding or open the active mode
  craft init [options]          Configure Craft
  craft config show             Print redacted configuration
  craft mode <name>             Switch agent, supervisor, or provider mode
  craft paths                   Print the ~/.craft_data layout
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
    "Agent - Prepare a standalone model runtime (model loop is not included yet)",
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
  if (["source", "capability", "task", "worker", "inbox", "home", "serve", "codex", "claude", "host-run", "supervisor"].includes(args[0] ?? "")) {
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
      else if (args[0] === "serve") {
        const supervisor = new LocalSupervisor(service, paths); await supervisor.start(0); const server = new LocalWorkbenchServer(service);
        try { const started = await server.start(option(args, "--port") === undefined ? 4173 : Number(option(args, "--port"))); stdout.write(`Craft Workbench: ${started.url}\n`); await new Promise<void>((resolve) => { const stop = () => resolve(); process.once("SIGINT", stop); process.once("SIGTERM", stop); }); }
        finally { await server.close(); await supervisor.close(); } return;
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
    ? "Agent mode configuration is ready; this release does not yet include the standalone model loop.\n"
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
