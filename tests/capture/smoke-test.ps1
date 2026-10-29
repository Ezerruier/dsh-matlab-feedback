# Smoke test for the MATLAB capture script (read-only)
#
# Runs the bundled capture script against the MATLAB session that is currently
# running on this Windows machine, then validates the produced manifest.json and
# PNG files. It never clicks, focuses, moves, restores or closes MATLAB windows.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/capture/smoke-test.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/capture/smoke-test.ps1 -ConsoleMode
#
# Exit codes: 0 = pass, 1 = validation failed, 2 = no running MATLAB session.

[CmdletBinding()]
param(
  [string]$OutDir = (Join-Path $env:TEMP ('matlab-feedback-smoke-' + [guid]::NewGuid().ToString('N'))),
  [switch]$ConsoleMode
)

$ErrorActionPreference = 'Stop'

function Write-Pass([string]$Message) { Write-Host "[PASS] $Message" }
function Write-Fail([string]$Message) { Write-Host "[FAIL] $Message"; $script:failed = $true }

$script:failed = $false

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$captureScript = Join-Path $repoRoot 'scripts\matlab-feedback.ps1'
if (-not (Test-Path -LiteralPath $captureScript)) {
  throw "capture script not found: $captureScript"
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powershell)) { $powershell = 'powershell.exe' }

$mode = if ($ConsoleMode) { 'console' } else { 'all' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Host "capture script : $captureScript"
Write-Host "output dir     : $OutDir"
Write-Host "mode           : $mode"

$started = Get-Date
& $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $captureScript -OutDir $OutDir -Mode $mode
$exitCode = $LASTEXITCODE
$elapsed = ((Get-Date) - $started).TotalMilliseconds
Write-Host ("capture exit   : {0} ({1:N0} ms)" -f $exitCode, $elapsed)

if ($exitCode -eq 2) {
  Write-Host 'No running MATLAB session found. Start MATLAB (desktop) and rerun this smoke test.'
  exit 2
}
if ($exitCode -ne 0) {
  Write-Host "capture script failed with exit code $exitCode"
  exit 1
}

$manifestPath = Join-Path $OutDir 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { Write-Fail 'manifest.json exists'; exit 1 }

$raw = [System.IO.File]::ReadAllBytes($manifestPath)
if ($raw.Length -ge 3 -and $raw[0] -eq 0xEF -and $raw[1] -eq 0xBB -and $raw[2] -eq 0xBF) {
  Write-Fail 'manifest.json is UTF-8 without BOM'
} else {
  Write-Pass 'manifest.json is UTF-8 without BOM'
}

$manifest = [System.IO.File]::ReadAllText($manifestPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
if ($manifest.schemaVersion -eq 1) { Write-Pass 'schemaVersion is 1' } else { Write-Fail "schemaVersion is 1 (got $($manifest.schemaVersion))" }

$windows = @($manifest.windows)
if ($windows.Count -ge 1) { Write-Pass "windows listed ($($windows.Count))" } else { Write-Fail 'at least one MATLAB window listed' }

$pngCount = 0
foreach ($window in $windows) {
  if ($null -eq $window.screenshot) { continue }
  $file = [string]$window.screenshot.file
  if ([string]::IsNullOrWhiteSpace($file)) { Write-Fail "window $($window.id) screenshot.file set"; continue }
  $pngPath = Join-Path $OutDir $file
  if (-not (Test-Path -LiteralPath $pngPath)) { Write-Fail "screenshot exists: $file"; continue }
  Add-Type -AssemblyName System.Drawing
  $image = [System.Drawing.Image]::FromFile($pngPath)
  try {
    $pngCount++
    if ($image.Width -eq $window.screenshot.width -and $image.Height -eq $window.screenshot.height) {
      Write-Pass ("screenshot {0} is {1}x{2} and matches manifest" -f $file, $image.Width, $image.Height)
    } else {
      Write-Fail ("screenshot {0} dimensions {1}x{2} != manifest {3}x{4}" -f $file, $image.Width, $image.Height, $window.screenshot.width, $window.screenshot.height)
    }
  } finally {
    $image.Dispose()
  }
}
if ($mode -eq 'console' -and $pngCount -ne 0) { Write-Fail 'console mode writes no PNG' }

$consoleText = if ($null -ne $manifest.console) { [string]$manifest.console.text } else { '' }
if ($ConsoleMode) {
  if ($consoleText.Trim().Length -gt 0) { Write-Pass "console text readable ($($consoleText.Length) chars)" } else { Write-Fail 'console text readable' }
}

Write-Host ''
if ($script:failed) {
  Write-Host 'SMOKE TEST FAILED'
  exit 1
}
Write-Host ("SMOKE TEST PASSED ({0} window(s), {1} screenshot(s))" -f $windows.Count, $pngCount)
exit 0
