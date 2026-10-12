'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const testDirectory = __dirname;
const files = fs.readdirSync(testDirectory)
  .filter(name => name.endsWith('.test.js'))
  .sort()
  .map(name => path.join(testDirectory, name));

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env: process.env,
});

if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
