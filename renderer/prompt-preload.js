'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// NOTE: We must not use 'prompt' here — that collides with Chromium's
// built-in window.prompt, and contextBridge.exposeInMainWorld silently
// refuses to overwrite existing window properties.  Use a unique key.
contextBridge.exposeInMainWorld('appPrompt', {
  // Renderer → main.  Result is `null` on cancel, or an object like { name }.
  submit(result) {
    ipcRenderer.send('quick-chat-rename-result', result);
  },

  // Main → renderer.  Delivers { title, label, value, okText, cancelText }.
  onInit(handler) {
    if (typeof handler !== 'function') return () => {};
    const wrapped = (_evt, payload) => {
      try { handler(payload || {}); } catch {}
    };
    ipcRenderer.on('prompt:init', wrapped);
    return () => {
      try { ipcRenderer.removeListener('prompt:init', wrapped); } catch {}
    };
  },
});
