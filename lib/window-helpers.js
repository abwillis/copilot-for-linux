'use strict';

function createWindowHelpers(deps = {}) {
  const {
    dialog,
    getAppConfig,
    applyMaxLayoutCSS,
    attachVWResize,
  } = deps;

  function reveal(win) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    try { win.moveTop(); } catch {}
  }

  function safeShowError(title, message) {
    try {
      dialog.showErrorBox(
        String(title ?? 'Error'),
        String(message ?? 'An error occurred')
      );
    } catch (err) {
      console.error('Could not show error dialog:', err);
    }
  }

  function onDidStopLoading() {
    try {
      // Place post-load logic here. Keep it lightweight and idempotent.
    } catch (err) {
      console.error('did-stop-loading handler error:', err);
    }
  }

  function ensureDidStopLoadingHandler(webContents, handler = onDidStopLoading) {
    if (!webContents) return;
    if (webContents.__hasDidStopLoadingHandler) return;
    webContents.__hasDidStopLoadingHandler = true;
    webContents.on('did-stop-loading', handler);
  }

  function attachCSSAndLayoutHandlers(win, { role = 'window', revealOnReady = true, didStopLoadingHandler = onDidStopLoading } = {}) {
    if (!win?.webContents) return;

    const appConfig = (typeof getAppConfig === 'function') ? getAppConfig() : {};

    ensureDidStopLoadingHandler(win.webContents, didStopLoadingHandler);
    if (!appConfig.enableLayoutCss) {
      win.once('ready-to-show', () => {
        if (revealOnReady) reveal(win);
      });
      return;
    }

    try {
      win.webContents.once('did-stop-loading', () => {
        setTimeout(() => {
          try { applyMaxLayoutCSS(win); }
          catch (e) { console.error(`applyMaxLayoutCSS (${role}) failed:`, e); }
        }, 0);
      });
    } catch (e) {
      console.error(`applyMaxLayoutCSS ${role} defer wiring failed:`, e);
    }

    win.once('ready-to-show', () => {
      if (revealOnReady) reveal(win);
      try { attachVWResize(win); }
      catch (e) { console.error(`attachVWResize (${role}) failed:`, e); }
    });
  }

  function ensureSaveState(win) {
    if (!win) return;
    if (typeof win.__lastSavePath === 'undefined') win.__lastSavePath = null;
    if (win.__saveStateInitialized) return;
    win.__saveStateInitialized = true;
  }

  return {
    reveal,
    safeShowError,
    onDidStopLoading,
    ensureDidStopLoadingHandler,
    attachCSSAndLayoutHandlers,
    ensureSaveState,
  };
}

module.exports = { createWindowHelpers };
