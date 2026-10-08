'use strict';

// Conversation capture driver (combined export engine).
//
// Walks a virtualized conversation top to bottom and persists every logical
// turn into a CanonicalConversationStore. Completeness is proven by identity,
// not by pixel coverage:
//
//   1. Continuity. A new window must overlap the previous accepted window. If
//      it does not, the scroll step is halved and retried.
//   2. Boundaries. Top and bottom must remain stable across several samples.
//   3. Fixed point. Unless a complete ordinal sequence proves completeness, a
//      verification pass must stop discovering turns.
//   4. Bounded transfer. Continuity is checked before streamed row HTML is
//      pulled into staged files in bounded chunks. Rejected windows are
//      released without transferring their HTML.

const fs = require('fs');
const { ExportCancelledError } = require('./export-job');

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveCaptureSettings(config = {}) {
  return {
    settleMs: positive(config.exportCaptureSettleMs, 80),
    maxSteps: positive(config.exportCaptureMaxSteps, 50000),
    budgetMs: positive(config.exportCaptureBudgetMs, 1800000),
    terminalSamples: Math.max(2, positive(config.exportCaptureTerminalSamples, 3)),
    stepFraction: Math.min(0.9, Math.max(0.2, positive(config.exportCaptureStepFraction, 0.7))),
    minStepPx: positive(config.exportCaptureMinStepPx, 40),
    maxVerificationPasses: Math.max(0, Math.round(Number(config.exportCaptureVerificationPasses ?? 2))),
    stuckLimit: positive(config.exportCaptureStuckLimit, 6),
    chunkChars: Math.max(16384, Math.min(1048576, positive(config.exportCaptureIpcChunkBytes, 524288))),
  };
}

async function captureConversation(options = {}) {
  const {
    store,
    callBatch,          // async payload => batch
    readRecordChunk,    // async payload => { chunk, nextOffset, totalLength }
    releaseRecords,     // async payload => { ok, released }
    signal,
    onProgress,
    log = () => {},
    config = {},
  } = options;
  const settings = resolveCaptureSettings(config);
  const started = Date.now();
  let totalSteps = 0;

  if (!store || typeof store.ingestBatch !== 'function') throw new TypeError('A canonical conversation store is required.');
  if (typeof callBatch !== 'function') throw new TypeError('callBatch must be a function.');

  const throwIfCancelled = () => {
    if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
  };
  const ensureBudget = () => {
    if (Date.now() - started > settings.budgetMs) {
      const error = new Error(`Conversation capture exceeded its ${Math.round(settings.budgetMs / 1000)}s time budget. Raise exportCaptureBudgetMs for very long conversations.`);
      error.code = 'EXPORT_CAPTURE_BUDGET';
      throw error;
    }
    if (totalSteps >= settings.maxSteps) {
      const error = new Error(`Conversation capture exceeded ${settings.maxSteps} scroll steps.`);
      error.code = 'EXPORT_CAPTURE_STEPS';
      throw error;
    }
  };

  async function fetchBatch(target, extra = {}) {
    throwIfCancelled();
    ensureBudget();
    totalSteps += 1;
    const batch = await callBatch({ target, settleMs: settings.settleMs, expandContent: true, ...extra });
    if (batch?.cancelled || batch?.reason === 'cancelled') throw new ExportCancelledError('Export cancelled');
    if (!batch?.ok) {
      throw new Error(`Conversation capture failed: ${String(batch?.reason || batch?.error || 'no response from the page')}`);
    }
    return batch;
  }

  function tokensFor(batch) {
    return (Array.isArray(batch?.records) ? batch.records : [])
      .map(record => String(record?.recordToken || ''))
      .filter(Boolean);
  }

  async function releaseBatchRecords(batch) {
    const tokens = tokensFor(batch);
    if (!tokens.length) return;
    if (typeof releaseRecords !== 'function') {
      throw new Error('The renderer returned streamed records, but no releaseRecords callback is available.');
    }
    const released = await releaseRecords({ recordTokens: tokens });
    if (!released?.ok) {
      throw new Error(`Could not release streamed conversation rows: ${String(released?.reason || released?.error || 'unknown error')}`);
    }
  }

  async function discardStagedRecords(records) {
    if (typeof store.discardStagedRecords === 'function') {
      await store.discardStagedRecords(records);
    }
  }

  async function stageBatchRecords(batch) {
    const metadata = Array.isArray(batch?.records) ? batch.records : [];
    if (!metadata.some(record => record?.recordToken)) return metadata;
    const staged = [];
    const createdPaths = [];
    let primaryError = null;
    try {
      if (typeof readRecordChunk !== 'function') {
        throw new Error('The renderer returned streamed records, but no readRecordChunk callback is available.');
      }
      for (let index = 0; index < metadata.length; index += 1) {
        throwIfCancelled();
        ensureBudget();
        const record = metadata[index] || {};
        if (!record.recordToken) {
          staged.push(record);
          continue;
        }

        const expectedLength = Math.max(0, Number(record.htmlLength || 0));
        if (!expectedLength) throw new Error('A streamed conversation row reported an empty HTML payload.');
        const incomingPath = await store.createIncomingFile(`record-${index + 1}`);
        createdPaths.push(incomingPath);
        let handle = null;
        try {
          handle = await fs.promises.open(incomingPath, 'w');
          let offset = 0;
          let chunks = 0;
          while (offset < expectedLength) {
            throwIfCancelled();
            ensureBudget();
            const part = await readRecordChunk({
              recordToken: record.recordToken,
              offset,
              maxChars: settings.chunkChars,
            });
            if (!part?.ok) {
              throw new Error(`Could not stream conversation row data: ${String(part?.reason || part?.error || 'unknown error')}`);
            }
            const nextOffset = Number(part.nextOffset || 0);
            if (nextOffset <= offset || nextOffset > expectedLength || Number(part.totalLength || 0) !== expectedLength) {
              throw new Error('Conversation row stream returned an invalid offset or length.');
            }
            await handle.write(String(part.chunk || ''), null, 'utf8');
            offset = nextOffset;
            chunks += 1;
            if (onProgress && chunks % 16 === 0) {
              await onProgress({
                pass: 'stream',
                step: totalSteps,
                turnInBatch: index + 1,
                batchTurns: metadata.length,
                completedCharacters: offset,
                totalCharacters: expectedLength,
              });
            }
          }
          await handle.close();
          handle = null;
          const stat = await fs.promises.stat(incomingPath);
          if (!stat.isFile() || stat.size <= 0) throw new Error('Conversation row stream produced an empty file.');
          staged.push({ ...record, stagedPath: incomingPath });
        } catch (error) {
          if (handle) await handle.close().catch(() => {});
          throw error;
        }
      }
    } catch (error) {
      primaryError = error;
      await discardStagedRecords(createdPaths.map(stagedPath => ({ stagedPath })));
    }

    try {
      await releaseBatchRecords(batch);
    } catch (releaseError) {
      if (!primaryError) {
        primaryError = releaseError;
        await discardStagedRecords(staged);
      }
    }

    // Releasing renderer-side copies is secondary cleanup. Preserve the first
    // transfer/cancellation error when both operations fail.
    if (primaryError) throw primaryError;
    return staged;
  }

  // Scroll to the top and wait until nothing above changes any more. Some
  // hosts load older history when the top is reached. Observation only: no
  // content is marked as sent while the top is still moving.
  async function settleAtTop() {
    let samples = 0;
    let signature = '';
    let batch = null;
    for (let i = 0; i < settings.terminalSamples * 6 && samples < settings.terminalSamples; i += 1) {
      batch = await fetchBatch(0, { observeOnly: true, expandContent: false });
      const next = `${Number(batch.range || 0)}|${batch.refs?.[0]?.key || ''}`;
      if (batch.atTop && next === signature) samples += 1;
      else { samples = 0; signature = next; }
    }
    return { batch, samples };
  }

  async function walk(kind) {
    const top = await settleAtTop();
    const pass = store.beginPass(kind);
    pass.topStableSamples = top.samples;
    let terminalStableSamples = 0;
    let stuck = false;
    try {
      let lastGoodTop = 0;
      let baseStep = Math.max(settings.minStepPx,
        Math.floor(Math.max(200, Number(top.batch?.clientHeight || 0)) * settings.stepFraction));
      let step = 0;
      let stuckCount = 0;
      let terminalSignature = '';
      let rejectedKeys = [];

      while (true) {
        const batch = await fetchBatch(lastGoodTop + step, { resend: rejectedKeys, streamRecords: true });
        rejectedKeys = [];
        if (!store.hasContinuity(batch.refs) && step > settings.minStepPx) {
          rejectedKeys = (batch.records || []).map(record => String(record.key || '')).filter(Boolean);
          await discardStagedRecords(batch.records);
          await releaseBatchRecords(batch);
          store.noteBacktrack();
          step = Math.max(settings.minStepPx, Math.floor(step / 2));
          continue;
        }

        const records = await stageBatchRecords(batch);
        const result = await store.ingestBatch({ ...batch, records });
        const scrollTop = Number(batch.scrollTop || 0);
        if (batch.atBottom) {
          const signature = `${Number(batch.range || 0)}|${(batch.refs || []).map(ref => ref.key).join(',')}`;
          if (signature === terminalSignature && !result.newTurns) terminalStableSamples += 1;
          else { terminalStableSamples = 0; terminalSignature = signature; }
          if (terminalStableSamples >= settings.terminalSamples) break;
          stuckCount = 0;
        } else {
          terminalStableSamples = 0;
          terminalSignature = '';
          if (step > 0 && scrollTop <= lastGoodTop + 1) {
            stuckCount += 1;
            if (stuckCount >= settings.stuckLimit) { stuck = true; break; }
          } else {
            stuckCount = 0;
          }
        }
        lastGoodTop = scrollTop;
        baseStep = Math.max(settings.minStepPx,
          Math.floor(Math.max(200, Number(batch.clientHeight || 0)) * settings.stepFraction));
        step = baseStep;

        if (onProgress && totalSteps % 5 === 0) {
          const range = Number(batch.range || 0);
          await onProgress({
            pass: kind,
            passIndex: pass.index,
            step: totalSteps,
            turns: store.entries.size,
            scrollTop,
            scrollRange: range,
            percent: range > 0 ? Math.min(100, Math.round((scrollTop / range) * 100)) : 100,
          });
        }
      }
    } finally {
      if (store.activePass) store.endPass({ terminalStableSamples, stuck });
    }
    const finished = store.passes[store.passes.length - 1];
    finished.reachedStart = finished.reachedStart || top.samples > 0;
    log('pass complete', {
      kind,
      newTurns: finished.newTurns,
      updatedTurns: finished.updatedTurns,
      seen: finished.seenCount,
      total: store.entries.size,
      backtracks: finished.backtracks,
      continuityBreaks: finished.continuityBreaks,
      elapsedMs: finished.elapsedMs,
    });
    return finished;
  }

  await walk('capture');
  let verificationPasses = 0;
  while (!store.ordinalsComplete() && verificationPasses < settings.maxVerificationPasses) {
    verificationPasses += 1;
    const pass = await walk('verify');
    if (!pass.newTurns && !pass.continuityBreaks) break;
  }
  return { elapsedMs: Date.now() - started, steps: totalSteps, verificationPasses };
}

module.exports = {
  captureConversation,
  resolveCaptureSettings,
};
