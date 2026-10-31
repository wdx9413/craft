import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type BrowserInvocation = { command: string; args: string[] };
export type BrowserSpawner = (command: string, args: string[]) => { unref(): void };
export type BrowserMode = "system" | "app";
export type BrowserOptions = { mode?: BrowserMode; appBrowser?: string };

/** Chromium's app mode gives the Workbench its own window without browser chrome. */
function findWindowsAppBrowser(): string | undefined {
  const candidates = [
    process.env.CRAFT_BROWSER_EXECUTABLE,
    process.env["ProgramFiles(x86)"] === undefined ? undefined : join(process.env["ProgramFiles(x86)"], "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "Microsoft", "Edge", "Application", "msedge.exe"),
    process.env.ProgramFiles === undefined ? undefined : join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe"),
    process.env["ProgramFiles(x86)"] === undefined ? undefined : join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe"),
    process.env.LOCALAPPDATA === undefined ? undefined : join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
  ];
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate));
}

/** Return the platform-specific command used to open a URL, without executing it. */
export function getBrowserInvocation(platform: NodeJS.Platform, url: string, options: BrowserOptions = {}): BrowserInvocation | undefined {
  if (platform === "win32" && options.mode === "app") {
    const appBrowser = options.appBrowser ?? findWindowsAppBrowser();
    if (appBrowser) return { command: appBrowser, args: [`--app=${url}`] };
  }
  switch (platform) {
    case "win32": return { command: "cmd.exe", args: ["/c", "start", "", url] };
    case "darwin": return { command: "open", args: [url] };
    case "linux":
    case "freebsd":
    case "openbsd":
    case "sunos":
      return { command: "xdg-open", args: [url] };
    default: return undefined;
  }
}

const defaultBrowserSpawner: BrowserSpawner = (command, args) => {
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  return child;
};

/** Open a URL in the user's default browser; return false when unavailable or disabled. */
export function openBrowser(
  url: string, platform: NodeJS.Platform = process.platform, spawnBrowser: BrowserSpawner = defaultBrowserSpawner,
  options: BrowserOptions = {},
): boolean {
  if (process.env.CRAFT_NO_BROWSER === "1") return false;
  const mode = options.mode ?? (process.env.CRAFT_BROWSER_MODE === "app" ? "app" : "system");
  const invocation = getBrowserInvocation(platform, url, {
    mode, appBrowser: options.appBrowser ?? process.env.CRAFT_BROWSER_EXECUTABLE,
  });
  if (!invocation) return false;
  try {
    spawnBrowser(invocation.command, invocation.args).unref();
    return true;
  } catch {
    return false;
  }
}
