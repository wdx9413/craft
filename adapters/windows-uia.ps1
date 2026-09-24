<#
  Local execution adapter for a prepared WindowsDesktopAutomation request.

  The Craft core issues the contract; this script is intentionally narrow.  It cannot start
  an executable, evaluate arbitrary PowerShell, send keystrokes, use cursor coordinates or
  inspect pixels.  It finds an already-running, allowlisted executable and then uses Windows
  UI Automation's AutomationId/exact Name/ControlType properties only.

  Discover an already-running application's UIA tree (read-only, no registration needed):
    pwsh -NoProfile -File .\adapters\windows-uia.ps1 -Discover -Executable notepad.exe

  Example (the value is supplied at execution time and is never present in the prepared request):
    pwsh -NoProfile -File .\adapters\windows-uia.ps1 -RequestJson $request -Value "draft" -HumanRelease
#>
[CmdletBinding(DefaultParameterSetName = "Prepared")]
param(
  [Parameter(Mandatory = $true, ParameterSetName = "Prepared")] [string] $RequestJson,
  [Parameter(Mandatory = $true, ParameterSetName = "Discover")] [switch] $Discover,
  [Parameter(Mandatory = $true, ParameterSetName = "Discover")] [string] $Executable,
  [string] $Value,
  [switch] $HumanRelease
)

$ErrorActionPreference = "Stop"

function Complete([string] $Result, [string] $Detail) {
  [pscustomobject]@{ result = $Result; detail = $Detail; adapter = "windows_uia" } | ConvertTo-Json -Compress
  exit $(if ($Result -eq "succeeded") { 0 } else { 1 })
}

function Assert-BareExecutable([string] $Executable) {
  if ($Executable -notmatch '^[a-zA-Z0-9_.-]{1,120}\.exe$') { throw "Request executable is not a bare .exe filename" }
}

function Find-ApplicationWindow([string] $Executable) {
  Assert-BareExecutable $Executable
  $processName = [System.IO.Path]::GetFileNameWithoutExtension($Executable)
  $process = Get-Process -Name $processName -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $process) { Complete "not_found" "No already-running allowlisted application was found" }
  $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id))
  if ($null -eq $window) { Complete "not_found" "Allowlisted application has no automatable top-level window" }
  return $window
}

try {
  Add-Type -AssemblyName UIAutomationClient
  if ($Discover) {
    if (-not [string]::IsNullOrEmpty($Value) -or $HumanRelease) { throw "UIA discovery is read-only and does not accept Value or HumanRelease" }
    $window = Find-ApplicationWindow $Executable
    $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $controls = [System.Collections.Generic.List[object]]::new()
    foreach ($element in $elements | Select-Object -First 200) {
      $patterns = [System.Collections.Generic.List[string]]::new()
      foreach ($pair in @(@("Invoke", [System.Windows.Automation.InvokePattern]::Pattern), @("Value", [System.Windows.Automation.ValuePattern]::Pattern), @("SelectionItem", [System.Windows.Automation.SelectionItemPattern]::Pattern), @("Toggle", [System.Windows.Automation.TogglePattern]::Pattern))) {
        try { $null = $element.GetCurrentPattern($pair[1]); $patterns.Add($pair[0]) } catch { }
      }
      $controls.Add([ordered]@{ automation_id = [string]$element.Current.AutomationId; name = [string]$element.Current.Name; control_type = [string]$element.Current.ControlType.ProgrammaticName; enabled = [bool]$element.Current.IsEnabled; patterns = @($patterns) })
    }
    [ordered]@{ result = "succeeded"; detail = "UIA control tree discovered; values and screen coordinates are intentionally omitted"; adapter = "windows_uia"; executable = $Executable.ToLowerInvariant(); controls = @($controls); truncated = $elements.Count -gt 200 } | ConvertTo-Json -Compress -Depth 6
    exit 0
  }
  $request = $RequestJson | ConvertFrom-Json -AsHashtable
  if ($null -eq $request.application -or $null -eq $request.control) { throw "Prepared request needs application and control" }
  $executable = [string]$request.application.executable
  Assert-BareExecutable $executable
  $operation = [string]$request.operation
  if ($operation -notin @("observe", "read", "set_value", "invoke", "select", "toggle")) { throw "Request operation is not supported" }
  if ($operation -eq "set_value" -and [string]::IsNullOrEmpty($Value)) { throw "set_value requires -Value at execution time" }
  if ($operation -ne "set_value" -and -not [string]::IsNullOrEmpty($Value)) { throw "Only set_value accepts -Value" }
  if ($operation -notin @("observe", "read") -and -not $HumanRelease) { Complete "blocked" "Desktop mutation requires an explicit interactive HumanRelease" }

  $window = Find-ApplicationWindow $executable

  $conditions = [System.Collections.Generic.List[System.Windows.Automation.Condition]]::new()
  $locator = $request.control
  if (-not [string]::IsNullOrEmpty([string]$locator.automation_id)) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, [string]$locator.automation_id))
  }
  if (-not [string]::IsNullOrEmpty([string]$locator.name)) {
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, [string]$locator.name))
  }
  if (-not [string]::IsNullOrEmpty([string]$locator.control_type)) {
    $controlType = [System.Windows.Automation.ControlType]::($locator.control_type)
    if ($null -eq $controlType) { throw "Unsupported UIA control type" }
    $conditions.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $controlType))
  }
  if ($conditions.Count -eq 0) { throw "Prepared request has no stable UIA locator" }
  $condition = if ($conditions.Count -eq 1) { $conditions[0] } else { [System.Windows.Automation.AndCondition]::new([System.Windows.Automation.Condition[]]$conditions.ToArray()) }
  $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if ($null -eq $element) { Complete "not_found" "Allowlisted UIA control was not found" }

  if ($operation -eq "observe") { Complete "succeeded" "UIA control is present" }
  if ($operation -eq "read") {
    $value = $element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$value)
    $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
    Complete "succeeded" "UIA control read; value_sha256=$hash; value_length=$([string]$value).Length"
  }
  if ($operation -eq "set_value") {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    ([System.Windows.Automation.ValuePattern]$pattern).SetValue($Value)
    Complete "succeeded" "UIA value set"
  }
  if ($operation -eq "invoke") {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    Complete "succeeded" "UIA control invoked"
  }
  if ($operation -eq "select") {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
    Complete "succeeded" "UIA control selected"
  }
  $pattern = $element.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
  ([System.Windows.Automation.TogglePattern]$pattern).Toggle()
  Complete "succeeded" "UIA control toggled"
} catch {
  Complete "failed" $_.Exception.Message
}
