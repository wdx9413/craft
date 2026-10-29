import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** GUI applications often inherit a shorter PATH than an interactive shell. */
export function workbenchCliPath(pathValue = process.env.PATH ?? "", home = homedir(), platform = process.platform): string {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const delimiter = windows ? ";" : ":";
  const additions = path.isAbsolute(home) ? [path.join(home, ".local", "bin")] : [];
  if (!windows) additions.push("/usr/local/bin");
  if (platform === "darwin") additions.push("/opt/homebrew/bin");
  const entries = pathValue.split(delimiter).filter(Boolean);
  for (const directory of additions) if (!entries.includes(directory)) entries.push(directory);
  return entries.join(delimiter);
}

export function workbenchCliEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  const key = Object.keys(env).find(name => name.toLowerCase() === "path") ?? "PATH";
  env[key] = workbenchCliPath(env[key]);
  return env;
}
