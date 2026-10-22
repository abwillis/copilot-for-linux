'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRuntimeConfig } = require('../lib/runtime-config');
const { defaultAppConfig } = require('../app-specific/app.config');

test('saving settings still works after config.json is corrupted while the app runs', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-corrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  const runtime = createRuntimeConfig({
    app: { getPath: () => dir }, fs, path,
    defaultAppConfig: Object.freeze({ ...defaultAppConfig }),
    partitionEnvVar: 'UNSET_TEST_PARTITION_VARIABLE',
  });
  runtime.loadAppConfig();
  runtime.updateAppConfig({ theme: 'dark' });
  const file = path.join(dir, 'config.json');
  const malformed = '{ "theme": "light", ';
  fs.writeFileSync(file, malformed);

  const saved = runtime.updateAppConfig({ theme: 'light' });

  assert.equal(saved.theme, 'light');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).theme, 'light');
  const kept = fs.readdirSync(dir).filter(name => name.endsWith('.corrupt'));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), 'utf8'), malformed);
  // .previous still holds the last good backup taken before the corruption.
  assert.equal(JSON.parse(fs.readFileSync(`${file}.previous`, 'utf8')).theme, 'system');
});
