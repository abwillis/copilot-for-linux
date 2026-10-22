'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

const PRELOAD_CORE = path.join(__dirname, '..', 'lib', 'preload-core.js');

// preload-core requires 'electron', which exists only inside Electron. Load it
// with a stub so the click handler can be exercised in plain Node.
function loadPreload(t) {
  const sent = [];
  const listeners = {};
  const electron = {
    contextBridge: { exposeInMainWorld() {} },
    ipcRenderer: {
      sendSync: () => ({ directOpenBehavior: 'shift-click' }),
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
  const originalLoad = Module._load;
  const hadWindow = Object.prototype.hasOwnProperty.call(global, 'window');
  const hadLocation = Object.prototype.hasOwnProperty.call(global, 'location');
  const priorWindow = global.window;
  const priorLocation = global.location;
  Module._load = function (request, ...rest) {
    return request === 'electron' ? electron : originalLoad.call(this, request, ...rest);
  };
  global.window = { addEventListener: (type, fn) => { listeners[type] = fn; } };
  global.location = { href: 'https://app.example/' };
  t.after(() => {
    Module._load = originalLoad;
    if (hadWindow) global.window = priorWindow; else delete global.window;
    if (hadLocation) global.location = priorLocation; else delete global.location;
    delete require.cache[PRELOAD_CORE];
  });
  delete require.cache[PRELOAD_CORE];
  const { initPreload } = require(PRELOAD_CORE);
  const { createIPC } = require('../lib/ipc');
  const IPC = createIPC('test');
  initPreload({ appSlug: 'test', hostApiName: 'testHost', IPC });
  return { sent, listeners, IPC };
}

function clickOn(anchor, overrides) {
  return { isTrusted: true, defaultPrevented: false, shiftKey: true, button: 0, target: anchor, ...overrides };
}

const anchor = { closest: () => anchor, href: 'https://files.example/report.pdf', getAttribute: () => 'https://files.example/report.pdf' };

test('a trusted shift+click queues a direct-open request', t => {
  const { sent, listeners, IPC } = loadPreload(t);
  listeners.click(clickOn(anchor));
  assert.deepEqual(sent.filter(m => m.channel === IPC.DIRECT_OPEN_LINK).map(m => m.payload.href), ['https://files.example/report.pdf']);
});

test('a script-dispatched (untrusted) click never queues a direct-open request', t => {
  const { sent, listeners, IPC } = loadPreload(t);
  listeners.click(clickOn(anchor, { isTrusted: false }));
  assert.equal(sent.filter(m => m.channel === IPC.DIRECT_OPEN_LINK).length, 0);
});

test('a plain click without shift is ignored', t => {
  const { sent, listeners, IPC } = loadPreload(t);
  listeners.click(clickOn(anchor, { shiftKey: false }));
  assert.equal(sent.filter(m => m.channel === IPC.DIRECT_OPEN_LINK).length, 0);
});
