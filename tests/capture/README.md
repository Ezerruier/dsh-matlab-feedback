# Capture smoke test

`smoke-test.ps1` runs the bundled read-only capture script against the MATLAB
session currently open on this Windows machine and validates the result.

Requirements:

- Windows 10/11 with Windows PowerShell 5.1;
- a running MATLAB desktop session (`matlab.exe`) for the current user.

Usage:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/capture/smoke-test.ps1
# console-only mode (no screenshots):
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/capture/smoke-test.ps1 -ConsoleMode
```

What it checks:

- the capture script exits 0 (or 2 when no MATLAB session exists);
- `manifest.json` is UTF-8 without BOM and has `schemaVersion: 1`;
- at least one MATLAB window is listed;
- every recorded screenshot exists and its pixel dimensions match the manifest;
- console mode writes no PNGs and (`-ConsoleMode`) reads non-empty console text.

The script is strictly read-only: it never clicks, types, focuses, moves,
restores or closes MATLAB windows. Output goes to a fresh directory under
`%TEMP%` unless `-OutDir` is given.
