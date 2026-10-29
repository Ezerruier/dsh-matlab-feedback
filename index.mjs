/**
 * dsh-matlab-feedback — Host half.
 *
 * Registers two agent tools that capture the *live* MATLAB desktop on this
 * Windows machine (screenshots via PrintWindow + UIA text) by running the
 * bundled PowerShell capture script:
 *
 *   matlab_snapshot  → window screenshots (image attachments) + command-window text
 *   matlab_console   → command-window text only (fast)
 *
 * The capture script (`scripts/matlab-feedback.ps1`, owned by the capture
 * implementation) writes a `manifest.json` plus `*.png` into a per-run
 * directory under `<workspace>/.dsh-matlab-feedback/<runId>/`.
 *
 * Only Node builtins are used. Optional services (`attachments`,
 * `systemPrompt`, `workingDirectory`) are looked up through `ctx.get()` so the
 * plugin still activates when a deployment does not provide them.
 */

import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir, readFile, readdir, rm, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const inject = ['tools'];

export const CAPTURE_SCRIPT_PATH = fileURLToPath(new URL('./scripts/matlab-feedback.ps1', import.meta.url));
export const CAPTURE_TIMEOUT_MS = 30_000;
export const MAX_IMAGES = 4;
export const SNAPSHOT_CONSOLE_CHARS = 6_000;
export const CONSOLE_TEXT_CHARS = 12_000;
export const KEEP_RUNS = 20;
export const RUN_ROOT_NAME = '.dsh-matlab-feedback';
export const NO_MATLAB_MESSAGE = 'No running MATLAB session with visible windows was found on this Windows machine. Ask the user to open MATLAB/DPARSF or check the process.';

export const SNAPSHOT_DESCRIPTION = 'Capture the live MATLAB session on this Windows machine: real window screenshots plus the MATLAB command-window text, SPM/DPARSF figure text and QC values. Use it whenever the user asks about what MATLAB currently shows or prints (DPABI/DPARSF/SPM QC).';

export const CONSOLE_DESCRIPTION = 'Read the live MATLAB command-window text (recent SPM/DPARSF output and warnings) without screenshots. Fast alternative to matlab_snapshot when only the console matters.';

export const SYSTEM_PROMPT = 'MATLAB 实时反馈：当用户询问 MATLAB、DPARSF/DPABI、SPM 当前显示什么、QC 结果、配准/分割质量、命令行报错或警告时，先调用 matlab_snapshot 抓取真实窗口截图与命令行窗口文本（或 matlab_console 只取命令行、更快），再基于返回内容回答；不要凭记忆或猜测描述 MATLAB 状态。图像只作定性观察（界面、脑图、评分选项），精确数值与报错文本以命令行窗口和控件文本为准；文本被截断或图像不清时要说明限制。捕获是只读操作，不改变用户 MATLAB 窗口状态；若返回没有运行中的 MATLAB，请让用户打开 MATLAB/DPARSF 后重试。';

const ROLE_RANK = Object.freeze({'qc-figure': 0, 'pipeline-gui': 1, figure: 2, desktop: 3, other: 4});
const TEXT_SOURCES = new Set(['uia-document', 'uia-commandwindow', 'none']);
const STDOUT_LIMIT = 8_192;
const STDERR_LIMIT = 8_192;

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class CaptureError extends Error {
  constructor(message, kind, options) {
    super(message, options);
    this.name = 'MatlabCaptureError';
    this.kind = kind;
  }
}

/**
 * Decode captured PowerShell output. PowerShell 5.1 writes native stdout/
 * stderr in the console code page (e.g. GBK on zh-CN systems); fall back to
 * GBK decoding when the bytes are not valid UTF-8.
 */
export function decodePowerShellOutput(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const utf8 = bytes.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(bytes);
    return gbk.includes('\uFFFD') ? utf8 : gbk;
  } catch {
    return utf8;
  }
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Flatten control characters / whitespace runs and cut to `limit` characters. */
export function previewText(text, limit = 240) {
  if (typeof text !== 'string' || text.length === 0) return '';
  const flat = text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Keep the tail of a long text. When the cut lands in the middle of a line and
 * the line ends within the first 200 characters, resume right after it so the
 * rendered console does not begin with a partial line.
 */
export function tailChars(text, limit) {
  const source = typeof text === 'string' ? text : '';
  if (!Number.isFinite(limit) || limit <= 0) return {text: '', truncated: source.length > 0};
  if (source.length <= limit) return {text: source, truncated: false};
  let sliced = source.slice(source.length - limit);
  const newline = sliced.indexOf('\n');
  if (newline >= 0 && newline < 200) sliced = sliced.slice(newline + 1);
  return {text: sliced, truncated: true};
}

/** Split text into lines and return the last `lines` lines. */
export function tailByLines(text, lines) {
  const source = typeof text === 'string' ? text : '';
  if (source.length === 0) return {text: '', totalLines: 0, returnedLines: 0};
  const all = source.split(/\r?\n/);
  if (all.length > 0 && all[all.length - 1] === '') all.pop();
  const totalLines = all.length;
  const take = Math.max(0, Math.min(lines, totalLines));
  const kept = take === totalLines ? all : all.slice(totalLines - take);
  return {text: kept.join('\n'), totalLines, returnedLines: kept.length};
}

function assertArguments(args, allowed, toolName) {
  const value = args === undefined || args === null ? {} : args;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${toolName} expects an object of arguments.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${toolName} received an unknown argument "${key}".`);
  }
  return value;
}

function getService(ctx, name) {
  try {
    return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

function throwIfAborted(exec) {
  const signal = exec?.signal;
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('MATLAB capture aborted');
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('MATLAB capture aborted');
  error.name = 'AbortError';
  return error;
}

function stderrSuffix(stderr) {
  const tail = tailChars(typeof stderr === 'string' ? stderr.trim() : '', 800);
  return tail.text.length > 0 ? ` stderr: ${tail.text}` : '';
}

/* ------------------------------------------------------------------ */
/* Capture script invocation                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve `powershell.exe`. Windows PowerShell 5.1 is required (the capture
 * script targets it); fall back to PATH if System32 cannot be located.
 */
export function resolvePowerShellPath({systemRoot = process.env.SystemRoot || process.env.windir, exists = existsSync} = {}) {
  if (systemRoot) {
    const candidate = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (exists(candidate)) return candidate;
  }
  return 'powershell.exe';
}

/** Build the exact argv handed to `powershell.exe`. */
export function buildCaptureArguments({scriptPath = CAPTURE_SCRIPT_PATH, outDir, mode = 'all'} = {}) {
  if (typeof outDir !== 'string' || outDir.length === 0) throw new Error('Capture outDir is required.');
  if (mode !== 'all' && mode !== 'console') throw new Error(`Unsupported MATLAB capture mode: ${mode}`);
  return [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-OutDir',
    outDir,
    '-Mode',
    mode,
  ];
}

/**
 * Run the PowerShell capture script and resolve with its captured output.
 * Rejects with a CaptureError carrying a stable `kind` on timeout, abort,
 * spawn failure, exit code 2 (no MATLAB) or any other non-zero exit.
 */
export function runCapture({
  outDir,
  mode = 'all',
  scriptPath = CAPTURE_SCRIPT_PATH,
  timeoutMs = CAPTURE_TIMEOUT_MS,
  signal,
  spawnImpl = spawn,
  powershellPath = resolvePowerShellPath(),
  checkScript = true,
} = {}) {
  const args = buildCaptureArguments({scriptPath, outDir, mode});
  if (checkScript && !existsSync(scriptPath)) {
    return Promise.reject(new CaptureError(`The MATLAB capture script is missing: ${scriptPath}. The dsh-matlab-feedback bundle is incomplete; reinstall it.`, 'NO_SCRIPT'));
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(powershellPath, args, {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    } catch (error) {
      reject(new CaptureError(`Unable to start the MATLAB capture script (${powershellPath}): ${error.message}`, 'SPAWN', {cause: error}));
      return;
    }
    const stdoutChunks = [];
    let stdoutBytes = 0;
    const stderrChunks = [];
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = null;
    let killTimer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (killTimer !== null) clearTimeout(killTimer);
      try {
        signal?.removeEventListener?.('abort', onAbort);
      } catch {
        /* ignore */
      }
      settle(value);
    };
    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    };
    const stdoutText = () => decodePowerShellOutput(Buffer.concat(stdoutChunks));
    const stderrText = () => decodePowerShellOutput(Buffer.concat(stderrChunks));
    const onChunk = (target) => (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
      const limit = target === 'stdout' ? STDOUT_LIMIT : STDERR_LIMIT;
      const current = target === 'stdout' ? stdoutBytes : stderrBytes;
      if (current >= limit) return;
      const slice = buffer.length <= limit - current ? buffer : buffer.subarray(0, limit - current);
      if (target === 'stdout') {
        stdoutChunks.push(slice);
        stdoutBytes += slice.length;
      } else {
        stderrChunks.push(slice);
        stderrBytes += slice.length;
      }
    };
    if (signal) {
      if (signal.aborted) {
        finish(reject, abortReason(signal));
        return;
      }
      try {
        signal.addEventListener('abort', onAbort, {once: true});
      } catch {
        /* ignore */
      }
    }
    timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 2_000);
      killTimer.unref?.();
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on('data', onChunk('stdout'));
    child.stderr?.on('data', onChunk('stderr'));
    child.once('error', (error) => {
      finish(reject, new CaptureError(`Unable to start the MATLAB capture script (${powershellPath}): ${error.message}`, 'SPAWN', {cause: error}));
    });
    child.once('close', (code, exitSignal) => {
      if (timedOut) {
        finish(reject, new CaptureError(`MATLAB capture timed out after ${timeoutMs} ms.${stderrSuffix(stderrText())}`, 'TIMEOUT'));
        return;
      }
      if (signal?.aborted) {
        finish(reject, abortReason(signal));
        return;
      }
      if (code === 2) {
        finish(reject, new CaptureError(NO_MATLAB_MESSAGE, 'NO_MATLAB'));
        return;
      }
      if (code !== 0) {
        finish(reject, new CaptureError(`MATLAB capture failed (exit code ${code}${exitSignal ? `, signal ${exitSignal}` : ''}).${stderrSuffix(stderrText())}`, 'FAILED'));
        return;
      }
      finish(resolve, {code: 0, stdout: stdoutText(), stderr: stderrText()});
    });
  });
}

/* ------------------------------------------------------------------ */
/* Manifest parsing and normalization                                  */
/* ------------------------------------------------------------------ */

function normalizeWindow(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const role = Object.hasOwn(ROLE_RANK, raw.role) ? raw.role : 'other';
  const rectRaw = raw.rect && typeof raw.rect === 'object' && !Array.isArray(raw.rect) ? raw.rect : {};
  const shotRaw = raw.screenshot && typeof raw.screenshot === 'object' && !Array.isArray(raw.screenshot) ? raw.screenshot : null;
  let screenshot = null;
  if (shotRaw && typeof shotRaw.file === 'string' && shotRaw.file.length > 0) {
    screenshot = {
      file: path.basename(shotRaw.file.replace(/\\/g, '/')),
      bytes: Math.max(0, Math.trunc(numberOr(shotRaw.bytes, 0))),
      width: Math.max(0, Math.trunc(numberOr(shotRaw.width, numberOr(rectRaw.width, 0)))),
      height: Math.max(0, Math.trunc(numberOr(shotRaw.height, numberOr(rectRaw.height, 0)))),
    };
  }
  const width = Math.max(0, Math.trunc(numberOr(rectRaw.width, screenshot?.width ?? 0)));
  const height = Math.max(0, Math.trunc(numberOr(rectRaw.height, screenshot?.height ?? 0)));
  return {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : `w${index + 1}`,
    title: typeof raw.title === 'string' ? raw.title : '(untitled MATLAB window)',
    role,
    hwnd: raw.hwnd === undefined || raw.hwnd === null ? null : String(raw.hwnd),
    pid: numberOr(raw.pid, null),
    visible: raw.visible !== false,
    minimized: raw.minimized === true,
    rect: {
      x: Math.trunc(numberOr(rectRaw.x, 0)),
      y: Math.trunc(numberOr(rectRaw.y, 0)),
      width,
      height,
    },
    screenshot,
    text: typeof raw.text === 'string' ? raw.text : '',
    textSource: TEXT_SOURCES.has(raw.textSource) ? raw.textSource : 'none',
    textTruncated: raw.textTruncated === true,
  };
}

/**
 * Validate and normalize the capture manifest. Missing optional fields degrade
 * to safe defaults; a structurally wrong document throws a CaptureError.
 */
export function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CaptureError('MATLAB capture manifest is not a JSON object.', 'BAD_MANIFEST');
  }
  if (raw.schemaVersion !== 1) {
    throw new CaptureError(`Unsupported MATLAB capture manifest schemaVersion: ${String(raw.schemaVersion)}.`, 'BAD_MANIFEST');
  }
  const windows = (Array.isArray(raw.windows) ? raw.windows : []).map(normalizeWindow).filter((window) => window !== null);
  const consoleRaw = raw.console && typeof raw.console === 'object' && !Array.isArray(raw.console) ? raw.console : null;
  const consoleInfo = consoleRaw
    ? {
        windowId: typeof consoleRaw.windowId === 'string' ? consoleRaw.windowId : null,
        title: typeof consoleRaw.title === 'string' ? consoleRaw.title : null,
        text: typeof consoleRaw.text === 'string' ? consoleRaw.text : '',
        textSource: TEXT_SOURCES.has(consoleRaw.textSource) ? consoleRaw.textSource : 'none',
        truncated: consoleRaw.truncated === true,
      }
    : null;
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings
        .filter((line) => typeof line === 'string' && line.trim().length > 0)
        .map((line) => line.trim().slice(0, 400))
        .filter((line, index, all) => all.indexOf(line) === index)
        .slice(0, 40)
    : [];
  const processes = (Array.isArray(raw.matlabProcesses) ? raw.matlabProcesses : [])
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({pid: numberOr(entry.pid, null), commandLine: typeof entry.commandLine === 'string' ? entry.commandLine : ''}));
  return {
    schemaVersion: 1,
    capturedAt: typeof raw.capturedAt === 'string' && raw.capturedAt.length > 0 ? raw.capturedAt : new Date().toISOString(),
    durationMs: Math.max(0, Math.trunc(numberOr(raw.durationMs, 0))),
    matlabProcesses: processes,
    windows,
    console: consoleInfo,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Window/image selection                                              */
/* ------------------------------------------------------------------ */

/** Windows with a usable screenshot, ordered by role priority, capped. */
export function selectImageWindows(windows, max = MAX_IMAGES) {
  const list = Array.isArray(windows) ? windows : [];
  return list
    .map((window, index) => ({window, index}))
    .filter(({window}) => window.screenshot !== null && window.screenshot.file.length > 0 && window.minimized !== true)
    .sort((a, b) => (ROLE_RANK[a.window.role] ?? 4) - (ROLE_RANK[b.window.role] ?? 4) || a.index - b.index)
    .slice(0, Math.max(0, max))
    .map(({window}) => window);
}

function safeScreenshotPath(outDir, file) {
  if (typeof file !== 'string' || file.length === 0) return null;
  const leaf = path.basename(file.replace(/\\/g, '/'));
  if (leaf !== file.replace(/\\/g, '/') || leaf === '.' || leaf === '..' || path.isAbsolute(file)) return null;
  const resolvedOutDir = path.resolve(outDir);
  const resolved = path.resolve(resolvedOutDir, leaf);
  if (path.dirname(resolved) !== resolvedOutDir) return null;
  return resolved;
}

/* ------------------------------------------------------------------ */
/* Run directories and pruning                                         */
/* ------------------------------------------------------------------ */

/** Create `<workspace>/.dsh-matlab-feedback/<runId>/` and prune old runs. */
export async function prepareRunDir(workspaceRoot, {keep = KEEP_RUNS} = {}) {
  const runRoot = path.join(workspaceRoot, RUN_ROOT_NAME);
  await mkdir(runRoot, {recursive: true});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `run-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
  const outDir = path.join(runRoot, runId);
  await mkdir(outDir, {recursive: true});
  try {
    await pruneRunRoot(runRoot, keep);
  } catch {
    /* pruning must never fail the capture */
  }
  return {runId, outDir, runRoot};
}

/** Delete all but the `keep` newest run directories. Returns removed paths. */
export async function pruneRunRoot(runRoot, keep = KEEP_RUNS, {readdirFn = readdir, statFn = stat, rmFn = rm} = {}) {
  let entries;
  try {
    entries = await readdirFn(runRoot, {withFileTypes: true});
  } catch {
    return [];
  }
  const directories = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(runRoot, entry.name);
    try {
      directories.push({full, mtimeMs: (await statFn(full)).mtimeMs});
    } catch {
      /* ignore unreadable entries */
    }
  }
  directories.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const removed = [];
  for (const directory of directories.slice(Math.max(0, keep))) {
    try {
      await rmFn(directory.full, {recursive: true, force: true});
      removed.push(directory.full);
    } catch {
      /* ignore deletion failures */
    }
  }
  return removed;
}

async function readManifestFromDir(outDir) {
  const manifestPath = path.join(outDir, 'manifest.json');
  let text;
  try {
    text = await readFile(manifestPath, 'utf8');
  } catch (error) {
    throw new CaptureError(`The capture script reported success but wrote no manifest at ${manifestPath}: ${error.message}`, 'NO_MANIFEST', {cause: error});
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CaptureError(`The capture manifest at ${manifestPath} is not valid JSON: ${error.message}`, 'BAD_MANIFEST', {cause: error});
  }
  return normalizeManifest(raw);
}

async function resolveWorkspace(ctx, exec) {
  const directories = getService(ctx, 'workingDirectory');
  const agent = exec?.agent;
  if (directories && typeof directories.ensure === 'function' && agent) {
    try {
      const ensured = await directories.ensure(agent, exec?.signal);
      if (typeof ensured === 'string' && ensured.length > 0) return ensured;
    } catch (error) {
      if (exec?.signal?.aborted) throw error;
      /* fall back to process.cwd() when the working-directory service is unusable */
    }
  }
  return process.cwd();
}

/* ------------------------------------------------------------------ */
/* Screenshot attachment persistence                                   */
/* ------------------------------------------------------------------ */

async function saveScreenshotImages(ctx, manifest, outDir) {
  const store = getService(ctx, 'attachments');
  const canSave = Boolean(store && typeof store.saveImage === 'function');
  const images = [];
  for (const window of selectImageWindows(manifest.windows)) {
    const expectedWidth = window.screenshot.width || window.rect.width;
    const expectedHeight = window.screenshot.height || window.rect.height;
    const absolutePath = safeScreenshotPath(outDir, window.screenshot.file);
    const entry = {
      id: window.id,
      role: window.role,
      title: window.title,
      path: absolutePath,
      width: expectedWidth,
      height: expectedHeight,
      bytes: window.screenshot.bytes,
      attachment: null,
      error: null,
    };
    if (absolutePath === null) {
      entry.error = 'manifest screenshot file name is not a safe relative file name';
      images.push(entry);
      continue;
    }
    let data;
    try {
      data = await readFile(absolutePath);
    } catch (error) {
      entry.error = `screenshot file is unreadable: ${error.message}`;
      images.push(entry);
      continue;
    }
    if (data.byteLength === 0) {
      entry.error = 'screenshot file is empty';
      images.push(entry);
      continue;
    }
    entry.bytes = data.byteLength;
    if (canSave) {
      try {
        const ref = await store.saveImage({data: new Uint8Array(data), mediaType: 'image/png', name: path.basename(absolutePath)});
        if (ref && typeof ref.attachmentId === 'string' && ref.attachmentId.length > 0) {
          const attachment = {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType || 'image/png',
            bytes: numberOr(ref.bytes, data.byteLength),
            width: numberOr(ref.width, expectedWidth),
            height: numberOr(ref.height, expectedHeight),
          };
          if (typeof ref.name === 'string' && ref.name.length > 0) attachment.name = ref.name;
          else attachment.name = path.basename(absolutePath);
          entry.attachment = attachment;
        } else {
          entry.error = 'attachment store returned an invalid image reference';
        }
      } catch (error) {
        entry.error = `attachment save failed: ${error?.message ?? String(error)}`;
      }
    } else {
      entry.error = store ? 'attachment store has no saveImage method' : 'no attachment service is mounted';
    }
    images.push(entry);
  }
  return images;
}

/* ------------------------------------------------------------------ */
/* Tool result rendering                                               */
/* ------------------------------------------------------------------ */

function fence(text) {
  const marker = text.includes('```') ? '````' : '```';
  return `${marker}text\n${text}\n${marker}`;
}

/** Text block for matlab_snapshot: window list + console tail + warnings. */
export function formatSnapshotText(value) {
  const lines = [];
  const duration = typeof value.durationMs === 'number' && value.durationMs > 0 ? ` (capture ${(value.durationMs / 1000).toFixed(2)} s)` : '';
  lines.push(`MATLAB live snapshot — captured ${value.capturedAt}${duration}`);
  lines.push(`Run: ${value.runId} | outDir: ${value.outDir}`);
  const processes = Array.isArray(value.matlabProcesses) ? value.matlabProcesses : [];
  if (processes.length === 0) {
    lines.push('MATLAB processes: none reported.');
  } else {
    const pids = processes.slice(0, 6).map((process) => String(process.pid ?? '?')).join(', ');
    lines.push(`MATLAB processes: ${processes.length} (pid ${pids}${processes.length > 6 ? ', …' : ''})`);
  }
  const windows = Array.isArray(value.windows) ? value.windows : [];
  lines.push(`Windows: ${windows.length}`);
  for (const window of windows.slice(0, 12)) {
    const shot = window.screenshotPath ? 'yes' : 'no';
    lines.push(`- [${window.role}] ${window.id} "${window.title}" ${window.width}x${window.height} minimized=${window.minimized ? 'yes' : 'no'} screenshot=${shot} text=${window.textSource}(${window.textLength} chars)`);
    if (window.textPreview) lines.push(`    ${window.textPreview}`);
  }
  if (windows.length > 12) lines.push(`- … ${windows.length - 12} more windows; see ${value.fullManifestPath}`);
  const consoleText = typeof value.consoleText === 'string' ? value.consoleText : '';
  if (consoleText.length === 0) {
    lines.push('Command window: no readable text (UIA text unavailable; rely on the screenshots).');
  } else {
    const range = value.consoleTruncated ? `kept last ${value.consoleChars} of ${value.consoleTotalChars} chars` : `${value.consoleTotalChars} chars`;
    lines.push(`Command window (${range}; full text: ${value.fullManifestPath}):`);
    lines.push(fence(consoleText));
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  if (warnings.length === 0) {
    lines.push('Warnings: none detected.');
  } else {
    lines.push(`Warnings (${warnings.length}):`);
    for (const warning of warnings.slice(0, 12)) lines.push(`- ${warning}`);
    if (warnings.length > 12) lines.push(`- … ${warnings.length - 12} more in the manifest`);
  }
  const images = Array.isArray(value.images) ? value.images : [];
  if (!value.attachmentsAvailable) {
    if (images.length > 0) {
      lines.push('Screenshots (image attachments are unavailable in this session; call read_image on these absolute paths):');
      for (const image of images) lines.push(`- ${image.path} (${image.title}, ${image.width}x${image.height})`);
    } else {
      lines.push('Screenshots: none captured (all windows minimized or PrintWindow failed).');
    }
  } else if (images.length === 0) {
    lines.push('Screenshots: none captured (all windows minimized or PrintWindow failed).');
  } else {
    lines.push(`Screenshots: ${images.length} image block(s) follow; full manifest: ${value.fullManifestPath}`);
  }
  return lines.join('\n');
}

/** Content blocks for matlab_snapshot. */
export function renderSnapshot(value) {
  const blocks = [{type: 'text', text: formatSnapshotText(value)}];
  if (!value.attachmentsAvailable) return blocks;
  const images = Array.isArray(value.images) ? value.images : [];
  for (const image of images) {
    const dimensions = `${image.width}×${image.height}`;
    if (image.attachment) {
      blocks.push({type: 'text', text: `Screenshot: ${image.title} (${dimensions}, path=${image.path})`});
      blocks.push({type: 'image', attachment: image.attachment});
    } else {
      blocks.push({type: 'text', text: `Screenshot: ${image.title} (${dimensions}, path=${image.path}) — attachment unavailable (${image.error || 'unknown reason'}); use read_image with this path.`});
    }
  }
  return blocks;
}

/** Text block for matlab_console. */
export function formatConsoleText(value) {
  const lines = [];
  const duration = typeof value.durationMs === 'number' && value.durationMs > 0 ? ` (capture ${(value.durationMs / 1000).toFixed(2)} s)` : '';
  lines.push(`MATLAB command window — captured ${value.capturedAt}${duration}`);
  lines.push(`Run: ${value.runId} | outDir: ${value.outDir}`);
  lines.push(`Console: ${value.returnedLines} of ${value.totalLines} lines (requested ${value.requestedLines})${value.consoleTruncated ? ' — truncated' : ''}`);
  const consoleText = typeof value.consoleText === 'string' ? value.consoleText : '';
  if (consoleText.length === 0) {
    lines.push('No readable command-window text (UIA text unavailable). Use matlab_snapshot if a screenshot is needed.');
  } else {
    lines.push(fence(consoleText));
  }
  const warnings = Array.isArray(value.warnings) ? value.warnings : [];
  if (warnings.length === 0) {
    lines.push('Warnings: none detected.');
  } else {
    lines.push(`Warnings (${warnings.length}):`);
    for (const warning of warnings.slice(0, 12)) lines.push(`- ${warning}`);
    if (warnings.length > 12) lines.push(`- … ${warnings.length - 12} more in the manifest`);
  }
  lines.push(`Full manifest: ${value.fullManifestPath}`);
  return lines.join('\n');
}

/** Content blocks for matlab_console. */
export function renderConsole(value) {
  return [{type: 'text', text: formatConsoleText(value)}];
}

/* ------------------------------------------------------------------ */
/* Tool implementations                                                */
/* ------------------------------------------------------------------ */

function compactWindows(windows, outDir) {
  return windows.map((window) => ({
    id: window.id,
    title: window.title,
    role: window.role,
    width: window.rect.width,
    height: window.rect.height,
    minimized: window.minimized,
    screenshotPath: window.screenshot ? safeScreenshotPath(outDir, window.screenshot.file) : null,
    textPreview: previewText(window.text, 240),
    textLength: window.text.length,
    textSource: window.textSource,
  }));
}

async function executeSnapshot(ctx, exec) {
  throwIfAborted(exec);
  const workspace = await resolveWorkspace(ctx, exec);
  throwIfAborted(exec);
  const run = await prepareRunDir(workspace);
  throwIfAborted(exec);
  await runCapture({outDir: run.outDir, mode: 'all', signal: exec?.signal});
  throwIfAborted(exec);
  const manifest = await readManifestFromDir(run.outDir);
  throwIfAborted(exec);
  const images = await saveScreenshotImages(ctx, manifest, run.outDir);
  throwIfAborted(exec);
  const fullConsole = manifest.console?.text ?? '';
  const consoleTail = tailChars(fullConsole, SNAPSHOT_CONSOLE_CHARS);
  return {
    kind: 'dsh-matlab-feedback',
    mode: 'snapshot',
    capturedAt: manifest.capturedAt,
    durationMs: manifest.durationMs,
    runId: run.runId,
    outDir: run.outDir,
    fullManifestPath: path.join(run.outDir, 'manifest.json'),
    matlabProcesses: manifest.matlabProcesses,
    windows: compactWindows(manifest.windows, run.outDir),
    consoleText: consoleTail.text,
    consoleChars: consoleTail.text.length,
    consoleTotalChars: fullConsole.length,
    consoleTruncated: consoleTail.truncated || Boolean(manifest.console?.truncated),
    consoleSource: manifest.console?.textSource ?? 'none',
    warnings: manifest.warnings,
    images,
    attachmentsAvailable: Boolean(getService(ctx, 'attachments')),
  };
}

/** Normalize the optional matlab_console `lines` argument (default 120, 10–400). */
export function normalizeConsoleLines(value) {
  if (value === undefined || value === null) return 120;
  if (!Number.isInteger(value) || value < 10 || value > 400) {
    throw new Error('matlab_console: "lines" must be an integer between 10 and 400.');
  }
  return value;
}

async function executeConsole(ctx, exec, args) {
  const requestedLines = normalizeConsoleLines(args?.lines);
  throwIfAborted(exec);
  const workspace = await resolveWorkspace(ctx, exec);
  throwIfAborted(exec);
  const run = await prepareRunDir(workspace);
  throwIfAborted(exec);
  await runCapture({outDir: run.outDir, mode: 'console', signal: exec?.signal});
  throwIfAborted(exec);
  const manifest = await readManifestFromDir(run.outDir);
  throwIfAborted(exec);
  const fullConsole = manifest.console?.text ?? '';
  const lineSlice = tailByLines(fullConsole, requestedLines);
  const capped = tailChars(lineSlice.text, CONSOLE_TEXT_CHARS);
  return {
    kind: 'dsh-matlab-feedback',
    mode: 'console',
    capturedAt: manifest.capturedAt,
    durationMs: manifest.durationMs,
    runId: run.runId,
    outDir: run.outDir,
    fullManifestPath: path.join(run.outDir, 'manifest.json'),
    matlabProcesses: manifest.matlabProcesses,
    windows: compactWindows(manifest.windows, run.outDir),
    consoleText: capped.text,
    consoleChars: capped.text.length,
    consoleTotalChars: fullConsole.length,
    consoleTruncated: capped.truncated || lineSlice.returnedLines < lineSlice.totalLines || Boolean(manifest.console?.truncated),
    consoleSource: manifest.console?.textSource ?? 'none',
    requestedLines,
    totalLines: lineSlice.totalLines,
    returnedLines: capped.truncated ? capped.text.split(/\r?\n/).length : lineSlice.returnedLines,
    warnings: manifest.warnings,
    images: [],
    attachmentsAvailable: Boolean(getService(ctx, 'attachments')),
  };
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                        */
/* ------------------------------------------------------------------ */

export function apply(ctx) {
  const disposers = [];
  const registerTool = (definition) => {
    const dispose = ctx.tools.register(definition);
    if (typeof dispose === 'function') disposers.push(dispose);
    return dispose;
  };
  const output = (render) => ({schema: {type: 'object', additionalProperties: true}, render: (_args, value) => render(value)});
  try {
    registerTool({
      name: 'matlab_snapshot',
      description: SNAPSHOT_DESCRIPTION,
      parameters: {type: 'object', properties: {}, additionalProperties: false},
      output: output(renderSnapshot),
      async execute(args, exec) {
        assertArguments(args, [], 'matlab_snapshot');
        return executeSnapshot(ctx, exec);
      },
    });
    registerTool({
      name: 'matlab_console',
      description: CONSOLE_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          lines: {type: 'integer', minimum: 10, maximum: 400, description: 'Number of trailing console lines to return (default 120).'},
        },
        additionalProperties: false,
      },
      output: output(renderConsole),
      async execute(args, exec) {
        const value = assertArguments(args, ['lines'], 'matlab_console');
        return executeConsole(ctx, exec, value);
      },
    });
    const systemPrompt = getService(ctx, 'systemPrompt');
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      try {
        const dispose = systemPrompt.section({name: 'dsh-matlab-feedback', order: 9060, text: SYSTEM_PROMPT});
        if (typeof dispose === 'function') disposers.push(dispose);
      } catch (error) {
        ctx.logger?.warn?.('dsh-matlab-feedback: unable to register the system prompt section', error);
      }
    }
    ctx.logger?.info?.('DSH_MATLAB_FEEDBACK_HOST_APPLY');
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* ignore cleanup failures while propagating the apply error */
      }
    }
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* ignore cleanup failures */
      }
    }
    ctx.logger?.info?.('DSH_MATLAB_FEEDBACK_HOST_DISPOSE');
  };
}
