'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('findModal', {
  // Renderer → main
  submit(payload) {
    ipcRenderer.send('find-modal-submit', {
      kind: String((payload && payload.kind) || ''),
      term: String((payload && payload.term) || ''),
      matchCase: !!(payload && payload.matchCase),
    });
  },

  clear() {
    ipcRenderer.send('find-modal-clear');
  },

  close() {
    ipcRenderer.send('find-modal-close');
  },

  // Main → renderer
  onResults(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_evt, result) => {
      try { handler(result); } catch {}
    };
    ipcRenderer.on('find-modal-results', wrapped);
    return () => {
      try { ipcRenderer.removeListener('find-modal-results', wrapped); } catch {}
    };
  },
});
