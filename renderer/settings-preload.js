'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preloads may only require a small Electron-provided module set.
// Keep these app-specific channels aligned with lib/ipc.js.
const IPC = Object.freeze({
  SETTINGS_GET: 'copilot:settings-get',
  SETTINGS_VALIDATE: 'copilot:settings-validate',
  SETTINGS_SAVE: 'copilot:settings-save',
});

contextBridge.exposeInMainWorld('appSettings', Object.freeze({
  get() {
    return ipcRenderer.invoke(IPC.SETTINGS_GET);
  },
  validate(patch) {
    return ipcRenderer.invoke(IPC.SETTINGS_VALIDATE, patch);
  },
  save(patch) {
    return ipcRenderer.invoke(IPC.SETTINGS_SAVE, patch);
  },
}));
