# dsh-matlab-feedback: stage single-line MATLAB code in the already-open
# Command Window WITHOUT executing it.
#
# Safety contract:
#   * never sends Enter / Return / any execution trigger;
#   * rejects empty or multi-line input (pasting multi-line text can execute);
#   * pastes through the clipboard into the focused Command Window input line;
#   * reports a machine-readable JSON line on stdout.
#
# This file must stay ASCII-only (Windows PowerShell 5.1 decodes BOM-less
# UTF-8 script files with the system ANSI code page). Chinese/Unicode MATLAB
# code is passed through -Code and does not need to live in this file.
#
# Usage:
#   powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
#     -File matlab-stage-code.ps1 -Code "disp('hello')"
#
# Exit codes: 0 staged, 2 no MATLAB, 3 foreground failed, 4 focus failed,
#             5 command line draft not empty, 6 paste not verified, 1 bad args.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Code,
  [int]$VerifyTimeoutMs = 2500
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)

$MAX_CODE_CHARS = 8000

function Fail([string]$status, [string]$message, [int]$exitCode) {
  $payload = [ordered]@{
    status = $status
    executed = $false
    message = $message
  }
  Write-Output ($payload | ConvertTo-Json -Compress)
  exit $exitCode
}

if ([string]::IsNullOrWhiteSpace($Code)) { Fail 'invalid-code' 'code must be a non-empty string' 1 }
if ($Code.Length -gt $MAX_CODE_CHARS) { Fail 'invalid-code' "code exceeds $MAX_CODE_CHARS characters" 1 }
if ($Code -match "[`r`n]") { Fail 'invalid-code' 'code must be a single line; multi-line pasting could execute code' 1 }
if ($Code.Contains([char]0)) { Fail 'invalid-code' 'code must not contain NUL characters' 1 }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies 'System.Drawing' @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class StageW32 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

  public static IntPtr FindMain(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h,l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      bool keep = false;
      foreach (var p in pids) if (p == pid) keep = true;
      if (!keep) return true;
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      if (t.ToString().StartsWith("MATLAB R20")) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string ForegroundInfo() {
    IntPtr fg = GetForegroundWindow();
    uint pid; GetWindowThreadProcessId(fg, out pid);
    var t = new StringBuilder(256); GetWindowText(fg, t, 256);
    return pid + "|" + t.ToString();
  }
  public static void SendCtrl0() {
    const byte VK_CONTROL = 0x11, VK_0 = 0x30;
    const uint KEYUP = 0x0002;
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(VK_0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(VK_0, 0, KEYUP, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
  }
  public static void SendCtrlV() {
    const byte VK_CONTROL = 0x11, VK_V = 0x56;
    const uint KEYUP = 0x0002;
    keybd_event(VK_CONTROL, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(VK_V, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(VK_V, 0, KEYUP, UIntPtr.Zero); System.Threading.Thread.Sleep(40);
    keybd_event(VK_CONTROL, 0, KEYUP, UIntPtr.Zero);
  }
}
"@

$matlabPids = @((Get-Process MATLAB -ErrorAction SilentlyContinue).Id)
if ($matlabPids.Count -eq 0) { Fail 'no-matlab' 'No running MATLAB process was found. Start MATLAB and retry.' 2 }

$hwnd = [StageW32]::FindMain([uint32[]]$matlabPids)
if ($hwnd -eq [IntPtr]::Zero) { Fail 'no-matlab-window' 'No MATLAB desktop window was found (is MATLAB running with the desktop?).' 2 }

$root = [System.Windows.Automation.AutomationElement]::RootElement
$windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
$main = $null
foreach ($w in $windows) {
  if ($matlabPids -contains $w.Current.ProcessId -and $w.Current.Name -match '^MATLAB R\d{4}[ab]$') { $main = $w; break }
}

function Get-KeyCaptureElement($mainWindow) {
  $all = $mainWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  foreach ($el in $all) {
    if ($el.Current.ClassName -eq 'keyCapture' -and $el.Current.Name -eq 'Command Window') { return $el }
  }
  return $null
}

function Get-InputValue($mainWindow) {
  $capture = Get-KeyCaptureElement $mainWindow
  if ($null -eq $capture) { return $null }
  try { return [string]$capture.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return $null }
}

if ($null -eq $main) { Fail 'no-matlab-window' 'MATLAB UI Automation element not found.' 2 }

$wasIconic = [StageW32]::IsIconic($hwnd)
if ($wasIconic) {
  [void][StageW32]::ShowWindow($hwnd, 9)
  Start-Sleep -Milliseconds 400
}
[void][StageW32]::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 500

$foreground = [StageW32]::ForegroundInfo()
$foregroundPid = [int]($foreground.Split('|')[0])
if (-not ($matlabPids -contains $foregroundPid)) {
  Fail 'foreground-failed' "Could not bring the MATLAB window to the foreground (foreground=$foreground). Bring MATLAB to the front and retry." 3
}

$draftBefore = Get-InputValue $main
$draftBeforeSafe = if ($null -eq $draftBefore) { '' } else { $draftBefore.TrimEnd() }
$existing = ''
if ($draftBeforeSafe -match '^>>\s*(.*)$') { $existing = $Matches[1].Trim() }
if ($existing.Length -gt 0) {
  $payload = [ordered]@{
    status = 'draft-not-empty'
    executed = $false
    message = 'The MATLAB Command Window already has unexecuted text. Press Esc (or clear it) in MATLAB and retry so the staged line is not mixed with existing input.'
    existingDraft = $existing
  }
  Write-Output ($payload | ConvertTo-Json -Compress)
  exit 5
}

[StageW32]::SendCtrl0()
Start-Sleep -Milliseconds 700

$focusInCommandWindow = $false
$focusedInfo = ''
try {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($focused) {
    $focusedInfo = ($focused.Current.ControlType.ProgrammaticName -replace 'ControlType\.','') + '|' + $focused.Current.Name
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $node = $focused
    for ($i = 0; $i -lt 15 -and $null -ne $node; $i++) {
      $id = [string]$node.Current.AutomationId
      $cls = [string]$node.Current.ClassName
      if ($id -eq 'commandWindowWrapper' -or $cls -match 'commandwindow' -or $cls -match 'rtePane') { $focusInCommandWindow = $true; break }
      $node = $walker.GetParent($node)
    }
  }
} catch { }

if (-not $focusInCommandWindow) {
  $payload = [ordered]@{
    status = 'focus-failed'
    executed = $false
    message = 'Could not focus the MATLAB Command Window. The code was NOT staged. Bring MATLAB to the front (or click its Command Window) and retry.'
    focused = $focusedInfo
  }
  Write-Output ($payload | ConvertTo-Json -Compress)
  exit 4
}

Set-Clipboard -Value $Code
Start-Sleep -Milliseconds 150
[StageW32]::SendCtrlV()

$deadline = (Get-Date).AddMilliseconds($VerifyTimeoutMs)
$draftAfter = $null
$verified = $false
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 250
  $draftAfter = Get-InputValue $main
  if ($null -ne $draftAfter -and ([string]$draftAfter).Contains($Code)) { $verified = $true; break }
}

if (-not $verified) {
  $payload = [ordered]@{
    status = 'paste-unverified'
    executed = $false
    message = 'The code was copied to the clipboard but the paste could not be verified in the Command Window. Paste it manually with Ctrl+V and press Enter yourself.'
    clipboardContainsCode = $true
    draftAfter = [string]$draftAfter
  }
  Write-Output ($payload | ConvertTo-Json -Compress)
  exit 6
}

$payload = [ordered]@{
  status = 'staged'
  executed = $false
  code = $Code
  codeLength = $Code.Length
  draftBefore = $draftBeforeSafe
  draftAfter = ([string]$draftAfter).TrimEnd()
  windowWasMinimized = $wasIconic
  backgroundColor = $null
  message = 'Staged in the MATLAB Command Window. It has NOT been executed. Review it in MATLAB and press Enter yourself to run it, or press Esc to discard it.'
}
Write-Output ($payload | ConvertTo-Json -Compress)
exit 0