'use strict';

const fs = require('fs');
const path = require('path');

async function pathExists(fsModule, target) {
  try {
    await fsModule.promises.access(target);
    return true;
  } catch {
    return false;
  }
}

async function removeWithRetries(fsModule, target, options = {}) {
  const retries = Math.max(0, Number(options.retries ?? 5));
  const delayMs = Math.max(1, Number(options.delayMs ?? 20));
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsModule.promises.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= retries || !['EBUSY', 'EPERM', 'EACCES'].includes(error?.code)) throw error;
      await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

async function replaceFileFromTemporary(tempPath, filePath, options = {}) {
  const fsModule = options.fs || fs;
  const platform = String(options.platform || process.platform);
  if (platform !== 'win32') {
    await fsModule.promises.rename(tempPath, filePath);
    return { replacedExisting: false, cleanupError: null };
  }

  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
  const backupPath = path.join(directory, `.${base}.${stamp}.replace-backup`);
  const hadExisting = await pathExists(fsModule, filePath);

  if (!hadExisting) {
    await fsModule.promises.rename(tempPath, filePath);
    return { replacedExisting: false, cleanupError: null };
  }

  await fsModule.promises.rename(filePath, backupPath);
  try {
    await fsModule.promises.rename(tempPath, filePath);
  } catch (error) {
    const failures = [error];
    try {
      if (await pathExists(fsModule, filePath)) {
        await removeWithRetries(fsModule, filePath, options);
      }
      await fsModule.promises.rename(backupPath, filePath);
    } catch (restoreError) {
      failures.push(restoreError);
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Could not replace or restore the destination file.');
    }
    throw error;
  }

  let cleanupError = null;
  try {
    await removeWithRetries(fsModule, backupPath, options);
  } catch (error) {
    cleanupError = error;
  }
  return { replacedExisting: true, cleanupError };
}

module.exports = {
  removeWithRetries,
  replaceFileFromTemporary,
};
