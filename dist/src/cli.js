#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import { initializeConfig, loadConfig, setMode, configureSemanticSearch } from "./config.js";
import {} from "./semantic.js";
import { craftPaths } from "./paths.js";
import { CraftService } from "./service.js";
import { CraftStore } from "./store.js";
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
`;
function option(args, name) {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
}
async function promptChoice(question, choices) {
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
        stdout.write(`${question}\n${choices.map((item, i) => `  ${i + 1}. ${item}`).join("\n")}\n`);
        const answer = Number.parseInt(await terminal.question("> "), 10);
        if (!Number.isInteger(answer) || answer < 1 || answer > choices.length) {
            throw new Error("Invalid selection.");
        }
        return answer - 1;
    }
    finally {
        terminal.close();
    }
}
async function interactiveInit() {
    const modes = ["agent", "supervisor", "provider"];
    const mode = modes[await promptChoice("How do you want to use Craft?", [
        "Agent - Prepare a standalone model runtime (model loop is not included yet)",
        "Supervisor - Configure execution hosts (automatic host drivers are not included yet)",
        "Provider - Craft supplies capabilities to another Agent",
    ])];
    if (mode === "provider")
        return { mode };
    if (mode === "supervisor") {
        const selected = await promptChoice("Choose the first execution host:", [
            "Codex CLI", "Claude Code", "Generic MCP host", "Configure later",
        ]);
        const hosts = selected === 3 ? []
            : [["codex-cli", "claude-code", "generic-mcp"][selected]];
        return { mode, supervisorHosts: hosts };
    }
    const kinds = ["direct-api", "codex-cli", "claude-code", "unconfigured"];
    const runtimeKind = kinds[await promptChoice("How should Craft Agent run models?", [
        "Direct model API", "Use Codex CLI", "Use Claude Code", "Configure later",
    ])];
    if (runtimeKind !== "direct-api")
        return { mode, runtimeKind };
    const terminal = createInterface({ input: stdin, output: stdout });
    try {
        const protocolAnswer = await terminal.question("Protocol (openai-compatible/anthropic): ");
        const protocol = protocolAnswer.trim();
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
    }
    finally {
        terminal.close();
    }
}
function nonInteractiveInit(args) {
    const mode = option(args, "--mode");
    if (!mode)
        throw new Error("Non-interactive init requires --mode.");
    const runtimeKind = option(args, "--runtime");
    const hosts = option(args, "--hosts")?.split(",").filter(Boolean);
    let provider;
    if (runtimeKind === "direct-api") {
        provider = {
            protocol: option(args, "--provider-protocol"),
            name: option(args, "--provider-name") || "",
            baseUrl: option(args, "--base-url") || "",
            model: option(args, "--model") || "",
            apiKeyEnv: option(args, "--api-key-env"),
        };
    }
    return { mode, runtimeKind, provider, supervisorHosts: hosts };
}
function embeddingProvider(args) {
    const timeout = option(args, "--timeout-ms");
    return { protocol: "openai-compatible", name: option(args, "--provider-name") || "", baseUrl: option(args, "--base-url") || "",
        model: option(args, "--model") || "", apiKeyEnv: option(args, "--api-key-env"),
        ...(timeout === undefined ? {} : { timeoutMs: Number(timeout) }) };
}
function publicConfig(config) {
    if (!config)
        return null;
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
export async function main(args = process.argv.slice(2)) {
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
        if (!args[1])
            throw new Error("mode requires agent, supervisor, or provider.");
        stdout.write(`${JSON.stringify(await setMode(args[1], paths), null, 2)}\n`);
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
            try {
                stdout.write(`${JSON.stringify((await CraftService.open(store)).semanticSearchStatus(), null, 2)}\n`);
            }
            finally {
                store.close();
            }
            return;
        }
        throw new Error("semantic requires configure, disable, or status.");
    }
    if (["source", "capability", "task"].includes(args[0] ?? "")) {
        const store = await new CraftStore(paths).open();
        const service = await CraftService.open(store);
        try {
            let result;
            if (args[0] === "source" && args[1] === "add")
                result = await service.sourceAdd({ path: args[2] });
            else if (args[0] === "source" && args[1] === "list")
                result = service.sourceList();
            else if (args[0] === "source" && args[1] === "scan")
                result = await service.sourceScan({ source_id: args[2] });
            else if (args[0] === "capability" && args[1] === "search")
                result = await service.capabilitySearch({ query: args.slice(2).join(" ") });
            else if (args[0] === "task" && args[1] === "list")
                result = service.taskList({});
            else
                throw new Error(`Unknown command: ${args.join(" ")}`);
            stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        }
        finally {
            store.close();
        }
        return;
    }
    if (args[0] === "init") {
        const input = args.length === 1 ? await interactiveInit() : nonInteractiveInit(args.slice(1));
        stdout.write(`${JSON.stringify(await initializeConfig(input, paths), null, 2)}\n`);
        return;
    }
    if (args.length > 0)
        throw new Error(`Unknown command: ${args[0]}`);
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
    main().catch((error) => {
        process.stderr.write(`craft: ${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
//# sourceMappingURL=cli.js.map