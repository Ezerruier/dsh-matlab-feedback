#requires -Version 5.1
<#
.SYNOPSIS
    Read-only capture of a live MATLAB (R202x, CEF/Chromium desktop) session.

.DESCRIPTION
    Produces manifest.json (UTF-8, no BOM) plus per-window PNG screenshots inside -OutDir.

    * Window discovery  : EnumWindows + GetWindowThreadProcessId (filtered to MATLAB processes),
                          class 'WindowClass', visible, non-empty title, exclusion list.
    * Screenshots       : PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT=2) into a bitmap that is
                          exactly the window rect, saved as PNG. Never BitBlt, never focus,
                          never click, never restore/move/minimize anything.
    * Window text       : UI Automation Document TextPattern (all windows).
    * Command window    : descendants of AutomationId='commandWindowWrapper' (fallback: a Group
                          named like the localized "command window" / 'Command Window'),
                          pre-order ControlType.Text collection, TextPattern preferred,
                          Name as fallback.
    * Warnings          : high-signal lines (Chinese warning/error/failure keywords plus
                          error/warning/failed/exception) extracted from console + window
                          text, de-duplicated.  (All non-ASCII literals in this file are
                          expressed as \\uXXXX regex escapes / code points on purpose: this
                          script is stored as ASCII, so it behaves identically under the
                          Windows PowerShell 5.1 ANSI/GBK script decoding.)

    Exit codes: 0 = success, 2 = no MATLAB process / no visible MATLAB window, 1 = fatal error.
    The script never mutates MATLAB state; it only reads windows, pixels and UIA text.

.PARAMETER OutDir
    Absolute output directory (created if missing). Receives manifest.json and *.png.

.PARAMETER Mode
    all (default): screenshots + all text. console: command-window text only, no screenshots.

.PARAMETER MaxTextChars
    Per-window text cap (default 30000, head is kept).

.PARAMETER MaxConsoleChars
    Console text cap (default 40000, tail is kept because the newest output is the useful part).

.EXAMPLE
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File matlab-feedback.ps1 -OutDir C:\tmp\run1 -Mode all
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutDir,

    [ValidateSet('all', 'console')]
    [string]$Mode = 'all',

    [int]$MaxTextChars = 30000,

    [int]$MaxConsoleChars = 40000
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:StartedAt = [DateTimeOffset]::Now
$script:Stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$script:UiaAvailable = $false

trap {
    Write-Stderr ('matlab-feedback.ps1 fatal error: ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message)
    try { if ($_.CategoryInfo) { Write-Stderr ('activity: ' + $_.CategoryInfo.Activity) } } catch { }
    try { if ($_.Exception.StackTrace) { Write-Stderr ('clr-stack: ' + $_.Exception.StackTrace) } } catch { }
    try { if ($_.Exception.InnerException) { Write-Stderr ('inner: ' + $_.Exception.InnerException.GetType().FullName + ': ' + $_.Exception.InnerException.Message) } } catch { }
    try { if ($_.ScriptStackTrace) { Write-Stderr $_.ScriptStackTrace } } catch { }
    exit 1
}

function ConvertTo-AsciiDiagnostic {
    # Keep stderr ASCII so consumers that decode it as UTF-8 never see mojibake:
    # Windows PowerShell localizes its exception messages (GBK on a zh-CN system).
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $builder = New-Object System.Text.StringBuilder
    foreach ($ch in $Text.ToCharArray()) {
        $code = [int]$ch
        if (($code -ge 32 -and $code -lt 127) -or $ch -eq "`n" -or $ch -eq "`r" -or $ch -eq "`t") {
            [void]$builder.Append($ch)
        }
        else {
            [void]$builder.Append('?')
        }
    }
    return $builder.ToString()
}

function Write-Stderr {
    param([string]$Message)
    try { [Console]::Error.WriteLine((ConvertTo-AsciiDiagnostic $Message)) } catch { }
}

# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

function ConvertTo-NormalizedText {
    param([string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return '' }
    $t = $Text.Replace("`r`n", "`n").Replace("`r", "`n")
    $t = $t.Replace([string][char]0xFFFC, '')     # UIA object-replacement placeholders
    $t = $t.Replace([string][char]0x200B, '')     # zero width space
    $lines = @($t -split "`n" | ForEach-Object { $_.TrimEnd() } | Where-Object { $_.Trim().Length -gt 0 })
    return ($lines -join "`n").Trim()
}

function Limit-Text {
    param(
        [string]$Text,
        [int]$MaxChars,
        [switch]$KeepTail
    )
    if ([string]::IsNullOrEmpty($Text)) { return @{ Text = ''; Truncated = $false } }
    if ($MaxChars -le 0 -or $Text.Length -le $MaxChars) { return @{ Text = $Text; Truncated = $false } }
    if ($KeepTail) {
        return @{ Text = $Text.Substring($Text.Length - $MaxChars); Truncated = $true }
    }
    return @{ Text = $Text.Substring(0, $MaxChars); Truncated = $true }
}

function Get-SafeFileBase {
    param([string]$Title)
    $safe = $Title -replace '[^A-Za-z0-9._\-]', '_'
    $safe = $safe.Trim('_', '.', '-')
    if ([string]::IsNullOrWhiteSpace($safe)) { $safe = 'window' }
    if ($safe.Length -gt 40) { $safe = $safe.Substring(0, 40).TrimEnd('_', '.', '-') }
    return $safe
}

function ConvertFrom-CodePoints {
    # ASCII-safe way to build localized UIA names (script file is intentionally ASCII-only).
    param([int[]]$CodePoints)
    $chars = foreach ($cp in $CodePoints) { [char]$cp }
    return (-join $chars)
}

# ---------------------------------------------------------------------------
# Console text assembly (pre-order Text elements -> readable lines)
# ---------------------------------------------------------------------------

function Add-ConsoleFragment {
    param(
        [System.Text.StringBuilder]$Builder,
        [string]$Fragment,
        [switch]$Inline
    )
    if ([string]::IsNullOrEmpty($Fragment)) { return }
    $frag = $Fragment.Replace("`r`n", "`n").Replace("`r", "`n")
    $frag = $frag.Replace([string][char]0xFFFC, '').Replace([string][char]0x200B, '')
    if ($frag.Length -eq 0) { return }

    if ($Inline -or $Builder.Length -eq 0) { [void]$Builder.Append($frag); return }

    $last = $Builder[$Builder.Length - 1]
    $first = $frag[0]
    $appendDirectly = $false
    if ($last -eq "`n") {
        $appendDirectly = $true
    }
    elseif ($first -eq "`n") {
        $appendDirectly = $true
    }
    elseif ($frag -match '^\s+\n') {
        $appendDirectly = $true
    }
    elseif ($frag[0] -match '^[\)\]\}\uFF09\u3011\u300B\u3009.,;:!?\u3001\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u2026\u2014]') {
        # Closing punctuation starts a continuation span, e.g. ")\n<location...>".
        $appendDirectly = $true
    }
    else {
        $trimmed = $frag.Trim()
        if ($trimmed.Length -eq 0) {
            $appendDirectly = $true
        }
        elseif ($trimmed -match '^[\(\)\[\]\{\}\uFF08\uFF09\u3010\u3011\u300A\u300B\u3008\u3009.,;:!?\u3001\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\u2026\u00B7\-''""\u201C\u201D\u2018\u2019]+$') {
            $appendDirectly = $true
        }
    }

    if ($appendDirectly) {
        [void]$Builder.Append($frag)
    }
    else {
        [void]$Builder.Append("`n")
        [void]$Builder.Append($frag)
    }
}

# ---------------------------------------------------------------------------
# UI Automation helpers
# ---------------------------------------------------------------------------

function Get-UiaWindowElement {
    param(
        [long]$Hwnd,
        [uint32]$ProcessId,
        [string]$Title,
        $RootChildren
    )
    $el = $null
    try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$Hwnd)
    }
    catch {
        $el = $null
    }
    if ($null -ne $el) { return $el }

    # Fallback: match a root child on process id + title.
    if ($null -ne $RootChildren) {
        foreach ($child in $RootChildren) {
            try {
                if ($child.Current.ProcessId -eq [int]$ProcessId -and $child.Current.Name -eq $Title) { return $child }
            }
            catch { }
        }
    }
    return $null
}

function Get-WindowDocumentText {
    param($WindowElement)
    if ($null -eq $WindowElement) { return '' }
    try {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Document)
        $doc = $WindowElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($null -eq $doc) { return '' }
        $tp = $null
        if (-not $doc.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) { return '' }
        return [string]$tp.DocumentRange.GetText(-1)
    }
    catch {
        return ''
    }
}

function Get-SelectedControlLabels {
    param($WindowElement)
    $labels = New-Object System.Collections.Generic.List[string]
    if ($null -eq $WindowElement) { return $labels }
    try {
        $radioCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::RadioButton)
        $radios = $WindowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $radioCond)
        foreach ($radio in $radios) {
            try {
                $p = $null
                if ($radio.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) {
                    if ($p.Current.IsSelected) {
                        $name = [string]$radio.Current.Name
                        if (-not [string]::IsNullOrWhiteSpace($name)) { $labels.Add($name.Trim()) }
                    }
                }
            }
            catch { }
        }
        $comboCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::ComboBox)
        $combos = $WindowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $comboCond)
        foreach ($combo in $combos) {
            try {
                $p = $null
                if ($combo.TryGetCurrentPattern([System.Windows.Automation.SelectionPattern]::Pattern, [ref]$p)) {
                    foreach ($sel in $p.Current.GetSelection()) {
                        $name = [string]$sel.Current.Name
                        if (-not [string]::IsNullOrWhiteSpace($name)) { $labels.Add($name.Trim()) }
                    }
                }
            }
            catch { }
        }
    }
    catch { }
    return $labels
}

function Find-CommandWindowWrapper {
    param($WindowElement)
    if ($null -eq $WindowElement) { return $null }
    # Primary: AutomationId='commandWindowWrapper' (MATLAB R2025a+ CEF desktop).
    try {
        $cond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, 'commandWindowWrapper')
        $wrapper = $WindowElement.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if ($null -ne $wrapper) { return $wrapper }
    }
    catch { }
    # Fallback: localized / English group name.  0x547D 0x4EE4 0x884C 0x7A97 0x53E3 = "command window" in zh-CN.
    $localizedCommandWindowName = ConvertFrom-CodePoints @(0x547D, 0x4EE4, 0x884C, 0x7A97, 0x53E3)
    foreach ($name in @($localizedCommandWindowName, 'Command Window')) {
        try {
            $cond = New-Object System.Windows.Automation.PropertyCondition(
                [System.Windows.Automation.AutomationElement]::NameProperty, $name)
            $candidates = $WindowElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
            foreach ($candidate in $candidates) {
                if ($candidate.Current.ControlType -eq [System.Windows.Automation.ControlType]::Group) { return $candidate }
            }
        }
        catch { }
    }
    return $null
}

function Get-CommandWindowText {
    param($WrapperElement)
    if ($null -eq $WrapperElement) { return '' }
    $builder = New-Object System.Text.StringBuilder
    try {
        # Text + Hyperlink, pre-order (UIA FindAll returns tree order).  Hyperlink names carry
        # the inline link text that older rich-text console output renders as separate spans
        # (without them the source locations / function names in warnings would be missing).
        $textCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Text)
        $linkCond = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Hyperlink)
        $condition = [System.Windows.Automation.OrCondition]::new($textCond, $linkCond)
        $textElements = $WrapperElement.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
        foreach ($element in $textElements) {
            $isHyperlink = $false
            try { $isHyperlink = ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Hyperlink) } catch { }
            $fragment = $null
            try {
                $tp = $null
                if ($element.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
                    $fragment = [string]$tp.DocumentRange.GetText(-1)
                }
            }
            catch { $fragment = $null }
            if ([string]::IsNullOrEmpty($fragment)) {
                try { $fragment = [string]$element.Current.Name } catch { $fragment = $null }
            }
            if ([string]::IsNullOrEmpty($fragment)) { continue }
            if ($isHyperlink) {
                Add-ConsoleFragment -Builder $builder -Fragment $fragment -Inline
            }
            else {
                Add-ConsoleFragment -Builder $builder -Fragment $fragment
            }
        }
    }
    catch { }
    $text = $builder.ToString()
    $text = $text -replace "`n{3,}", "`n`n"
    $lines = @($text -split "`n" | ForEach-Object { $_.TrimEnd() })
    return ($lines -join "`n").Trim()
}

# ---------------------------------------------------------------------------
# Warnings
# ---------------------------------------------------------------------------

function Get-WarningLines {
    param([string[]]$Texts)
    $result = New-Object System.Collections.Generic.List[string]
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    # Chinese keywords: \u8B66\u544A=warning, \u9519\u8BEF=error, \u5931\u8D25=failed, \u5F02\u5E38=exception.
    $signal = '(?i)\u8B66\u544A|\u9519\u8BEF|\u5931\u8D25|\u5F02\u5E38|error|warning|failed|exception'
    foreach ($text in $Texts) {
        if ([string]::IsNullOrEmpty($text)) { continue }
        foreach ($rawLine in ($text -split "`n")) {
            $line = $rawLine.Trim()
            if ($line.Length -lt 2) { continue }
            if ($line -notmatch $signal) { continue }
            # Drop a bare keyword line ("warning:" with no content).
            if ($line -match '^(?:\u8B66\u544A|\u9519\u8BEF|error|warning|failed|exception)\s*[:\uFF1A]?\s*$') { continue }
            # Skip pure source-location / stack lines.  \u4F4D\u7F6E = "location".
            if ($line -match '^(?:\u4F4D\u7F6E|> ?\u4F4D\u7F6E|at)\s*[:\uFF1A]') { continue }
            if ($line -match '^\u4F4D\u7F6E\s*:') { continue }
            if ($line -match '\u8C03\u7528\u5806\u6808|Call stack|Error in .* \(line ') { continue }
            if ($line.Length -gt 400) { $line = $line.Substring(0, 400) }
            if ($seen.Add($line)) {
                $result.Add($line)
                if ($result.Count -ge 40) { return $result }
            }
        }
    }
    return $result
}

# ===========================================================================
# 1. Native interop (windows + PrintWindow)
# ===========================================================================

# Guarded so the script can also be dot-sourced twice in one PowerShell session.
if (-not ('MfNative' -as [type])) {
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies 'System.Drawing' @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class MfWindowInfo {
    public long Hwnd;
    public uint Pid;
    public string Title;
    public string ClassName;
    public bool Visible;
    public bool Minimized;
    public int X;
    public int Y;
    public int Width;
    public int Height;
    public bool HasRect;
}

public static class MfNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static MfWindowInfo[] ListWindows(uint[] pids) {
        var list = new List<MfWindowInfo>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            bool matches = false;
            foreach (uint p in pids) { if (p == pid) { matches = true; break; } }
            if (!matches) { return true; }

            var title = new StringBuilder(1024);
            GetWindowText(hWnd, title, 1024);
            var cls = new StringBuilder(512);
            GetClassName(hWnd, cls, 512);
            RECT rect;
            bool hasRect = GetWindowRect(hWnd, out rect);

            var info = new MfWindowInfo();
            info.Hwnd = hWnd.ToInt64();
            info.Pid = pid;
            info.Title = title.ToString();
            info.ClassName = cls.ToString();
            info.Visible = IsWindowVisible(hWnd);
            info.Minimized = IsIconic(hWnd);
            info.HasRect = hasRect;
            if (hasRect) {
                info.X = rect.Left;
                info.Y = rect.Top;
                info.Width = rect.Right - rect.Left;
                info.Height = rect.Bottom - rect.Top;
            }
            list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list.ToArray();
    }

    public static bool CaptureToPng(long hwnd, string path, int width, int height) {
        bool printed = false;
        using (var bitmap = new System.Drawing.Bitmap(width, height, System.Drawing.Imaging.PixelFormat.Format32bppArgb)) {
            using (var graphics = System.Drawing.Graphics.FromImage(bitmap)) {
                IntPtr hdc = graphics.GetHdc();
                try { printed = PrintWindow(new IntPtr(hwnd), hdc, 2); }
                finally { graphics.ReleaseHdc(hdc); }
            }
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
        return printed;
    }
}
"@
}

# ===========================================================================
# 2. MATLAB processes
# ===========================================================================

$matlabProcesses = @(Get-Process -Name MATLAB -ErrorAction SilentlyContinue)
if ($matlabProcesses.Count -eq 0) {
    Write-Stderr 'No MATLAB process was found (Get-Process -Name MATLAB). Start MATLAB and retry.'
    exit 2
}

$processIds = @($matlabProcesses | ForEach-Object { [uint32]$_.Id })

# Command lines via a single CIM query; best effort - failure must not break capture.
$commandLines = @{}
try {
    $cimProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'MATLAB.exe'" -ErrorAction Stop)
    foreach ($cim in $cimProcesses) {
        try { $commandLines[[uint32]$cim.ProcessId] = [string]$cim.CommandLine } catch { }
    }
}
catch {
    Write-Stderr ("Warning: could not read MATLAB command lines: " + $_.Exception.Message)
}

$processEntries = New-Object System.Collections.Generic.List[object]
foreach ($proc in $matlabProcesses) {
    $pidValue = [int]$proc.Id
    $commandLine = ''
    if ($commandLines.ContainsKey([uint32]$pidValue)) { $commandLine = [string]$commandLines[[uint32]$pidValue] }
    $entry = [ordered]@{ pid = $pidValue; commandLine = $commandLine }
    $processEntries.Add($entry)
}

# ===========================================================================
# 3. Top-level window discovery / filtering / roles
# ===========================================================================

$excludePattern = 'IME|MSCTFIME UI|GDI\+ Hook Window Class|DDEMLEvent|DDEMLMom|WorkerW|Qt681MW_|Chrome_WidgetWin_|Base_PowerMessageWindow|Client_TempWindow|tempWindow|PnP|tooltip|Opening\.\.\.'

$rawWindows = @([MfNative]::ListWindows([uint32[]]$processIds))
$candidates = New-Object System.Collections.Generic.List[object]
$seenWindowKeys = New-Object 'System.Collections.Generic.HashSet[string]'

foreach ($raw in $rawWindows) {
    if ($raw.ClassName -cne 'WindowClass') { continue }
    if (-not $raw.Visible) { continue }
    $title = [string]$raw.Title
    if ($null -eq $title) { $title = '' }
    $title = $title.Trim()
    if ([string]::IsNullOrWhiteSpace($title)) { continue }
    if ($title -match $excludePattern) { continue }
    if ($raw.ClassName -match $excludePattern) { continue }

    $key = ("{0}|{1}" -f $raw.Pid, $title)
    if (-not $seenWindowKeys.Add($key)) { continue }

    $role = 'figure'
    if ($title -match '^MATLAB R\d{4}[ab]$') {
        $role = 'desktop'
    }
    elseif ($title -match 'SPM' -and $title -match 'Graphics') {
        $role = 'qc-figure'
    }
    elseif ($title -match 'DPARSF' -or $title -match 'DPABI') {
        $role = 'pipeline-gui'
    }

    $roleRank = 4
    switch ($role) {
        'qc-figure' { $roleRank = 0 }
        'pipeline-gui' { $roleRank = 1 }
        'figure' { $roleRank = 2 }
        'desktop' { $roleRank = 3 }
        'other' { $roleRank = 4 }
    }

    $candidates.Add([pscustomobject]@{
        Hwnd      = [long]$raw.Hwnd
        Pid       = [int]$raw.Pid
        Title     = $title
        Role      = $role
        RoleRank  = $roleRank
        Minimized = [bool]$raw.Minimized
        X         = [int]$raw.X
        Y         = [int]$raw.Y
        Width     = [int]$raw.Width
        Height    = [int]$raw.Height
        HasRect   = [bool]$raw.HasRect
    })
}

if ($candidates.Count -eq 0) {
    Write-Stderr ("MATLAB process(es) found (PID: " + ($processIds -join ', ') + "), but no visible MATLAB 'WindowClass' top-level window was found.")
    exit 2
}

$orderedWindows = @($candidates | Sort-Object -Property @{ Expression = { $_.RoleRank } }, @{ Expression = { $_.Title } })

# ===========================================================================
# 4. UI Automation (window text + command window text)
# ===========================================================================

try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $script:UiaAvailable = $true
}
catch {
    Write-Stderr ('Warning: UI Automation is not available; continuing without text (' + $_.Exception.GetType().Name + ').')
}

$rootChildren = $null
if ($script:UiaAvailable) {
    try {
        $root = [System.Windows.Automation.AutomationElement]::RootElement
        $rootChildren = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    }
    catch { $rootChildren = $null }
}

$windowCount = $orderedWindows.Count
$windowElements = New-Object 'object[]' $windowCount
$documentTexts = New-Object 'string[]' $windowCount
$selectedLabels = New-Object 'object[]' $windowCount
for ($i = 0; $i -lt $windowCount; $i++) {
    $documentTexts[$i] = ''
    $selectedLabels[$i] = New-Object System.Collections.Generic.List[string]
}

$consoleWrapper = $null
$consoleWindowIndex = -1
$consoleText = ''
$consoleTextSource = 'none'

if ($script:UiaAvailable) {
    # Resolve UIA elements first (per-window try/catch).
    for ($i = 0; $i -lt $windowCount; $i++) {
        try {
            $windowElements[$i] = Get-UiaWindowElement -Hwnd $orderedWindows[$i].Hwnd -ProcessId ([uint32]$orderedWindows[$i].Pid) -Title $orderedWindows[$i].Title -RootChildren $rootChildren
        }
        catch {
            $windowElements[$i] = $null
        }
    }

    # Locate the command window wrapper. Desktop windows first: the command window
    # normally lives in the minimized main window and UIA still exposes it.
    $searchOrder = @()
    foreach ($desktopFirst in $true, $false) {
        for ($i = 0; $i -lt $windowCount; $i++) {
            if (($orderedWindows[$i].Role -eq 'desktop') -eq $desktopFirst) { $searchOrder += $i }
        }
    }
    foreach ($i in $searchOrder) {
        if ($null -eq $windowElements[$i]) { continue }
        try {
            $wrapper = Find-CommandWindowWrapper -WindowElement $windowElements[$i]
            if ($null -ne $wrapper) {
                $consoleWrapper = $wrapper
                $consoleWindowIndex = $i
                break
            }
        }
        catch { }
    }

    if ($null -ne $consoleWrapper) {
        try {
            $consoleText = Get-CommandWindowText -WrapperElement $consoleWrapper
            if (-not [string]::IsNullOrWhiteSpace($consoleText)) { $consoleTextSource = 'uia-commandwindow' }
        }
        catch { }
        # The command window lives in the desktop (main) window; label it accordingly.
        if ($consoleWindowIndex -ge 0 -and $orderedWindows[$consoleWindowIndex].Role -ne 'desktop') {
            $orderedWindows[$consoleWindowIndex].Role = 'desktop'
        }
    }

    if ($Mode -eq 'all') {
        for ($i = 0; $i -lt $windowCount; $i++) {
            if ($null -eq $windowElements[$i]) { continue }
            try {
                $documentTexts[$i] = Get-WindowDocumentText -WindowElement $windowElements[$i]
            }
            catch { $documentTexts[$i] = '' }
            try {
                $labels = Get-SelectedControlLabels -WindowElement $windowElements[$i]
                if ($null -ne $labels -and $labels.Count -gt 0) { $selectedLabels[$i] = $labels }
            }
            catch { }
        }
    }
}

# ===========================================================================
# 5. Screenshots (only in Mode=all)
# ===========================================================================

$screenshots = New-Object 'object[]' $windowCount
for ($i = 0; $i -lt $windowCount; $i++) { $screenshots[$i] = $null }

$outDirResolved = $OutDir
try {
    $outDirResolved = [System.IO.Path]::GetFullPath($OutDir)
    if (-not (Test-Path -LiteralPath $outDirResolved -PathType Container)) {
        New-Item -ItemType Directory -Force -Path $outDirResolved | Out-Null
    }
}
catch {
    Write-Stderr ("Cannot create output directory '" + $OutDir + "': " + $_.Exception.Message)
    exit 1
}

if ($Mode -eq 'all') {
    for ($i = 0; $i -lt $windowCount; $i++) {
        $win = $orderedWindows[$i]
        if ($win.Minimized) { continue }
        if (-not $win.HasRect) { continue }
        if ($win.X -le -30000 -or $win.Y -le -30000) { continue }
        if ($win.Width -lt 80 -or $win.Height -lt 80) { continue }

        $windowId = ('w{0}' -f ($i + 1))
        $fileName = ('{0}-{1}.png' -f $windowId, (Get-SafeFileBase -Title $win.Title))
        $path = Join-Path $outDirResolved $fileName
        try {
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
            $printed = [MfNative]::CaptureToPng($win.Hwnd, $path, $win.Width, $win.Height)
            if ((Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt 0)) {
                $fileInfo = Get-Item -LiteralPath $path
                $screenshots[$i] = [ordered]@{
                    file   = $fileName
                    bytes  = [int]$fileInfo.Length
                    width  = [int]$win.Width
                    height = [int]$win.Height
                }
                if (-not $printed) {
                    Write-Stderr ("Warning: PrintWindow returned false for '" + $win.Title + "' but a PNG was written; keeping it.")
                }
            }
            else {
                if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
                $screenshots[$i] = $null
            }
        }
        catch {
            try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue } } catch { }
            $screenshots[$i] = $null
        }
    }
}

# ===========================================================================
# 6. Assemble manifest
# ===========================================================================

$windowEntries = New-Object System.Collections.Generic.List[object]
$textsForWarnings = New-Object System.Collections.Generic.List[string]
if (-not [string]::IsNullOrWhiteSpace($consoleText)) { $textsForWarnings.Add($consoleText) }

for ($i = 0; $i -lt $windowCount; $i++) {
    $win = $orderedWindows[$i]
    $windowId = ('w{0}' -f ($i + 1))

    $text = $documentTexts[$i]
    if ($null -eq $text) { $text = '' }
    if ($Mode -eq 'all' -and $selectedLabels[$i].Count -gt 0) {
        $selectedBlock = ($selectedLabels[$i] | ForEach-Object { '- ' + $_ }) -join "`n"
        if ([string]::IsNullOrEmpty($text)) {
            $text = "[selected radio/combo values]`n" + $selectedBlock
        }
        else {
            $text = $text.TrimEnd() + "`n`n[selected radio/combo values]`n" + $selectedBlock
        }
    }
    $text = ConvertTo-NormalizedText -Text $text

    $limited = Limit-Text -Text $text -MaxChars $MaxTextChars
    $textSource = 'none'
    if (-not $script:UiaAvailable) { $textSource = 'none' }
    elseif (-not [string]::IsNullOrEmpty($limited.Text)) { $textSource = 'uia-document' }

    $screenshot = $screenshots[$i]

    $entry = [ordered]@{
        id            = $windowId
        title         = $win.Title
        role          = $win.Role
        hwnd          = [string]$win.Hwnd
        pid           = [int]$win.Pid
        visible       = $true
        minimized     = [bool]$win.Minimized
        rect          = [ordered]@{ x = [int]$win.X; y = [int]$win.Y; width = [int]$win.Width; height = [int]$win.Height }
        screenshot    = $screenshot
        text          = $limited.Text
        textSource    = $textSource
        textTruncated = [bool]$limited.Truncated
    }
    $windowEntries.Add($entry)
    if (-not [string]::IsNullOrWhiteSpace($limited.Text)) { $textsForWarnings.Add($limited.Text) }
}

$consoleLimited = Limit-Text -Text $consoleText -MaxChars $MaxConsoleChars -KeepTail
$consoleEntry = [ordered]@{
    windowId   = $null
    title      = $null
    text       = $consoleLimited.Text
    textSource = $consoleTextSource
    truncated  = [bool]$consoleLimited.Truncated
}
if ($consoleWindowIndex -ge 0) {
    $consoleEntry.windowId = ('w{0}' -f ($consoleWindowIndex + 1))
    $consoleEntry.title = $orderedWindows[$consoleWindowIndex].Title
}

$warningLines = @(Get-WarningLines -Texts ([string[]]$textsForWarnings.ToArray()))

$script:Stopwatch.Stop()
# NOTE: do not use @($genericList) here: Windows PowerShell 5.1 has a dynamic-binder
# bug ("Argument types do not match") for the array subexpression over a List[object].
$manifest = [ordered]@{
    schemaVersion    = 1
    capturedAt       = $script:StartedAt.ToString('yyyy-MM-ddTHH:mm:ss.fffzzz')
    durationMs       = [int]$script:Stopwatch.ElapsedMilliseconds
    matlabProcesses  = $processEntries.ToArray()
    windows          = $windowEntries.ToArray()
    console          = $consoleEntry
    warnings         = @($warningLines)
}

try {
    $json = $manifest | ConvertTo-Json -Depth 8 -Compress
    $manifestPath = Join-Path $outDirResolved 'manifest.json'
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($manifestPath, $json, $utf8NoBom)
}
catch {
    Write-Stderr ("Failed to write manifest.json: " + $_.Exception.Message)
    exit 1
}

exit 0
