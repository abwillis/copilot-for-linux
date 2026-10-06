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
    indexFindConversation,
    cancelFindContentVisibilityIndexing,
    disableFindContentVisibility,
    // Optional future provider contract:
    //   canSearch({ win, term, matchCase }) -> boolean
    //   search({ win, wc, term, options, direction, sendResults })
    //       -> { matches, activeMatchOrdinal, snippets, finalUpdate }
    //   navigate({ win, wc, resultId, direction, sendResults })
    //   clear({ win, wc }) / cancel({ win, wc })
    //
    // Such a provider can maintain a temporary index of logical messages,
    // return matching snippets, hydrate a virtualized result, and navigate to
    // it directly. Chromium remains the fallback rather than the only path.
    logicalMessageFindProvider = null,
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
  let findDebounce = null;
  let findGeneration = 0;
  let activeIndexingWin = null;
  let activeFindProvider = null;
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

  function getTargetWin() {
    const focused = BrowserWindow.getFocusedWindow();
    return focused?.getParentWindow() || focused || getMain();
  }

  function getWC() {
    return getTargetWin()?.webContents || null;
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
      backend: activeFindProvider?.id || 'chromium',
      activeMatchOrdinal: 0,
      matches: 0,
      snippets: [],
      finalUpdate: true
    });
  }

  const chromiumFindProvider = Object.freeze({
    id: 'chromium',
    canSearch() { return true; },
    search({ wc, term, options }) {
      return {
        deferred: true,
        requestId: wc.findInPage(term, options)
      };
    },
    clear({ wc }) {
      wc.stopFindInPage('clearSelection');
    },
    cancel({ wc }) {
      wc.stopFindInPage('clearSelection');
    }
  });
  activeFindProvider = chromiumFindProvider;

  function chooseFindProvider(context) {
    if (
      logicalMessageFindProvider &&
      typeof logicalMessageFindProvider.search === 'function'
    ) {
      try {
        if (
          typeof logicalMessageFindProvider.canSearch !== 'function' ||
          logicalMessageFindProvider.canSearch(context)
        ) {
          return logicalMessageFindProvider;
        }
      } catch {}
    }
    return chromiumFindProvider;
  }

  function publishProviderResult(provider, result) {
    if (!result || result.deferred) return;
    sendFindModalResults({
      kind: 'result',
      backend: provider.id || 'logical-messages',
      activeMatchOrdinal: Number(result.activeMatchOrdinal || 0),
      matches: Number(result.matches || 0),
      snippets: Array.isArray(result.snippets) ? result.snippets : [],
      finalUpdate: result.finalUpdate !== false
    });
  }

  async function cancelIndexing(win) {
    const target = win || activeIndexingWin;
    activeIndexingWin = null;
    if (!target || typeof cancelFindContentVisibilityIndexing !== 'function') return;
    try { await cancelFindContentVisibilityIndexing(target); } catch {}
  }

  function cancelProvider(win, wc) {
    try {
      const provider = activeFindProvider || chromiumFindProvider;
      if (typeof provider.cancel === 'function') {
        const pending = provider.cancel({ win, wc, sendResults: sendFindModalResults });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      }
    } catch {}
  }

  async function prepareConversationForFind(win, generation) {
    if (
      !APP_CONFIG.findContentVisibilityOverride ||
      typeof enableFindContentVisibility !== 'function'
    ) {
      return { ok: true, needsScrollWalk: false };
    }

    const visibility = await enableFindContentVisibility(win);
    if (generation !== findGeneration) return { ok: false, cancelled: true };
    if (!visibility?.needsScrollWalk || typeof indexFindConversation !== 'function') {
      return visibility || { ok: true, needsScrollWalk: false };
    }

    activeIndexingWin = win;
    sendFindModalResults({
      kind: 'indexing',
      message: 'Indexing conversation…',
      cancellable: true,
      finalUpdate: false
    });

    const indexed = await indexFindConversation(win);
    if (activeIndexingWin === win) activeIndexingWin = null;
    if (generation !== findGeneration || indexed?.cancelled) {
      return { ok: false, cancelled: true };
    }
    return indexed || { ok: true };
  }

  async function runFindRequest({ win, wc, term, matchCase, kind, isNewTerm, generation }) {
    const prepared = await prepareConversationForFind(win, generation);
    if (generation !== findGeneration) return;
    if (prepared?.cancelled) {
      sendFindModalResults({
        kind: 'cancelled',
        message: 'Indexing cancelled',
        finalUpdate: true
      });
      return;
    }

    sendFindModalResults({ kind: 'searching', term, finalUpdate: false });
    const provider = chooseFindProvider({ win, wc, term, matchCase });
    activeFindProvider = provider;
    try {
      const result = await provider.search({
        win,
        wc,
        term,
        matchCase,
        direction: kind === 'prev' ? 'previous' : 'next',
        options: lastFindOpts,
        sendResults: sendFindModalResults
      });
      if (generation === findGeneration) publishProviderResult(provider, result);
    } catch (err) {
      if (provider !== chromiumFindProvider && generation === findGeneration) {
        activeFindProvider = chromiumFindProvider;
        try {
          chromiumFindProvider.search({ wc, term, options: lastFindOpts });
          return;
        } catch {}
      }
      if (generation === findGeneration) {
        sendFindModalResults({
          kind: 'error',
          message: String(err?.message || err || 'Find failed'),
          finalUpdate: true
        });
      }
    }
  }

  function attachFindResultForwarding(win) {
    if (!win?.webContents) return;
    const wc = win.webContents;
    if (wc.__findResultForwardingAttached) return;
    wc.__findResultForwardingAttached = true;
    wc.on('found-in-page', (_event, result) => {
      if (activeFindProvider !== chromiumFindProvider) return;
      try {
        sendFindModalResults({
          kind: 'result',
          backend: 'chromium',
          requestId: result?.requestId ?? null,
          activeMatchOrdinal: Number(result?.activeMatchOrdinal ?? 0),
          matches: Number(result?.matches ?? 0),
          snippets: [],
          finalUpdate: !!result?.finalUpdate
        });
      } catch {}
    });
  }

  // === openFindModal — the full Find modal window ===
  function openFindModal(parent) {
    if (APP_CONFIG.findContentVisibilityOverride) {
      Promise.resolve(enableFindContentVisibility(parent)).catch(() => {});
    }
    if (findModal && !findModal.isDestroyed()) {
      findModal.show(); findModal.focus(); return;
    }
    findModal = new BrowserWindow({
      parent, modal: true, width: 420, height: 210, resizable: false,
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
      const modalW = 420;
      const modalH = 210;
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
      findGeneration++;
      clearTimeout(findDebounce);
      cancelIndexing(parent).catch(() => {});
      resetFindModalResults('closed');
      Promise.resolve(disableFindContentVisibility()).catch(() => {});
      findModal = null;
    });
    findModal.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error('Find modal failed to load:', code, desc, url);
    });
  }

  async function repeatFind(direction) {
    const win = getTargetWin();
    const wc = win?.webContents || null;
    if (!wc || !lastFindTerm) return;
    const provider = activeFindProvider || chromiumFindProvider;
    if (provider !== chromiumFindProvider && typeof provider.navigate === 'function') {
      try {
        const result = await provider.navigate({
          win,
          wc,
          direction,
          sendResults: sendFindModalResults
        });
        publishProviderResult(provider, result);
        return;
      } catch {}
    }
    activeFindProvider = chromiumFindProvider;
    lastFindOpts = applyWordStartOptions({
      ...lastFindOpts,
      forward: direction !== 'previous',
      findNext: true
    });
    chromiumFindProvider.search({ wc, term: lastFindTerm, options: lastFindOpts });
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
        click: () => { repeatFind('next').catch(() => {}); }
      },
      {
        label: 'Find Previous',
        accelerator: 'Shift+F3',
        click: () => { repeatFind('previous').catch(() => {}); }
      },
      {
        label: 'Clear Highlights',
        accelerator: 'Esc',
        click: () => {
          const win = getTargetWin();
          const wc = win?.webContents || null;
          if (!wc) return;
          cancelProvider(win, wc);
          wc.stopFindInPage('clearSelection');
        }
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

      const isNewTerm = term !== lastFindTerm || matchCase !== lastFindOpts.matchCase;
      const generation = ++findGeneration;
      clearTimeout(findDebounce);
      cancelIndexing(activeIndexingWin).catch(() => {});
      if (isNewTerm) cancelProvider(win, wc);

      lastFindTerm = term;
      lastFindOpts = applyWordStartOptions({
        ...lastFindOpts,
        matchCase,
        findNext: isNewTerm ? false : true,
        forward: payload?.kind !== 'prev'
      });
      sendFindModalResults({ kind: 'searching', term, finalUpdate: false });

      findDebounce = setTimeout(() => {
        runFindRequest({
          win,
          wc,
          term,
          matchCase,
          kind: payload?.kind,
          isNewTerm,
          generation
        }).catch(() => {});
      }, FIND_DEBOUNCE_MS);
    });

    ipcMain.on('find-modal-cancel-indexing', (event) => {
      const win = getWinFromEventSender(event.sender);
      findGeneration++;
      clearTimeout(findDebounce);
      cancelIndexing(win).catch(() => {});
      sendFindModalResults({
        kind: 'cancelled',
        message: 'Indexing cancelled',
        finalUpdate: true
      });
    });

    ipcMain.on('find-modal-navigate-result', async (event, payload) => {
      const win = getWinFromEventSender(event.sender);
      const wc = win?.webContents || null;
      const provider = activeFindProvider;
      if (!wc || !provider || typeof provider.navigate !== 'function') return;
      try {
        const result = await provider.navigate({
          win,
          wc,
          resultId: payload?.resultId,
          direction: payload?.direction,
          sendResults: sendFindModalResults
        });
        publishProviderResult(provider, result);
      } catch {}
    });

    ipcMain.on('find-modal-clear', (event) => {
      const win = getWinFromEventSender(event.sender);
      const wc = win?.webContents || null;
      findGeneration++;
      clearTimeout(findDebounce);
      cancelIndexing(win).catch(() => {});
      if (!wc) return;
      try {
        const provider = activeFindProvider || chromiumFindProvider;
        if (typeof provider.clear === 'function') {
          const pending = provider.clear({ win, wc, sendResults: sendFindModalResults });
          if (pending && typeof pending.catch === 'function') pending.catch(() => {});
        }
      } catch {}
      wc.stopFindInPage('clearSelection');
      resetFindModalResults('clear');
    });

    ipcMain.on('find-modal-close', (event) => {
      const win = getWinFromEventSender(event.sender);
      findGeneration++;
      clearTimeout(findDebounce);
      cancelIndexing(win).catch(() => {});
      resetFindModalResults('close');
      Promise.resolve(disableFindContentVisibility()).catch(() => {});
      if (findModal && !findModal.isDestroyed()) { findModal.close(); }
      findModal = null;
    });
  }

  // === Escape-key handler ===
  function handleEscapeStopFind(win) {
    if (!win?.webContents) return;
    findGeneration++;
    clearTimeout(findDebounce);
    cancelIndexing(win).catch(() => {});
    cancelProvider(win, win.webContents);
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
