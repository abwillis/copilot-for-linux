'use strict';

const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preloads may only require a small Electron-provided module set.
// Keep these app-specific channels aligned with lib/ipc.js.
const IPC = Object.freeze({
  SETTINGS_GET: 'copilot:settings-get',
  SETTINGS_VALIDATE: 'copilot:settings-validate',
  SETTINGS_SAVE: 'copilot:settings-save',
  SETTINGS_RESTORE: 'copilot:settings-restore',
  SETTINGS_EXPORT: 'copilot:settings-export',
  SETTINGS_IMPORT: 'copilot:settings-import',
});

contextBridge.exposeInMainWorld('appSettings', Object.freeze({
  restorePrevious() { return ipcRenderer.invoke(IPC.SETTINGS_RESTORE); },
  exportSettings() { return ipcRenderer.invoke(IPC.SETTINGS_EXPORT); },
  importSettings() { return ipcRenderer.invoke(IPC.SETTINGS_IMPORT); },
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
