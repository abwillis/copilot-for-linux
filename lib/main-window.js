'use strict';

function createMainWindowManager(deps = {}) {
  const {
    BrowserWindow,
    Menu,
    nativeImage,
    shell,
    path,
    dirname,
    appConfig,
    appLabel,
    getAppConfig,
    getAppUrl,
    getAppPartition,
    getMainWindow,
    setMainWindow,
    getAppIconImage,
    setAppIconImage,
    getTrayImage24,
    setTrayImage24,
    getIconPath,
    getInitialWindowBounds,
    reveal,
    setRoleTitle,
    augmentApplicationMenu,
    registerShowContextMenuIpcHandler,
    ensureDidStopLoadingHandler,
    attachCSSAndLayoutHandlers,
    attachWindowStatePersistence,
    attachFindResultForwarding,
    onDidStopLoading,
    buildContextMenuTemplate,
    registerFindIpcHandlers,
    handleEscapeStopFind,
    enableLayoutWidthKeyboardShortcuts = false,
    layoutWidthKeyboardApiPrefix,
    defaultVwSize,
  } = deps;

  function buildAdjustLayoutWidthScript(delta) {
    const prefix = layoutWidthKeyboardApiPrefix;
    const getterName = prefix ? `${prefix}_getTargetVW` : null;
    const setterName = prefix ? `${prefix}_setTargetVW` : null;
    const fallback = Number(defaultVwSize || 100);

    if (!getterName || !setterName) return null;

    return `(() => {
      const getter = window[${JSON.stringify(getterName)}];
      const setter = window[${JSON.stringify(setterName)}];
      const current = (typeof getter === 'function') ? getter() : ${fallback};
      if (typeof setter === 'function') setter(current + ${Number(delta)});
    })()`;
  }

  function createWindow() {
    if (getMainWindow()) return;

    const appConfigSnapshot = (typeof getAppConfig === 'function') ? getAppConfig() : {};
    const boundsKey = 'main';
    const iconPath = getIconPath(appConfig.iconFileName);
    const loadedIcon = nativeImage.createFromPath(iconPath);

    if (!getAppIconImage() || getAppIconImage().isEmpty()) setAppIconImage(loadedIcon);
    if (!getTrayImage24() || getTrayImage24().isEmpty?.()) {
      try { setTrayImage24(loadedIcon.resize({ width: 24, height: 24 })); } catch {}
    }

    const appIconImage = getAppIconImage();
    const initialBounds = getInitialWindowBounds(boundsKey);
    const win = new BrowserWindow({
      skipTaskbar: false,
      title: `${appLabel} Main Chat`,
      width: initialBounds.width,
      height: initialBounds.height,
      x: typeof initialBounds.x === 'number' ? initialBounds.x : undefined,
      y: typeof initialBounds.y === 'number' ? initialBounds.y : undefined,
      show: false,
      icon: appIconImage || loadedIcon,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(dirname, 'preload.js'),
        partition: getAppPartition(),
        devTools: !!appConfigSnapshot.devToolsEnabled,
        backgroundThrottling: true,
        spellcheck: false,
      },
      type: 'normal',
      autoHideMenuBar: false,
    });

    setMainWindow(win);
    win.setMenuBarVisibility(true);
    try { win.setIcon(appIconImage || loadedIcon); } catch {}

    registerShowContextMenuIpcHandler();

    win.once('ready-to-show', () => {
      reveal(win);
      try { win.__appRole = 'main'; } catch {}
      try { win.__boundsKey = boundsKey; } catch {}
      try { setRoleTitle(win, 'main'); } catch {}
      augmentApplicationMenu(win);
    });

    win.setSkipTaskbar(false);
    ensureDidStopLoadingHandler(win.webContents);
    win.webContents.setMaxListeners(0);

    win.loadURL(getAppUrl());

    attachCSSAndLayoutHandlers(win, { role: 'main', revealOnReady: false });
    attachWindowStatePersistence(win, boundsKey, { hideOnClose: true });
    attachFindResultForwarding(win);

    win.webContents.on('did-start-navigation', () => {
      // Keep the did-stop-loading handler singular across SPA navigations.
    });
    win.webContents.on('destroyed', () => {
      try {
        win.webContents?.removeListener('did-stop-loading', onDidStopLoading);
        if (win.webContents) delete win.webContents.__hasDidStopLoadingHandler;
      } catch {}
    });

    win.webContents.on('context-menu', (_event, params) => {
      let menu;
      try {
        menu = Menu.buildFromTemplate(
          buildContextMenuTemplate(win, params, {
            includeQuickChatFeatures: !!appConfigSnapshot.enableQuickChat,
            includeChatPaneFeatures: true,
            includeMarkdownExport: true,
          })
        );
      } catch (err) {
        console.error('Context menu template error:', err);
        const hasSelection = !!params?.selectionText && params.selectionText.length > 0;
        menu = Menu.buildFromTemplate([{ role: 'copy', enabled: hasSelection }, { role: 'selectAll' }]);
      }
      try { menu.popup({ window: win }); }
      catch (err) { console.error('Context menu popup failed:', err); }
    });

    win.webContents.setWindowOpenHandler(({ url }) => (
      shell.openExternal(url), { action: 'deny' }
    ));

    registerFindIpcHandlers();

    win.webContents.on('before-input-event', (event, input) => {
      if (enableLayoutWidthKeyboardShortcuts && input.type === 'keyDown' && input.control && input.alt) {
        if (input.key === '=' || input.key === '+') {
          event.preventDefault();
          const script = buildAdjustLayoutWidthScript(5);
          if (script) try { win.webContents.executeJavaScript(script); } catch {}
        }
        if (input.key === '-') {
          event.preventDefault();
          const script = buildAdjustLayoutWidthScript(-5);
          if (script) try { win.webContents.executeJavaScript(script); } catch {}
        }
      }

      if (input.type === 'keyDown' && input.key === 'Escape') {
        handleEscapeStopFind(win);
      }
    });

    win.on('closed', () => {
      if (getMainWindow() === win) setMainWindow(null);
    });

    return win;
  }

  return {
    createWindow,
  };
}

module.exports = { createMainWindowManager };
