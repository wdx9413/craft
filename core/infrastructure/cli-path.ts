import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** GUI applications often inherit a shorter PATH than an interactive shell. */
export function workbenchCliPath(pathValue = process.env.PATH ?? "", home = homedir(), platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const delimiter = windows ? ";" : ":";
  const additions = path.isAbsolute(home) ? [path.join(home, ".local", "bin")] : [];
  // A default npm global prefix is not always inherited by a GUI process, so a
  // CLI installed from the workbench would otherwise stay invisible.
  if (windows) {
    for (const root of [env.APPDATA, env.LOCALAPPDATA]) if (root) additions.push(path.join(root, "npm"));
  }
  if (!windows) additions.push("/usr/local/bin");
  if (platform === "darwin") additions.push("/opt/homebrew/bin");
  const entries = pathValue.split(delimiter).filter(Boolean);
  for (const directory of additions) if (!entries.includes(directory)) entries.push(directory);
  return entries.join(delimiter);
}

export function workbenchCliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
  env[key] = workbenchCliPath(env[key], homedir(), process.platform, env);
  return env;
}
