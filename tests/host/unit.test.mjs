import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';

import {
  apply,
  inject,
  buildCaptureArguments,
  buildStageArguments,
  decodePowerShellOutput,
  formatStageText,
  normalizeManifest,
  normalizeConsoleLines,
  normalizeStageCode,
  parseStagePayload,
  previewText,
  pruneRunRoot,
  renderConsole,
  renderSnapshot,
  renderStage,
  resolvePowerShellPath,
  runCapture,
  runStageCode,
  selectImageWindows,
  tailByLines,
  tailChars,
  formatConsoleText,
  formatSnapshotText,
  CAPTURE_TIMEOUT_MS,
  CONSOLE_DESCRIPTION,
  KEEP_RUNS,
  MAX_IMAGES,
  NO_MATLAB_MESSAGE,
  SNAPSHOT_DESCRIPTION,
  STAGE_CODE_DESCRIPTION,
  STAGED_NOT_EXECUTED_NOTE,
  SYSTEM_PROMPT,
} from '../../index.mjs';

import {createFakeHost, fakeExec} from './fake-host.mjs';
import {sampleManifest, sampleManifestJson, sampleSnapshotValue} from './fixture.mjs';

/* ------------------------------------------------------------------ */
/* Fake child process helper for runCapture tests                      */
/* ------------------------------------------------------------------ */

function createFakeChild({exitCode = 0, stderrText = '', autoClose = 0, closeOnKill = true, emitError = null} = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  let closed = false;
  const close = (code, signal) => {
    if (closed) return;
    closed = true;
    child.emit('close', code, signal);
  };
  child.kill = () => {
    child.killed = true;
    if (closeOnKill) setTimeout(() => close(null, 'SIGTERM'), 2);
    return true;
  };
  if (stderrText) child.stderr.write(stderrText);
  if (emitError) setTimeout(() => child.emit('error', emitError), 1);
  else if (autoClose !== null) setTimeout(() => close(exitCode, exitCode === 0 ? null : 'SIGTERM'), autoClose);
  return child;
}

/* ------------------------------------------------------------------ */
/* Plugin surface                                                      */
/* ------------------------------------------------------------------ */

test('exports inject = ["tools"] and the SPEC tool descriptions', () => {
  assert.deepEqual(inject, ['tools']);
  assert.equal(
    SNAPSHOT_DESCRIPTION,
    'Capture the live MATLAB session on this Windows machine: real window screenshots plus the MATLAB command-window text, SPM/DPARSF figure text and QC values. Use it whenever the user asks about what MATLAB currently shows or prints (DPABI/DPARSF/SPM QC).',
  );
  assert.equal(
    CONSOLE_DESCRIPTION,
    'Read the live MATLAB command-window text (recent SPM/DPARSF output and warnings) without screenshots. Fast alternative to matlab_snapshot when only the console matters.',
  );
  assert.ok(STAGE_CODE_DESCRIPTION.includes('WITHOUT executing'));
  assert.ok(STAGE_CODE_DESCRIPTION.includes('never sends Enter'));
  assert.ok(STAGED_NOT_EXECUTED_NOTE.includes('NOT executed'));
  assert.ok(SYSTEM_PROMPT.length <= 900, `system prompt must be <= 900 chars, got ${SYSTEM_PROMPT.length}`);
  assert.ok(SYSTEM_PROMPT.includes('matlab_stage_code'));
});

test('apply registers all three tools, the prompt section and cleans up in reverse order', () => {
  const {ctx, state} = createFakeHost({workspaceRoot: 'C:\\fake-workspace'});
  const dispose = apply(ctx);
  assert.deepEqual(state.registrationOrder, ['matlab_snapshot', 'matlab_console', 'matlab_stage_code']);
  assert.equal(state.sections.length, 1);
  assert.equal(state.sections[0].name, 'dsh-matlab-feedback');
  assert.equal(state.sections[0].order, 9060);
  assert.equal(state.sections[0].text, SYSTEM_PROMPT);

  const snapshot = state.registrations.get('matlab_snapshot');
  assert.deepEqual(snapshot.parameters, {type: 'object', properties: {}, additionalProperties: false});
  assert.deepEqual(snapshot.output.schema, {type: 'object', additionalProperties: true});
  const consoleTool = state.registrations.get('matlab_console');
  assert.deepEqual(consoleTool.parameters, {
    type: 'object',
    properties: {lines: {type: 'integer', minimum: 10, maximum: 400, description: 'Number of trailing console lines to return (default 120).'}},
    additionalProperties: false,
  });
  const stageTool = state.registrations.get('matlab_stage_code');
  assert.equal(stageTool.description, STAGE_CODE_DESCRIPTION);
  assert.deepEqual(stageTool.parameters, {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        minLength: 1,
        maxLength: 8_000,
        description: 'One line of MATLAB code to place in the Command Window. Newlines are rejected; the code is NOT executed.',
      },
    },
    required: ['code'],
    additionalProperties: false,
  });

  dispose();
  assert.deepEqual(state.disposed, ['section:dsh-matlab-feedback', 'tool:matlab_stage_code', 'tool:matlab_console', 'tool:matlab_snapshot']);
});

test('apply still activates when every optional service is missing', () => {
  const {ctx, state} = createFakeHost({workspaceRoot: 'C:\\fake-workspace', attachments: false, systemPrompt: false, workingDirectory: false});
  const dispose = apply(ctx);
  assert.deepEqual(state.registrationOrder, ['matlab_snapshot', 'matlab_console', 'matlab_stage_code']);
  assert.equal(state.sections.length, 0);
  dispose();
});

test('matlab_snapshot rejects unknown arguments before spawning', async () => {
  const {ctx, state} = createFakeHost({workspaceRoot: 'C:\\fake-workspace'});
  apply(ctx);
  const snapshot = state.registrations.get('matlab_snapshot');
  await assert.rejects(snapshot.execute({unexpected: true}, fakeExec()), /unknown argument "unexpected"/);
});

test('matlab_console validates the lines argument before spawning', async () => {
  const {ctx, state} = createFakeHost({workspaceRoot: 'C:\\fake-workspace'});
  apply(ctx);
  const consoleTool = state.registrations.get('matlab_console');
  await assert.rejects(consoleTool.execute({lines: 5}, fakeExec()), /between 10 and 400/);
  await assert.rejects(consoleTool.execute({lines: 'many'}, fakeExec()), /between 10 and 400/);
});

test('decodePowerShellOutput decodes UTF-8 and falls back to GBK stderr bytes', () => {
  assert.equal(decodePowerShellOutput(Buffer.from('警告: 测试', 'utf8')), '警告: 测试');
  const gbkWarning = Buffer.from([0xbe, 0xaf, 0xb8, 0xe6, 0x3a, 0x20, 0xb2, 0xe2, 0xca, 0xd4]);
  assert.equal(decodePowerShellOutput(gbkWarning), '警告: 测试');
  assert.equal(decodePowerShellOutput(Buffer.alloc(0)), '');
});

/* ------------------------------------------------------------------ */
/* Capture invocation                                                  */
/* ------------------------------------------------------------------ */

test('buildCaptureArguments produces the documented PowerShell 5.1 argv', () => {
  const args = buildCaptureArguments({scriptPath: 'C:\\bundle\\scripts\\matlab-feedback.ps1', outDir: 'C:\\work\\run-1', mode: 'all'});
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\bundle\\scripts\\matlab-feedback.ps1',
    '-OutDir',
    'C:\\work\\run-1',
    '-Mode',
    'all',
  ]);
  assert.equal(buildCaptureArguments({outDir: 'C:\\x', mode: 'console'}).at(-1), 'console');
  assert.throws(() => buildCaptureArguments({outDir: '', mode: 'all'}), /outDir is required/);
  assert.throws(() => buildCaptureArguments({outDir: 'C:\\x', mode: 'bogus'}), /Unsupported MATLAB capture mode/);
});

test('resolvePowerShellPath prefers System32 and falls back to PATH', () => {
  // path.join keeps the assertion portable: this helper is Windows-only, but the
  // unit tests also run on Linux in CI.
  const expected = path.join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  assert.equal(resolvePowerShellPath({systemRoot: 'C:\\Windows', exists: () => true}), expected);
  assert.equal(resolvePowerShellPath({systemRoot: 'C:\\Windows', exists: () => false}), 'powershell.exe');
  assert.equal(resolvePowerShellPath({systemRoot: '', exists: () => true}), 'powershell.exe');
});

test('runCapture rejects with NO_SCRIPT when the capture script is missing', async () => {
  await assert.rejects(
    runCapture({outDir: 'C:\\work\\run-missing-script', scriptPath: 'C:\\definitely-missing\\matlab-feedback.ps1', signal: new AbortController().signal}),
    (error) => error.kind === 'NO_SCRIPT' && /capture script is missing/.test(error.message),
  );
});

test('runCapture resolves on exit code 0 and reports timeout / no-MATLAB / failure', async () => {
  const run = (child, timeoutMs = 2_000) =>
    runCapture({
      outDir: 'C:\\work\\run-1',
      scriptPath: 'C:\\bundle\\scripts\\matlab-feedback.ps1',
      checkScript: false,
      timeoutMs,
      spawnImpl: () => child,
      powershellPath: 'powershell.exe',
      signal: new AbortController().signal,
    });

  const ok = await run(createFakeChild({exitCode: 0}));
  assert.equal(ok.code, 0);

  await assert.rejects(
    run(createFakeChild({exitCode: 2})),
    (error) => error.kind === 'NO_MATLAB' && error.message === NO_MATLAB_MESSAGE,
  );

  await assert.rejects(
    run(createFakeChild({exitCode: 1, stderrText: 'boom: UIA failed'})),
    (error) => error.kind === 'FAILED' && /exit code 1/.test(error.message) && /stderr: boom: UIA failed/.test(error.message),
  );

  await assert.rejects(
    run(createFakeChild({autoClose: null, closeOnKill: true}), 40),
    (error) => error.kind === 'TIMEOUT' && new RegExp(`timed out after 40 ms`).test(error.message),
  );

  await assert.rejects(
    run(createFakeChild({emitError: new Error('spawn ENOENT')})),
    (error) => error.kind === 'SPAWN' && /spawn ENOENT/.test(error.message),
  );
});

test('runCapture honors exec.signal abort', async () => {
  const controller = new AbortController();
  const result = runCapture({
    outDir: 'C:\\work\\run-abort',
    scriptPath: 'C:\\bundle\\scripts\\matlab-feedback.ps1',
    checkScript: false,
    spawnImpl: () => createFakeChild({autoClose: null}),
    powershellPath: 'powershell.exe',
    signal: controller.signal,
  });
  const reason = new Error('user cancelled');
  reason.name = 'AbortError';
  controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
});

/* ------------------------------------------------------------------ */
/* Manifest normalization                                              */
/* ------------------------------------------------------------------ */

test('normalizeManifest maps the documented schema and defaults', () => {
  const manifest = normalizeManifest(sampleManifest());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.capturedAt, '2026-10-29T22:30:00.000+08:00');
  assert.equal(manifest.durationMs, 3210);
  assert.equal(manifest.matlabProcesses.length, 2);
  assert.equal(manifest.windows.length, 5);
  const qc = manifest.windows[0];
  assert.equal(qc.id, 'w1');
  assert.equal(qc.role, 'qc-figure');
  assert.equal(qc.rect.width, 703);
  assert.equal(qc.screenshot.file, 'w1-SPM26_Graphics.png');
  assert.equal(qc.textSource, 'uia-document');
  assert.match(qc.text, /QC Score: 5 - Very Good/);
  assert.equal(manifest.windows[2].minimized, true);
  assert.equal(manifest.windows[2].screenshot, null);
  assert.equal(manifest.console.windowId, 'w3');
  assert.match(manifest.console.text, /Realign: Estimate & Reslice/);
  assert.equal(manifest.warnings.length, 2);
});

test('normalizeManifest accepts the JSON text form and rejects bad documents', () => {
  assert.equal(normalizeManifest(JSON.parse(sampleManifestJson())).windows.length, 5);
  assert.throws(() => normalizeManifest(null), (error) => error.kind === 'BAD_MANIFEST');
  assert.throws(() => normalizeManifest([]), (error) => error.kind === 'BAD_MANIFEST');
  assert.throws(() => normalizeManifest({schemaVersion: 2, windows: []}), /schemaVersion/);
});

test('normalizeManifest sanitizes screenshot names, role and warning lists', () => {
  const raw = sampleManifest();
  raw.windows[0].screenshot.file = '..\\evil.png';
  raw.windows[1].role = 'not-a-role';
  raw.windows[1].textSource = 'weird-source';
  raw.windows[1].rect = null;
  raw.warnings = [
    '警告: A',
    '警告: A',
    '错误: B',
    ...Array.from({length: 50}, (_, index) => `警告: extra ${index}`),
  ];
  const manifest = normalizeManifest(raw);
  assert.equal(manifest.windows[0].screenshot.file, 'evil.png');
  assert.equal(manifest.windows[1].role, 'other');
  assert.equal(manifest.windows[1].textSource, 'none');
  // rect fallback recovers the dimensions from the screenshot record.
  assert.equal(manifest.windows[1].rect.width, 817);
  assert.equal(manifest.windows[1].rect.height, 909);
  assert.equal(manifest.warnings.length, 40);
  assert.equal(manifest.warnings[0], '警告: A');
  assert.equal(manifest.warnings[1], '错误: B');
});

/* ------------------------------------------------------------------ */
/* Image-window priority                                               */
/* ------------------------------------------------------------------ */

test('selectImageWindows ranks qc-figure > pipeline-gui > figure > desktop > other and caps at MAX_IMAGES', () => {
  const windows = normalizeManifest(sampleManifest()).windows;
  const selected = selectImageWindows(windows);
  assert.deepEqual(selected.map((window) => window.id), ['w1', 'w2', 'w4', 'w5']);
  assert.ok(selected.length <= MAX_IMAGES);
  assert.deepEqual(selectImageWindows(windows, 2).map((window) => window.id), ['w1', 'w2']);
  // Minimized windows (w3) never make the image cut, even with a screenshot record.
  assert.ok(!selected.some((window) => window.minimized));
});

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

test('tailChars keeps the tail and reports truncation', () => {
  assert.deepEqual(tailChars('short', 100), {text: 'short', truncated: false});
  const cut = tailChars('line1\nline2\nline3', 8);
  assert.equal(cut.truncated, true);
  assert.equal(cut.text, 'line3');
  const exact = tailChars('abcdef', 3);
  assert.deepEqual(exact, {text: 'def', truncated: true});
  assert.deepEqual(tailChars('', 10), {text: '', truncated: false});
});

test('tailByLines returns the last N lines with totals', () => {
  assert.deepEqual(tailByLines('a\nb\nc\n', 2), {text: 'b\nc', totalLines: 3, returnedLines: 2});
  assert.deepEqual(tailByLines('a\nb', 10), {text: 'a\nb', totalLines: 2, returnedLines: 2});
  assert.deepEqual(tailByLines('', 5), {text: '', totalLines: 0, returnedLines: 0});
  assert.deepEqual(tailByLines('only', 1), {text: 'only', totalLines: 1, returnedLines: 1});
});

test('previewText flattens whitespace and truncates at the limit', () => {
  assert.equal(previewText('a\r\n\tb   c'), 'a b c');
  assert.equal(previewText('x'.repeat(20), 10).length, 10);
  assert.equal(previewText(''), '');
});

test('normalizeConsoleLines clamps to the documented 10–400 range', () => {
  assert.equal(normalizeConsoleLines(undefined), 120);
  assert.equal(normalizeConsoleLines(null), 120);
  assert.equal(normalizeConsoleLines(10), 10);
  assert.equal(normalizeConsoleLines(400), 400);
  assert.throws(() => normalizeConsoleLines(9), /between 10 and 400/);
  assert.throws(() => normalizeConsoleLines(401), /between 10 and 400/);
  assert.throws(() => normalizeConsoleLines(12.5), /between 10 and 400/);
});

/* ------------------------------------------------------------------ */
/* Render formatting                                                   */
/* ------------------------------------------------------------------ */

test('formatSnapshotText includes header, window list, console tail and warnings', () => {
  const text = formatSnapshotText(sampleSnapshotValue());
  assert.match(text, /^MATLAB live snapshot — captured 2026-10-29T22:30:00.000\+08:00 \(capture 3\.21 s\)/);
  assert.match(text, /Run: run-2026-10-29T22-30-00-000Z-test01 \| outDir: C:\\work/);
  assert.match(text, /MATLAB processes: 1 \(pid 4242\)/);
  assert.match(text, /Windows: 2/);
  assert.match(text, /\[qc-figure\] w1 "SPM26 \(00\.00\): Graphics" 703x1051 minimized=no screenshot=yes text=uia-document\(120 chars\)/);
  assert.match(text, /\[desktop\] w3 "MATLAB R2026a" 1600x900 minimized=yes screenshot=no/);
  assert.match(text, /Command window \(48 chars; full text: C:\\work/);
  assert.match(text, /Realign: Estimate & Reslice/);
  assert.match(text, /Warnings \(1\):/);
  assert.match(text, /警告: 使用 parfor/);
  assert.match(text, /Screenshots: 1 image block\(s\) follow/);
});

test('formatSnapshotText marks truncation and falls back to absolute PNG paths without attachments', () => {
  const value = sampleSnapshotValue({
    consoleTruncated: true,
    consoleChars: 6000,
    consoleTotalChars: 21034,
    attachmentsAvailable: false,
    images: sampleSnapshotValue().images.map((image) => ({...image, attachment: null, error: 'no attachment service is mounted'})),
  });
  const text = formatSnapshotText(value);
  assert.match(text, /kept last 6000 of 21034 chars/);
  assert.match(text, /image attachments are unavailable in this session; call read_image/);
  assert.match(text, /C:\\work\\\.dsh-matlab-feedback\\run-test\\w1-SPM26_Graphics\.png/);
});

test('renderSnapshot returns the text block plus per-image text and image blocks', () => {
  const blocks = renderSnapshot(sampleSnapshotValue());
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /^Screenshot: SPM26 \(00\.00\): Graphics \(703×1051, path=C:\\work/);
  assert.equal(blocks[2].type, 'image');
  assert.equal(blocks[2].attachment.attachmentId, 'att-fixture-1');
  assert.equal(blocks[2].attachment.mediaType, 'image/png');
  assert.equal(blocks[2].attachment.width, 703);
  assert.equal(blocks[2].attachment.height, 1051);
});

test('renderSnapshot degrades to a single text block without the attachments service', () => {
  const base = sampleSnapshotValue();
  const value = {
    ...base,
    attachmentsAvailable: false,
    images: base.images.map((image) => ({...image, attachment: null, error: 'no attachment service is mounted'})),
  };
  const blocks = renderSnapshot(value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /call read_image/);
  assert.match(blocks[0].text, /w1-SPM26_Graphics\.png/);
});

test('renderSnapshot adds a read_image hint for one failed attachment', () => {
  const base = sampleSnapshotValue();
  const value = {...base, images: [{...base.images[0], attachment: null, error: 'attachment save failed: boom'}]};
  const blocks = renderSnapshot(value);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /attachment unavailable \(attachment save failed: boom\); use read_image/);
});

test('formatConsoleText and renderConsole include lines stats and warnings', () => {
  const base = sampleSnapshotValue();
  const value = {
    ...base,
    mode: 'console',
    windows: base.windows,
    requestedLines: 120,
    totalLines: 340,
    returnedLines: 120,
    consoleTruncated: true,
    images: [],
  };
  const text = formatConsoleText(value);
  assert.match(text, /^MATLAB command window — captured/);
  assert.match(text, /Console: 120 of 340 lines \(requested 120\) — truncated/);
  assert.match(text, /Realign: Estimate & Reslice/);
  assert.match(text, /Warnings \(1\):/);
  assert.match(text, /Full manifest: C:\\work/);
  const blocks = renderConsole(value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, text);
});

test('formatConsoleText reports missing UIA text without throwing', () => {
  const base = sampleSnapshotValue();
  const text = formatConsoleText({...base, mode: 'console', consoleText: '', totalLines: 0, returnedLines: 0, requestedLines: 120, consoleTruncated: false, warnings: [], images: []});
  assert.match(text, /No readable command-window text/);
  assert.match(text, /Warnings: none detected/);
});

/* ------------------------------------------------------------------ */
/* Run-directory pruning                                               */
/* ------------------------------------------------------------------ */

test('pruneRunRoot keeps the newest runs and ignores deletion failures', async () => {
  const entries = Array.from({length: 25}, (_, index) => ({name: `run-${String(index).padStart(2, '0')}`, isDirectory: () => true}));
  // Key by the same path.join() the implementation uses so the fake mtimes bind
  // on every platform (path separators differ on Linux CI).
  const mtimes = new Map(entries.map((entry, index) => [path.join('C:\\runs', entry.name), index]));
  const removed = [];
  await pruneRunRoot(
    'C:\\runs',
    KEEP_RUNS,
    {
      readdirFn: async () => entries,
      statFn: async (full) => ({mtimeMs: mtimes.get(full) ?? 0}),
      rmFn: async (full) => {
        if (full.endsWith('run-04')) throw new Error('EBUSY');
        removed.push(full);
      },
    },
  );
  assert.equal(removed.length, 4); // 5 stale dirs, one deletion refused
  assert.ok(removed.every((full) => !/run-(2[0-4])/.test(full)));
});
/* ------------------------------------------------------------------ */
/* Code staging (matlab_stage_code)                                    */
/* ------------------------------------------------------------------ */

test('normalizeStageCode accepts one line and rejects unsafe input', () => {
  const line = "disp('hello'); x = 1;";
  assert.equal(normalizeStageCode(line), line);
  assert.throws(() => normalizeStageCode(''), /must not be empty/);
  assert.throws(() => normalizeStageCode('   '), /must not be empty/);
  assert.throws(() => normalizeStageCode(42), /must be a string/);
  assert.throws(() => normalizeStageCode('a = 1;\nb = 2;'), /single line/);
  assert.throws(() => normalizeStageCode('a = 1;\rb = 2;'), /single line/);
  assert.throws(() => normalizeStageCode(`a${String.fromCharCode(0)}b`), /NUL/);
  assert.throws(() => normalizeStageCode('x'.repeat(8_001)), /must not exceed 8000 characters/);
});

test('buildStageArguments produces the documented staging argv', () => {
  const args = buildStageArguments({scriptPath: 'C:\\bundle\\scripts\\matlab-stage-code.ps1', code: "disp('hi')"});
  assert.deepEqual(args, [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'C:\\bundle\\scripts\\matlab-stage-code.ps1',
    '-Code',
    "disp('hi')",
  ]);
  assert.throws(() => buildStageArguments({code: 1}), /must be a string/);
});

test('parseStagePayload reads the last JSON payload line and ignores noise', () => {
  const stdout = 'noise line\n' + JSON.stringify({status: 'staged', draftAfter: '>> disp(1)'}) + '\n';
  assert.equal(parseStagePayload(stdout).status, 'staged');
  assert.equal(parseStagePayload(''), null);
  assert.equal(parseStagePayload('not json at all'), null);
  assert.equal(parseStagePayload('{broken json'), null);
});

test('matlab_stage_code validates arguments before spawning', async () => {
  const {ctx, state} = createFakeHost({workspaceRoot: 'C:\\fake-workspace'});
  apply(ctx);
  const stageTool = state.registrations.get('matlab_stage_code');
  await assert.rejects(stageTool.execute({unexpected: true}, fakeExec()), /unknown argument "unexpected"/);
  await assert.rejects(stageTool.execute({code: ''}, fakeExec()), /must not be empty/);
  await assert.rejects(stageTool.execute({code: 'a = 1\nb = 2'}, fakeExec()), /single line/);
  await assert.rejects(stageTool.execute({code: 'x'.repeat(8_001)}, fakeExec()), /must not exceed/);
});

test('runStageCode resolves staged and never claims execution', async () => {
  const child = createFakeChild({autoClose: null});
  const pending = runStageCode({
    code: "disp('hi')",
    scriptPath: 'C:\\bundle\\scripts\\matlab-stage-code.ps1',
    checkScript: false,
    spawnImpl: () => child,
    powershellPath: 'powershell.exe',
    signal: new AbortController().signal,
  });
  child.stdout.write(JSON.stringify({status: 'staged', draftedAfter: '', draftAfter: '>> disp(\'hi\')'}) + '\n');
  child.emit('close', 0, null);
  const value = await pending;
  assert.equal(value.status, 'staged');
  assert.equal(value.executed, false);
  assert.equal(value.code, "disp('hi')");
  assert.equal(value.draftAfter, ">> disp('hi')");
});

test('runStageCode maps script statuses to stable error kinds', async () => {
  const rejectWith = async (payload, exitCode) => {
    const child = createFakeChild({autoClose: null});
    const pending = runStageCode({
      code: "disp('hi')",
      scriptPath: 'C:\\bundle\\scripts\\matlab-stage-code.ps1',
      checkScript: false,
      spawnImpl: () => child,
      powershellPath: 'powershell.exe',
      signal: new AbortController().signal,
    });
    child.stdout.write(JSON.stringify(payload) + '\n');
    child.emit('close', exitCode, 'SIGTERM');
    return pending;
  };
  await assert.rejects(
    rejectWith({status: 'draft-not-empty', message: 'Command Window already has text.'}, 5),
    (error) => error.kind === 'DRAFT_NOT_EMPTY' && /already has text/.test(error.message),
  );
  await assert.rejects(
    rejectWith({status: 'focus-failed', message: 'Could not focus the Command Window.'}, 4),
    (error) => error.kind === 'FOCUS_FAILED' && /Could not focus/.test(error.message),
  );
  await assert.rejects(
    rejectWith({status: 'paste-unverified', message: 'Paste could not be verified.'}, 6),
    (error) => error.kind === 'PASTE_UNVERIFIED' && /could not be verified/.test(error.message),
  );
  await assert.rejects(
    rejectWith({status: 'no-matlab', message: 'No running MATLAB process was found.'}, 2),
    (error) => error.kind === 'NO_MATLAB',
  );
});

test('runStageCode rejects with NO_SCRIPT when the staging script is missing', async () => {
  await assert.rejects(
    runStageCode({code: "disp('hi')", scriptPath: 'C:\\definitely-missing\\matlab-stage-code.ps1', signal: new AbortController().signal}),
    (error) => error.kind === 'NO_SCRIPT' && /staging script is missing/.test(error.message),
  );
});

test('formatStageText and renderStage state that the code was not executed', () => {
  const value = {status: 'staged', executed: false, code: "disp('hi')", draftAfter: ">> disp('hi')", windowWasMinimized: true};
  const text = formatStageText(value);
  assert.match(text, /NOT executed/);
  assert.match(text, /disp\('hi'\)/);
  assert.match(text, /restored from the taskbar/);
  assert.match(text, /press Enter themselves/);
  const blocks = renderStage(value);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /NOT executed/);
});