// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Optional bridge (you can keep or remove it); not required for core functionality
contextBridge.exposeInMainWorld('contextMenu', {
  show: (params) => ipcRenderer.send('show-context-menu', params)
});

contextBridge.exposeInMainWorld('hostUI', {
  setLayoutMode: (mode) => {
    try { window.postMessage({ type: 'host:setLayoutMode', payload: { mode } }, '*'); } catch {}
  }
});

