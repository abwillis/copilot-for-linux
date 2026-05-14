// preload.js — Copilot for Linux (app-specific wrapper)
'use strict';

const { createIPC } = require('./lib/ipc');
const { initPreload } = require('./lib/preload-core');

const IPC = createIPC('copilot');

initPreload({
  appSlug:             'copilot',
  hostApiName:         'copilotHost',
  IPC,
  enableDirectOpen:    true,
  enableHoverTooltips: true,
});
