'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');

const { createCanonicalConversationStore, validateCanonicalCapture } = require('../lib/canonical-conversation');
const { captureConversation } = require('../lib/conversation-capture');

// Simulated virtualizer: turns with heights, a viewport, overscan, optional
// re-measurement (heights change after first mount) and optional ordinals.
function makePage({ heights, viewport = 800, overscan = 200, remeasure = null, ordinals = false, lazyTop = 0 }) {
  let turns = heights.map((h, i) => ({ key: `t${i + 1}`, h, measured: false, i }));
  const hidden = turns.splice(0, lazyTop); // older history loaded at the top
  let scrollTop = 0;
  const sent = new Set();
  const layout = () => { let y = 0; return turns.map(t => { const r = { t, y }; y += t.h; return r; }); };
  const total = () => turns.reduce((s, t) => s + t.h, 0);
  const range = () => Math.max(0, total() - viewport);
  let topVisits = 0;
  return {
    sentCount: () => sent.size,
    async callBatch(opts) {
      for (const k of opts.resend || []) sent.delete(k);
      const r = range();
      const target = opts.target === 'end' ? r : Math.max(0, Math.min(r, Number(opts.target) || 0));
      scrollTop = target;
      if (scrollTop === 0 && hidden.length && ++topVisits > 1) { turns = hidden.splice(0).concat(turns); }
      const mounted = layout().filter(({ t, y }) => y + t.h > scrollTop - overscan && y < scrollTop + viewport + overscan);
      if (remeasure) {
        for (const { t } of mounted) if (!t.measured) { t.measured = true; t.h = remeasure(t); }
        // keep the first mounted turn anchored (scroll anchoring)
      }
      const refs = mounted.map(({ t, y }) => ({
        key: t.key, sourceKey: `message:${t.key}`, role: 'unknown', fingerprint: t.key,
        textLength: 20, y, ...(ordinals ? { ordinal: t.i + 1, setSize: heights.length } : {}),
      }));
      const records = opts.observeOnly ? [] : refs.filter(x => !sent.has(x.key)).map(x => (sent.add(x.key), { ...x, html: `<p>${x.key}</p>` }));
      const nr = range();
      scrollTop = Math.min(scrollTop, nr);
      return { ok: true, refs, records, scrollTop, clientHeight: viewport, range: nr, atTop: scrollTop <= 2, atBottom: nr <= 2 || scrollTop >= nr - 2 };
    },
  };
}

async function run(page, config = {}) {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'capture-test' });
  try {
    await captureConversation({ store, callBatch: page.callBatch, config: { exportCaptureSettleMs: 1, ...config } });
    const manifest = store.buildManifest();
    return { manifest, completeness: validateCanonicalCapture(manifest) };
  } finally {
    await store.dispose();
  }
}

test('captures every turn of a long conversation in order', async () => {
  const heights = Array.from({ length: 300 }, (_, i) => 80 + ((i * 137) % 900));
  const { manifest, completeness } = await run(makePage({ heights }));
  assert.equal(manifest.turnCount, 300);
  assert.deepEqual(manifest.entries.map(e => e.key), heights.map((_, i) => `t${i + 1}`));
  assert.equal(completeness.lowConfidence, false, completeness.failures.join('\n'));
});

test('survives turns taller than the viewport and late re-measurement', async () => {
  const heights = Array.from({ length: 60 }, (_, i) => (i % 7 === 0 ? 5000 : 120));
  const page = makePage({ heights, overscan: 0, remeasure: t => t.h * (t.i % 3 === 0 ? 3 : 1) });
  const { manifest, completeness } = await run(page);
  assert.equal(manifest.turnCount, 60);
  assert.deepEqual(manifest.entries.map(e => e.key), heights.map((_, i) => `t${i + 1}`));
  assert.equal(completeness.lowConfidence, false, completeness.failures.join('\n'));
});

test('skips verification when ordinals prove completeness', async () => {
  const heights = Array.from({ length: 40 }, () => 300);
  const { manifest, completeness } = await run(makePage({ heights, ordinals: true }));
  assert.equal(manifest.turnCount, 40);
  assert.equal(manifest.passes.length, 1);
  assert.equal(completeness.lowConfidence, false, completeness.failures.join('\n'));
});

test('picks up history that loads when the top is reached', async () => {
  const heights = Array.from({ length: 50 }, () => 250);
  const { manifest, completeness } = await run(makePage({ heights, lazyTop: 10 }));
  assert.equal(manifest.turnCount, 50);
  assert.deepEqual(manifest.entries.map(e => e.key), heights.map((_, i) => `t${i + 1}`));
  assert.equal(completeness.lowConfidence, false, completeness.failures.join('\n'));
});


// Wrap makePage() so it behaves like the streaming renderer: records carry a
// recordToken and htmlLength, HTML is read in chunks, and the next batch is
// refused while any token is still pending.
function makeStreamingPage(pageOptions, htmlFor) {
  const page = makePage(pageOptions);
  const pending = new Map();
  const stats = { chunkReads: 0, charsRead: 0, released: 0 };
  let serial = 0;
  return {
    pending,
    stats,
    async callBatch(opts) {
      if (pending.size) return { ok: false, reason: 'pending-canonical-records-not-released' };
      const batch = await page.callBatch(opts);
      if (!opts.streamRecords || opts.observeOnly) return batch;
      batch.records = batch.records.map(record => {
        const html = htmlFor(record.key);
        const token = `record-${++serial}`;
        pending.set(token, html);
        const metadata = { ...record };
        delete metadata.html;
        return { ...metadata, recordToken: token, htmlLength: html.length };
      });
      return batch;
    },
    async readRecordChunk({ recordToken, offset, maxChars }) {
      const html = pending.get(recordToken);
      if (typeof html !== 'string') return { ok: false, reason: 'missing-token' };
      let end = Math.min(html.length, offset + maxChars);
      if (end < html.length && end > offset) {
        const last = html.charCodeAt(end - 1);
        if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
      }
      stats.chunkReads += 1;
      stats.charsRead += end - offset;
      return { ok: true, chunk: html.slice(offset, end), nextOffset: end, totalLength: html.length };
    },
    async releaseRecords({ recordTokens }) {
      let released = 0;
      for (const token of recordTokens) {
        if (pending.delete(token)) released += 1;
      }
      stats.released += released;
      return { ok: true, released };
    },
  };
}

test('streams large turns in bounded chunks without splitting surrogate pairs', async t => {
  // The emoji straddles the 16384-character chunk boundary.
  const expectedHtml = `<article>${'x'.repeat(16374)}\u{1F600}${'y'.repeat(20000)}</article>`;
  const page = makeStreamingPage({ heights: [300, 300], viewport: 800, ordinals: true }, () => expectedHtml);
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'capture-stream' });
  t.after(() => store.dispose());

  await captureConversation({
    store,
    callBatch: opts => page.callBatch(opts),
    readRecordChunk: opts => page.readRecordChunk(opts),
    releaseRecords: opts => page.releaseRecords(opts),
    config: { exportCaptureSettleMs: 1, exportCaptureIpcChunkBytes: 16384 },
  });

  const manifest = store.buildManifest();
  assert.equal(manifest.turnCount, 2);
  assert.equal(page.pending.size, 0);
  assert.ok(page.stats.chunkReads >= 6);
  for (const entry of manifest.entries) {
    assert.equal(await fs.promises.readFile(entry.rawPath, 'utf8'), expectedHtml);
  }
  assert.deepEqual(await fs.promises.readdir(store.incomingDirectory), []);
});

test('rejected streamed windows are released without transferring their HTML', async t => {
  // Placeholder rows shrink after mounting, forcing at least one continuity
  // backtrack. Streamed records from that rejected window must not be read.
  const heights = Array.from({ length: 80 }, () => 900);
  const page = makeStreamingPage(
    { heights, overscan: 0, remeasure: turn => (turn.i % 2 ? 60 : 900) },
    key => `<p>${key}</p>`
  );
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'capture-reject' });
  t.after(() => store.dispose());

  await captureConversation({
    store,
    callBatch: opts => page.callBatch(opts),
    readRecordChunk: opts => page.readRecordChunk(opts),
    releaseRecords: opts => page.releaseRecords(opts),
    config: { exportCaptureSettleMs: 1, exportCaptureStepFraction: 0.9 },
  });

  const manifest = store.buildManifest();
  assert.equal(manifest.turnCount, 80);
  assert.deepEqual(manifest.entries.map(entry => entry.key), heights.map((_, index) => `t${index + 1}`));
  assert.ok(manifest.passes.some(pass => pass.backtracks > 0), 'scenario must exercise rejection');
  const keptCharacters = manifest.entries.reduce((sum, entry) => sum + entry.htmlLength, 0);
  assert.equal(page.stats.charsRead, keptCharacters);
  assert.equal(page.pending.size, 0);
  assert.equal(validateCanonicalCapture(manifest).lowConfidence, false);
});

test('rejected pre-staged windows are cleaned up before retrying', async t => {
  const heights = Array.from({ length: 80 }, (_, index) => (index % 5 === 0 ? 40 : 600));
  const page = makePage({ heights, overscan: 0 });
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'capture-staged' });
  t.after(() => store.dispose());

  const callBatch = async opts => {
    const batch = await page.callBatch(opts);
    const records = [];
    for (const record of batch.records) {
      const stagedPath = await store.createIncomingFile(record.key);
      await fs.promises.writeFile(stagedPath, record.html, 'utf8');
      const { html, ...metadata } = record;
      records.push({ ...metadata, htmlLength: html.length, stagedPath });
    }
    return { ...batch, records };
  };

  await captureConversation({
    store,
    callBatch,
    config: { exportCaptureSettleMs: 1, exportCaptureStepFraction: 0.9 },
  });

  const manifest = store.buildManifest();
  assert.equal(manifest.turnCount, 80);
  assert.deepEqual(manifest.entries.map(entry => entry.key), heights.map((_, index) => `t${index + 1}`));
  assert.deepEqual(await fs.promises.readdir(store.incomingDirectory), []);
});

test('a release failure does not hide the primary streaming error', async t => {
  const page = makeStreamingPage({ heights: [300], viewport: 800 }, () => '<p>x</p>');
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'capture-fail' });
  t.after(() => store.dispose());

  await assert.rejects(
    captureConversation({
      store,
      callBatch: opts => page.callBatch(opts),
      readRecordChunk: async () => ({ ok: false, reason: 'renderer-chunk-broken' }),
      releaseRecords: async () => ({ ok: false, reason: 'release-broken' }),
      config: { exportCaptureSettleMs: 1 },
    }),
    /renderer-chunk-broken/
  );
  assert.deepEqual(await fs.promises.readdir(store.incomingDirectory), []);
});
