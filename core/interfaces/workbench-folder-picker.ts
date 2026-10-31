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
const FOLDER_DIALOG_INTEROP = `
using System;
using System.Runtime.InteropServices;

public static class CraftWorkbenchFolderPicker
{
    private const uint CLSCTX_INPROC_SERVER = 1;
    private const uint FOS_NOCHANGEDIR = 0x00000008;
    private const uint FOS_PICKFOLDERS = 0x00000020;
    private const uint FOS_FORCEFILESYSTEM = 0x00000040;
    private const uint FOS_PATHMUSTEXIST = 0x00000800;
    private const uint SIGDN_FILESYSPATH = 0x80058000;
    private static readonly Guid CLSID_FileOpenDialog = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");
    private static readonly Guid IID_IFileOpenDialog = new Guid("d57c7288-d4ad-4768-be02-9d969532d960");
    private static readonly Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");

    [ComImport]
    [Guid("42f85136-db7e-439c-85f1-e4075d135fc8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
    }

    [ComImport]
    [Guid("d57c7288-d4ad-4768-be02-9d969532d960")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOpenDialog : IFileDialog
    {
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [ComImport]
    [Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        [PreserveSig] int GetParent(out IShellItem ppsi);
        [PreserveSig] int GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        [PreserveSig] int GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        [PreserveSig] int Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [DllImport("ole32.dll", PreserveSig = true)]
    private static extern int CoCreateInstance(ref Guid rclsid, IntPtr pUnkOuter, uint dwClsContext, ref Guid riid, out IFileOpenDialog ppv);

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    private static extern int SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    public static string PickFolder(IntPtr owner, string title, string initial)
    {
        IFileOpenDialog dialog;
        Guid clsid = CLSID_FileOpenDialog;
        Guid iid = IID_IFileOpenDialog;
        int hr = CoCreateInstance(ref clsid, IntPtr.Zero, CLSCTX_INPROC_SERVER, ref iid, out dialog);
        if (hr < 0) Marshal.ThrowExceptionForHR(hr);
        try
        {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_NOCHANGEDIR);
            dialog.SetTitle(title);
            dialog.SetOkButtonLabel("选择文件夹");
            if (!String.IsNullOrWhiteSpace(initial))
            {
                IShellItem folder = null;
                Guid shellItemId = IID_IShellItem;
                if (SHCreateItemFromParsingName(initial, IntPtr.Zero, ref shellItemId, out folder) >= 0)
                {
                    try { dialog.SetFolder(folder); } finally { Marshal.ReleaseComObject(folder); }
                }
            }
            hr = dialog.Show(owner);
            if (hr == unchecked((int)0x800704C7)) return null;
            if (hr < 0) Marshal.ThrowExceptionForHR(hr);
            IShellItem selected;
            dialog.GetResult(out selected);
            try
            {
                string path;
                hr = selected.GetDisplayName(SIGDN_FILESYSPATH, out path);
                if (hr < 0) Marshal.ThrowExceptionForHR(hr);
                return path;
            }
            finally { Marshal.ReleaseComObject(selected); }
        }
        finally { Marshal.ReleaseComObject(dialog); }
    }
}
`;

const DIALOG_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
${FOLDER_DIALOG_INTEROP}
'@
$initial = $env:CRAFT_WORKBENCH_PICKER_INITIAL
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
  $selected = [CraftWorkbenchFolderPicker]::PickFolder($owner.Handle, '选择文件夹', $initial)
} finally {
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
