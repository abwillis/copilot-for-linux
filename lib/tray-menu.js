'use strict';

function createTrayMenu(deps = {}) {
  const {
    Menu,
    Tray,
    nativeImage,
    path,
    app,
    appConfig,
    appLabel,
    dirname,
    getTray,
    setTray,
    getTrayImage24,
    setTrayImage24,
    getAppIconImage,
    getIconPath,
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

  function createTray() {
    const iconPath = getIconPath(appConfig.iconFileName);
    const trayImage = getTrayImage24() || nativeImage.createFromPath(iconPath);
    const smallImage = (typeof trayImage.isEmpty === 'function' && trayImage.isEmpty())
      ? null
      : trayImage.resize({ width: 24, height: 24 });

    if (!getTrayImage24() && smallImage) {
      try { setTrayImage24(smallImage); } catch {}
    }

    const fallbackIcon = nativeImage.createFromPath(path.join(dirname, 'assets', appConfig.iconFileName));
    const trayIcon = smallImage || getAppIconImage() || fallbackIcon;
    try {
      console.log('[tray] iconPath:', iconPath,
      'trayImageEmpty:', (typeof trayImage.isEmpty === 'function' ? trayImage.isEmpty() : 'n/a'),
      'trayIconEmpty:', (trayIcon && typeof trayIcon.isEmpty === 'function' ? trayIcon.isEmpty() : 'n/a'));
    } catch {}
    const nextTray = new Tray(trayIcon);

    nextTray.setToolTip(appConfig.trayToolTip || appLabel);
    refreshTrayMenu();
    // CRITICAL: store the tray globally BEFORE refreshTrayMenu(). refreshTrayMenu()
    // calls getTray() and returns early when it is null, so without this the tray's
    // context menu is never applied. On Linux an appindicator/StatusNotifierItem is
    // only shown once it has a context menu, so a menu-less tray registers on the
    // D-Bus StatusNotifierWatcher and is then culled -- no visible icon.
    setTray(nextTray);
    nextTray.setToolTip(appConfig.trayToolTip || appLabel);
    // Apply the context menu directly here too (belt and suspenders): guarantees the
    // DBusMenu is exported on this exact Tray instance before the click handler is
    // wired and before the KDE tray host reads the item's properties.
    try {
    nextTray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
    } catch (err) {
    console.error('createTray setContextMenu failed:', err);
    }
    refreshTrayMenu();
    nextTray.on('click', () => {
      const mainWindow = (typeof getMainWindow === 'function') ? getMainWindow() : null;
      if (!mainWindow) return;
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        reveal(mainWindow);
      }
      refreshTrayMenu();
    });

    return nextTray;
  }

  return {
    buildTrayMenuTemplate,
    refreshTrayMenu,
    createTray,
  };
}

module.exports = { createTrayMenu };
