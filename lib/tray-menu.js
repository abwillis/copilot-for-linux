'use strict';

function createTrayMenu(deps = {}) {
  const {
    Menu,
    app,
    appLabel,
    getTray,
    getMainWindow,
    getAppConfig,
    getActiveAppWindow,
    getActiveQuickChatWindow,
    reveal,
    createQuickChatWindow,
    promptSaveChatPane,
    reloadApp,
    toggleActiveWindowAlwaysOnTop,
    clearAppCache,
    clearCookiesAndSignOut,
    openLogsFolder,
    openConfigFile,
    showAboutDialog,
    setIsQuitting,
  } = deps;

  function buildTrayMenuTemplate() {
    const mainWindow = (typeof getMainWindow === 'function') ? getMainWindow() : null;
    const appConfig = (typeof getAppConfig === 'function') ? getAppConfig() : {};
    const activeWindow = (typeof getActiveAppWindow === 'function') ? getActiveAppWindow() : null;
    const activeQuick = appConfig.enableQuickChat && typeof getActiveQuickChatWindow === 'function'
      ? getActiveQuickChatWindow({ createIfMissing: false })
      : null;
    const activeWindowIsAlwaysOnTop = !!activeWindow?.isAlwaysOnTop?.();
    const mainVisible = !!mainWindow && !mainWindow.isDestroyed?.() && mainWindow.isVisible?.();

    return [
      {
        label: 'Show',
        enabled: !!mainWindow && !mainWindow.isDestroyed?.(),
        click: () => {
          if (mainWindow) reveal(mainWindow);
          refreshTrayMenu();
        }
      },
      {
        label: 'Hide',
        enabled: mainVisible,
        click: () => {
          if (mainWindow) mainWindow.hide();
          refreshTrayMenu();
        }
      },
      { type: 'separator' },
      {
        label: 'New Quick Chat',
        accelerator: 'Ctrl+Alt+N',
        click: () => {
          try { reveal(createQuickChatWindow()); }
          catch (err) { console.error('Tray New Quick Chat failed:', err); }
        }
      },
      {
        label: 'Show Active Quick Chat',
        accelerator: 'Ctrl+Alt+2',
        enabled: !!activeQuick,
        click: () => {
          const win = getActiveQuickChatWindow({ createIfMissing: false });
          if (win) reveal(win);
        }
      },
      {
        label: 'Save Chat Pane',
        accelerator: 'Ctrl+S',
        enabled: !!activeWindow && !activeWindow.isDestroyed?.(),
        click: async () => {
          const win = getActiveAppWindow();
          if (win) await promptSaveChatPane(win);
        }
      },
      { type: 'separator' },
      {
        label: 'Reload',
        accelerator: 'Ctrl+R',
        click: () => reloadApp({ ignoreCache: false })
      },
      {
        label: 'Toggle Always on Top',
        type: 'checkbox',
        checked: activeWindowIsAlwaysOnTop,
        enabled: !!activeWindow && !activeWindow.isDestroyed?.(),
        click: () => toggleActiveWindowAlwaysOnTop()
      },
      {
        label: 'Clear Session/Cache',
        submenu: [
          {
            label: 'Clear ' + appLabel + ' Cache',
            click: async () => {
              await clearAppCache();
            }
          },
          {
            label: 'Clear Cookies / Sign Out',
            click: async () => {
              await clearCookiesAndSignOut();
            }
          }
        ]
      },
      { type: 'separator' },
      {
        label: 'Open Logs Folder',
        click: async () => {
          await openLogsFolder();
        }
      },
      {
        label: 'Open Config File',
        click: async () => {
          await openConfigFile();
        }
      },
      { type: 'separator' },
      {
        label: 'About',
        click: () => showAboutDialog()
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          if (typeof setIsQuitting === 'function') setIsQuitting(true);
          app.quit();
        }
      }
    ];
  }

  function refreshTrayMenu() {
    try {
      const tray = (typeof getTray === 'function') ? getTray() : null;
      if (!tray) return;
      tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
    } catch (err) {
      console.error('refreshTrayMenu failed:', err);
    }
  }

  return {
    buildTrayMenuTemplate,
    refreshTrayMenu,
  };
}

module.exports = { createTrayMenu };
