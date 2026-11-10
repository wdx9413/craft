import { accessSync, constants, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { workbenchCliEnvironment } from "./infrastructure/cli-path.ts";
import type { CraftSettings } from "./settings.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

export type DshLaunch = {
  mode: "cli" | "desktop";
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  dshHome: string;
  entryPath: string | null;
};

export type DshProviderStatus = {
  id: "dsh";
  name: "DSH";
  status: "available" | "not_found" | "error" | "unconfigured";
  version: string | null;
  install_url: string | null;
  executable: string | null;
  dsh_home: string | null;
  detail: string | null;
};

/** Replace the ACP profile tail with another DSH CLI invocation. */
export function dshArguments(launch: DshLaunch, args: string[]): string[] {
  if (launch.mode === "desktop") {
    const prefix = launch.args.slice(0, Math.max(0, launch.args.length - 2));
    return [...prefix, ...args];
  }
  return [...args];
}

const DSH_INSTALL_URL = "https://github.com/deepseek-ai/deepseek-harness";

function executableOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = env.PATH ?? env.Path ?? "";
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
    : [""];
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension.toLowerCase()}`);
      try {
        if (statSync(candidate).isFile()) {
          accessSync(candidate, constants.X_OK);
          return resolve(candidate);
        }
      } catch {
        // Continue through PATH; a GUI process commonly inherits partial entries.
      }
    }
  }
  return null;
}

function defaultDshHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DSH_HOME?.trim()) return resolve(env.DSH_HOME);
  if (process.platform === "win32") return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "dsh-desktop", "harness");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "dsh-desktop", "harness");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "dsh-desktop", "harness");
}

/**
 * The stdout-clean resolve hook that retries host-owned packages from the packaged
 * app.asar anchor. It is preloaded with `node --import` and writes nothing to stdout,
 * so ACP and MCP framing stay clean without a separate shim script.
 */
function resolveDshResolveHook(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(process.cwd(), "adapters", "dsh-plugin-host", "dsh-resolve-hook.mjs"),
    resolve(here, "..", "adapters", "dsh-plugin-host", "dsh-resolve-hook.mjs"),
    resolve(here, "..", "..", "adapters", "dsh-plugin-host", "dsh-resolve-hook.mjs"),
  ].find((candidate) => existsSync(candidate)) ?? null;
}

function desktopLaunch(executable: string, settings: CraftSettings, env: NodeJS.ProcessEnv): DshLaunch | null {
  const resources = join(dirname(executable), "resources");
  const wrapper = join(resources, "harness-node-entry.mjs");
  const entry = settings.workbench.dshEntryPath
    ?? join(resources, "app.asar", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const asar = /^(.*?[\\/]app\.asar)[\\/]/u.exec(entry)?.[1];
  if (!existsSync(wrapper) || (!existsSync(entry) && !(asar !== undefined && existsSync(asar)))) return null;
  const resolvedEntry = resolve(entry);
  const hook = resolveDshResolveHook();
  // With the hook we run the real entry directly (clean stdout); without it we fall
  // back to the packaged wrapper, which is noisier but still functional.
  const prefix = hook ? ["--import", pathToFileURL(hook).href, resolvedEntry] : [resolve(wrapper), resolvedEntry];
  const launchEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
  if (hook) launchEnv.CRAFT_DSH_ENTRY_ANCHOR = resolvedEntry;
  return {
    mode: "desktop",
    executable: resolve(executable),
    args: [...prefix, "--profile", "acp"],
    env: launchEnv,
    dshHome: settings.workbench.dshHome ?? defaultDshHome(env),
    entryPath: resolvedEntry,
  };
}

/**
 * Resolve the DSH ACP launcher without assuming a global `dsh` install.
 *
 * The desktop carrier runs the bundled CLI through Electron's Node mode. A
 * standalone CLI uses the documented `dsh --profile acp` entry. The returned
 * launch is pure configuration; process ownership stays with DshAcpClient.
 */
export function resolveDshLaunch(settings: CraftSettings, env: NodeJS.ProcessEnv = process.env): DshLaunch {
  const configured = settings.workbench.dshExecutable;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("workbench.dshExecutable must be absolute");
    const desktop = desktopLaunch(configured, settings, env);
    if (desktop) return desktop;
    return {
      mode: "cli",
      executable: resolve(configured),
      args: ["--profile", "acp"],
      env: { ...env },
      dshHome: settings.workbench.dshHome ?? defaultDshHome(env),
      entryPath: settings.workbench.dshEntryPath,
    };
  }

  const desktopFromEnvironment = env.DSH_DESKTOP_EXE?.trim();
  if (desktopFromEnvironment && isAbsolute(desktopFromEnvironment)) {
    const launch = desktopLaunch(desktopFromEnvironment, settings, env);
    if (launch) return launch;
  }

  const pathDsh = executableOnPath("dsh", env);
  if (pathDsh) {
    return {
      mode: basename(pathDsh).toLowerCase() === "dsh desktop.exe" ? "desktop" : "cli",
      executable: pathDsh,
      args: ["--profile", "acp"],
      env: { ...env },
      dshHome: settings.workbench.dshHome ?? defaultDshHome(env),
      entryPath: settings.workbench.dshEntryPath,
    };
  }

  const commonDesktop = process.platform === "win32"
    ? [
        join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "dsh-desktop", "DSH Desktop.exe"),
        join(env.ProgramFiles ?? "C:\\Program Files", "DSH Desktop", "DSH Desktop.exe"),
      ]
    : [];
  for (const candidate of commonDesktop) {
    if (!existsSync(candidate)) continue;
    const launch = desktopLaunch(candidate, settings, env);
    if (launch) return launch;
  }
  throw new Error("DSH executable was not found; configure workbench.dshExecutable");
}

function probeVersion(launch: DshLaunch): Promise<string> {
  return new Promise((resolveVersion, reject) => {
    // npm installs a .cmd shim on Windows; execFile cannot spawn it directly.
    const shim = process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(launch.executable);
    const command = shim ? (process.env.ComSpec ?? "cmd.exe") : launch.executable;
    const args = [...launch.args.slice(0, -2), "--version"];
    execFile(command, shim ? ["/d", "/s", "/c", launch.executable, ...args] : args, {
      timeout: 5_000,
      maxBuffer: 32 * 1024,
      windowsHide: true,
      shell: false,
      env: { ...workbenchCliEnvironment(), ...launch.env, DSH_HOME: launch.dshHome },
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const line = stdout.split(/\r?\n/u).map((value) => value.trim()).find((value) => /^\d+\.\d+\.\d+/u.test(value));
      resolveVersion(line ?? "unknown");
    });
  });
}

export async function detectDshProvider(settings: CraftSettings, env: NodeJS.ProcessEnv = process.env): Promise<DshProviderStatus> {
  if (!settings.workbench.dshExecutable && !env.DSH_DESKTOP_EXE && !executableOnPath("dsh", env)
    && !existsSync(join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "dsh-desktop", "DSH Desktop.exe"))) {
    return { id: "dsh", name: "DSH", status: "not_found", version: null, install_url: DSH_INSTALL_URL,
      executable: null, dsh_home: null, detail: null };
  }
  try {
    const launch = resolveDshLaunch(settings, env);
    let version = "unknown";
    try {
      version = await probeVersion(launch);
    } catch {
      // Detection still reports the resolved launcher; an ACP probe is the stronger check.
    }
    return { id: "dsh", name: "DSH", status: "available", version, install_url: null,
      executable: launch.executable, dsh_home: launch.dshHome, detail: launch.mode };
  } catch (error) {
    return { id: "dsh", name: "DSH", status: "error", version: null, install_url: DSH_INSTALL_URL,
      executable: settings.workbench.dshExecutable, dsh_home: settings.workbench.dshHome,
      detail: error instanceof Error ? error.message : String(error) };
  }
}
