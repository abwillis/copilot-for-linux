'use strict';

function createMainBootstrap(deps = {}) {
  const {
    app,
    BrowserWindow,
    appConfig,
    getAppConfig,
    loadAppConfig,
    getLayoutObserverGlobal,
    getMainWindow,
    setIsQuitting,
    createWindow,
    createTray,
    configureRuntimeServices,
    registerDirectOpenIpcHandler,
    registerDirectOpenDownloadHandler,
    pruneExpiredDirectOpenRequests,
    cleanupTempFiles,
    closeAllQuickChatWindows,
    shutdownLogging,
    unregisterGlobalShortcuts,
  } = deps;

  let quitCleanupStarted = false;
  let loggingShutdownComplete = false;

  function bootstrapApp() {
    app.setName(appConfig.appName);
    app.setAppUserModelId(appConfig.appUserModelId);

    app.whenReady().then(() => {
      loadAppConfig();
      if (typeof configureRuntimeServices === 'function') configureRuntimeServices();

      const config = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      registerDirectOpenIpcHandler();
      registerDirectOpenDownloadHandler();

      createWindow();
      if (config.showTrayIcon !== false) createTray();

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
          createWindow();
        } else {
          const mainWindow = (typeof getMainWindow === 'function') ? getMainWindow() : null;
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      });
    });

    app.on('window-all-closed', () => {
      const config = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      if (config.showTrayIcon === false) app.quit();
    });

    app.on('before-quit', event => {
      if (typeof setIsQuitting === 'function') setIsQuitting(true);

      // Give the asynchronous buffered log writer one chance to drain before
      // Electron exits. The second app.quit() passes through this guard.
      if (!loggingShutdownComplete) {
        event.preventDefault();
        if (quitCleanupStarted) return;
        quitCleanupStarted = true;
      }

      try {
        try { unregisterGlobalShortcuts?.(); } catch {}
        try { pruneExpiredDirectOpenRequests(); } catch {}

        const mainWindow = (typeof getMainWindow === 'function') ? getMainWindow() : null;
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.executeJavaScript(`(function(observerName){
            try {
              if (window[observerName]) {
                window[observerName].disconnect();
                window[observerName] = null;
              }
            } catch {}
          })(${JSON.stringify(getLayoutObserverGlobal())});`).catch(() => {});
        }

        try { closeAllQuickChatWindows(); } catch {}
        try { cleanupTempFiles(); } catch {}
      } catch {}

      if (!loggingShutdownComplete) {
        Promise.resolve(
          typeof shutdownLogging === 'function' ? shutdownLogging() : undefined
        ).catch(() => {}).finally(() => {
          loggingShutdownComplete = true;
          app.quit();
        });
      }
    });
  }

  return {
    bootstrapApp,
  };
}

module.exports = { createMainBootstrap };
