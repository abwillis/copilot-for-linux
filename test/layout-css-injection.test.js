'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const layout = require('../app-specific/layout-css');

function fakeWebContents() {
  const wc = new EventEmitter();
  let counter = 0;
  wc.live = new Set();
  wc.calls = [];
  wc.mainFrame = { framesInSubtree: [] };
  wc.isDestroyed = () => false;
  wc.insertCSS = css => new Promise(resolve => setTimeout(() => {
    const key = `css-${++counter}`;
    wc.live.add(key);
    resolve(key);
  }, 10));
  wc.removeInsertedCSS = key => { wc.live.delete(key); return Promise.resolve(); };
  wc.executeJavaScript = async source => {
    for (const method of ['startVWResize', 'setTargetVW']) if (source.includes(method)) wc.calls.push(method);
    return { ok: true };
  };
  return wc;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a burst of navigation events leaves exactly one live stylesheet', async () => {
  const wc = fakeWebContents();
  const holder = { key: null, css: '', __wired: false };
  layout.injectCSSOnLoad({ webContents: wc }, 'a{}', holder);
  wc.emit('dom-ready');
  wc.emit('did-navigate-in-page');
  wc.emit('dom-ready');
  await wait(300);
  assert.equal(wc.live.size, 1);
});

test('responsive width listener installs even when dom-ready already fired', async () => {
  const api = layout.createLayoutCSS({
    rendererApiGlobal: '__test',
    dynamicWidth: { cssVar: '--test-vw', minVw: 70, maxVw: 100, defaultVw: 100, screenPercent: 95 },
    getRuntimeConfig: () => ({ layoutWidthVw: 100 }),
  });
  const wc = fakeWebContents();
  wc.emit('dom-ready');
  await api.attachVWResize({ webContents: wc, isDestroyed: () => false });
  assert.equal(wc.calls.filter(name => name === 'startVWResize').length, 1);
});

test('changing the layout width re-arms the responsive listener', async () => {
  let width = 100;
  const api = layout.createLayoutCSS({
    rendererApiGlobal: '__test',
    dynamicWidth: { cssVar: '--test-vw', minVw: 70, maxVw: 100, defaultVw: 100, screenPercent: 95 },
    getRuntimeConfig: () => ({ layoutWidthVw: width }),
  });
  const wc = fakeWebContents();
  const win = { webContents: wc, isDestroyed: () => false };
  await api.attachVWResize(win);
  wc.calls.length = 0;
  width = 90;
  await api.applyDynamicWidth(win);
  assert.deepEqual(wc.calls, ['setTargetVW', 'startVWResize']);
});
