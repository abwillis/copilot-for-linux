'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const {
  CANCEL_HEADLINE,
  CANCEL_FOOTER,
  ACTIVE_FOOTER,
  formatDuration,
  formatBar,
  buildExportProgressView,
} = require('../lib/export-progress');
const { ExportJob, ExportCancelledError } = require('../lib/export-job');
const { createCanonicalConversationStore } = require('../lib/canonical-conversation');
const { captureConversation } = require('../lib/conversation-capture');
const { createHarness } = require('../test-support/dom-agent-harness');

test('formatDuration and formatBar produce stable text', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(65_400), '1:05');
  assert.equal(formatDuration(3_723_000), '1:02:03');
  assert.equal(formatBar(0.5), `${'\u2588'.repeat(10)}${'\u2591'.repeat(10)} 50%`);
  assert.equal(formatBar(2), `${'\u2588'.repeat(20)} 100%`);
  assert.equal(formatBar(NaN), '');
});

test('capture view shows captured/expected turns, pass, backtracks and elapsed time', () => {
  const view = buildExportProgressView({
    phase: 'capture',
    phaseIndex: 3,
    phaseCount: 8,
    message: 'Capturing conversation',
    elapsedMs: 83_000,
    metrics: { pass: 'capture', capturedTurns: 120, expectedTurns: 300, backtracks: 4, scrollPercent: 38 },
  });
  assert.deepEqual(view.lines, [
    'Capturing conversation',
    'Step 4 of 8: Capturing conversation \u00b7 1:23 elapsed',
    'Turns: 120 captured of 300 expected',
    'Pass: initial capture',
    'Position 38% \u00b7 4 backtracks',
    formatBar(0.4),
    ACTIVE_FOOTER,
  ]);
});

test('verification pass and unknown totals are labelled explicitly', () => {
  const view = buildExportProgressView({
    phase: 'capture',
    message: 'Verifying no turns were missed',
    metrics: {
      pass: 'verify', verificationPass: 1, maxVerificationPasses: 2,
      capturedTurns: 57, backtracks: 1, continuityBreaks: 0, scrollPercent: 90,
    },
  });
  assert.ok(view.lines.includes('Turns: 57 captured (total not reported by page)'));
  assert.ok(view.lines.includes('Pass: verification 1 of up to 2'));
  assert.ok(view.lines.includes('Position 90% \u00b7 1 backtrack'));
  assert.equal(view.fraction, 0.9);
});

test('transform and render views show assets and PDF shard numbers', () => {
  const transform = buildExportProgressView({
    phase: 'transform',
    metrics: {
      serializedTurns: 40, totalTurns: 160,
      assetsProcessed: 12, assetsEmbedded: 10, assetsFailed: 2, pdfShard: 2,
    },
  });
  assert.ok(transform.lines.includes('Converted: 40 of 160 turns'));
  assert.ok(transform.lines.includes('Images: 12 processed (10 saved, 2 failed)'));
  assert.ok(transform.lines.includes('PDF section: 2 being assembled'));
  assert.equal(transform.fraction, 0.25);

  const render = buildExportProgressView({
    phase: 'render',
    metrics: { pdfShard: 3, pdfShards: 7, renderedPages: 41, assetsProcessed: 12, assetsEmbedded: 12 },
  });
  assert.ok(render.lines.includes('PDF section: 3 of 7 \u00b7 41 pages'));
  assert.ok(render.lines.includes('Images: 12 processed (12 saved)'));
});

test('cancelling view replaces the Esc hint with a finishing-current-turn state', () => {
  const view = buildExportProgressView({
    phase: 'transform',
    message: 'Converting turns',
    cancelling: true,
    metrics: { serializedTurns: 5, totalTurns: 10 },
  });
  assert.equal(view.lines[0], CANCEL_HEADLINE);
  assert.equal(view.lines[1], 'Converting turns');
  assert.equal(view.lines[view.lines.length - 1], CANCEL_FOOTER);
  assert.ok(!view.lines.includes(ACTIVE_FOOTER));
  assert.ok(!view.lines.some(line => line.includes('%')), 'no progress bar while cancelling');
});

test('ExportJob keeps metrics sticky, throttles reports and reuses the last message', async () => {
  const reports = [];
  const job = new ExportJob({
    progressIntervalMs: 10_000,
    reportProgress: async payload => { reports.push(payload); },
    handlers: {
      capture: async current => {
        await current.reportMetrics('Capturing conversation', { capturedTurns: 1 }, { force: true });
        await current.reportMetrics('Capturing conversation', { capturedTurns: 2, backtracks: 1 });
        assert.equal(current.metrics.capturedTurns, 2, 'metrics merge even when the report is throttled');
        await current.updateProgress();
      },
    },
  });
  await job.run();
  const capture = reports.filter(report => report.phase === 'capture');
  const forced = capture.find(report => report.metrics.capturedTurns === 1);
  assert.ok(forced, 'forced report was sent');
  const heartbeatLike = capture.find(report => report.metrics.capturedTurns === 2 && report.metrics.backtracks === 1);
  assert.ok(heartbeatLike, 'later report carries throttled metrics');
  assert.equal(heartbeatLike.message, 'Capturing conversation');
  assert.equal(heartbeatLike.phaseIndex, 3);
  assert.equal(heartbeatLike.phaseCount, 8);
  assert.ok(Array.isArray(heartbeatLike.lines) && heartbeatLike.lines.includes('Turns: 2 captured (total not reported by page)'));
});

test('ExportJob publishes the cancelling state immediately on abort', async () => {
  const reports = [];
  let release;
  const job = new ExportJob({
    reportProgress: async payload => { reports.push(payload); },
    handlers: {
      transform: async current => {
        await current.reportMetrics('Converting turns', { serializedTurns: 3, totalTurns: 9 }, { force: true });
        current.abort('user');
        // Simulate the in-flight turn finishing after the abort was requested.
        await new Promise(resolve => { release = resolve; setTimeout(resolve, 5); });
        current.throwIfCancelled();
      },
    },
  });
  await assert.rejects(job.run(), error => error instanceof ExportCancelledError);
  const cancelling = reports.find(report => report.cancelling === true);
  assert.ok(cancelling, 'a cancelling report was emitted');
  assert.equal(cancelling.phase, 'transform');
  assert.equal(cancelling.cancellable, false);
  assert.equal(cancelling.lines[0], CANCEL_HEADLINE);
  assert.ok(cancelling.lines.includes('Converted: 3 of 9 turns'));
  assert.ok(typeof release === 'function');
});

// Minimal virtualizer: fixed heights, optional ordinals, and an optional
// forced continuity break that produces one backtrack per pass.
function makePage({ count, height = 300, viewport = 800, ordinals = false, breakOnce = false }) {
  let scrollTop = 0;
  let broke = false;
  const sent = new Set();
  const total = count * height;
  const range = () => Math.max(0, total - viewport);
  return {
    async callBatch(opts) {
      for (const key of opts.resend || []) sent.delete(key);
      scrollTop = Math.max(0, Math.min(range(), Number(opts.target) || 0));
      let view = scrollTop;
      if (breakOnce && !broke && !opts.observeOnly && scrollTop > 0) {
        broke = true;
        view = Math.min(range(), scrollTop + viewport * 3);
      }
      const refs = [];
      for (let i = 0; i < count; i += 1) {
        const y = i * height;
        if (y + height > view && y < view + viewport) {
          refs.push({
            key: `t${i + 1}`, sourceKey: `message:t${i + 1}`, role: 'unknown', fingerprint: `t${i + 1}`,
            textLength: 10, ...(ordinals ? { ordinal: i + 1, setSize: count } : {}),
          });
        }
      }
      const records = opts.observeOnly ? [] : refs
        .filter(ref => !sent.has(ref.key))
        .map(ref => (sent.add(ref.key), { ...ref, html: `<p>${ref.key}</p>` }));
      return {
        ok: true, refs, records, scrollTop, clientHeight: viewport, range: range(),
        atTop: scrollTop <= 2, atBottom: scrollTop >= range() - 2,
      };
    },
  };
}

async function captureWithProgress(page, config = {}) {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'progress-test' });
  const events = [];
  try {
    await captureConversation({
      store,
      callBatch: page.callBatch,
      progressIntervalMs: 0,
      onProgress: info => { events.push(info); },
      config: { exportCaptureSettleMs: 1, ...config },
    });
    return { events, manifest: store.buildManifest() };
  } finally {
    await store.dispose();
  }
}

test('capture progress reports canonical-store turns and the page-reported total', async () => {
  const { events, manifest } = await captureWithProgress(makePage({ count: 30, ordinals: true }));
  assert.equal(manifest.turnCount, 30);
  const last = events[events.length - 1];
  assert.equal(last.passComplete, true);
  assert.equal(last.capturedTurns, 30);
  assert.equal(last.expectedTurns, 30);
  assert.equal(last.pass, 'capture');
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i].capturedTurns >= events[i - 1].capturedTurns, 'captured turns never decrease');
  }
});

test('capture progress numbers verification passes and accumulates backtracks', async () => {
  const { events } = await captureWithProgress(makePage({ count: 30, breakOnce: true }), {
    exportCaptureVerificationPasses: 2,
  });
  const verify = events.filter(event => event.pass === 'verify');
  assert.ok(verify.length > 0, 'verification pass reported');
  assert.equal(verify[0].verificationPass, 1);
  assert.equal(verify[0].maxVerificationPasses, 2);
  const captureBacktracks = Math.max(...events.filter(e => e.pass === 'capture').map(e => e.backtracks));
  assert.ok(captureBacktracks >= 1, 'backtrack counted during capture');
  assert.ok(verify.every(event => event.backtracks >= captureBacktracks), 'backtracks are cumulative across passes');
});

test('renderer overlay paints lines and keeps the cancelling state sticky', t => {
  const harness = createHarness('empty-shell.json', {});
  t.after(() => harness.dispose());
  const { api, document } = harness;
  const overlay = () => document.querySelector('[data-app-expand-overlay]');
  const active = buildExportProgressView({
    phase: 'capture', message: 'Capturing conversation', metrics: { capturedTurns: 3 },
  });

  assert.equal(api.beginExportJob({ jobId: 'job-1' }).ok, true);
  api.updateExportJobProgress({ jobId: 'job-1', message: active.message, lines: active.lines });
  assert.equal(overlay().textContent, active.lines.join('\n'));

  api.cancelExportJob({ jobId: 'job-1' });
  const afterCancel = overlay().textContent.split('\n');
  assert.equal(afterCancel[0], CANCEL_HEADLINE);
  assert.equal(afterCancel[afterCancel.length - 1], CANCEL_FOOTER);
  assert.ok(afterCancel.includes('Turns: 3 captured (total not reported by page)'));

  // A progress message that was already in flight (not yet cancelling) must
  // not restore the "Press Esc to cancel" presentation.
  const stale = buildExportProgressView({
    phase: 'capture', message: 'Capturing conversation', metrics: { capturedTurns: 4 },
  });
  api.updateExportJobProgress({ jobId: 'job-1', message: stale.message, lines: stale.lines });
  const painted = overlay().textContent.split('\n');
  assert.equal(painted[0], CANCEL_HEADLINE);
  assert.ok(!painted.includes(ACTIVE_FOOTER));
  assert.ok(painted.includes('Turns: 4 captured (total not reported by page)'));

  api.endExportJob({ jobId: 'job-1' });
  assert.equal(overlay(), null, 'overlay removed when the job ends');
});
