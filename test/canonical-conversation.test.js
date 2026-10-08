'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');

const {
  createCanonicalConversationStore,
  validateCanonicalCapture,
  logicalAnchorKey,
  intervalCoverage,
} = require('../lib/canonical-conversation');

function ref(key, extra = {}) {
  return { key, sourceKey: `message:${key}`, role: 'unknown', fingerprint: `${key}:fp`, textLength: 10, ...extra };
}
function rec(key, html, extra = {}) {
  return { ...ref(key, extra), html: html || `<article>${key}</article>` };
}

test('store merges overlapping windows into conversation order and keeps the richest copy', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-v2' });
  t.after(() => store.dispose());
  store.beginPass('capture');
  await store.ingestBatch({ refs: [ref('a'), ref('b')], records: [rec('a'), rec('b')], scrollTop: 0, clientHeight: 500, range: 900, atTop: true });
  assert.equal(store.hasContinuity([ref('b'), ref('c')]), true);
  assert.equal(store.hasContinuity([ref('x')]), false);
  await store.ingestBatch({
    refs: [ref('b'), ref('c'), ref('d')],
    records: [rec('b', '<article>b with a much longer tail</article>', { textLength: 30 }), rec('c'), rec('d')],
    scrollTop: 400, clientHeight: 500, range: 900, atBottom: true,
  });
  store.endPass({ terminalStableSamples: 3 });
  const manifest = store.buildManifest();
  assert.deepEqual(manifest.entries.map(e => e.key), ['a', 'b', 'c', 'd']);
  assert.match(await fs.promises.readFile(manifest.entries[1].rawPath, 'utf8'), /longer tail/);
  const result = validateCanonicalCapture(manifest);
  assert.equal(result.lowConfidence, false, result.failures.join('\n'));
});

test('a new turn seen before known turns is inserted ahead of them', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-v2' });
  t.after(() => store.dispose());
  store.beginPass('capture');
  await store.ingestBatch({ refs: [ref('b'), ref('c')], records: [rec('b'), rec('c')], atTop: true, atBottom: true });
  store.endPass();
  store.beginPass('verify');
  await store.ingestBatch({ refs: [ref('a'), ref('b')], records: [rec('a')], atTop: true, atBottom: true });
  store.endPass();
  const manifest = store.buildManifest();
  assert.deepEqual(manifest.entries.map(e => e.key), ['a', 'b', 'c']);
  const result = validateCanonicalCapture(manifest);
  assert.equal(result.lowConfidence, true);
  assert.match(result.failures.join('\n'), /verification pass still discovered 1/);
});

test('validation fails on continuity breaks and ordinal gaps, but pixel gaps are informational', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-v2' });
  t.after(() => store.dispose());
  store.beginPass('capture');
  await store.ingestBatch({ refs: [ref('a', { ordinal: 1 })], records: [rec('a', null, { ordinal: 1 })], scrollTop: 0, clientHeight: 100, range: 5000, atTop: true });
  await store.ingestBatch({ refs: [ref('c', { ordinal: 3 })], records: [rec('c', null, { ordinal: 3 })], scrollTop: 4900, clientHeight: 100, range: 5000, atBottom: true });
  store.endPass({ terminalStableSamples: 3 });
  const result = validateCanonicalCapture(store.buildManifest());
  assert.equal(result.lowConfidence, true);
  const text = result.failures.join('\n');
  assert.match(text, /could not be linked/);
  assert.match(text, /1 turn position/);
});

test('logical anchors prefer source identity, then role plus ordinal', () => {
  assert.equal(logicalAnchorKey({ sourceKey: 'message:abc', role: 'assistant', ordinal: 7 }), 'source:message:abc');
  assert.equal(logicalAnchorKey({ role: 'assistant', ordinal: 7 }), 'ordinal:assistant:7');
  assert.equal(logicalAnchorKey({ role: 'assistant' }), '');
});

test('interval coverage reports internal gaps', () => {
  const result = intervalCoverage([[0, 300], [500, 1000]], 500, 500);
  assert.equal(result.gapPx, 200);
  assert.equal(result.coveragePct, 80);
});


test('store refreshes a learned logical identity when a richer observation arrives', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-identity' });
  t.after(() => store.dispose());

  store.beginPass('capture');
  await store.ingestBatch({
    refs: [{ ...ref('stable'), sourceKey: '' }],
    records: [{ ...rec('stable', '<article>draft</article>', { textLength: 5 }), sourceKey: '' }],
    atTop: true,
  });
  await store.ingestBatch({
    refs: [ref('stable', { sourceKey: 'message:learned' })],
    records: [rec('stable', '<article>draft with complete details</article>', {
      sourceKey: 'message:learned',
      textLength: 27,
    })],
    atBottom: true,
  });
  store.endPass({ terminalStableSamples: 3 });

  const manifest = store.buildManifest();
  assert.equal(manifest.turnCount, 1);
  assert.equal(manifest.entries[0].sourceKey, 'message:learned');
  assert.equal(manifest.entries[0].logicalAnchor, 'source:message:learned');
});

test('a richer observation without a role preserves the learned role', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-role' });
  t.after(() => store.dispose());

  store.beginPass('capture');
  await store.ingestBatch({
    refs: [ref('stable', { role: 'assistant' })],
    records: [rec('stable', '<article>draft</article>', { role: 'assistant', textLength: 5 })],
    atTop: true,
  });
  const richer = rec('stable', '<article>draft with complete details</article>', { textLength: 27 });
  delete richer.role;
  await store.ingestBatch({ refs: [ref('stable')], records: [richer], atBottom: true });
  store.endPass({ terminalStableSamples: 3 });

  assert.equal(store.buildManifest().entries[0].role, 'assistant');
});

test('store preserves repeated identical content when stable keys differ', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-repeat' });
  t.after(() => store.dispose());

  const first = rec('repeat-1', '<article>same text</article>', { fingerprint: 'same' });
  const second = rec('repeat-2', '<article>same text</article>', { fingerprint: 'same' });
  store.beginPass('capture');
  await store.ingestBatch({
    refs: [first, second],
    records: [first, second],
    atTop: true,
    atBottom: true,
  });
  store.endPass({ terminalStableSamples: 3 });

  assert.deepEqual(store.buildManifest().entries.map(entry => entry.key), ['repeat-1', 'repeat-2']);
});

test('store adopts streamed turn files and removes every unused staged observation', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-stream' });
  t.after(() => store.dispose());

  async function stagedRecord(key, html, textLength) {
    const stagedPath = await store.createIncomingFile(key);
    await fs.promises.writeFile(stagedPath, html, 'utf8');
    return {
      ...rec(key, '', { textLength }),
      html: '',
      htmlLength: html.length,
      stagedPath,
    };
  }

  store.beginPass('capture');
  const first = await stagedRecord('streamed', '<article>first complete copy</article>', 19);
  await store.ingestBatch({ refs: [ref('streamed')], records: [first], atTop: true });
  assert.equal(fs.existsSync(first.stagedPath), false);

  const redundant = await stagedRecord('streamed', '<article>x</article>', 1);
  const unreferenced = await stagedRecord('not-mounted', '<article>unused</article>', 6);
  await store.ingestBatch({ refs: [ref('streamed')], records: [redundant, unreferenced], atBottom: true });
  assert.equal(fs.existsSync(redundant.stagedPath), false);
  assert.equal(fs.existsSync(unreferenced.stagedPath), false);
  store.endPass({ terminalStableSamples: 3 });

  const manifest = store.buildManifest();
  assert.equal(manifest.turnCount, 1);
  assert.equal(await fs.promises.readFile(manifest.entries[0].rawPath, 'utf8'), '<article>first complete copy</article>');
});

test('a failed staged replacement preserves the committed turn and removes temporary files', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-atomic' });
  t.after(() => store.dispose());

  store.beginPass('capture');
  await store.ingestBatch({
    refs: [ref('stable')],
    records: [rec('stable', '<article>committed</article>', { textLength: 9 })],
    atTop: true,
  });

  const committed = store.entries.get('stable');
  const committedPath = committed.rawPath;
  const committedScore = committed.score;
  const stagedPath = await store.createIncomingFile('stable-richer');
  await fs.promises.writeFile(stagedPath, '<article>uncommitted richer replacement</article>', 'utf8');
  const richer = {
    ...rec('stable', '', { textLength: 99, fingerprint: 'replacement' }),
    html: '',
    htmlLength: 50,
    stagedPath,
  };

  const replace = store._replaceFileFromTemporary;
  store._replaceFileFromTemporary = async () => {
    const error = new Error('simulated replacement failure');
    error.code = 'EIO';
    throw error;
  };
  await assert.rejects(
    store.ingestBatch({ refs: [ref('stable')], records: [richer], atBottom: true }),
    /simulated replacement failure/
  );
  store._replaceFileFromTemporary = replace;

  assert.equal(await fs.promises.readFile(committedPath, 'utf8'), '<article>committed</article>');
  assert.equal(committed.score, committedScore);
  assert.equal(committed.fingerprint, 'stable:fp');
  assert.equal(fs.existsSync(stagedPath), false);
  assert.deepEqual(await fs.promises.readdir(store.incomingDirectory), []);
  assert.deepEqual(await fs.promises.readdir(store.turnDirectory), [path.basename(committedPath)]);
});

test('staged-record cleanup never deletes a path outside the incoming directory', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-safe-cleanup' });
  const outsideDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'canon-outside-'));
  const outsidePath = path.join(outsideDirectory, 'keep.txt');
  await fs.promises.writeFile(outsidePath, 'keep', 'utf8');
  t.after(async () => {
    await store.dispose();
    await fs.promises.rm(outsideDirectory, { recursive: true, force: true });
  });

  await store.discardStagedRecords([{ stagedPath: outsidePath }]);
  assert.equal(await fs.promises.readFile(outsidePath, 'utf8'), 'keep');
});

test('expected total uses the dominant virtualizer observation rather than one outlier', async t => {
  const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: 'canon-total' });
  t.after(() => store.dispose());

  store.beginPass('capture');
  const rows = [
    rec('one', null, { ordinal: 1, setSize: 999 }),
    rec('two', null, { ordinal: 2, setSize: 3 }),
    rec('three', null, { ordinal: 3, setSize: 3 }),
  ];
  await store.ingestBatch({ refs: rows, records: rows, atTop: true, atBottom: true });
  store.endPass({ terminalStableSamples: 3 });

  const manifest = store.buildManifest();
  assert.equal(manifest.expectedTotal, 3);
  assert.equal(manifest.ordinalsComplete, true);
});
