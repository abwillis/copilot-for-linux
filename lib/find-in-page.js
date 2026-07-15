'use strict';
const path = require('path');

// === Find-in-page infrastructure ===
// Extracted from main.js (Tier 3 refactor).
// Factory: createFindInPage(deps) → API object.

function createFindInPage(deps = {}) {
  const {
    BrowserWindow,
    ipcMain,
    screen,
    getMainWindow,
    getAppConfig,
    enableFindContentVisibility,
    disableFindContentVisibility,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });

  function getMain() {
    return (typeof getMainWindow === 'function') ? getMainWindow() : null;
  }

  // --- Module state ---
  let findModal = null;
  let lastFindTerm = '';
  let lastFindOpts = {
    forward: true, matchCase: false,
    medialCapitalAsWordStart: false, wordStart: false, findNext: false
  };
  let findIpcHandlersRegistered = false;
  let findDebounce;
  const FIND_DEBOUNCE_MS = 20;

  // === Parent-aware helpers ===
  function getWCFromEventSender(sender) {
    const modalWin = BrowserWindow.fromWebContents(sender);
    const targetWin = modalWin?.getParentWindow() || getMain();
    return targetWin?.webContents || null;
  }

  function getWinFromEventSender(sender) {
    const modalWin = BrowserWindow.fromWebContents(sender);
    return modalWin?.getParentWindow() || getMain();
  }

  function getWC() {
    const focused = BrowserWindow.getFocusedWindow();
    const target = focused?.getParentWindow() || focused || getMain();
    return target?.webContents || null;
  }

  function applyWordStartOptions(opts) {
    return {
      ...opts,
      wordStart: false,
      medialCapitalAsWordStart: false,
    };
  }

  function sendFindModalResults(payload) {
    try {
      if (!findModal || findModal.isDestroyed()) return;
      findModal.webContents.send('find-modal-results', payload || {});
    } catch {}
  }

  function resetFindModalResults(reason = 'idle') {
    sendFindModalResults({
      kind: 'reset',
      reason,
      activeMatchOrdinal: 0,
      matches: 0,
      finalUpdate: true
    });
  }

  function attachFindResultForwarding(win) {
    if (!win?.webContents) return;
    const wc = win.webContents;
    if (wc.__findResultForwardingAttached) return;
    wc.__findResultForwardingAttached = true;
    wc.on('found-in-page', (_event, result) => {
      try {
        sendFindModalResults({
          kind: 'result',
          requestId: result?.requestId ?? null,
          activeMatchOrdinal: Number(result?.activeMatchOrdinal ?? 0),
          matches: Number(result?.matches ?? 0),
          finalUpdate: !!result?.finalUpdate
        });
      } catch {}
    });
  }

  // === openFindModal — the full Find modal window ===
  // (Moved verbatim from main.js; mainWindow → getMain())

  function openFindModal(parent) {
    if (APP_CONFIG.findContentVisibilityOverride) enableFindContentVisibility(parent);
    if (findModal && !findModal.isDestroyed()) {
      findModal.show(); findModal.focus(); return;
    }
    findModal = new BrowserWindow({
      parent, modal: true, width: 380, height: 160, resizable: false,
      minimizable: false, maximizable: false, show: false,
      title: 'Find in Page', autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        preload: path.join(__dirname, '..', 'renderer', 'find-modal-preload.js'),
      }
    });

    // Position relative to parent
    try {
      const pb = (parent && typeof parent.getNormalBounds === 'function')
        ? parent.getNormalBounds()
        : parent.getBounds();
      const modalW = 380;
      const modalH = 160;
      let x = Math.round(pb.x + (pb.width - modalW) / 2);
      let y = Math.round(pb.y + (pb.height - modalH) / 2);
      const display = screen.getDisplayMatching({
        x: pb.x, y: pb.y, width: pb.width, height: pb.height
      });
      const wa = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };
      x = Math.max(wa.x, Math.min(x, wa.x + wa.width - modalW));
      y = Math.max(wa.y, Math.min(y, wa.y + wa.height - modalH));
      findModal.setBounds({ x, y, width: modalW, height: modalH });
    } catch (e) {
      // Let the WM decide placement
    }

    findModal.removeMenu();
    findModal.loadFile(
      path.join(__dirname, '..', 'renderer', 'find-modal.html')
    ).catch(function (err) {
      try { console.error('Find modal loadFile failed:', err); } catch {}
    });
    findModal.once('ready-to-show', () => {
      try { findModal.show(); findModal.focus(); } catch {}
    });
    findModal.on('closed', () => {
      resetFindModalResults('closed');
      disableFindContentVisibility();
      findModal = null;
    });
    findModal.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('Find modal failed to load:', code, desc, url);
    });
  }

  // === Edit menu: Find items ===
  function buildEditFindMenuItems() {
    return [
      {
        label: 'Find',
        accelerator: 'Ctrl+F',
        click: () => {
          const w = BrowserWindow.getFocusedWindow() || getMain();
          if (w) openFindModal(w);
        }
      },
      {
        label: 'Find Next',
        accelerator: 'F3',
        click: () => {
          const wc = getWC(); if (!wc || !lastFindTerm) return;
          lastFindOpts = applyWordStartOptions({ ...lastFindOpts, forward: true, findNext: true });
          wc.findInPage(lastFindTerm, lastFindOpts);
        }
      },
      {
        label: 'Find Previous',
        accelerator: 'Shift+F3',
        click: () => {
          const wc = getWC(); if (!wc || !lastFindTerm) return;
          lastFindOpts = applyWordStartOptions({ ...lastFindOpts, forward: false, findNext: true });
          wc.findInPage(lastFindTerm, lastFindOpts);
        }
      },
      {
        label: 'Clear Highlights',
        accelerator: 'Esc',
        click: () => { const wc = getWC(); if (!wc) return; wc.stopFindInPage('clearSelection'); }
      },
    ];
  }

  // === IPC handlers ===
  function registerFindIpcHandlers() {
    if (findIpcHandlersRegistered) return;
    findIpcHandlersRegistered = true;

    ipcMain.on('find-modal-submit', (event, payload) => {
      const win = getWinFromEventSender(event.sender);
      const wc = win?.webContents || null;
      if (!wc) return;

      const term = String(payload?.term || '').trim();
      const matchCase = !!payload?.matchCase;
      if (!term) return;

      const isNewTerm = term !== lastFindTerm;
      lastFindTerm = term;

      sendFindModalResults({ kind: 'searching', term, finalUpdate: false });

      if (isNewTerm) {
        wc.stopFindInPage('clearSelection');
      }

      lastFindOpts = applyWordStartOptions({
        ...lastFindOpts,
        matchCase,
        findNext: isNewTerm ? false : true,
        forward: (payload?.kind !== 'prev')
      });

      // Re-trigger visibility override before every search so the
      // virtualizer cannot re-hide content between searches.
      if (APP_CONFIG.findContentVisibilityOverride && win) {
        enableFindContentVisibility(win);
      }

      // Use a longer delay for new terms to let the visibility override
      // take effect; use the short debounce for Next/Prev navigation.
      const delay = isNewTerm ? 300 : FIND_DEBOUNCE_MS;
      clearTimeout(findDebounce);
      findDebounce = setTimeout(() => {
        try { wc.findInPage(lastFindTerm, lastFindOpts); }
        catch (_) { /* ignore */ }
      }, delay);
    });

    ipcMain.on('find-modal-clear', (event) => {
      const wc = getWCFromEventSender(event.sender);
      if (!wc) return;
      wc.stopFindInPage('clearSelection');
      resetFindModalResults('clear');
    });

    ipcMain.on('find-modal-close', () => {
      resetFindModalResults('close');
      disableFindContentVisibility();
      if (findModal && !findModal.isDestroyed()) { findModal.close(); }
      findModal = null;
    });
  }

  // === Escape-key handler ===
  function handleEscapeStopFind(win) {
    if (!win?.webContents) return;
    win.webContents.stopFindInPage('clearSelection');
    resetFindModalResults('escape');
  }

  return {
    openFindModal,
    attachFindResultForwarding,
    sendFindModalResults,
    resetFindModalResults,
    getWCFromEventSender,
    getWC,
    applyWordStartOptions,
    buildEditFindMenuItems,
    registerFindIpcHandlers,
    handleEscapeStopFind,
  };
}

module.exports = { createFindInPage };
