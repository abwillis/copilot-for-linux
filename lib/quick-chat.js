'use strict';

function createQuickChatManager(deps = {}) {
  const {
    app,
    BrowserWindow,
    Menu,
    MenuItem,
    ipcMain,
    dialog,
    shell,
    clipboard,
    path,
    dirname,
    getMainWindow,
    getAppIconImage,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    getAppUrl,
    appLabel,
    appSlug,
    getAppPartition,
    SEND_MODE,
    IPC,
    reveal,
    safeShowError,
    getInitialWindowBounds,
    attachWindowStatePersistence,
    attachCSSAndLayoutHandlers,
    attachFindResultForwarding,
    ensureDidStopLoadingHandler,
    onDidStopLoading,
    buildContextMenuTemplate,
    getSelectionFragment,
    htmlToMarkdown,
    refreshTrayMenu,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });

  let quickChatWindows = [];
  let activeQuickChatId = null;
  let quickChatIdCounter = 0;
  let quickChatMenuInstalled = false;
  let promptCounter = 0;

  // --- Clipboard-based Quick Chat paste timing ---------------------------------
  const QUICK_PASTE_NEW_WINDOW_DELAY_MS = 300;
  const QUICK_PASTE_POST_KEY_DELAY_MS = 40;

  function getMain() {
    return (typeof getMainWindow === 'function') ? getMainWindow() : null;
  }

  function getAppIcon() {
    return (typeof getAppIconImage === 'function') ? getAppIconImage() : null;
  }

  function getQuickPasteDelayMs() {
    const configured = Number(APP_CONFIG.quickPasteDelayMs);
    if (Number.isFinite(configured) && configured >= 0) return Math.round(configured);
    return Number(DEFAULT_APP_CONFIG?.quickPasteDelayMs ?? 3000);
  }

  function normalizeSendOptions(opts) {
    const o = (opts && typeof opts === 'object') ? opts : {};
    return {
      mode: (o.mode === SEND_MODE.QUOTE) ? SEND_MODE.QUOTE : SEND_MODE.PLAIN,
      autoSubmit: !!o.autoSubmit,
      targetQuickId: (typeof o.targetQuickId === 'number' && Number.isFinite(o.targetQuickId)) ? o.targetQuickId : null,
    };
  }

  function quoteify(text) {
    return String(text ?? '')
      .split('\n')
      .map(line => `> ${line}`)
      .join('\n');
  }

  function getQuickDisplayName(winOrId) {
    const win = (typeof winOrId === 'number') ? getQuickById(winOrId) : winOrId;
    if (!win || win.isDestroyed?.()) return 'Quick Chat';

    const id = (typeof win.__quickId === 'number') ? win.__quickId : null;
    const customName = String(win.__quickName ?? '').trim();

    if (id !== null && customName) return `Quick Chat ${id}: ${customName}`;
    if (id !== null) return `Quick Chat ${id}`;
    return customName || 'Quick Chat';
  }

  function updateQuickWindowTitle(win) {
    try {
      if (!win || win.isDestroyed?.()) return;
      if (win.__appRole !== 'quick') return;
      win.setTitle(`${appLabel} ${getQuickDisplayName(win)}`);
    } catch {}
  }

  function setRoleTitle(win, role, id) {
    try {
      if (role === 'main') win.setTitle((deps.appLabel || 'Main Chat') + ' Main Chat');
      else {
        if (typeof id === 'number' && typeof win.__quickId !== 'number') {
          win.__quickId = id;
        }
        updateQuickWindowTitle(win);
      }
    } catch {}
  }

  function closeQuickChatWindow(win) {
    try {
      if (!win || win.isDestroyed?.()) return;
      win.destroy();
    } catch {}
  }

  function closeAllQuickChatWindows() {
    try {
      for (const win of [...quickChatWindows]) {
        closeQuickChatWindow(win);
      }
    } catch {}
  }

  function getQuickById(id) {
    return quickChatWindows.find(w => w && !w.isDestroyed() && w.__quickId === id) || null;
  }

  function listQuickIds() {
    return quickChatWindows
      .filter(w => w && !w.isDestroyed() && typeof w.__quickId === 'number')
      .map(w => w.__quickId)
      .sort((a, b) => a - b);
  }

  function getActiveQuickChatWindow({ createIfMissing = true } = {}) {
    const active = activeQuickChatId ? getQuickById(activeQuickChatId) : null;
    if (active) return active;

    const any = quickChatWindows.find(w => w && !w.isDestroyed());
    if (any) return any;

    if (!createIfMissing) return null;
    return createQuickChatWindow();
  }

  function getTargetQuickWindow(targetQuickId, { createIfMissing = true } = {}) {
    if (typeof targetQuickId === 'number') {
      const exact = getQuickById(targetQuickId);
      if (exact) return exact;
      return getActiveQuickChatWindow({ createIfMissing });
    }
    return getActiveQuickChatWindow({ createIfMissing });
  }

  function registerQuickWindow(win) {
    if (!win) return;
    quickChatWindows = quickChatWindows.filter(w => w && !w.isDestroyed());
    if (!quickChatWindows.includes(win)) quickChatWindows.push(win);
    refreshQuickChatMenu();
    try { refreshTrayMenu?.(); } catch {}
  }

  function onQuickFocus(win) {
    try { activeQuickChatId = win.__quickId || null; } catch {}
    refreshQuickChatMenu();
    try { refreshTrayMenu?.(); } catch {}
  }

  function onQuickClosed(win) {
    quickChatWindows = quickChatWindows.filter(w => w && w !== win && !w.isDestroyed());
    if (activeQuickChatId && win && win.__quickId === activeQuickChatId) {
      activeQuickChatId = quickChatWindows.at(-1)?.__quickId || null;
    }
    refreshQuickChatMenu();
    try { refreshTrayMenu?.(); } catch {}
  }

  function promptForText(parentWin, { title = 'Rename', message = 'Name:', defaultValue = '' } = {}) {
    return new Promise(resolve => {
      const channel = `${appSlug}:prompt-response:${++promptCounter}`;
      let resolved = false;
      let promptWin = null;

      const finish = (value) => {
        if (resolved) return;
        resolved = true;
        try { ipcMain.removeAllListeners(channel); } catch {}
        try {
          if (promptWin && !promptWin.isDestroyed()) promptWin.close();
        } catch {}
        resolve(value);
      };

      try {
        promptWin = new BrowserWindow({
          parent: parentWin || getMain(),
          modal: true,
          width: 420,
          height: 170,
          resizable: false,
          minimizable: false,
          maximizable: false,
          show: false,
          title,
          autoHideMenuBar: true,
          webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
          }
        });

        const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
body {
  font-family: system-ui, Segoe UI, Arial, sans-serif;
  margin: 14px;
}
label {
  display: block;
  margin-bottom: 8px;
  font-size: 13px;
}
input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 8px;
  font-size: 13px;
}
.actions {
  margin-top: 14px;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
</head>
<body>
<label for="value">${String(message).replace(/</g, '<').replace(/>/g, '>')}</label>
<input id="value" type="text" value="${String(defaultValue).replace(/&/g, '&').replace(/"/g, '"').replace(/</g, '<').replace(/>/g, '>')}" autofocus>
<div class="actions">
<button id="cancel">Cancel</button>
<button id="ok">OK</button>
</div>
<script>
const { ipcRenderer } = require('electron');
const channel = ${JSON.stringify(channel)};
const input = document.getElementById('value');
function submit(ok) {
  ipcRenderer.send(channel, {
    ok,
    value: ok ? input.value : null
  });
}
document.getElementById('ok').onclick = () => submit(true);
document.getElementById('cancel').onclick = () => submit(false);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter') submit(true);
  if (e.key === 'Escape') submit(false);
});
</script>
</body>
</html>`;

        ipcMain.once(channel, (_event, payload) => {
          finish(payload?.ok ? String(payload.value ?? '').trim() : null);
        });

        promptWin.removeMenu();
        promptWin.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
        promptWin.once('ready-to-show', () => {
          try { promptWin.show(); promptWin.focus(); } catch {}
        });
        promptWin.on('closed', () => finish(null));
      } catch (err) {
        console.error('promptForText failed:', err);
        finish(null);
      }
    });
  }

  async function renameQuickChatWindow(win) {
    try {
      if (!win || win.isDestroyed?.()) return;
      const current = String(win.__quickName ?? '').trim();
      const value = await promptForText(BrowserWindow.getFocusedWindow() || getMain(), {
        title: 'Rename Quick Chat',
        message: `New name for ${getQuickDisplayName(win)}:`,
        defaultValue: current
      });
      if (value === null) return;
      win.__quickName = value;
      updateQuickWindowTitle(win);
      refreshQuickChatMenu();
    } catch (err) {
      console.error('Rename Quick Chat failed:', err);
    }
  }

  function buildQuickChatManagerMenuTemplate() {
    const items = [];
    const wins = quickChatWindows
      .filter(w => w && !w.isDestroyed() && typeof w.__quickId === 'number')
      .sort((a, b) => a.__quickId - b.__quickId);

    items.push({
      label: 'New Quick Chat Window',
      accelerator: 'Ctrl+Alt+N',
      click: () => {
        try { reveal(createQuickChatWindow()); }
        catch (err) { console.error('Quick Chat Manager new window failed:', err); }
      }
    });

    items.push({
      label: 'Show Active Quick Chat',
      accelerator: 'Ctrl+Alt+2',
      enabled: !!getActiveQuickChatWindow({ createIfMissing: false }),
      click: () => {
        try {
          const win = getActiveQuickChatWindow({ createIfMissing: true });
          if (win) reveal(win);
        } catch (err) {
          console.error('Quick Chat Manager show active failed:', err);
        }
      }
    });

    items.push({
      label: 'Show Main Window',
      accelerator: 'Ctrl+Alt+1',
      enabled: !!getMain(),
      click: () => {
        try {
          const win = getMain();
          if (win) reveal(win);
        } catch (err) {
          console.error('Quick Chat Manager show main window failed:', err);
        }
      }
    });

    items.push({ type: 'separator' });

    items.push({
      label: 'Send Selection to Active Quick Chat',
      accelerator: 'Ctrl+Alt+Q',
      click: async () => {
        const src = BrowserWindow.getFocusedWindow() || getMain();
        await sendSelectionToQuick(src, {
          mode: SEND_MODE.PLAIN,
          autoSubmit: false,
          targetQuickId: null
        });
      }
    });

    items.push({
      label: 'Send Selection as Quote to Active Quick Chat',
      accelerator: 'Ctrl+Alt+Shift+Q',
      click: async () => {
        const src = BrowserWindow.getFocusedWindow() || getMain();
        await sendSelectionToQuick(src, {
          mode: SEND_MODE.QUOTE,
          autoSubmit: false,
          targetQuickId: null
        });
      }
    });

    items.push({
      label: 'Send Selection & Auto Submit to Active Quick Chat',
      accelerator: 'Ctrl+Alt+Enter',
      click: async () => {
        const src = BrowserWindow.getFocusedWindow() || getMain();
        await sendSelectionToQuick(src, {
          mode: SEND_MODE.PLAIN,
          autoSubmit: true,
          targetQuickId: null
        });
      }
    });

    items.push({
      label: 'Send Selection to Specific Quick Chat',
      accelerator: 'Ctrl+Alt+W',
      click: async () => {
        const src = BrowserWindow.getFocusedWindow() || getMain();
        await sendSelectionToSpecificQuickViaDialog(src, {
          mode: SEND_MODE.PLAIN,
          autoSubmit: false
        });
      }
    });

    if (!wins.length) {
      items.push({ type: 'separator' });
      items.push({ label: 'No Quick Chat Windows Open', enabled: false });
      return items;
    }

    items.push({ type: 'separator' });

    for (const win of wins) {
      const id = win.__quickId;
      const pinned = !!win.isAlwaysOnTop?.();
      const active = activeQuickChatId === id;
      const labelPrefix = `${pinned ? '📌 ' : ''}${active ? '● ' : ''}`;

      items.push({
        label: `${labelPrefix}${getQuickDisplayName(win)}`,
        submenu: [
          { label: 'Bring to Front', click: () => reveal(win) },
          {
            label: 'Send Selection Here',
            click: async () => {
              const src = BrowserWindow.getFocusedWindow() || getMain();
              await sendSelectionToQuick(src, { mode: SEND_MODE.PLAIN, autoSubmit: false, targetQuickId: id });
            }
          },
          {
            label: 'Send Selection as Quote Here',
            click: async () => {
              const src = BrowserWindow.getFocusedWindow() || getMain();
              await sendSelectionToQuick(src, { mode: SEND_MODE.QUOTE, autoSubmit: false, targetQuickId: id });
            }
          },
          {
            label: 'Send Selection & Auto Submit Here',
            click: async () => {
              const src = BrowserWindow.getFocusedWindow() || getMain();
              await sendSelectionToQuick(src, { mode: SEND_MODE.PLAIN, autoSubmit: true, targetQuickId: id });
            }
          },
          { type: 'separator' },
          {
            label: 'Pin Always on Top',
            type: 'checkbox',
            checked: pinned,
            click: () => {
              try {
                win.setAlwaysOnTop(!win.isAlwaysOnTop());
                refreshQuickChatMenu();
              } catch (err) {
                console.error('Quick Chat pin toggle failed:', err);
              }
            }
          },
          { label: 'Rename...', click: () => renameQuickChatWindow(win) },
          { type: 'separator' },
          { label: 'Close', click: () => closeQuickChatWindow(win) }
        ]
      });
    }

    items.push({ type: 'separator' });
    items.push({ label: 'Close All Quick Chat Windows', click: () => closeAllQuickChatWindows() });

    return items;
  }

  function installQuickChatMenu(appMenu) {
    if (!APP_CONFIG.enableQuickChat) return;
    if (!appMenu) return;
    const label = 'Quick Chat';
    const rebuilt = new Menu();
    const quickChatMenu = new MenuItem({
      label,
      submenu: Menu.buildFromTemplate(buildQuickChatManagerMenuTemplate())
    });
    let inserted = false;
    for (const item of appMenu.items) {
      if (!item || item.label === label) continue;
      rebuilt.append(item);
      if (!inserted && item.label === 'Edit') {
        rebuilt.append(quickChatMenu);
        inserted = true;
      }
    }
    if (!inserted) rebuilt.append(quickChatMenu);
    Menu.setApplicationMenu(rebuilt);
    quickChatMenuInstalled = true;
  }

  function refreshQuickChatMenu() {
    try {
      const appMenu = Menu.getApplicationMenu();
      if (!appMenu || !quickChatMenuInstalled) return;
      installQuickChatMenu(appMenu);
    } catch (err) {
      console.error('refreshQuickChatMenu failed:', err);
    }
  }

  function getPasteModifiers() {
    return (process.platform === 'darwin') ? ['meta'] : ['control'];
  }

  function sendPasteKeystroke(wc) {
    if (!wc) return false;
    try {
      const mods = getPasteModifiers();
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: mods });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: mods });
      return true;
    } catch (e) {
      console.error('sendPasteKeystroke failed:', e);
      return false;
    }
  }

  function sendEnterKeystroke(wc) {
    if (!wc) return false;
    try {
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      return true;
    } catch (e) {
      console.error('sendEnterKeystroke failed:', e);
      return false;
    }
  }

  function delayMs(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function waitForChatInput(wc, timeoutMs = 4000) {
    const start = Date.now();
    const pollIntervalMs = 200;
    const probeScript = `
    (function () {
      try {
        const el =
          document.querySelector('textarea') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('div[role="textbox"]');
        if (!el) return false;
        const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
        const visible = (el.offsetParent !== null) && r && (r.width > 0) && (r.height > 0);
        return !!visible;
      } catch (e) {
        return false;
      }
    })();
    `;
    while ((Date.now() - start) < timeoutMs) {
      const ok = await wc.executeJavaScript(probeScript, true).catch(() => false);
      if (ok) return true;
      await delayMs(pollIntervalMs);
    }
    return false;
  }

  async function scheduleQuickPaste(wc, { autoSubmit = false } = {}) {
    if (!wc) return;
    const ready = await waitForChatInput(wc, 4000);
    if (ready) {
      setTimeout(() => {
        const pasted = sendPasteKeystroke(wc);
        if (autoSubmit && pasted) {
          setTimeout(() => sendEnterKeystroke(wc), QUICK_PASTE_POST_KEY_DELAY_MS);
        }
      }, QUICK_PASTE_NEW_WINDOW_DELAY_MS);
      return;
    }
    setTimeout(() => {
      const pasted = sendPasteKeystroke(wc);
      if (autoSubmit && pasted) {
        setTimeout(() => sendEnterKeystroke(wc), QUICK_PASTE_POST_KEY_DELAY_MS);
      }
    }, getQuickPasteDelayMs());
  }

  async function chooseQuickChatTargetDialog(parentWin) {
    const ids = listQuickIds();
    const buttons = ids.map(id => `Quick Chat ${id}`);
    buttons.push('New Quick Chat');
    buttons.push('Cancel');

    const res = await dialog.showMessageBox(parentWin || getMain(), {
      type: 'question',
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      title: 'Send to Quick Chat',
      message: 'Choose a Quick Chat target window:',
      noLink: true
    });

    if (res.response === buttons.length - 1) return null;
    if (res.response === buttons.length - 2) return createQuickChatWindow();

    const chosenId = ids[res.response];
    return getQuickById(chosenId);
  }

  function createQuickChatWindow() {
    if (!APP_CONFIG.enableQuickChat) return null;
    quickChatIdCounter += 1;
    const id = quickChatIdCounter;
    const boundsKey = `quick-${id}`;
    const initialBounds = getInitialWindowBounds(boundsKey);
    const win = new BrowserWindow({
      skipTaskbar: false,
      width: initialBounds.width,
      height: initialBounds.height,
      x: typeof initialBounds.x === 'number' ? initialBounds.x : undefined,
      y: typeof initialBounds.y === 'number' ? initialBounds.y : undefined,
      show: false,
      title: `${deps.appLabel || 'Quick Chat'} Quick Chat ${id}`,
      icon: getAppIcon(),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(dirname, 'preload.js'),
        partition: (typeof getAppPartition === 'function') ? getAppPartition() : undefined,
        devTools: !!APP_CONFIG.devToolsEnabled,
        backgroundThrottling: true,
        spellcheck: false
      },
      type: 'normal',
      autoHideMenuBar: false
    });

    win.__appRole = 'quick';
    win.__quickId = id;
    win.__boundsKey = boundsKey;
    updateQuickWindowTitle(win);
    activeQuickChatId = id;
    registerQuickWindow(win);
    win.setMenuBarVisibility(true);
    attachWindowStatePersistence(win, boundsKey, { hideOnClose: true });
    win.on('focus', () => onQuickFocus(win));
    win.on('closed', () => onQuickClosed(win));
    win.webContents.on('destroyed', () => {
      try {
        win.webContents?.removeListener('did-stop-loading', onDidStopLoading);
        delete win.webContents.__hasDidStopLoadingHandler;
      } catch {}
    });
    ensureDidStopLoadingHandler(win.webContents);
    win.webContents.setMaxListeners(0);
    win.loadURL((typeof getAppUrl === 'function') ? getAppUrl() : '');
    attachCSSAndLayoutHandlers(win, { role: 'quick', revealOnReady: true });
    attachFindResultForwarding(win);
    win.webContents.on('did-start-navigation', () => {});
    win.webContents.on('context-menu', (_event, params) => {
      let menu;
      try {
        menu = Menu.buildFromTemplate(
          buildContextMenuTemplate(win, params, {
            includeQuickChatFeatures: APP_CONFIG.enableQuickChat,
            includeChatPaneFeatures: true,
            includeMarkdownExport: true
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
      shell.openExternal(url),
      { action: 'deny' }
    ));
    return win;
  }

  async function buildSelectionEnvelope(sourceWin, opts) {
    const { mode, autoSubmit } = normalizeSendOptions(opts);
    const src = sourceWin || getMain();
    if (!src || src.isDestroyed()) return null;

    const { hasSelection, html, text } = await getSelectionFragment(src);
    if (!hasSelection) return null;

    let content = '';
    try {
      content = html ? htmlToMarkdown(html) : String(text || '');
    } catch {
      content = String(text || '');
    }

    if (mode === SEND_MODE.QUOTE) content = quoteify(content);

    const role = src.__appRole || (src === getMain() ? 'main' : 'unknown');
    const quickId = (typeof src.__quickId === 'number') ? src.__quickId : undefined;

    return {
      kind: 'inject',
      mode,
      content,
      autoSubmit: !!autoSubmit,
      meta: {
        source: 'selection',
        sourceRole: role,
        sourceQuickId: quickId,
        timestamp: Date.now(),
        format: 'markdown'
      }
    };
  }

  async function sendSelectionToQuick(sourceWin, opts) {
    if (!APP_CONFIG.enableQuickChat) return;
    const { targetQuickId } = normalizeSendOptions(opts);
    const quick = getTargetQuickWindow(targetQuickId, { createIfMissing: true });
    if (!quick || quick.isDestroyed()) return;

    const envelope = await buildSelectionEnvelope(sourceWin, opts);
    if (!envelope) return;

    try {
      clipboard.writeText(String(envelope.content || ''));
    } catch (e) {
      console.error('clipboard.writeText failed:', e);
    }

    reveal(quick);
    const wc = quick.webContents;
    try {
      if (wc && wc.isLoading && wc.isLoading()) {
        wc.once('did-finish-load', () => {
          scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
        });
      } else {
        scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
      }
    } catch {
      scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
    }
  }

  async function sendSelectionToSpecificQuickViaDialog(sourceWin, opts) {
    const parent = BrowserWindow.getFocusedWindow() || getMain();
    const target = await chooseQuickChatTargetDialog(parent);
    if (!target) return;
    const forced = { ...(opts || {}), targetQuickId: target.__quickId };
    await sendSelectionToQuick(sourceWin, forced);
  }

  function buildSendToQuickSubmenu(sourceWin, optsBase) {
    const ids = listQuickIds();
    const items = [];

    items.push({
      label: 'Active Quick Chat',
      click: async () => sendSelectionToQuick(sourceWin, { ...optsBase, targetQuickId: null })
    });

    if (ids.length) {
      items.push({ type: 'separator' });
      for (const id of ids) {
        items.push({
          label: `Quick Chat ${id}`,
          click: async () => sendSelectionToQuick(sourceWin, { ...optsBase, targetQuickId: id })
        });
      }
    }

    items.push({ type: 'separator' });
    items.push({ label: 'Choose', click: async () => sendSelectionToSpecificQuickViaDialog(sourceWin, optsBase) });
    items.push({
      label: 'New Quick Chat Window',
      click: async () => {
        const w = createQuickChatWindow();
        await sendSelectionToQuick(sourceWin, { ...optsBase, targetQuickId: w?.__quickId ?? null });
      }
    });
    return items;
  }

  let ipcHandlersRegistered = false;
  function registerIpcHandlers() {
    if (ipcHandlersRegistered) return;
    ipcHandlersRegistered = true;

    ipcMain.on(IPC.SEND_SELECTION, async (event, opts) => {
      const sender = BrowserWindow.fromWebContents(event.sender);
      const source = (sender && sender.__appRole === 'main') ? sender : getMain();
      try { await sendSelectionToQuick(source, opts); }
      catch (e) { console.error('IPC send selection failed:', e); }
    });

    ipcMain.on(IPC.QUICK_NEW, () => {
      if (!APP_CONFIG.enableQuickChat) return;
      try { reveal(createQuickChatWindow()); }
      catch (e) { console.error('IPC quick new failed:', e); }
    });
  }

  return {
    normalizeSendOptions,
    quoteify,
    getQuickDisplayName,
    updateQuickWindowTitle,
    setRoleTitle,
    closeQuickChatWindow,
    closeAllQuickChatWindows,
    getQuickById,
    listQuickIds,
    getActiveQuickChatWindow,
    getTargetQuickWindow,
    registerQuickWindow,
    createQuickChatWindow,
    buildQuickChatManagerMenuTemplate,
    installQuickChatMenu,
    refreshQuickChatMenu,
    getPasteModifiers,
    sendPasteKeystroke,
    sendEnterKeystroke,
    delayMs,
    waitForChatInput,
    scheduleQuickPaste,
    chooseQuickChatTargetDialog,
    buildSelectionEnvelope,
    sendSelectionToQuick,
    sendSelectionToSpecificQuickViaDialog,
    buildSendToQuickSubmenu,
    registerIpcHandlers,
  };
}

module.exports = { createQuickChatManager };
