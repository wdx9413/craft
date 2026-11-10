import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { detectWorkbenchClis } from "./workbench-cli-detection.ts";
import { detectDshProvider } from "../dsh-executable.ts";
import { loadSettingsSync } from "../settings.ts";

export type ToolInstallProvider = "codex" | "claude" | "dsh";
export type ToolInstallState = "running" | "succeeded" | "failed" | "cancelled";

type ToolInstallEntry = {
  id: ToolInstallProvider;
  label: string;
  package: string;
  scripts: string[];
  docs: string;
};

export const TOOL_INSTALL_CATALOG: Readonly<Record<ToolInstallProvider, ToolInstallEntry>> = {
  codex: { id: "codex", label: "Codex CLI", package: "@openai/codex", scripts: ["@openai/codex"], docs: "https://developers.openai.com/codex/cli/" },
  claude: { id: "claude", label: "Claude Code", package: "@anthropic-ai/claude-code", scripts: ["@anthropic-ai/claude-code"], docs: "https://code.claude.com/docs/en/setup" },
  dsh: { id: "dsh", label: "DSH", package: "@deepseek-ai/dsh",
    scripts: ["@deepseek-ai/dsh", "@deepseek-ai/dsh-subprocess-local", "koffi", "node-pty", "@google/genai", "protobufjs"],
    docs: "https://github.com/deepseek-ai/deepseek-harness" },
};

export type ToolInstallJob = {
  id: string;
  provider: ToolInstallProvider;
  label: string;
  state: ToolInstallState;
  stage: "preflight" | "install" | "verify" | "writeback" | "done";
  command: string;
  output: string;
  exit_code: number | null;
  detected_executable: string | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};

type RunResult = { code: number | null };
type Runner = (command: string, args: string[], onOutput: (chunk: string) => void) => Promise<RunResult>;
type DetectResult = { available: boolean; executable: string | null };
type Detect = (provider: ToolInstallProvider) => Promise<DetectResult>;

const OUTPUT_LIMIT = 64 * 1024;
const MAX_JOBS = 20;

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}

/** npm shims are .cmd on Windows; never use a shell string, only argv. */
export function installCommand(provider: ToolInstallProvider): { command: string; args: string[]; label: string } {
  const entry = TOOL_INSTALL_CATALOG[provider];
  if (!entry) throw new Error("该工具没有可自动执行的安装命令");
  const args = ["install", "-g", `--allow-scripts=${entry.scripts.join(",")}`, entry.package];
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", args, label: `npm ${args.join(" ")}` };
}

function defaultRunner(command: string, args: string[], onOutput: (chunk: string) => void): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    // npm installs a .cmd shim on Windows; cmd.exe is the only reliable way to
    // launch it without a shell string. Every argv element is fixed by the
    // catalog, never user input.
    const shim = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(command);
    const child = spawn(shim ? (process.env.ComSpec ?? "cmd.exe") : command, shim ? ["/d", "/s", "/c", command, ...args] : args,
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
    child.stdout?.on("data", (chunk: Buffer) => onOutput(chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => onOutput(chunk.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code }));
  });
}

async function defaultDetect(provider: ToolInstallProvider): Promise<DetectResult> {
  if (provider === "dsh") {
    const status = await detectDshProvider(loadSettingsSync());
    return { available: status.status === "available", executable: status.executable };
  }
  const detected = await detectWorkbenchClis();
  const entry = detected.providers.find((item) => item.id === provider);
  return { available: entry?.status === "available", executable: entry?.status === "available" ? (entry as { executable?: string | null }).executable ?? null : null };
}

/**
 * One allow-listed installer for the three local CLI hosts.
 *
 * The job owns only a child process and its bounded output. Verification is a
 * separate stage so a successful `npm` exit code is never presented as proof
 * that the CLI is runnable.
 */
export class ToolInstallManager {
  #jobs = new Map<string, ToolInstallJob>();
  #running = new Map<string, { provider: ToolInstallProvider; child: null }>();
  #runner: Runner;
  #detect: Detect;
  #now: () => string;

  constructor(options: { run?: Runner; detect?: Detect; now?: () => string } = {}) {
    this.#runner = options.run ?? defaultRunner;
    this.#detect = options.detect ?? defaultDetect;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  list(): { providers: Array<ToolInstallEntry & { command: string }>; jobs: ToolInstallJob[] } {
    return {
      providers: (Object.keys(TOOL_INSTALL_CATALOG) as ToolInstallProvider[]).map((id) => ({
        ...TOOL_INSTALL_CATALOG[id],
        command: installCommand(id).label,
      })),
      jobs: [...this.#jobs.values()].sort((left, right) => right.started_at.localeCompare(left.started_at)),
    };
  }

  get(id: string): ToolInstallJob | null {
    return this.#jobs.get(id) ?? null;
  }

  start(provider: string): ToolInstallJob {
    if (!Object.hasOwn(TOOL_INSTALL_CATALOG, provider)) throw new Error("该工具没有可自动执行的安装命令");
    const key = provider as ToolInstallProvider;
    if (this.#running.size > 0) throw new Error("已有安装任务在进行中，请等待完成或取消");
    const command = installCommand(key);
    const job: ToolInstallJob = {
      id: `install_${randomUUID().replaceAll("-", "")}`,
      provider: key,
      label: TOOL_INSTALL_CATALOG[key].label,
      state: "running",
      stage: "preflight",
      command: command.label,
      output: "",
      exit_code: null,
      detected_executable: null,
      error: null,
      started_at: this.#now(),
      finished_at: null,
    };
    this.#jobs.set(job.id, job);
    this.#running.set(job.id, { provider: key, child: null });
    this.#trim();
    void this.#run(job, command);
    return job;
  }

  cancel(id: string): ToolInstallJob {
    const job = this.#jobs.get(id);
    if (!job) throw new Error("安装任务不存在");
    if (job.state !== "running") return job;
    job.state = "cancelled";
    job.stage = "done";
    job.error = "安装已取消";
    job.finished_at = this.#now();
    this.#running.delete(id);
    return job;
  }

  async #run(job: ToolInstallJob, command: { command: string; args: string[]; label: string }): Promise<void> {
    const onOutput = (chunk: string) => { job.output = appendTail(job.output, chunk); };
    try {
      job.stage = "install";
      onOutput(`$ ${command.label}\n`);
      let installed = await this.#runner(command.command, command.args, onOutput);
      // npm < 11.6 has no --allow-scripts. Retry the plain global install so an
      // otherwise valid machine is not blocked by the policy flag alone.
      if (installed.code !== 0 && /unknown (?:option|argument)/iu.test(job.output)) {
        onOutput("\n[兼容] 当前 npm 不支持 --allow-scripts，改用普通全局安装…\n");
        installed = await this.#runner(command.command, ["install", "-g", TOOL_INSTALL_CATALOG[job.provider].package], onOutput);
      }
      job.exit_code = installed.code;
      if ((job.state as string) === "cancelled") return;
      if (installed.code !== 0) {
        job.state = "failed";
        job.stage = "done";
        job.error = `安装命令退出码 ${String(installed.code)}`;
        return;
      }
      job.stage = "verify";
      const detected = await this.#detect(job.provider);
      if ((job.state as string) === "cancelled") return;
      job.detected_executable = detected.executable;
      if (!detected.available) {
        job.state = "failed";
        job.stage = "done";
        job.error = "安装命令已成功，但未检测到可运行的工具；请检查 PATH 或手动填写可执行文件路径";
        return;
      }
      job.state = "succeeded";
      job.stage = "writeback";
      onOutput(`\n[已验证] ${TOOL_INSTALL_CATALOG[job.provider].label} 可用${detected.executable ? `：${detected.executable}` : ""}\n`);
    } catch (error) {
      if (job.state === "cancelled") return;
      job.state = "failed";
      job.stage = "done";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (job.state === "succeeded") job.stage = "done";
      job.finished_at = this.#now();
      this.#running.delete(job.id);
    }
  }

  #trim(): void {
    while (this.#jobs.size > MAX_JOBS) {
      const oldest = [...this.#jobs.values()].filter((job) => job.state !== "running").sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
      if (!oldest) return;
      this.#jobs.delete(oldest.id);
    }
  }
}
