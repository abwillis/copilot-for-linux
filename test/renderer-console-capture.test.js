'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeConfig } = require('../lib/runtime-config');
const defaults = require('../app-specific/app.config').defaultAppConfig;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-capture-'));
  const runtime = createRuntimeConfig({
    app: { getPath: () => dir }, fs, path,
    defaultAppConfig: { ...defaults, enableFileLogging: true, enableRendererConsoleCapture: true },
  });
  t.after(async () => { await runtime.shutdownLogging(); fs.rmSync(dir, { recursive: true, force: true }); });
  runtime.loadAppConfig();
  return runtime;
}

function attach(runtime) {
  const listeners = [];
  const webContents = { on: (name, listener) => listeners.push({ name, listener }) };
  assert.equal(runtime.attachRendererConsoleCapture(webContents, 'renderer'), true);
  const entry = listeners.find(item => item.name === 'console-message');
  assert.ok(entry, 'console-message listener registered');
  return entry.listener;
}

test('console-message listener is single-parameter so Electron does not warn about deprecated arguments', t => {
  const listener = attach(fixture(t));
  // Electron decides between the legacy positional API and the event-object API by arity.
  assert.ok(listener.length <= 1, `listener declares ${listener.length} parameters`);
});

test('renderer console output is captured from the event-object form', async t => {
  const runtime = fixture(t);
  const listener = attach(runtime);
  listener({ level: 'warning', message: 'composer width not applied', lineNumber: 42, sourceId: 'https://app.test/main.js' });
  listener({ level: 'error', message: 'boom', lineNumber: 1, sourceId: 'x.js' });
  await runtime.flushLogBuffers();
  const text = fs.readFileSync(runtime.getRendererLogFilePath(), 'utf8');
  assert.match(text, /\[WARN\] \[renderer\] composer width not applied \(https:\/\/app\.test\/main\.js:42\)/);
  assert.match(text, /\[ERROR\] \[renderer\] boom \(x\.js:1\)/);
});
