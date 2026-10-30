# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-10-30

### Added

- `matlab_stage_code` Agent tool: writes **one line** of MATLAB code into the
  already-open Command Window and **never executes it** — the user reviews the
  line in MATLAB and presses Enter themselves (Esc discards it).
  - Focus is taken via MATLAB's Ctrl+0 shortcut and verified through UI
    Automation before any paste; the code is inserted with clipboard + Ctrl+V.
  - Safe by construction: empty/multi-line/oversized/NUL input is rejected,
    no Enter/Return key is ever sent, and staged input is read back from the
    command input element for verification.
  - Refuses to stage when the Command Window already contains unexecuted text,
    or when the window cannot be focused, instead of pasting blindly.
- `scripts/matlab-stage-code.ps1` (Windows PowerShell 5.1, ASCII-only) with
  machine-readable JSON statuses (`staged`, `draft-not-empty`, `focus-failed`,
  `paste-unverified`, `no-matlab`, ...).
- Nine new Host unit tests (35 total) covering staging validation, argv,
  payload parsing, status-to-error mapping and rendering.
- README/DESIGN sections explaining why Windows COM (`MATLAB.Application`) is
  not usable for this workflow and documenting the verified keyboard-level
  staging channel.

### Changed

- Plugin version bumped to 0.2.0; `files` now ships both PowerShell scripts.
- README feature table, architecture sketch, safety guarantees and limitations
  updated for the staged-execution workflow.

## [0.1.0] - 2026-10-30

### Added

- Host half with two Agent tools:
  - `matlab_snapshot` — captures every visible MATLAB window as a PNG, returns the
    screenshots as inline image attachments together with the window list, the
    command-window text tail, and extracted warnings/errors;
  - `matlab_console` — command-window text only (faster, no screenshots).
- Client half: a compact "MATLAB snapshot" button in `conversation.input.left`
  that inserts a preset prompt into the composer (never auto-submits).
- Read-only Windows capture engine (`scripts/matlab-feedback.ps1`,
  Windows PowerShell 5.1): window enumeration + `PrintWindow` screenshots +
  UI Automation text, UTF-8 (no BOM) `manifest.json` with schema version 1,
  per-window graceful degradation, and exit code 2 when no MATLAB session exists.
- Deterministic run directories under `<workspace>/.dsh-matlab-feedback/<runId>/`
  with automatic pruning (latest 20 runs kept).
- Optional attachment degradation: when no attachment service is mounted the
  tools return text plus absolute PNG paths for `read_image`.
- Fixture-based Host unit tests (27 cases) that do not require MATLAB, a real
  end-to-end dry-run script, and a read-only capture smoke test.
- Documentation: `README.md`, `docs/DESIGN.md`, and an architecture diagram
  (`docs/flow.png`) that contains no real subject data.
- GitHub Actions CI workflow (Node 22/24) and MIT license.

### Verified

- End-to-end against a live MATLAB R2026a + DPARSF/SPM QC session on Windows 11
  with DSH Desktop 0.2.1-rc.3: window screenshots, QC control text/selected radio
  state, command-window log lines and warnings were all captured read-only.

[0.1.0]: https://github.com/Ezerruier/dsh-matlab-feedback/releases/tag/v0.1.0
