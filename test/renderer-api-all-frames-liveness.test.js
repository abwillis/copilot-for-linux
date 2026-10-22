'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callRendererMethodInAllFrames } = require('../lib/renderer-api');

const OPTIONS = { __rendererApiOptions: { rendererApiGlobal: '__fixture' } };

function makeWindow(subFrames) {
  const mainFrame = { routingId: 1 };
  mainFrame.framesInSubtree = [mainFrame, ...subFrames];
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    executeJavaScript: async () => ({ ok: true, top: true }),
  };
  return { webContents, isDestroyed: () => false, mainFrame };
}

test('a sub-frame removed during an all-frames call does not stall the call', async () => {
  const dead = { routingId: 7, detached: false, executeJavaScript: () => new Promise(() => {}) };
  const live = { routingId: 8, detached: false, executeJavaScript: async () => ({ ok: true, sub: true }) };
  const win = makeWindow([dead, live]);
  setTimeout(() => { win.mainFrame.framesInSubtree = [win.mainFrame, live]; }, 20);
  const results = await Promise.race([
    callRendererMethodInAllFrames(win, 'locateChatRoot', {}, OPTIONS),
    new Promise((_, reject) => setTimeout(() => reject(new Error('did not settle')), 1000)),
  ]);
  assert.deepEqual(results.map(r => r.frameId), [0, 8]);
});
