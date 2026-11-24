import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { craftPaths, dataRoot } from "./infrastructure/paths.ts";
import { CRAFT_RELEASE_VERSION } from "./version.ts";

export const LEARNING_WORKER_LAUNCH_AGENT_LABEL = "com.craft.learning-worker";
const COMPONENTS = "experience,knowledge,memory,notes";

export interface LaunchAgentDependencies {
  platform?: NodeJS.Platform;
  home_dir?: string;
  uid?: number;
  exec_path?: string;
  env?: NodeJS.ProcessEnv;
  worker_entrypoint?: string;
  worker_revision?: string;
  exists?: (path: string) => boolean;
  launchctl?: (args: string[]) => string;
  read_file?: (path: string) => string;
  write_file?: (path: string, contents: string, options: { flag: string; mode: number }) => void;
  mkdir?: (path: string) => void;
  chmod?: (path: string, mode: number) => void;
  unlink?: (path: string) => void;
  rename?: (oldPath: string, newPath: string) => void;
}

function paths(deps: LaunchAgentDependencies) {
  const home = deps.home_dir ?? homedir();
  const uid = deps.uid ?? userInfo().uid;
  const label = LEARNING_WORKER_LAUNCH_AGENT_LABEL;
  return { home, uid, domain: `gui/${uid}`, target: `gui/${uid}/${label}`,
    directory: join(home, "Library", "LaunchAgents"), plist: join(home, "Library", "LaunchAgents", `${label}.plist`) };
}

function workerEntrypoint(deps: LaunchAgentDependencies): string {
  if (deps.worker_entrypoint) return resolve(deps.worker_entrypoint);
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const packaged = resolve(moduleDirectory, "../plugin/craft-experience-learning-worker.js");
  const source = resolve(moduleDirectory, "../deploy/experience-learning/worker.ts");
  const exists = deps.exists ?? existsSync;
  if (exists(packaged)) return packaged;
  if (exists(source)) return source;
  throw new Error("learning_worker_launch_agent_worker_unavailable");
}

function workerMcpArgs(worker: string, exists: (path: string) => boolean): string[] {
  const packagedServer = join(dirname(worker), "craft-mcp.cjs");
  if (exists(packagedServer)) return [packagedServer, "--surface", "component-context-complete"];
  const sourceServer = resolve(dirname(worker), "../../bin/craft-mcp.ts");
  if (exists(sourceServer)) return ["--experimental-strip-types", sourceServer, "--surface", "component-context-complete"];
  throw new Error("learning_worker_launch_agent_mcp_server_unavailable");
}

function renderInstalledWorker(worker: string, deps: LaunchAgentDependencies): string {
  const execPath = deps.exec_path ?? process.execPath;
  return renderLearningWorkerLaunchAgent({ exec_path: execPath, worker_entrypoint: worker,
    data_root: craftPaths(dataRoot(deps.env ?? process.env)).root, worker_revision: workerRevision(deps, worker), environment: {
      ...launchEnvironment(deps.env ?? process.env), CRAFT_EXPERIENCE_MCP_COMMAND: execPath,
      CRAFT_EXPERIENCE_MCP_ARGS: JSON.stringify(workerMcpArgs(worker, deps.exists ?? existsSync)),
    } });
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function workerRevision(deps: LaunchAgentDependencies, worker: string): string {
  if (deps.worker_revision) return deps.worker_revision;
  try { return createHash("sha256").update(CRAFT_RELEASE_VERSION).update(readFileSync(worker)).digest("hex"); }
  catch { return `path:${worker}`; }
}

function launchEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const names = ["CODEX_HOME", "CRAFT_LEARNING_MODEL_HOST", "CRAFT_EXPERIENCE_POLL_MS", "CRAFT_KNOWLEDGE_POLL_MS",
    "CRAFT_MEMORY_POLL_MS", "CRAFT_NOTES_POLL_MS", "CRAFT_LEARNING_PROJECT_SCOPES", "CRAFT_PROGRAM_MEMORY_DESIGNS",
    "CRAFT_HELD_OUT_ADAPTER_COMMAND", "CRAFT_HELD_OUT_ADAPTER_TIMEOUT_MS", "CRAFT_TRUSTED_EVALUATORS"];
  return Object.fromEntries([["PATH", env.PATH ?? "/usr/bin:/bin"], ...names.filter(name => env[name]).map(name => [name, env[name]!] as const)]);
}

export function renderLearningWorkerLaunchAgent(options: { exec_path: string; worker_entrypoint: string; data_root: string;
  worker_revision?: string; environment?: Record<string, string> }): string {
  const args = [options.exec_path, ...(options.worker_entrypoint.endsWith(".ts") ? ["--experimental-strip-types"] : []), options.worker_entrypoint];
  const plistArgs = args.map(argument => `    <string>${xml(argument)}</string>`).join("\n");
  const environment: Record<string, string> = { PATH: "/usr/bin:/bin", ...(options.environment ?? {}) };
  environment.CRAFT_LEARNING_WORKER_REVISION = options.worker_revision ?? `path:${options.worker_entrypoint}`;
  const plistEnvironment = Object.entries(environment).map(([key, value]) => `    <key>${xml(key)}</key><string>${xml(value)}</string>`).join("\n");
  const logPath = join(options.data_root, "runtime", "learning-worker.log");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key><string>${LEARNING_WORKER_LAUNCH_AGENT_LABEL}</string>\n  <key>ProgramArguments</key><array>\n${plistArgs}\n  </array>\n  <key>EnvironmentVariables</key><dict>\n    <key>CRAFT_DATA_DIR</key><string>${xml(options.data_root)}</string>\n    <key>CRAFT_LEARNING_COMPONENTS</key><string>${COMPONENTS}</string>\n${plistEnvironment}\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>StartInterval</key><integer>60</integer>\n  <key>StandardOutPath</key><string>${xml(logPath)}</string>\n  <key>StandardErrorPath</key><string>${xml(logPath)}</string>\n</dict>\n</plist>\n`;
}

function ensureMac(deps: LaunchAgentDependencies): void {
  if ((deps.platform ?? process.platform) !== "darwin") throw new Error("learning_worker_launch_agent_requires_macos");
}

function launchctl(deps: LaunchAgentDependencies, args: string[]): string {
  return deps.launchctl ? deps.launchctl(args) : execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function isCraftLearningWorkerPlist(contents: string): boolean {
  return contents.includes(`<key>Label</key><string>${LEARNING_WORKER_LAUNCH_AGENT_LABEL}</string>`)
    && contents.includes(`<key>CRAFT_LEARNING_COMPONENTS</key><string>${COMPONENTS}</string>`)
    && contents.includes("<key>ProgramArguments</key><array>");
}

/** Ensure the user-level worker for a valid plugin session without taking over an unknown service. */
export function ensureLearningWorkerLaunchAgent(deps: LaunchAgentDependencies = {}): { status: string; plist_path?: string } {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  if (env.CRAFT_CONTINUOUS_LEARNING === "0") return { status: "disabled" };
  if (platform !== "darwin") return { status: "unsupported_platform" };

  const location = paths(deps);
  const read = deps.read_file ?? ((path: string) => readFileSync(path, "utf8"));
  let current: string | undefined;
  try { current = read(location.plist); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }

  if (current === undefined) {
    const status = learningWorkerLaunchAgentStatus(deps);
    if (status.loaded) throw new Error("learning_worker_launch_agent_conflicting_installation");
    return installLearningWorkerLaunchAgent(deps);
  }
  if (!isCraftLearningWorkerPlist(current)) throw new Error("learning_worker_launch_agent_conflicting_installation");
  return upgradeLearningWorkerLaunchAgent(deps);
}

export function installLearningWorkerLaunchAgent(deps: LaunchAgentDependencies = {}): { status: string; plist_path: string } {
  ensureMac(deps);
  const location = paths(deps);
  const worker = workerEntrypoint(deps);
  const dataDirectory = craftPaths(dataRoot(deps.env ?? process.env)).root;
  const contents = renderInstalledWorker(worker, deps);
  const read = deps.read_file ?? ((path: string) => readFileSync(path, "utf8"));
  const write = deps.write_file ?? ((path, value, options) => writeFileSync(path, value, options));
  const mkdir = deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }));
  const chmod = deps.chmod ?? chmodSync;
  mkdir(location.directory);
  mkdir(join(dataDirectory, "runtime"));
  let existing: string | undefined;
  try { existing = read(location.plist); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  if (existing !== undefined) {
    if (existing !== contents) throw new Error("learning_worker_launch_agent_conflicting_installation");
    if (!learningWorkerLaunchAgentStatus(deps).loaded) launchctl(deps, ["bootstrap", location.domain, location.plist]);
    return { status: "already_installed", plist_path: location.plist };
  }
  if (learningWorkerLaunchAgentStatus(deps).loaded) launchctl(deps, ["bootout", location.target]);
  write(location.plist, contents, { flag: "wx", mode: 0o600 });
  chmod(location.plist, 0o600);
  launchctl(deps, ["bootstrap", location.domain, location.plist]);
  return { status: "installed", plist_path: location.plist };
}

export function learningWorkerLaunchAgentStatus(deps: LaunchAgentDependencies = {}): { installed: boolean; loaded: boolean; plist_path: string; reason: string | null;
  held_out_adapter_configured: boolean; program_memory_designs_configured: boolean } {
  ensureMac(deps);
  const location = paths(deps);
  let installed = false;
  let contents = "";
  try { contents = (deps.read_file ?? ((path: string) => readFileSync(path, "utf8")))(location.plist); installed = true; }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  let loaded = false;
  try { launchctl(deps, ["print", location.target]); loaded = true; }
  catch (error) {
    if (!(error instanceof Error && "status" in error && typeof error.status === "number")) throw error;
  }
  let programMissing = false;
  if (installed && contents.includes("<key>ProgramArguments</key>")) {
    const argumentBlock = contents.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u)?.[1] ?? "";
    const programArguments = [...argumentBlock.matchAll(/<string>([\s\S]*?)<\/string>/gu)].map(match => match[1]!
      .replaceAll("&apos;", "'").replaceAll("&quot;", '"').replaceAll("&gt;", ">").replaceAll("&lt;", "<").replaceAll("&amp;", "&"));
    const exists = deps.exists ?? existsSync;
    programMissing = programArguments.length < 2 || !exists(programArguments[0]!) || !exists(programArguments.at(-1)!);
  }
  let reason: string | null = null;
  if (!installed) reason = "not_installed";
  else if (programMissing) reason = "program_missing";
  else if (!loaded) reason = "not_loaded";
  return { installed, loaded, plist_path: location.plist, reason,
    held_out_adapter_configured: /<key>CRAFT_HELD_OUT_ADAPTER_COMMAND<\/key>\s*<string>[^<]+<\/string>/u.test(contents),
    program_memory_designs_configured: /<key>CRAFT_PROGRAM_MEMORY_DESIGNS<\/key>\s*<string>[^<]+<\/string>/u.test(contents) };
}

export function startLearningWorkerLaunchAgent(deps: LaunchAgentDependencies = {}): { status: string } {
  ensureMac(deps);
  const location = paths(deps);
  const result = learningWorkerLaunchAgentStatus(deps);
  if (!result.installed) throw new Error("learning_worker_launch_agent_not_installed");
  if (result.loaded) return { status: "already_running" };
  if (result.reason === "program_missing") throw new Error("learning_worker_launch_agent_program_missing");
  launchctl(deps, ["bootstrap", location.domain, location.plist]);
  return { status: "started" };
}

export function stopLearningWorkerLaunchAgent(deps: LaunchAgentDependencies = {}): { status: string } {
  ensureMac(deps);
  const location = paths(deps);
  const result = learningWorkerLaunchAgentStatus(deps);
  if (!result.loaded) return { status: result.installed ? "already_stopped" : "not_installed" };
  launchctl(deps, ["bootout", location.target]);
  return { status: "stopped" };
}

export function uninstallLearningWorkerLaunchAgent(deps: LaunchAgentDependencies = {}): { status: string } {
  ensureMac(deps);
  const location = paths(deps);
  const state = learningWorkerLaunchAgentStatus(deps);
  if (!state.installed) {
    if (state.loaded) { launchctl(deps, ["bootout", location.target]); return { status: "orphaned_job_stopped" }; }
    return { status: "already_uninstalled" };
  }
  const current = (deps.read_file ?? ((path: string) => readFileSync(path, "utf8")))(location.plist);
  if (!isCraftLearningWorkerPlist(current)) {
    throw new Error("learning_worker_launch_agent_changed_after_install");
  }
  if (state.loaded) launchctl(deps, ["bootout", location.target]);
  (deps.unlink ?? unlinkSync)(location.plist);
  return { status: "uninstalled" };
}

export function upgradeLearningWorkerLaunchAgent(deps: LaunchAgentDependencies = {}): { status: string; plist_path: string } {
  ensureMac(deps);
  const location = paths(deps);
  const read = deps.read_file ?? ((path: string) => readFileSync(path, "utf8"));
  const write = deps.write_file ?? ((path, value, options) => writeFileSync(path, value, options));
  let current: string;
  try { current = read(location.plist); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return installLearningWorkerLaunchAgent(deps);
    throw error;
  }
  if (!isCraftLearningWorkerPlist(current)) {
    throw new Error("learning_worker_launch_agent_changed_after_install");
  }
  const worker = workerEntrypoint(deps);
  const contents = renderInstalledWorker(worker, deps);
  const state = learningWorkerLaunchAgentStatus(deps);
  if (current === contents) {
    if (!state.loaded) launchctl(deps, ["bootstrap", location.domain, location.plist]);
    return { status: "already_current", plist_path: location.plist };
  }
  const temporary = `${location.plist}.upgrade.${process.pid}`;
  const dataDirectory = craftPaths(dataRoot(deps.env ?? process.env)).root;
  const mkdir = deps.mkdir ?? ((path: string) => mkdirSync(path, { recursive: true, mode: 0o700 }));
  mkdir(location.directory);
  mkdir(join(dataDirectory, "runtime"));
  try {
    try { (deps.unlink ?? unlinkSync)(temporary); } catch { /* no stale temp file */ }
    write(temporary, contents, { flag: "wx", mode: 0o600 });
    (deps.chmod ?? chmodSync)(temporary, 0o600);
    if (state.loaded) launchctl(deps, ["bootout", location.target]);
    (deps.rename ?? renameSync)(temporary, location.plist);
    launchctl(deps, ["bootstrap", location.domain, location.plist]);
  } catch (error) {
    try { (deps.unlink ?? unlinkSync)(temporary); } catch { /* already renamed or absent */ }
    try { launchctl(deps, ["bootstrap", location.domain, location.plist]); } catch { /* operator can inspect status and retry */ }
    throw error;
  }
  return { status: "upgraded", plist_path: location.plist };
}
