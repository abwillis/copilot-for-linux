'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Shared tests live in test/. Tests for code that differs per app (for example
// app-specific/layout-css.js) live in test/app-specific/, so a shared test never
// fails in another app because that app's copy of the code differs. The
// directory is optional: an app without app-specific tests simply has none.
const testDirectories = [__dirname, path.join(__dirname, 'app-specific')];
const files = testDirectories
  .filter(directory => fs.existsSync(directory))
  .flatMap(directory => fs.readdirSync(directory)
    .filter(name => name.endsWith('.test.js'))
    .sort()
    .map(name => path.join(directory, name)));

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
