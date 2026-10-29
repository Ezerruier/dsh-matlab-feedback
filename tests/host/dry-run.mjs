/**
 * Real dry-run of the dsh-matlab-feedback Host half.
 *
 * Imports index.mjs, wires it to a fake DSH context (fake attachments store,
 * fake systemPrompt, fake workingDirectory) and exercises the *real* pipeline:
 * PowerShell capture → manifest parse → PNG attachment refs → tool result →
 * render blocks. Read-only: it never clicks, focuses or restores MATLAB windows.
 *
 * Usage:
 *   node dry-run.mjs [--workspace <dir>]
 *
 * Writes a machine-readable summary to `dry-run-last.json` next to this file
 * and exits 0 only when the critical checks pass.
 */

import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {apply, CAPTURE_SCRIPT_PATH, inject, KEEP_RUNS} from '../../index.mjs';
import {createFakeHost, fakeExec, pngSize} from './fake-host.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : undefined;
}

function prefix(text, limit) {
  const value = typeof text === 'string' ? text : '';
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

async function pngFacts(filePath) {
  const buffer = await readFile(filePath);
  const dimensions = pngSize(buffer);
  const magic = buffer.subarray(0, 8).toString('hex');
  return {
    bytes: buffer.byteLength,
    width: dimensions.width,
    height: dimensions.height,
    isPng: magic === '89504e470d0a1a0a',
  };
}

async function main() {
  const workspaceRoot = argValue('--workspace') ? path.resolve(argValue('--workspace')) : path.join(here, '.tmp-workspace');
  const resultPath = path.join(here, 'dry-run-last.json');
  const summary = {
    generatedAt: new Date().toISOString(),
    inject,
    captureScript: {path: CAPTURE_SCRIPT_PATH, exists: existsSync(CAPTURE_SCRIPT_PATH)},
    workspaceRoot,
    ok: false,
    checks: {},
    errors: [],
  };

  if (!summary.captureScript.exists) {
    summary.errors.push('capture script is missing (capture implementation not ready yet)');
    await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(summary, null, 2));
    process.exit(3);
  }
  const scriptBytes = await readFile(CAPTURE_SCRIPT_PATH);
  summary.captureScript.bytes = scriptBytes.byteLength;
  summary.captureScript.sha256 = createHash('sha256').update(scriptBytes).digest('hex');

  await rm(workspaceRoot, {recursive: true, force: true});
  await mkdir(workspaceRoot, {recursive: true});
  const {ctx, state} = createFakeHost({workspaceRoot});
  const dispose = apply(ctx);
  try {
    const snapshotTool = state.registrations.get('matlab_snapshot');
    const consoleTool = state.registrations.get('matlab_console');
    if (!snapshotTool || !consoleTool) throw new Error('apply did not register both tools');

    /* ---- matlab_snapshot ---- */
    const snapshotStarted = Date.now();
    const snapshot = await snapshotTool.execute({}, fakeExec());
    const snapshotMs = Date.now() - snapshotStarted;
    const snapshotBlocks = snapshotTool.output.render({}, snapshot);
    const imageBlocks = snapshotBlocks.filter((block) => block.type === 'image');
    const screenshotTextBlocks = snapshotBlocks.filter((block) => block.type === 'text' && block.text.startsWith('Screenshot: '));

    const pngFactsList = [];
    for (const image of snapshot.images) {
      pngFactsList.push({path: image.path, ...(await pngFacts(image.path))});
    }
    const refs = snapshot.images.filter((image) => image.attachment).map((image) => image.attachment);
    const refMismatches = snapshot.images
      .map((image, index) => ({image, facts: pngFactsList[index]}))
      .filter(({image, facts}) => image.attachment && (image.attachment.width !== facts.width || image.attachment.height !== facts.height))
      .map(({image, facts}) => `${image.id}: ref ${image.attachment.width}x${image.attachment.height} vs png ${facts.width}x${facts.height}`);
    const snapshotText = snapshotBlocks[0].text;
    const consoleTailProbe = (snapshot.consoleText || '').trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';

    summary.snapshot = {
      ms: snapshotMs,
      runId: snapshot.runId,
      outDir: snapshot.outDir,
      capturedAt: snapshot.capturedAt,
      manifestPath: snapshot.fullManifestPath,
      manifestExists: existsSync(snapshot.fullManifestPath),
      matlabProcesses: snapshot.matlabProcesses.length,
      windows: snapshot.windows.length,
      windowsWithScreenshot: snapshot.windows.filter((window) => window.screenshotPath).length,
      windowDetails: snapshot.windows.map((window) => ({
        id: window.id,
        role: window.role,
        title: window.title,
        size: `${window.width}x${window.height}`,
        minimized: window.minimized,
        screenshot: window.screenshotPath ? path.basename(window.screenshotPath) : null,
        textSource: window.textSource,
        textLength: window.textLength,
      })),
      images: snapshot.images.length,
      imageRefs: refs.length,
      attachmentsSaved: state.savedImages.length,
      refMismatches,
      pngs: pngFactsList,
      blocks: snapshotBlocks.map((block) => block.type),
      screenshotTextBlocks: screenshotTextBlocks.length,
      consoleChars: snapshot.consoleText.length,
      consoleTotalChars: snapshot.consoleTotalChars,
      consoleTruncated: snapshot.consoleTruncated,
      consoleSource: snapshot.consoleSource,
      warnings: snapshot.warnings.length,
      textChars: snapshotText.length,
      textPrefix: prefix(snapshotText, 600),
      textIncludesConsoleTail: consoleTailProbe.length > 0 && snapshotText.includes(consoleTailProbe),
      textEndsWithImageNotice: /Screenshots: \d+ image block\(s\) follow/.test(snapshotText),
    };

    /* ---- degraded render without attachments ---- */
    const fallbackBlocks = snapshotTool.output.render({}, {
      ...snapshot,
      attachmentsAvailable: false,
      images: snapshot.images.map((image) => ({...image, attachment: null, error: 'dry-run: attachments disabled'})),
    });
    const fallbackText = fallbackBlocks.map((block) => (block.type === 'text' ? block.text : '')).join('\n');
    summary.fallbackRender = {
      blocks: fallbackBlocks.map((block) => block.type),
      hasReadImageInstruction: fallbackText.includes('read_image'),
      hasAbsolutePngPath: snapshot.images.some((image) => fallbackText.includes(image.path)),
    };

    /* ---- tool-result value must survive the session-log JSON round-trip ---- */
    const roundTripped = JSON.parse(JSON.stringify(snapshot));
    summary.jsonRoundTrip = {
      images: roundTripped.images.length,
      refs: roundTripped.images.filter((image) => image.attachment?.attachmentId).length,
      preserved: roundTripped.images.every((image, index) => image.attachment?.attachmentId === snapshot.images[index]?.attachment?.attachmentId),
    };

    /* ---- real capture through a context without the attachments service ---- */
    const bareHost = createFakeHost({workspaceRoot, attachments: false});
    const disposeBare = apply(bareHost.ctx);
    const bareTool = bareHost.state.registrations.get('matlab_snapshot');
    const bareValue = await bareTool.execute({}, fakeExec());
    const bareBlocks = bareTool.output.render({}, bareValue);
    const bareText = bareBlocks[0].text;
    summary.noAttachments = {
      images: bareValue.images.length,
      attachmentlessImages: bareValue.images.filter((image) => image.attachment === null).length,
      blocks: bareBlocks.map((block) => block.type),
      hasReadImageInstruction: bareText.includes('read_image'),
      listsAbsolutePngPaths: bareValue.images.every((image) => bareText.includes(image.path)),
    };
    disposeBare();

    /* ---- matlab_console ---- */
    const consoleStarted = Date.now();
    const consoleResult = await consoleTool.execute({lines: 120}, fakeExec());
    const consoleMs = Date.now() - consoleStarted;
    const consoleBlocks = consoleTool.output.render({}, consoleResult);
    summary.consoleTool = {
      ms: consoleMs,
      runId: consoleResult.runId,
      outDir: consoleResult.outDir,
      manifestPath: consoleResult.fullManifestPath,
      manifestExists: existsSync(consoleResult.fullManifestPath),
      requestedLines: consoleResult.requestedLines,
      totalLines: consoleResult.totalLines,
      returnedLines: consoleResult.returnedLines,
      chars: consoleResult.consoleText.length,
      consoleTotalChars: consoleResult.consoleTotalChars,
      truncated: consoleResult.consoleTruncated,
      warnings: consoleResult.warnings.length,
      blocks: consoleBlocks.map((block) => block.type),
      textChars: consoleBlocks[0].text.length,
      textPrefix: prefix(consoleBlocks[0].text, 500),
    };

    /* ---- matlab_console honors a small lines argument ---- */
    const consoleLines10 = await consoleTool.execute({lines: 10}, fakeExec());
    summary.consoleLines10 = {
      requestedLines: consoleLines10.requestedLines,
      returnedLines: consoleLines10.returnedLines,
      totalLines: consoleLines10.totalLines,
      chars: consoleLines10.consoleText.length,
      truncated: consoleLines10.consoleTruncated,
    };

    /* ---- run-directory history is bounded ---- */
    let runDirs = [];
    try {
      runDirs = (await readdir(path.join(workspaceRoot, '.dsh-matlab-feedback'), {withFileTypes: true})).filter((entry) => entry.isDirectory())?.map((entry) => entry.name) ?? [];
    } catch {
      runDirs = [];
    }
    summary.runHistory = {count: runDirs.length, limit: KEEP_RUNS, runIds: runDirs.sort()};

    /* ---- system prompt section ---- */
    summary.systemPrompt = {
      sections: state.sections.length,
      name: state.sections[0]?.name ?? null,
      order: state.sections[0]?.order ?? null,
      chars: state.sections[0]?.text.length ?? 0,
    };

    /* ---- checks: host-side contract (environment independent) ---- */
    summary.checks = {
      windowsAtLeastOne: summary.snapshot.windows >= 1,
      pngsAtLeastOne: summary.snapshot.images >= 1,
      pngFilesExistAndArePng: pngFactsList.every((facts) => facts.isPng && facts.bytes > 0),
      attachmentRefsAtLeastOne: refs.length >= 1,
      attachmentRefDimensionsMatchPng: refMismatches.length === 0,
      imageBlocksEqualRefs: imageBlocks.length === refs.length,
      screenshotTextBlocksEqualRefs: screenshotTextBlocks.length === refs.length,
      snapshotTextIncludesConsoleTail: summary.snapshot.textIncludesConsoleTail || snapshot.consoleChars === 0,
      manifestWritten: existsSync(snapshot.fullManifestPath),
      jsonRoundTripPreservesRefs: summary.jsonRoundTrip.images === snapshot.images.length && summary.jsonRoundTrip.refs === refs.length && summary.jsonRoundTrip.preserved,
      fallbackRenderTextOnly: fallbackBlocks.length === 1 && fallbackBlocks[0].type === 'text',
      fallbackMentionsReadImage: summary.fallbackRender.hasReadImageInstruction,
      noAttachmentCaptureDegradesToText: summary.noAttachments.blocks.length === 1 && summary.noAttachments.blocks[0] === 'text',
      noAttachmentRefsAbsent: summary.noAttachments.attachmentlessImages === summary.noAttachments.images,
      noAttachmentListsAbsolutePaths: summary.noAttachments.hasReadImageInstruction && summary.noAttachments.listsAbsolutePngPaths,
      consoleTextNonEmpty: consoleResult.consoleText.length > 0,
      consoleManifestWritten: existsSync(consoleResult.fullManifestPath),
      consoleToolTextOnly: consoleBlocks.length === 1 && consoleBlocks[0].type === 'text',
      consoleLinesArgumentHonored: consoleLines10.requestedLines === 10 && consoleLines10.returnedLines === Math.min(10, consoleLines10.totalLines),
      runHistoryBounded: runDirs.length <= KEEP_RUNS,
      systemPromptRegistered: summary.systemPrompt.name === 'dsh-matlab-feedback' && summary.systemPrompt.order === 9060 && summary.systemPrompt.chars <= 900,
    };
    /* The number of visible windows depends on what the user currently has
       open (e.g. the SPM QC figure may have been closed). Record it as an
       observation, not as a host-contract failure. */
    summary.environment = {
      visibleWindows: summary.snapshot.windows,
      screenshots: summary.snapshot.images,
      richEnvironment: summary.snapshot.windows >= 3 && summary.snapshot.images >= 2,
      note: summary.snapshot.windows >= 3 && summary.snapshot.images >= 2
        ? 'live MATLAB exposed >=3 windows and >=2 screenshot windows'
        : 'live MATLAB exposed fewer screenshot windows at capture time; host pipeline still verified with the available images',
    };
    summary.ok = Object.values(summary.checks).every(Boolean);
  } catch (error) {
    summary.errors.push(error?.stack ?? `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`);
    summary.ok = false;
  } finally {
    dispose();
  }
  summary.disposed = state.disposed;
  await writeFile(resultPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.ok ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error?.stack ?? String(error));
  process.exit(1);
});
