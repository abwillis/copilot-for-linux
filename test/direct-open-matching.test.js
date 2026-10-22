'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDirectOpen } = require('../lib/direct-open');

function harness(t, requestedUrl, item) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-open-match-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(console, 'log', () => {});
  const session = new EventEmitter();
  const ipcMain = new EventEmitter();
  const direct = createDirectOpen({
    session: { fromPartition: () => session },
    shell: { openPath: async () => '' },
    fs, path,
    app: { getPath: () => dir },
    ipcMain,
    getAppConfig: () => ({ directOpenBehavior: 'shift-click' }),
    getAppPartition: () => 'persist:test',
    appSlug: 'test',
    safeShowError() {},
  });
  const IPC = { DIRECT_OPEN_LINK: 'open', RENDERER_SETTINGS: 'settings', PRELOAD_PING: 'ping' };
  direct.registerDirectOpenIpcHandler(IPC);
  direct.registerDirectOpenDownloadHandler();
  ipcMain.emit('open', { sender: { id: 1 } }, { href: requestedUrl });
  let savePath = null;
  Object.assign(item, {
    getFilename: () => 'file.bin', getReceivedBytes: () => 0, getTotalBytes: () => 0,
    setSavePath(p) { savePath = p; }, setSaveDialogOptions() {},
  });
  const wc = new EventEmitter();
  wc.id = 1;
  session.emit('will-download', {}, Object.assign(new EventEmitter(), item), wc);
  return () => savePath;
}

test('a download from the same path prefix is not adopted for direct-open', t => {
  const url = 'https://site.example/unrelated/payload.bin';
  const savePath = harness(t, 'https://site.example/', { getURL: () => url, getURLChain: () => [url] });
  assert.equal(savePath(), null);
});

test('a redirected download still matches through its URL chain', t => {
  const first = 'https://site.example/file';
  const final = 'https://cdn.example/abc';
  const savePath = harness(t, first, { getURL: () => final, getURLChain: () => [first, final] });
  assert.ok(savePath());
});
