'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { callRendererMethodInFrame } = require('../lib/renderer-api');

const OPTIONS = { __rendererApiOptions: { rendererApiGlobal: '__fixture' } };

function makeWindow(frames) {
  const mainFrame = { routingId: 1, framesInSubtree: frames.slice() };
  const webContents = {
    mainFrame,
    isDestroyed: () => false,
    executeJavaScript: async () => null,
  };
  return { webContents, isDestroyed: () => false, mainFrame };
}

test('a frame removed during an RPC yields a bounded structured failure', async () => {
  // Mirrors Electron: the reply channel dies with the frame, so the promise never settles.
  const frame = { routingId: 7, detached: false, executeJavaScript: () => new Promise(() => {}) };
  const win = makeWindow([frame]);
  win.mainFrame.framesInSubtree = [win.mainFrame, frame];
  const pending = callRendererMethodInFrame(win, 7, 'slow', 1000, OPTIONS);
  setTimeout(() => { win.mainFrame.framesInSubtree = [win.mainFrame]; }, 20);
  const result = await Promise.race([
    pending,
    new Promise((_, reject) => setTimeout(() => reject(new Error('did not settle')), 1000)),
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RENDERER_FRAME_GONE');
  assert.match(result.error, /frame/i);
});

test('a detached or disposed frame is reported as gone', async () => {
  const detached = { routingId: 8, detached: false, executeJavaScript: () => new Promise(() => {}) };
  const win = makeWindow([detached]);
  win.mainFrame.framesInSubtree = [win.mainFrame, detached];
  setTimeout(() => { detached.detached = true; }, 20);
  const result = await callRendererMethodInFrame(win, 8, 'slow', 1000, OPTIONS);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RENDERER_FRAME_GONE');

  const disposed = { routingId: 9, executeJavaScript: () => new Promise(() => {}) };
  Object.defineProperty(disposed, 'detached', { get() { throw new Error('Render frame was disposed'); } });
  const win2 = makeWindow([disposed]);
  win2.mainFrame.framesInSubtree = [win2.mainFrame, disposed];
  const result2 = await callRendererMethodInFrame(win2, 9, 'slow', 1000, OPTIONS);
  assert.equal(result2.ok, false);
  assert.equal(result2.code, 'RENDERER_FRAME_GONE');
});

test('a live frame still returns its value', async () => {
  const frame = { routingId: 5, detached: false, executeJavaScript: async () => ({ ok: true, value: 42 }) };
  const win = makeWindow([frame]);
  win.mainFrame.framesInSubtree = [win.mainFrame, frame];
  const result = await callRendererMethodInFrame(win, 5, 'echo', 42, OPTIONS);
  assert.deepEqual(result, { ok: true, value: 42 });
});

test('a rejected frame call still resolves to a structured failure', async () => {
  const frame = { routingId: 6, detached: false, executeJavaScript: async () => { throw new Error('boom'); } };
  const win = makeWindow([frame]);
  win.mainFrame.framesInSubtree = [win.mainFrame, frame];
  const result = await callRendererMethodInFrame(win, 6, 'echo', 1, OPTIONS);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});
