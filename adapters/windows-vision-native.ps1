<#
  Native Windows boundary for Craft's bundled visual adapter.

  This script never performs OCR and never uploads pixels.  `capture` returns one temporary
  PNG to the local Craft Node adapter, which removes it after local WASM recognition. `click`
  accepts a freshly-recognized screen point only after the caller supplied -HumanRelease.
#>
[CmdletBinding()]
param(
  [ValidateSet("capture", "click")] [string] $Mode = "capture",
  [string] $Executable,
  [int] $X,
  [int] $Y,
  [switch] $HumanRelease
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CraftVisionNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@

function Complete([string] $Result, [string] $Detail, $Extra = @{}) {
  [ordered]@{ result = $Result; detail = $Detail; adapter = "windows_vision_native" } + $Extra | ConvertTo-Json -Compress -Depth 8
  exit $(if ($Result -in @("captured", "succeeded")) { 0 } else { 1 })
}
function Assert-BareExecutable([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value -notmatch '^[a-zA-Z0-9_.-]{1,120}\.exe$') { throw "Executable must be a bare .exe filename" }
}
function Find-Window([string] $AllowedExecutable) {
  Assert-BareExecutable $AllowedExecutable
  $processName = [IO.Path]::GetFileNameWithoutExtension($AllowedExecutable)
  $process = Get-Process -Name $processName -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if ($null -eq $process) { Complete "not_found" "No already-running application window was found" }
  return $process
}
function Window-Bounds($Process) {
  $rect = [CraftVisionNative+RECT]::new()
  if (-not [CraftVisionNative]::GetWindowRect($Process.MainWindowHandle, [ref]$rect)) { throw "Unable to get the application window bounds" }
  $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
  if ($width -lt 20 -or $height -lt 20 -or $width -gt 32768 -or $height -gt 32768) { throw "Application window bounds are invalid" }
  return [pscustomobject]@{ left = $rect.Left; top = $rect.Top; width = $width; height = $height }
}

try {
  $process = Find-Window $Executable
  $bounds = Window-Bounds $process
  if ($Mode -eq "click") {
    if (-not $HumanRelease) { Complete "blocked" "Visual click requires explicit HumanRelease" }
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $bounds.width -or $Y -ge $bounds.height) { throw "Click point must stay within the current window" }
    [CraftVisionNative]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
    [CraftVisionNative]::SetCursorPos($bounds.left + $X, $bounds.top + $Y) | Out-Null
    [CraftVisionNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [CraftVisionNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Complete "succeeded" "Fresh locally recognized target was clicked after HumanRelease" @{ observed_at = [DateTime]::UtcNow.ToString("o"); human_release = $true }
  }
  $bitmap = [Drawing.Bitmap]::new($bounds.width, $bounds.height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($bounds.left, $bounds.top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
  $path = Join-Path ([IO.Path]::GetTempPath()) ("craft-vision-" + [Guid]::NewGuid().ToString("N") + ".png")
  try { $bitmap.Save($path, [Drawing.Imaging.ImageFormat]::Png) } finally { $bitmap.Dispose() }
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($path))).ToLowerInvariant()
  Complete "captured" "Window captured for local OCR" @{ screenshot_path = $path; screenshot_digest = "sha256:$hash"; image_width = $bounds.width; image_height = $bounds.height; observed_at = [DateTime]::UtcNow.ToString("o") }
} catch { Complete "failed" $_.Exception.Message }
