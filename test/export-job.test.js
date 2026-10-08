'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EXPORT_JOB_PHASES,
  ExportJob,
  ExportCancelledError,
  ConversationSnapshot,
  ConversationSnapshotCache,
} = require('../lib/export-job');

test('ExportJob executes the required phases in order and always cleans up', async () => {
  const phases = [];
  const cleanup = [];
  const handlers = Object.fromEntries(EXPORT_JOB_PHASES.map(phase => [phase, async job => {
    phases.push(phase);
    if (phase === 'locate') job.addCleanup(async () => cleanup.push('restored'));
    return { phase };
  }]));
  const job = new ExportJob({ handlers });
  const result = await job.run();
  assert.equal(result.ok, true);
  assert.deepEqual(phases, EXPORT_JOB_PHASES);
  assert.deepEqual(cleanup, ['restored']);
  assert.equal(result.context instanceof Object, true);
});

test('ExportJob cancellation rejects and still runs cleanup', async () => {
  const cleanup = [];
  const controller = new AbortController();
  const job = new ExportJob({
    controller,
    handlers: {
      locate: async current => {
        current.addCleanup(() => cleanup.push('clean'));
        controller.abort('stop');
      },
    },
  });
  await assert.rejects(job.run(), error => error instanceof ExportCancelledError);
  assert.deepEqual(cleanup, ['clean']);
});

test('ConversationSnapshotCache keys entries by owner, revision, identity and expansion options', () => {
  const cache = new ConversationSnapshotCache();
  const owner = {};
  const identity = {
    conversationIdentity: 'conversation-1',
    url: 'https://example.test/chat/1',
    mutationRevision: 7,
    expansionOptions: { expandReasoning: true },
    includeRaw: false,
  };
  const snapshot = new ConversationSnapshot({
    cleanSemanticHtml: '<article>ok</article>',
    plainText: 'ok',
    title: 'Conversation',
  });
  cache.set(owner, identity, snapshot);
  assert.equal(cache.get(owner, identity), snapshot);
  assert.equal(cache.get(owner, { ...identity, mutationRevision: 8 }), null);
  assert.equal(cache.get(owner, { ...identity, expansionOptions: { expandReasoning: false } }), null);
  cache.invalidate(owner);
  assert.equal(cache.get(owner, identity), null);
});

test('ConversationSnapshot preserves the reusable capture fields', () => {
  const snapshot = new ConversationSnapshot({
    cleanSemanticHtml: '<main>clean</main>',
    rawHtml: '<main class="raw">clean</main>',
    plainText: 'clean',
    messageFingerprints: ['1:5'],
    orderFingerprints: ['1:5'],
    title: 'Title',
    url: 'https://example.test/chat',
    capturedAt: '2026-10-08T16:00:00.000Z',
    theme: { foreground: '#111', background: '#fff' },
    sourceMetadata: { rendererAgentVersion: 3 },
    materializedImageMap: { 'https://example.test/a.png': 'data:image/png;base64,AA==' },
    completeness: { logicalTurnsAfter: 1, lowConfidence: false },
  });
  assert.equal(snapshot.cleanSemanticHtml, '<main>clean</main>');
  assert.equal(snapshot.rawHtml.includes('raw'), true);
  assert.equal(snapshot.plainText, 'clean');
  assert.deepEqual(snapshot.messageFingerprints, ['1:5']);
  assert.equal(snapshot.completeness.lowConfidence, false);
  assert.equal(Object.isFrozen(snapshot), true);
});
