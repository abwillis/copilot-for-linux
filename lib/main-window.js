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
    dynamicWidth,
    defaultVwSize,
  } = deps;

  // Ctrl+Alt+= / Ctrl+Alt+- shortcut.  Reads and writes the CSS variable
  // named by app.config.js dynamicWidth.cssVar directly, so no window-level
  // globals or renderer-agent round-trip is needed for this keystroke path.
  // All project-specific values come from `dynamicWidth`; this file stays
  // cross-project safe.
  function buildAdjustLayoutWidthScript(delta) {
    if (!dynamicWidth || !dynamicWidth.cssVar) return null;

    const cssVar   = dynamicWidth.cssVar;
    const minVw    = Number(dynamicWidth.minVw ?? 0);
    const maxVw    = Number(dynamicWidth.maxVw ?? 100);
    const fallback = Number(defaultVwSize ?? dynamicWidth.defaultVw ?? 100);

    return `(() => {
      try {
        const root = document.documentElement;
        const raw = getComputedStyle(root).getPropertyValue(${JSON.stringify(cssVar)}).trim();
        const m = /^(\\d+)vw$/.exec(raw);
        const current = m ? parseInt(m[1], 10) : ${fallback};
        const next = Math.max(${minVw}, Math.min(${maxVw}, Math.round(current + ${Number(delta)})));
        root.style.setProperty(${JSON.stringify(cssVar)}, next + 'vw');
      } catch {}
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
