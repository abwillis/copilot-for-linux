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
    registerDirectOpenIpcHandler,
    registerDirectOpenDownloadHandler,
    pruneExpiredDirectOpenRequests,
    cleanupTempFiles,
    closeAllQuickChatWindows,
  } = deps;

  function bootstrapApp() {
    app.setName(appConfig.appName);
    app.setAppUserModelId(appConfig.appUserModelId);

    app.whenReady().then(() => {
      loadAppConfig();

      const config = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      if (config.enableDirectOpen) {
        registerDirectOpenIpcHandler();
        registerDirectOpenDownloadHandler();
      }

      createWindow();
      createTray();

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
      // Keep tray resident.
    });

    app.on('before-quit', () => {
      if (typeof setIsQuitting === 'function') setIsQuitting(true);

      try {
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
    });
  }

  return {
    bootstrapApp,
  };
}

module.exports = { createMainBootstrap };
