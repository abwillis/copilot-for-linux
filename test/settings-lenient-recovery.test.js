'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeConfig } = require('../lib/runtime-config');
const { validateSettingsPatch } = require('../lib/settings-schema');
const defaults = require('../app-specific/app.config').defaultAppConfig;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lenient-recovery-'));
  const runtime = createRuntimeConfig({
    app: { getPath: () => dir }, fs, path,
    defaultAppConfig: { ...defaults, enableConsoleLogging: true },
  });
  t.after(async () => { await runtime.shutdownLogging(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { runtime, dir, file: path.join(dir, 'config.json') };
}

test('hand-edited string booleans and clamped ranges keep the rest of the file', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ theme: 'dark', enableFileLogging: 'true', layoutWidthVw: 70 }));
  const config = f.runtime.loadAppConfig();
  assert.equal(config.theme, 'dark');
  assert.equal(config.enableFileLogging, true);
  assert.equal(config.layoutWidthVw, 83);
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.corrupt')), false);
});

test('one out-of-range value resets only that setting', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, JSON.stringify({ theme: 'dark', quickPasteDelayMs: 999999 }));
  const config = f.runtime.loadAppConfig();
  assert.equal(config.theme, 'dark');
  assert.equal(config.quickPasteDelayMs, defaults.quickPasteDelayMs);
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.corrupt')), false);
});

test('malformed JSON is still preserved as .corrupt', t => {
  const f = fixture(t);
  fs.writeFileSync(f.file, '{broken');
  f.runtime.loadAppConfig();
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.corrupt')), true);
});

test('number fields reject empty and non-numeric input instead of saving 0', () => {
  for (const value of ['', '  ', null, true, []]) {
    const result = validateSettingsPatch(defaults, { quickPasteDelayMs: value });
    assert.equal(result.valid, false, JSON.stringify(value));
  }
  assert.equal(validateSettingsPatch(defaults, { quickPasteDelayMs: '250' }).valid, true);
  assert.equal(validateSettingsPatch(defaults, { quickPasteDelayMs: 0 }).valid, true);
});
