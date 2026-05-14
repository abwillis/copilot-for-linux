// lib/ipc.js — Shared IPC channel definitions
// Both apps use this to guarantee channel names stay in sync
// between main.js and preload.js.
'use strict';

/**
 * Factory: createIPC(appSlug) → frozen IPC channel map.
 * @param {string} appSlug - e.g. 'gemini' or 'copilot'
 */
function createIPC(appSlug) {
  const prefix = String(appSlug || 'app');
  return Object.freeze({
    SEND_SELECTION:   `${prefix}:send-selection`,
    QUICK_NEW:        `${prefix}:quick-new`,
    DIRECT_OPEN_LINK: `${prefix}:direct-open-link`,
    PRELOAD_PING:     `${prefix}:preload-ping`,
  });
}

module.exports = { createIPC };
