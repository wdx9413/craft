import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export type WorkbenchFolderPick = { path: string } | { cancelled: true };
export type WorkbenchFolderPicker = (initial?: string | null) => Promise<WorkbenchFolderPick>;
type FolderDialogRunner = (initial: string) => Promise<unknown>;
type FolderDialogStream = {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: "data", listener: (chunk: unknown) => void): unknown;
};
type FolderDialogProcess = {
  stdout: FolderDialogStream;
  stderr: FolderDialogStream;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): boolean;
};
type FolderDialogSpawnOptions = {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  stdio: ["ignore", "pipe", "pipe"];
};
type FolderDialogSpawn = (file: string, args: string[], options: FolderDialogSpawnOptions) => FolderDialogProcess;
type FolderDialogDependencies = {
  platform?: NodeJS.Platform;
  systemRoot?: string;
  spawnProcess?: FolderDialogSpawn;
};

const MAX_PATH_LENGTH = 4096;
const DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择要引用的文件夹'
$dialog.ShowNewFolderButton = $true
$initial = $env:CRAFT_WORKBENCH_PICKER_INITIAL
if ($initial -and [System.IO.Directory]::Exists($initial)) { $dialog.SelectedPath = $initial }
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.Opacity = 0
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$owner.Location = New-Object System.Drawing.Point(-32000, -32000)
$selected = ''
$owner.Show()
try {
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { $selected = $dialog.SelectedPath }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
if ($selected) {
  [Console]::Out.Write((ConvertTo-Json @{ path = $selected } -Compress))
} else {
  [Console]::Out.Write('{"cancelled":true}')
}
`.trim();

function initialDirectory(initial?: string | null): string {
  const value = typeof initial === "string" ? initial.trim() : "";
  return value && value.length <= MAX_PATH_LENGTH && isAbsolute(value) && !value.includes("\0") ? value : homedir();
}

export async function runWindowsFolderDialog(initial: string, {
  platform = process.platform,
  systemRoot = process.env.SystemRoot,
  spawnProcess = spawn as unknown as FolderDialogSpawn,
}: FolderDialogDependencies = {}): Promise<unknown> {
  if (platform !== "win32") throw new Error("system folder picker is only available on Windows");
  const executable = join(systemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(executable, ["-NoProfile", "-STA", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", DIALOG_SCRIPT], {
      env: { ...process.env, CRAFT_WORKBENCH_PICKER_INITIAL: initial },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += String(chunk); if (stdout.length > 64 * 1024) child.kill(); });
    child.stderr.on("data", chunk => { stderr += String(chunk); if (stderr.length > 64 * 1024) child.kill(); });
    child.on("error", reject);
    child.on("exit", code => {
      if (code !== 0) { reject(new Error(stderr.trim() || "folder picker exited unexpectedly")); return; }
      try { resolve(JSON.parse(stdout.trim())); }
      catch { reject(new Error("folder picker returned an invalid response")); }
    });
  });
}

/** Open the host folder picker and return a canonical, existing directory path. */
export async function pickWorkbenchFolder(initial?: string | null, runner: FolderDialogRunner = runWindowsFolderDialog): Promise<WorkbenchFolderPick> {
  const result = await runner(initialDirectory(initial));
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("folder picker returned an invalid response");
  const record = result as Record<string, unknown>;
  if (record.cancelled === true) return { cancelled: true };
  if (typeof record.path !== "string" || !record.path || record.path.length > MAX_PATH_LENGTH || record.path.includes("\0")) {
    throw new Error("folder picker returned an invalid path");
  }
  const path = await realpath(record.path);
  if (!(await stat(path)).isDirectory()) throw new Error("selected path is not a folder");
  return { path };
}
