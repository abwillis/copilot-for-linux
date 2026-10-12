'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { replaceFileFromTemporary } = require('../lib/atomic-file');

async function makeDirectory(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-file-test-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Windows replacement swaps an existing destination and removes its backup', async t => {
  const directory = await makeDirectory(t);
  const destination = path.join(directory, 'export.txt');
  const temporary = path.join(directory, '.export.pending.tmp');
  await fs.promises.writeFile(destination, 'old', 'utf8');
  await fs.promises.writeFile(temporary, 'new', 'utf8');

  const result = await replaceFileFromTemporary(temporary, destination, { platform: 'win32' });

  assert.equal(await fs.promises.readFile(destination, 'utf8'), 'new');
  assert.equal(fs.existsSync(temporary), false);
  assert.equal(result.replacedExisting, true);
  assert.equal(result.cleanupError, null);
  assert.deepEqual(await fs.promises.readdir(directory), ['export.txt']);
});

test('Windows replacement restores the old destination when installing the temporary file fails', async t => {
  const directory = await makeDirectory(t);
  const destination = path.join(directory, 'export.txt');
  const temporary = path.join(directory, '.export.pending.tmp');
  await fs.promises.writeFile(destination, 'old', 'utf8');
  await fs.promises.writeFile(temporary, 'new', 'utf8');

  let failedInstall = false;
  const fsProxy = {
    promises: {
      ...fs.promises,
      rename: async (source, target) => {
        if (!failedInstall && source === temporary && target === destination) {
          failedInstall = true;
          const error = new Error('simulated sharing violation');
          error.code = 'EPERM';
          throw error;
        }
        return fs.promises.rename(source, target);
      },
    },
  };

  await assert.rejects(
    replaceFileFromTemporary(temporary, destination, { platform: 'win32', fs: fsProxy }),
    /simulated sharing violation/
  );
  assert.equal(await fs.promises.readFile(destination, 'utf8'), 'old');
  assert.equal(await fs.promises.readFile(temporary, 'utf8'), 'new');
  const leftovers = (await fs.promises.readdir(directory)).filter(name => name.includes('replace-backup'));
  assert.deepEqual(leftovers, []);
});
