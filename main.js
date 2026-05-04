// main.js
const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const TurndownService = require('turndown');
const turndownPluginGfm = require('turndown-plugin-gfm');

// Force a persistent Chromium storage partition for Copilot.
// Electron: partitions starting with "persist:" use a persistent session. [5](https://www.electronjs.org/docs/latest/api/session)
const COPILOT_PARTITION = String(process.env.COPILOT_PARTITION ?? 'persist:copilot-for-linux').trim();

let mainWindow = null;
let quickChatWindows = [];         // Multi-Quick Chat windows
let activeQuickChatId = null;      // last-focused quick window id
let quickChatIdCounter = 0;
let tray = null;
let isQuitting = false;
let lastSavePath = null;  // (legacy) Remember where "Save" last wrote to (per session/window)
let findModal = null;  // === Find modal ===
let quickChatMenuInstalled = false;
let promptCounter = 0;
let appIconImage = null;  // Cached icon images
let trayImage24 = null;  // Cached icon images

// --- Clipboard-based Quick Chat paste timing ---------------------------------
// Requirement: copy selection -> open/focus Quick Chat -> wait 3s -> paste.
const QUICK_PASTE_NEW_WINDOW_DELAY_MS = 300;
const QUICK_PASTE_DELAY_MS = 3000; // NOTE: This is now a fallback timeout only. Primary path waits for input readiness.
const QUICK_PASTE_POST_KEY_DELAY_MS = 40; // tiny gap between paste and optional Enter


// --- Quick Chat / IPC constants --------------------------------------------
const COPILOT_URL = 'https://m365.cloud.microsoft/chat';

const IPC = Object.freeze({
  SEND_SELECTION: 'copilot:send-selection',
  QUICK_NEW: 'copilot:quick-new',
  DIRECT_OPEN_LINK: 'copilot:direct-open-link',
  PRELOAD_PING: 'copilot:preload-ping',
});

const SEND_MODE = Object.freeze({
  PLAIN: 'plain',
  QUOTE: 'quote',
});

// ============================================================================
// Shift+click direct-open download support
// ============================================================================
const DIRECT_OPEN_REQUEST_TTL_MS = 15000;
const directOpenRequests = new Map(); // senderWC.id -> { url, expiresAt }
const tempOpenedFiles = new Set();    // best-effort cleanup on quit

function debugDirectOpen(...args) {
  try {
    console.log('[direct-open]', ...args);
  } catch {}
}

function normalizeComparableUrl(input) {
  try {
    const u = new URL(String(input || '').trim());
    u.hash = '';
    return u.toString();
  } catch {
    return String(input || '').trim();
  }
}

function sanitizeDownloadFilename(name) {
  const raw = String(name || '').trim() || 'download';
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'download';
}

function buildDirectOpenTempPath(filename) {
  const safeName = sanitizeDownloadFilename(filename);
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(app.getPath('temp'), `copilot-open-${stamp}-${safeName}`);
}

function pruneExpiredDirectOpenRequests() {
  const now = Date.now();
  for (const [key, value] of directOpenRequests.entries()) {
    if (!value || value.expiresAt <= now) {
      directOpenRequests.delete(key);
    }
  }
}

function itemUrlMatchesDirectOpenRequest(item, request) {
  if (!request?.url) return false;

  const requested = normalizeComparableUrl(request.url);
  const candidates = new Set();

  try {
    const current = item?.getURL?.();
    if (current) candidates.add(normalizeComparableUrl(current));
  } catch {}

  try {
    const chain = item?.getURLChain?.();
    if (Array.isArray(chain)) {
      for (const u of chain) {
        if (u) candidates.add(normalizeComparableUrl(u));
      }
    }
  } catch {}

  if (candidates.has(requested)) return true;

  // Redirects sometimes preserve the requested URL as a prefix/query ancestor.
  for (const u of candidates) {
    if (u === requested) return true;
    if (u.startsWith(requested) || requested.startsWith(u)) return true;
  }

  return false;
}

function registerDirectOpenDownloadHandler() {
  const ses = session.fromPartition(COPILOT_PARTITION);
  if (!ses || ses.__copilotDirectOpenDownloadHandlerAttached) return;
  ses.__copilotDirectOpenDownloadHandlerAttached = true;

  // Prevent Chromium from prompting with the normal save dialog for a tagged
  // Shift+click download. We decide the path in will-download.
  ses.on('download-created', (_event, item, webContents) => {
  try {
   pruneExpiredDirectOpenRequests();
   const senderId = webContents?.id;
   if (!senderId) return;
   const request = directOpenRequests.get(senderId);
   if (!request) return;
   debugDirectOpen('download-created', {
    senderId,
    requestUrl: request.url,
    itemUrl: item?.getURL?.(),
    itemUrlChain: (typeof item?.getURLChain === 'function') ? item.getURLChain() : [],
    itemFilename: (typeof item?.getFilename === 'function') ? item.getFilename() : null,
   });
   if (request.expiresAt <= Date.now()) {
    directOpenRequests.delete(senderId);
    return;
   }
   if (itemUrlMatchesDirectOpenRequest(item, request) && typeof item.setSaveDialogOptions === 'function') {
    item.setSaveDialogOptions({ defaultPath: '' });
   }
  } catch {}
 });

  ses.on('will-download', (event, item, webContents) => {
    try {
      pruneExpiredDirectOpenRequests();

      const senderId = webContents?.id;
      if (!senderId) return;

      const request = directOpenRequests.get(senderId);
      if (!request) return;
      const matches = itemUrlMatchesDirectOpenRequest(item, request);
      debugDirectOpen('will-download', {
       senderId,
       requestUrl: request.url,
       itemUrl: item?.getURL?.(),
       itemUrlChain: (typeof item?.getURLChain === 'function') ? item.getURLChain() : [],
       itemFilename: (typeof item?.getFilename === 'function') ? item.getFilename() : null,
       matches,
      });
      if (request.expiresAt <= Date.now()) {
        directOpenRequests.delete(senderId);
        return;
      }

      directOpenRequests.delete(senderId);

      const filename =
        sanitizeDownloadFilename(
          item?.getFilename?.() ||
          (() => {
            try {
            const u = new URL(String(request.url || ''));
              return path.basename(u.pathname || '') || 'download';
            } catch {
              return 'download';
            }
          })()
        );

      const tempPath = buildDirectOpenTempPath(filename);
      tempOpenedFiles.add(tempPath);

    debugDirectOpen('about to setSavePath', {
      tempPath,
      itemUrl: item?.getURL?.(),
      itemFilename: (typeof item?.getFilename === 'function') ? item.getFilename() : null,
      totalBytes: (typeof item?.getTotalBytes === 'function') ? item.getTotalBytes() : null,
    });

    item.on('updated', (_evt, state) => {
      debugDirectOpen('download updated', {
        state,
        receivedBytes: (typeof item?.getReceivedBytes === 'function') ? item.getReceivedBytes() : null,
        totalBytes: (typeof item?.getTotalBytes === 'function') ? item.getTotalBytes() : null,
        isPaused: (typeof item?.isPaused === 'function') ? item.isPaused() : null,
      });
    });

      debugDirectOpen('setSavePath', tempPath);
      try {
        item.setSavePath(tempPath);
      } catch (err) {
        console.error('Direct-open setSavePath failed:', err);
        tempOpenedFiles.delete(tempPath);
        return;
      }

      item.once('done', async (_evt, state) => {
        debugDirectOpen('download done', { state, tempPath });
        if (state !== 'completed') {
          try { await fs.promises.unlink(tempPath); } catch {}
          tempOpenedFiles.delete(tempPath);
          return;
        }

        try {
          const openError = await shell.openPath(tempPath);
          if (openError) {
            safeShowError('Open downloaded file failed', String(openError));
          }
        } catch (err) {
          console.error('Direct-open shell.openPath failed:', err);
          safeShowError('Open downloaded file failed', String(err?.message || err));
        }
      });
    } catch (err) {
      directOpenRequests.delete(webContents?.id);
      console.error('Direct-open will-download handler failed:', err);
    }
  });
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
    if (win.__copilotRole !== 'quick') return;
    win.setTitle(`Copilot ${getQuickDisplayName(win)}`);
  } catch {}
}

function setRoleTitle(win, role, id) {
  try {
    if (role === 'main') win.setTitle('Copilot Main Chat');
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

  // Unified reveal helper to avoid repeated show/focus chains
  function reveal(win) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    try { win.moveTop(); } catch {}
  }

// ============================================================================
// Multi-Quick Chat window management + send-to-specific-#N helpers
// ============================================================================
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
}

function onQuickFocus(win) {
  try { activeQuickChatId = win.__quickId || null;
  } catch {}
  refreshQuickChatMenu();
}

function onQuickClosed(win) {
  quickChatWindows = quickChatWindows.filter(w => w && w !== win && !w.isDestroyed());
  if (activeQuickChatId && win && win.__quickId === activeQuickChatId) {
    activeQuickChatId = quickChatWindows.at(-1)?.__quickId || null;
  }
  refreshQuickChatMenu();
}

function promptForText(parentWin, { title = 'Rename', message = 'Name:', defaultValue = '' } = {}) {
  return new Promise(resolve => {
    const channel = `copilot:prompt-response:${++promptCounter}`;
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
        parent: parentWin || mainWindow,
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
  <label for="value">${String(message).replace(/</g, '&lt;').replace(/>/g, '&gt;')}</label>
  <input id="value" type="text" value="${String(defaultValue).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}" autofocus>
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
    const value = await promptForText(BrowserWindow.getFocusedWindow() || mainWindow, {
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

  items.push({ type: 'separator' });

  items.push({
    label: 'Send Selection to Active Quick Chat',
    accelerator: 'Ctrl+Alt+Q',
    click: async () => {
      const src = BrowserWindow.getFocusedWindow() || mainWindow;
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
      const src = BrowserWindow.getFocusedWindow() || mainWindow;
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
      const src = BrowserWindow.getFocusedWindow() || mainWindow;
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
      const src = BrowserWindow.getFocusedWindow() || mainWindow;
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
        {
          label: 'Bring to Front',
          click: () => reveal(win)
        },
        {
          label: 'Send Selection Here',
          click: async () => {
            const src = BrowserWindow.getFocusedWindow() || mainWindow;
            await sendSelectionToQuick(src, {
              mode: SEND_MODE.PLAIN,
              autoSubmit: false,
              targetQuickId: id
            });
          }
        },
        {
          label: 'Send Selection as Quote Here',
          click: async () => {
            const src = BrowserWindow.getFocusedWindow() || mainWindow;
            await sendSelectionToQuick(src, {
              mode: SEND_MODE.QUOTE,
              autoSubmit: false,
              targetQuickId: id
            });
          }
        },
        {
          label: 'Send Selection & Auto Submit Here',
          click: async () => {
            const src = BrowserWindow.getFocusedWindow() || mainWindow;
            await sendSelectionToQuick(src, {
              mode: SEND_MODE.PLAIN,
              autoSubmit: true,
              targetQuickId: id
            });
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
        {
          label: 'Rename...',
          click: () => renameQuickChatWindow(win)
        },
        { type: 'separator' },
        {
          label: 'Close',
          click: () => closeQuickChatWindow(win)
        }
      ]
    });
  }

  items.push({ type: 'separator' });
  items.push({
    label: 'Close All Quick Chat Windows',
    click: () => closeAllQuickChatWindows()
  });

  return items;
}

function installQuickChatMenu(appMenu) {
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

  if (!inserted) {
  rebuilt.append(quickChatMenu);
  }

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

// ============================================================================
// Clipboard paste helpers (iframe-safe)
// ============================================================================
function getPasteModifiers() {
  // Cmd+V on macOS, Ctrl+V elsewhere
  return (process.platform === 'darwin') ? ['meta'] : ['control'];
}

function sendPasteKeystroke(wc) {
  if (!wc) return false;
  try {
    const mods = getPasteModifiers();
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: mods });
    wc.sendInputEvent({ type: 'keyUp',   keyCode: 'V', modifiers: mods });
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
    wc.sendInputEvent({ type: 'keyUp',   keyCode: 'Enter' });
    return true;
  } catch (e) {
    console.error('sendEnterKeystroke failed:', e);
    return false;
  }
}

function delayMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until the Copilot chat input appears and is visible.
 * This avoids a fixed delay and pastes as soon as the UI is ready.
 *
 * Returns true if ready before timeout, else false.
 */
async function waitForChatInput(wc, timeoutMs = 4000) {
  const start = Date.now();
  const pollIntervalMs = 200;

  // A small set of selectors to detect an input surface.
  // The UI can change; we keep this conservative and generic.
  const probeScript = `
    (function () {
      try {
        // Common cases: textarea or contenteditable editor
        const el =
          document.querySelector('textarea') ||
          document.querySelector('[contenteditable="true"]') ||
          document.querySelector('div[role="textbox"]');
        if (!el) return false;

        // Visible-ish check: offsetParent null usually means display:none or detached.
        // Also ensure it has a client rect (not 0x0).
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

/**
 * Dynamic paste: wait for input readiness (up to timeout), then paste.
 * Falls back to QUICK_PASTE_DELAY_MS if readiness isn't detected in time.
 */
async function scheduleQuickPaste(wc, { autoSubmit = false } = {}) {
  if (!wc) return;

  // Primary: wait for UI readiness
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

  // Fallback: preserve old behavior in case selectors break / UI changes
  setTimeout(() => {
    const pasted = sendPasteKeystroke(wc);
    if (autoSubmit && pasted) {
      setTimeout(() => sendEnterKeystroke(wc), QUICK_PASTE_POST_KEY_DELAY_MS);
    }
  }, QUICK_PASTE_DELAY_MS);
}

async function chooseQuickChatTargetDialog(parentWin) {
  const ids = listQuickIds();
  const buttons = ids.map(id => `Quick Chat ${id}`);
  buttons.push('New Quick Chat');
  buttons.push('Cancel');

  const res = await dialog.showMessageBox(parentWin || mainWindow, {
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
    title: `Copilot Quick Chat ${id}`,
    icon: appIconImage,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      partition: COPILOT_PARTITION,
      devTools: true,
      backgroundThrottling: true,
      spellcheck: false
    },
    type: 'normal',
    autoHideMenuBar: false
  });

  win.__copilotRole = 'quick';
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

  // Allow Electron's internal executeJavaScript() listeners
  // without triggering false-positive leak warnings
  win.webContents.setMaxListeners(0);
  win.loadURL(COPILOT_URL);
  attachCSSAndLayoutHandlers(win, { role: 'quick', revealOnReady: true });
  attachFindResultForwarding(win);

  win.webContents.on('did-start-navigation', () => {
    //  try { attachVWResize(win); } catch {}
  });

  win.webContents.on('context-menu', (_event, params) => {
    try {
      menu = Menu.buildFromTemplate(
        buildContextMenuTemplate(win, params, {
          includeQuickChatFeatures: true,
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
  // --- end context menu ---

  win.webContents.setWindowOpenHandler(({ url }) => (
    shell.openExternal(url),
    { action: 'deny' }
  ));

  return win;
}


// --- Make the site use the full viewport by injecting CSS (CSP-safe) ---
const CHAT_ROOT_SELECTORS = [
  '#mainChat',
  '[data-testid="layout-main-pane"]',
  '[data-testid="MessageListContainer"]',
  '[id*="messagelist" i]',
  '[role="feed"]'
];
const CHAT_MESSAGE_LIST_SELECTORS = [
  '#mainChat div[id*="messagelist" i]',
  '[data-testid="MessageListContainer"] [role="feed"]',
  '[id*="messagelist" i]',
  '[role="feed"]'
];
const CHAT_SCOPE_SELECTOR = CHAT_ROOT_SELECTORS.join(', ');
const CHAT_SCOPE_PSEUDO = `:is(${CHAT_SCOPE_SELECTOR})`;
const CHAT_MESSAGE_LIST_SELECTOR = CHAT_MESSAGE_LIST_SELECTORS.join(', ');
const CHAT_MESSAGE_LIST_PSEUDO = `:is(${CHAT_MESSAGE_LIST_SELECTOR})`;
const EXPORT_ROOT_CLASS = 'copilot-export-root';
const EXPORT_ROOT_SELECTOR = `.${EXPORT_ROOT_CLASS}`;
const CODE_PREVIEW_IFRAME_SELECTOR = 'iframe[id^="codePreviewIframe"], iframe[id*="codePreviewIframe"]';

// Shared cleanup selectors for exported/copied content.
const DOM_CLEANUP_SELECTORS = [
  'button',
  '[role="button"]',
  '[data-testid*="copy"]',
  '[data-testid*="feedback"]',
  '[data-testid*="thumb"]',
  '[data-testid*="reaction"]',
  '[data-testid*="reference"]',
  '[data-testid*="citation"]',
  '[class*="copy" i]',
  '[class*="feedback" i]',
  '[class*="toolbar" i]',
  '[class*="action" i]',
  '[class*="hover" i]',
  '[class*="menu" i]',
  '[class*="icon" i]'
];

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

function cleanupDOMFragmentScript(containerName = 'container') {
  const selectorsJson = JSON.stringify(DOM_CLEANUP_SELECTORS);
  return `
    (function() {
      const __target = ${containerName};
      const __selectors = ${selectorsJson};
      if (!__target) return;
      __target.querySelectorAll(__selectors.join(',')).forEach(el => {
        try { el.remove(); } catch {}
      });
      __target.querySelectorAll('pre, code, table, ul, ol').forEach(el => {
        try { el.setAttribute('data-preserve', 'true'); } catch {}
      });
      __target.querySelectorAll('div, span').forEach(el => {
        try {
          if (
            !el.textContent.trim() &&
            !el.querySelector('[data-preserve]') &&
            !el.querySelector('pre, code, table, ul, ol')
          ) {
            el.remove();
          }
        } catch {}
      });
    })();
  `;
}

function buildChatPaneDetectionScript(options = {}) {
  const {
    includeHtml = false,
    selectContent = false,
    cleanupJunk = false,
    scrollIntoView = false
  } = options;

  const candidatesJson = JSON.stringify(CHAT_ROOT_SELECTORS);
  const junkSelectorsJson = cleanupJunk
    ? JSON.stringify(DOM_CLEANUP_SELECTORS)
    : 'null';

  return `
    (function () {
      const candidates = ${candidatesJson};
      const junkSelectors = ${junkSelectorsJson};

      function visible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect?.();
        return !!r && r.width > 0 && r.height > 0;
      }

      function scoreElement(el) {
        let score = 0;
        try {
          if (visible(el)) score += 1000;
          score += (el.querySelectorAll?.('[role="article"]').length ?? 0) * 25;
          score += (el.querySelectorAll?.('[id^="copilot-message-"]').length ?? 0) * 25;
          score += (el.querySelectorAll?.('[role="feed"]').length ?? 0) * 50;
          score += Math.min(String(el.innerText ?? '').length, 500);
        } catch {}
        return score;
      }

      const found = [];
      for (const sel of candidates) {
        try {
          document.querySelectorAll(sel).forEach(el => found.push({ sel, el }));
        } catch {}
      }
      if (!found.length) return null;

      const scored = found.map(({ sel, el }) => ({
        sel,
        el,
        score: scoreElement(el)
      }));
      scored.sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (!best || !best.el) return null;

      if (${scrollIntoView ? 'true' : 'false'}) {
        try {
          best.el.scrollIntoView({ block: 'start', inline: 'nearest' });
        } catch {}
      }

      if (${selectContent ? 'true' : 'false'}) {
        try {
          const sel = window.getSelection?.();
          if (sel) {
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(best.el);
            sel.addRange(range);
          }
        } catch {}
      }

      let resultHtml = '';
      if (${includeHtml ? 'true' : 'false'}) {
        if (${cleanupJunk ? 'true' : 'false'} && junkSelectors) {
          const clone = best.el.cloneNode(true);
          clone.querySelectorAll(junkSelectors.join(',')).forEach(el => {
            try { el.remove(); } catch {}
          });
          clone.querySelectorAll('pre, code, table, ul, ol').forEach(el => {
            try { el.setAttribute('data-preserve', 'true'); } catch {}
          });
          clone.querySelectorAll('div, span').forEach(el => {
            try {
              if (
                !el.textContent.trim() &&
                !el.querySelector('[data-preserve]') &&
                !el.querySelector('pre, code, table, ul, ol')
              ) {
                el.remove();
              }
            } catch {}
          });
          resultHtml = clone.outerHTML;
        } else {
          resultHtml = best.el.outerHTML;
        }
      }

      const selectedTextLength = ${selectContent ? 'String(window.getSelection?.()?.toString() ?? "").length' : '0'};

      return {
        ok: true,
        selector: best.sel,
        html: resultHtml,
        textLength: String(best.el.innerText ?? '').length,
        score: Number(best.score ?? 0),
        selectedTextLength
      };
    })();
  `;
}

function attachWindowStatePersistence(win, boundsKey, { hideOnClose = true } = {}) {
  if (!win) return;
  win.on('resize', () => scheduleSaveWindowState(win, boundsKey));
  win.on('move', () => scheduleSaveWindowState(win, boundsKey));
  win.on('close', (e) => {
    try { scheduleSaveWindowState(win, boundsKey); } catch {}
    if (!isQuitting && hideOnClose) {
      e.preventDefault();
      win.hide();
    }
  });
}

function attachCSSAndLayoutHandlers(win, { role = 'window', revealOnReady = true } = {}) {
  if (!win?.webContents) return;

  ensureDidStopLoadingHandler(win.webContents);

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

function buildContextMenuTemplate(win, params, options = {}) {
  const {
    includeQuickChatFeatures = true,
    includeChatPaneFeatures = true,
    includeMarkdownExport = true
  } = options;

  const isEditable = !!params?.isEditable;
  const hasSelection = !!params?.selectionText && params.selectionText.length > 0;

  const inspectItem = {
    label: 'Inspect Element',
    accelerator: 'Ctrl+Shift+C',
    click: () => {
      try {
        win.webContents.inspectElement(params.x, params.y);
        if (!win.webContents.isDevToolsOpened()) {
          win.webContents.openDevTools({ mode: 'right' });
        }
      } catch (err) {
        console.error('Inspect failed:', err);
      }
    }
  };

  const template = [
    { role: 'cut', accelerator: 'Ctrl+X', enabled: isEditable },
    { role: 'copy', accelerator: 'Ctrl+C', enabled: (hasSelection || isEditable) },
    { role: 'paste', accelerator: 'Ctrl+V', enabled: isEditable },
    { type: 'separator' },
    { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true }
  ];

  if (includeQuickChatFeatures) {
    template.push(
      { type: 'separator' },
      {
        label: 'Send to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.PLAIN, autoSubmit: false })
      },
      {
        label: 'Send as Quote to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.QUOTE, autoSubmit: false })
      },
      {
        label: 'Send & Auto Submit to Quick Chat',
        submenu: buildSendToQuickSubmenu(win, { mode: SEND_MODE.PLAIN, autoSubmit: true })
      },
      { type: 'separator' },
      {
        label: 'New Quick Chat Window',
        accelerator: 'Ctrl+Alt+N',
        click: () => {
          try { reveal(createQuickChatWindow()); }
          catch (e) { console.error('New Quick Chat (context) failed:', e); }
        }
      }
    );
  }

  if (includeChatPaneFeatures) {
    template.push(
      { type: 'separator' },
      {
        label: 'Select Chat Pane',
        accelerator: 'Ctrl+Shift+A',
        enabled: true,
        click: async () => {
          try {
            const res = await selectChatPane(win);
            if (!res?.ok) safeShowError('Select Chat Pane', 'Could not select the chat pane.');
          } catch (err) {
            console.error('Select Chat Pane failed:', err);
            safeShowError('Select Chat Pane failed', String(err?.message ?? err));
          }
        }
      },
      {
        label: 'Save Chat Pane',
        click: async () => {
          await promptSaveChatPane(win);
        }
      }
    );
  }

  if (includeMarkdownExport) {
    template.push(
      { type: 'separator' },
      {
        label: 'Copy Selection as Markdown',
        accelerator: 'Ctrl+Shift+M',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(win);
            if (!ok) return;
            const md = htmlToMarkdown(html || text);
            clipboard.writeText(md);
          } catch (err) {
            console.error('Copy Selection as Markdown failed:', err);
          }
        }
      },
      {
        label: 'Save Selection as Markdown',
        enabled: hasSelection,
        click: async () => {
          await saveSelectionAsMarkdown(win);
        }
      },
      {
        label: 'Save Selection as Plain Text',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(win);
            if (!ok) {
              safeShowError('Save Selection as Text', 'No selection found.');
              return;
            }
            const safeHtml = stripExecutableBlocks(decodeEntities(html || text));
            let plain = stripTags(safeHtml)
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            const { filePath, canceled } = await dialog.showSaveDialog(win, {
              title: 'Save Selection as Plain Text',
              defaultPath: 'selection.txt',
              filters: [{ name: 'Plain Text', extensions: ['txt'] }]
            });
            if (canceled || !filePath) return;
            await fs.promises.writeFile(filePath, plain, 'utf8');
          } catch (err) {
            console.error('Save Selection as Plain Text failed:', err);
            safeShowError('Save failed', String(err?.message ?? err));
          }
        }
      }
    );
  }

  template.push({ type: 'separator' }, inspectItem);
  return template;
}

// Parameterized single-message selector
const messageContentById = (id) => `${CHAT_SCOPE_PSEUDO} #${id}, ${CHAT_MESSAGE_LIST_PSEUDO} #${id}, [id="${id}"]`; 

// === Safe 'did-stop-loading' wiring =========================================
// A named handler so removeListener(...) can reliably detach the same function.
function onDidStopLoading() {
  try {
    // Place your post-load logic here (keep it lightweight or idempotent).
    // Example: enforceNoHScroll(BrowserWindow.getFocusedWindow() || mainWindow);
  } catch (err) {
    console.error('did-stop-loading handler error:', err);
  }
}

// Attach the handler exactly once per webContents.
function ensureDidStopLoadingHandler(webContents) {
 if (!webContents) return;

  // Guard against duplicate attachment across SPA navigations
  if (webContents.__hasDidStopLoadingHandler) return;

  webContents.__hasDidStopLoadingHandler = true;
  webContents.on('did-stop-loading', onDidStopLoading);
}

// 7 options grouped into containers vs content for correct layout application
const SELECTORS = {
  // Containers (safe to apply full-viewport/layout rules)
  feedContainer: CHAT_MESSAGE_LIST_PSEUDO,
  listContainer: '[data-testid="MessageListContainer"]',
  copilotChatClass: `[class*="CopilotChat"]`,
  layoutMainPane: `[data-testid="layout-main-pane"]`,
  chatMessageResponserId: `[id*="chatMessageResponser"]`,
  markdownReplyTestId: `[data-testid="markdown-reply"]`,
  llmChatMessageClass: `[class*="m365-chat-llm-web-ui-chat-chat-message"]`,
  chatMessageContainerId: `[id*="chatMessageContainer"]`,
  llmChatMessageTestId: `[data-testid="m365-chat-llm-web-ui-chat-message"]`,
  copilotMessageTestId: `[data-testid*="copilot-message"]`,

  // Content targets (do NOT force height: 100vh here)H
  allMessageContent_class:
    `${CHAT_MESSAGE_LIST_PSEUDO} .fai-CopilotMessage .fai-CopilotMessage__content`, 
  allMessageContent_class_lowSpecificity:
    `${CHAT_MESSAGE_LIST_PSEUDO} :where(.fai-CopilotMessage) :where(.fai-CopilotMessage__content)`, 
  allMessageContent_attr:
    `${CHAT_MESSAGE_LIST_PSEUDO} [role="article"][aria-labelledby*="copilot-message-" i] > div[id^="copilot-message-" i]`, 
  linksInContent_class:
    `${CHAT_MESSAGE_LIST_PSEUDO} .fai-CopilotMessage__content a`, 
  linksInContent_attr:
    `${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] > div[id^="copilot-message-"] a`, 
  minimalSemantic:
    `${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] > [id^="copilot-message-"]`, 
};

// --- Centralized ignore list: ALWAYS excluded from layout adjustments ---
const IGNORE_SELECTORS = [
  `div[role=\"textbox\"]`,
  `[class*="Drawer" i]`,
  `[class*="button" i]`,
  `[type*="button" i]` ,
  `[role="button" i]` ,
  `[class*="Menu" i]`,
  `[class*="MessageBar" i]`,
  `[role="status"]`,
  `[role*="tooltip"]`,
  `[class*="tooltip" i]`,
  `[class*="popover" i]`,
  `[class*="hover" i]`,
  `[data-tooltip]`,
  `[data-popover]`,
  `[role*="toolbar"]`,
  `[data-testid*="message-actions" i]` ,
  `[data-testid*="hover" i]` ,
  `[class*="messageActions" i]` ,
  `[class*="hoverCard" i]` ,
  `[class*="floatingToolbar" i]` ,
  `[class*="flyout" i]` ,
  `[class*="contextualMenu" i]` ,
  `[id*="toggle-work"]` ,
  `[id*="toggle-web"]` ,
  `[class*="actionsContainer"]` 
];
const IGNORE_JOINED = IGNORE_SELECTORS.join(', ');
/*
Removed the following from the IGNORE List above
  `rich-textarea`,
  `rich-textarea .ql-editor[contenteditable=\"true\"]`,
  `.text-input-field_textarea .ql-editor[contenteditable=\"true\"]`,
  `.ql-editor[contenteditable=\"true\"]`,
  `div[contenteditable=\"true\"][role=\"textbox\"]`,
  `textarea`,
  `input`,
  `[contenteditable=\"true\"]`,
  `[class*="chatinput" i]`,
  `[id*="ChatInput" i]`,
  `[class*="chat-input" i]`,
  `[id*="chat-input" i]`,
  `[class*="editorinput" i]` ,
  `[class*="usermessage" i]` ,
  `[id*="user-message"]` ,
*/

function applyDynamicWidth(win) {
  if (!win) return;
  const script = String.raw`(function(){try{
    const root = document.documentElement;
    if (!getComputedStyle(root).getPropertyValue('--copilot-vw')) {
      root.style.setProperty('--copilot-vw', '${VW_SIZE}vw');
    }
    window.__copilot_getTargetVW = function(){
      try { const v = getComputedStyle(root).getPropertyValue('--copilot-vw').trim();
        const m = /^(\d+)vw$/.exec(v); return m ? parseInt(m[1],10) : ${VW_SIZE}; } catch { return ${VW_SIZE}; }
    };
    window.__copilot_setTargetVW = function(v){
      try { const c = Math.max(${MIN_VW}, Math.min(${MAX_VW}, Math.round(v))); root.style.setProperty('--copilot-vw', c+'vw'); } catch {}
    };
  }catch(e){} })();`;
  try { win.webContents.executeJavaScript(script).catch(()=>{}); } catch {}
}

// Responsive VW: keep --copilot-vw tied to window size (95    30vw)
function attachVWResize(win) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;

  // Run layout-affecting JS only once per window lifetime
  if (wc.__copilotVWResizeAttached) return;
  wc.__copilotVWResizeAttached = true;

  const script = `
    (function () {
      try {
        const MAX = 95;
        const MIN = 70;
        const root = document.documentElement;
        function computeVW() {
          try {
            const screenW = (window.screen && window.screen.width) ? window.screen.width : window.innerWidth;
            const winW = window.innerWidth;
            let vw = Math.round((winW / screenW) * MAX);
            vw = Math.max(MIN, Math.min(MAX, vw));
            root.style.setProperty('--copilot-vw', vw + 'vw');
            if (window.__copilot_setTargetVW) window.__copilot_setTargetVW(vw);
          } catch {}
        }
        computeVW();
        window.addEventListener('resize', computeVW, { passive: true });
        window.addEventListener('orientationchange', computeVW, { passive: true });
      } catch {}
    })();
  `;
  const run = () => { try { wc.executeJavaScript(script).catch(() => {}); } catch {} };
  wc.once('dom-ready', run);
}

// --- Dynamic width constants (added) ---
const MAX_CHARS = 1024;
const VW_SIZE = 100;
const MIN_VW = 70;
const MAX_VW = 100;
//let   VW_WIDTH = 83;

// Build CSS with container vs content separation

function buildMaxLayoutCSS({ specificMessageId } = {}) {
  const CONTAINERS = [
    // existing containers
    CHAT_SCOPE_PSEUDO,
    SELECTORS.feedContainer,
    SELECTORS.listContainer,
    SELECTORS.copilotChatClass,
    SELECTORS.layoutMainPane,
    SELECTORS.chatMessageResponserId,
    SELECTORS.markdownReplyTestId,
    SELECTORS.llmChatMessageClass,
    SELECTORS.chatMessageContainerId,
    SELECTORS.llmChatMessageTestId,
    SELECTORS.copilotMessageTestId,
  ].join(',\n');

  const CONTENT = [
    specificMessageId ? messageContentById(specificMessageId) : null,
    SELECTORS.allMessageContent_class,
    SELECTORS.allMessageContent_class_lowSpecificity,
    SELECTORS.allMessageContent_attr,
    `${CHAT_MESSAGE_LIST_PSEUDO} [role="article"]`, 
    SELECTORS.linksInContent_class,
    SELECTORS.linksInContent_attr,
    SELECTORS.minimalSemantic,
  ].filter(Boolean).join(',\n');

  return String.raw`

    /* Copilot code preview iframes use ids like codePreviewIframe2, codePreviewIframe4, ... */
    ${CODE_PREVIEW_IFRAME_SELECTOR} {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      /* JS will set the real height from the iframe document; keep a sane floor here. */
      min-height: 333px !important;
      height: auto !important;
      border: 0 !important;
      position: relative !important;
      z-index: 2 !important;
      box-sizing: border-box !important;
      overflow: visible !important;
    }

    /* Root var for dynamic target width; default 90vw */
    html { --copilot-vw: ${VW_SIZE}vw; }

    /* Page-level: strictly prevent horizontal scroll; allow vertical */
    html, body {
      height: 100vh !important;
      width: 100% !important;
      margin: 0 !important;
      margin-left: 0 !important;
      padding-left: 0 !important;
      padding: 0 !important;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      background: #fff !important;
      word-break: break-word !important;
    }
    @supports (overflow: clip) {
      html, body { overflow-x: clip !important; }
    }

    /* #officehome-scroll-container must NOT scroll */
    #officehome-scroll-container {
      overflow: visible !important;        /* or overflow: hidden; if content must clip */
      overscroll-behavior: contain !important;   /* avoid nested scroll chaining */
    }

    ${CHAT_SCOPE_PSEUDO}, ${CHAT_SCOPE_PSEUDO} * { 
      max-width: 100% !important;
      box-sizing: border-box !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;

    }

    /* Main chat/message containers: always full width, never clipped */
    [class*="CopilotChat"],
    [data-testid="layout-main-pane"],
    [id*="chatMessageResponser"],
    [data-testid="markdown-reply"],
    [class*="m365-chat-llm-web-ui-chat-chat-message"],
    [id*="chatMessageContainer"],
    [data-testid="m365-chat-llm-web-ui-chat-message"],
    [data-testid*="copilot-message"] {
      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
      box-sizing: border-box !important;
      overflow-x: visible !important;
      overflow-y: visible !important;
      word-break: break-word !important;
    }

    /* Guard: descendant matches of the ignore list within containers keep spacing */
    :is(${CONTAINERS}) :is(${IGNORE_JOINED}) {
      width: auto !important;
      max-width: none !important;
      margin: initial !important;
      padding: initial !important;
      padding-left: 1px !important;
    }

    ${SELECTORS.llmChatMessageClass},
    ${SELECTORS.chatMessageContainerId},
    ${SELECTORS.llmChatMessageTestId},
    ${SELECTORS.copilotMessageTestId} {
      /* eliminate left/right padding/margins that cause right shift */
      margin-right: 0 !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      /* align start in any flex/grid parent */
      justify-self: start !important;
      align-self: start !important;
      place-self: start !important;
      /* ensure they take full available width within container clamp */
      width: 100% !important;
      max-width: none !important;
      box-sizing: border-box !important;
      /* neutralize common layout shifters */
      left: auto !important;
      right: auto !important;
      text-align: left !important;
    }

    /* If any inner wrapper adds accidental horizontal gap, clear it */
    ${SELECTORS.llmChatMessageClass} *,
    ${SELECTORS.chatMessageContainerId} *,
    ${SELECTORS.llmChatMessageTestId} * {
      padding-left: 0 !important;
    }

    /* === NEW: Shift-left nested message bubbles inside the three panes === */
    /* Common bubble structures: role="article", copilot-message-* wrappers, generic bubble classes */
    ${SELECTORS.llmChatMessageClass} [role="article"],
    ${SELECTORS.llmChatMessageClass} [id^="copilot-message-" i],
    ${SELECTORS.llmChatMessageClass} .fai-CopilotMessage,
    ${SELECTORS.llmChatMessageClass} .fai-CopilotMessage__content,
    ${SELECTORS.chatMessageContainerId} [role="article"],
    ${SELECTORS.chatMessageContainerId} [id^="copilot-message-" i],
    ${SELECTORS.chatMessageContainerId} .fai-CopilotMessage,
    ${SELECTORS.chatMessageContainerId} .fai-CopilotMessage__content,
    ${SELECTORS.llmChatMessageTestId} [role="article"],
    ${SELECTORS.llmChatMessageTestId} [id^="copilot-message-" i],
    ${SELECTORS.llmChatMessageTestId} .fai-CopilotMessage,
    ${SELECTORS.llmChatMessageTestId} .fai-CopilotMessage__content {
      margin-left: 0 !important;
      padding-left: 0 !important;
      /* Ensure left alignment even if parent uses center/space-around */
      text-align: left !important;
      justify-content: flex-start !important;
      align-items: flex-start !important;
      /* --- Ensure text wraps inside bubbles --- */
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      white-space: normal !important;
    }

    /* Catch-all bubble alignment + wrapping for any Copilot message */
    ${SELECTORS.feedContainer} [role="article"] > [id^="copilot-message-" i],
    ${SELECTORS.feedContainer} [role="article"] [id^="copilot-message-" i],
    ${SELECTORS.feedContainer} .fai-CopilotMessage,
    ${SELECTORS.feedContainer} .fai-CopilotMessage__content {
      margin-left: 0 !important;
      padding-left: 0 !important;
      text-align: left !important;
      justify-content: flex-start !important;
      align-items: flex-start !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      white-space: normal !important;
      width: 100% !important;
      max-width: none !important;
      box-sizing: border-box !important;
    }

   /* Make every message article bubble full-width and text-wrapping */
   ${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] { 
     width: 100% !important;
     max-width: none !important;
     box-sizing: border-box !important;
     text-align: left !important;
     overflow-wrap: anywhere !important;
     word-break: break-word !important;
     white-space: normal !important;
   }

    /* Ensure plain text elements wrap within message articles */
    ${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] p, 
    ${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] li, 
    ${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] ul, 
    ${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] ol, 
    ${CHAT_MESSAGE_LIST_PSEUDO} [role="article"] blockquote { 
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      white-space: normal !important;
    }

    /* --- Ensure code blocks and inline code wrap inside bubbles --- */
    ${SELECTORS.llmChatMessageClass} pre,
    ${SELECTORS.llmChatMessageClass} code,
    ${SELECTORS.chatMessageContainerId} pre,
    ${SELECTORS.chatMessageContainerId} code,
    ${SELECTORS.llmChatMessageTestId} pre,
    ${SELECTORS.llmChatMessageTestId} code {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      max-width: 100% !important;
    }

 
    /* Nested bubble containers in flex/grid layouts: force start alignment */
    ${SELECTORS.llmChatMessageClass} .message,
    ${SELECTORS.chatMessageContainerId} .message,
    ${SELECTORS.llmChatMessageTestId} .message,
    ${SELECTORS.copilotMessageTestId} .message {
      justify-content: flex-start !important;
      align-items: flex-start !important;
      place-content: start !important;
      place-items: start !important;
      text-align: left !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      white-space: normal !important;
      margin-left: 0 !important;
      padding-left: 0 !important;
      width: 100% !important;
      max-width: none !important;
      box-sizing: border-box !important;
    }

    /* Clamp wide media/code to container width; preserve aspect ratio */
    ${SELECTORS.feedContainer} img,
    ${SELECTORS.feedContainer} svg,
    ${SELECTORS.feedContainer} canvas,
    ${SELECTORS.feedContainer} video,
    ${SELECTORS.feedContainer} iframe,
    ${SELECTORS.feedContainer} embed,
    ${SELECTORS.feedContainer} table {
      max-width: 100% !important;
      height: auto !important;
    }

    /* Code & inline tokens: wrap aggressively to avoid horizontal overflow */
    ${SELECTORS.feedContainer} pre,
    ${SELECTORS.feedContainer} code,
    ${SELECTORS.feedContainer} kbd,
    ${SELECTORS.feedContainer} samp {
      white-space: pre-wrap !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      max-width: 100% !important;
    }

    /* Long links: let the URL wrap rather than forcing horizontal scroll */
    ${SELECTORS.feedContainer} a {
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
    }

    [data-testid="chat-history-search-input"] {
      width: 2000ch !important;
      max-width: 100% !important;
    }

    [class*="tooltip" i] {
      width: auto !important;
      max-width: none !important;
      margin: initial !important;
      padding: initial !important;
      box-sizing: border-box !important;
      text-align: initial !important;
      justify-content: initial !important;
      align-items: initial !important;
      justify-self: initial !important;
      align-self: initial !important;
      place-self: initial !important;
    }

    [class*="tooltip" i],
    [class*="fui-Tab__content"],
    [id="toggle-work"],
    [id="toggle-web"]  {
      display: inline-block !important;   /* Allows width to fit content */
      width: fit-content !important;      /* Shrinks to text width */
      height: fit-content !important;     /* Shrinks to text height */
      padding: 0 !important;              /* Optional: remove extra space */
      margin: 0 !important;               /* Optional: remove extra space */
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
     }

    [data-testid="chatOutput"] {
      width: min(min(var(--copilot-vw, ${VW_SIZE}vw), 91vw), ${MAX_CHARS}ch) !important;
      max-width: 100% !important;
      box-sizing: border-box !important;
      overflow-x: visible !important;
      overflow-y: visible !important;
      word-break: break-word !important;
    }

    [class*="UserMessage"]:not([class*="UserMessage_actionBar"]),
    [data-testid="chatQuestion"], [data-testid*="UserMessage"]:not([class*="UserMessage_actionBar"]) {
      max-width: min(min(var(--copilot-vw, ${VW_SIZE}vw), 91vw), ${MAX_CHARS}ch) !important;
      width: auto !important;
      box-sizing: content-box !important;
      margin-left: auto !important;
      margin-right: 0 !important;
      padding-left: auto !important;
      padding-right: 0 !important;
      align-self: flex-end !important;
      justify-self: end !important;
      place-self: end !important;
      display: block !important;
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
      white-space: pre-wrap !important;
    }

    /* Tables: auto layout & full width to reduce clipping overflow */
    ${SELECTORS.feedContainer} table {
      margin-left: 12px !important;
      padding-left: 12px !important;
      table-layout: auto !important;
      width: 100% !important;
    }
  `;
}

// ============================================================================
// Max-layout CSS caching + injection bookkeeping (framesInSubtree variant)
// ============================================================================
const maxLayoutCssCache = new Map();              // cacheKey -> css string
const injectedFrameIdsByWC = new WeakMap();       // webContents -> Set<routingId>
const insertedMainCssKeyByWC = new WeakMap();     // webContents -> insertedCSS key (main frame)
const cssApplyDebounceByWC = new WeakMap();       // webContents -> timeoutId

// CSP-safe injection with re-inject on SPA navigations (and cleanup)
function injectCSSOnLoad(win, css, keyHolder) {
 if (!win || !win.webContents) return;
 const wc = win.webContents;
 if (!keyHolder) return;
 // Allow callers to update CSS without re-wiring listeners.
 keyHolder.css = String(css ?? keyHolder.css ?? '');

 const inject = () => {
  try {
   const currentCss = String(keyHolder.css ?? '');
   if (!currentCss) return;
   if (keyHolder.key) {
    try { wc.removeInsertedCSS(keyHolder.key); } catch {}
    keyHolder.key = null;
   }
   wc.insertCSS(currentCss)
    .then(k => { keyHolder.key = k; })
    .catch(() => {});
  } catch (err) {
   console.error('insertCSS failed:', err);
  }
 };

 // Wire reinjection hooks exactly once per keyHolder.
 if (!keyHolder.__wired) {
  keyHolder.__wired = true;
  wc.on('dom-ready', inject);
  wc.on('did-finish-load', inject);
  wc.on('did-navigate-in-page', inject);
  wc.on('did-start-navigation', inject);
 }
 inject();
}

// Inject CSS into all frames (main + iframes), and re-inject on frame loads.
function injectCSSIntoAllFrames(win, css) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;
  const apply = () => {
    try {
     // Debounce reinjection bursts from multiple navigation/frame events.
     const prev = cssApplyDebounceByWC.get(wc);
     if (prev) clearTimeout(prev);
     const t = setTimeout(() => {
      try {
          // IMPORTANT:
          // Frames can navigate while keeping the same routingId; CSS is dropped on navigation.
          // Reset injection bookkeeping each apply so navigations get reinjected.
          const injected = new Set();
          injectedFrameIdsByWC.set(wc, injected);

       // Iterate over the whole frame subtree (Electron 20+)
       const frames = wc.mainFrame?.framesInSubtree ?? wc.mainFrame?.frames ?? [];
       for (const f of frames) {
         try {
           const rid = (typeof f?.routingId === 'number') ? f.routingId : null;
            // Always attempt insertion; avoid "already injected" false positives after navigation.
            f.insertCSS(css).then(() => { if (rid !== null) injected.add(rid); }).catch(() => {});
         } catch {}
       }

       // Main frame injection with key tracking to avoid accumulating duplicates.
       const prevKey = insertedMainCssKeyByWC.get(wc);
       if (prevKey) {
        try { wc.removeInsertedCSS(prevKey); } catch {}
       }
       try {
        wc.insertCSS(css).then((k) => { insertedMainCssKeyByWC.set(wc, k); }).catch(() => {});
       } catch {}
      } catch {}
     }, 150);
     cssApplyDebounceByWC.set(wc, t);
    } catch {}
  };
  // Hook all relevant events (document + frame loads + in-page SPA nav)
  wc.on('dom-ready', apply);
  wc.on('did-frame-finish-load', apply);
  wc.on('did-navigate-in-page', apply);
  wc.on('did-frame-navigate', apply);
  apply();
}

function applyMaxLayoutCSS(win, { specificMessageId } = {}) {
  if (!win) return;
  const cacheKey = specificMessageId || 'default';
  let css = maxLayoutCssCache.get(cacheKey);
  if (!css) {
   css = buildMaxLayoutCSS({ specificMessageId });
   maxLayoutCssCache.set(cacheKey, css);
  }
  // For Quick Chat windows, inject into all frames to catch iframe-hosted UI.
  if (win.___copilotRole === 'quick' || win.__copilotRole === 'quick') {
    injectCSSIntoAllFrames(win, css);
    return;
  }
  // Default: main-frame injection (lighter weight).
  if (!win.__maxLayoutKeyHolder) {
    win.__maxLayoutKeyHolder = { key: null, css: '', __wired: false };
  }
  injectCSSOnLoad(win, css, win.__maxLayoutKeyHolder);
}

function requestExpandedLayout(win) {
  if (!win) return;
  const script = `
    (function() {
      try {
        // Send a message to the page requesting expanded/full-bleed layout
        window.postMessage({
          type: 'host:setLayoutMode',
          payload: { mode: 'expanded' }
        }, '*');
      } catch (e) {
        console.error('PostMessage layout request failed:', e);
      }
    })();
  `;
  const run = () => {
    try { win.webContents.executeJavaScript(script).catch(() => {}); }
    catch (err) { console.error('requestExpandedLayout failed:', err); }
  };
  // Initial load
  win.webContents.on('did-finish-load', run);
  // Client-side route changes (SPA)
  win.webContents.on('did-navigate-in-page', run);
}

// === Window state persistence (size/position) ===
function getWindowStateFile(key) {
  const safe = String(key || 'main')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return path.join(app.getPath('userData'), `window-state-${safe}.json`);
}

const windowStateCache = new Map(); // key -> {x,y,width,height}
const saveStateDebounceByKey = new Map(); // key -> timeoutId
const SAVE_STATE_DEBOUNCE_MS = 500;

function loadWindowState(key = 'main') {
  try {
    const file = getWindowStateFile(key);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    windowStateCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function isBoundsOnAnyDisplay(bounds) {
  try {
    const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const disp = screen.getDisplayMatching(rect);
    if (!disp) return false;
    const wa = disp.workArea;
    const intersects =
      rect.x < (wa.x + wa.width) &&
      (rect.x + rect.width) > wa.x &&
      rect.y < (wa.y + wa.height) &&
      (rect.y + rect.height) > wa.y;
    return intersects;
  } catch {
    return true;
  }
}

function getInitialWindowBounds(key = 'main') {
  const persisted = windowStateCache.get(key) || loadWindowState(key);
  if (persisted && persisted.width && persisted.height) {
    if (isBoundsOnAnyDisplay(persisted)) {
      return {
        width: Math.max(600, persisted.width),
        height: Math.max(400, persisted.height),
        x: typeof persisted.x === 'number' ? persisted.x : undefined,
        y: typeof persisted.y === 'number' ? persisted.y : undefined
      };
    }
    return {
      width: Math.max(600, persisted.width),
      height: Math.max(400, persisted.height)
    };
  }
  return { width: 1200, height: 800 };
}

function scheduleSaveWindowState(win, key = 'main') {
  const prev = saveStateDebounceByKey.get(key);
  if (prev) clearTimeout(prev);
 const t = setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const state = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      const file = getWindowStateFile(key);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(state), 'utf8');
      windowStateCache.set(key, state);
    } catch (err) {
      console.error('Failed to persist window state:', err);
    }
  }, SAVE_STATE_DEBOUNCE_MS);
  saveStateDebounceByKey.set(key, t);
}

// === Helper: runtime info for About dialog ===
function getRuntimeInfo() {
  const name = app.getName?.() || 'Application';
  const appVersion = app.getVersion?.() || '0.0.0';
  const nodeVersion = process.versions?.node || 'unknown';
  const electronVersion = process.versions?.electron || 'unknown';
  const chromeVersion = process.versions?.chrome || 'unknown';
  const v8Version = process.versions?.v8 || 'unknown';

  return {
    name,
    appVersion,
    nodeVersion,
    electronVersion,
    chromeVersion,
    v8Version,
    detail:
      `Version: ${appVersion}\n` +
      `Node: ${nodeVersion}\n` +
      `V8: ${v8Version}\n` +
      `Electron: ${electronVersion}\n` +
      `Chromium: ${chromeVersion}\n`
  };
}


// ============================================================================
// Session / cache / troubleshooting menu helpers
// ============================================================================
function getCopilotSession() {
  return session.fromPartition(COPILOT_PARTITION);
}

function getActiveCopilotWindow() {
  const focused = BrowserWindow.getFocusedWindow();
  const parent = focused?.getParentWindow?.();
  return parent || focused || mainWindow;
}

function getActiveCopilotWebContents() {
  const win = getActiveCopilotWindow();
  if (!win || win.isDestroyed?.()) return null;
  return win.webContents || null;
}

function reloadCopilot({ ignoreCache = false } = {}) {
  try {
    const wc = getActiveCopilotWebContents();
    if (!wc) return;
    if (ignoreCache) wc.reloadIgnoringCache();
    else wc.reload();
  } catch (err) {
    console.error('Reload Copilot failed:', err);
    safeShowError('Reload Copilot failed', String(err?.message ?? err));
  }
}

async function clearCopilotCache() {
  try {
    const ses = getCopilotSession();
    await ses.clearCache();
  } catch (err) {
    console.error('Clear Copilot Cache failed:', err);
    safeShowError('Clear Copilot Cache failed', String(err?.message ?? err));
  }
}

async function clearCookiesAndSignOut() {
  try {
    const ses = getCopilotSession();
    await ses.clearStorageData({
      storages: [
        'cookies',
        'localstorage',
        'sessionstorage',
        'indexeddb',
        'serviceworkers',
        'cachestorage'
      ]
    });
    reloadCopilot({ ignoreCache: true });
  } catch (err) {
    console.error('Clear Cookies / Sign Out failed:', err);
    safeShowError('Clear Cookies / Sign Out failed', String(err?.message ?? err));
  }
}

function copyCurrentUrl() {
  try {
    const wc = getActiveCopilotWebContents();
    if (!wc) return;
    clipboard.writeText(wc.getURL());
  } catch (err) {
    console.error('Copy Current URL failed:', err);
    safeShowError('Copy Current URL failed', String(err?.message ?? err));
  }
}

async function openCurrentUrlExternal() {
  try {
    const wc = getActiveCopilotWebContents();
    if (!wc) return;
    const url = wc.getURL();
    if (url) await shell.openExternal(url);
  } catch (err) {
    console.error('Open Current URL in External Browser failed:', err);
    safeShowError('Open Current URL failed', String(err?.message ?? err));
  }
}

app.setName('copilot-for-linux');  // Shows as WMClass "yourapp" or "YourApp"
app.setAppUserModelId('your.company.copilot');

// === Parent-aware helpers for find-in-page ===
// Prefer the parent window's webContents when the focused window is a modal.
function getWCFromEventSender(sender) {
  const modalWin = BrowserWindow.fromWebContents(sender);
  const targetWin = modalWin?.getParentWindow() || mainWindow;
  return targetWin?.webContents || null;
}

function getWC() {
  const focused = BrowserWindow.getFocusedWindow();
  const target = focused?.getParentWindow() || focused || mainWindow;
  return target?.webContents || null;
}

// Optional: utility to safely enable "whole word-ish" behavior.
// Chromium's flags are heuristic; enable if desired.
function applyWordStartOptions(opts) {
  return {
    ...opts,
    // Enable these if you want word-start behavior, useful for token-like terms.
    wordStart: opts.wordStart ?? true,
    medialCapitalAsWordStart: opts.medialCapitalAsWordStart ?? true,
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
    if (wc.__copilotFindResultForwardingAttached) return;
    wc.__copilotFindResultForwardingAttached = true;

    wc.on('found-in-page', (_event, result) => {
        try {
            // Forward Chromium findInPage() result state to the modal UI.
            // result = {
            //   requestId,
            //   activeMatchOrdinal,
            //   matches,
            //   selectionArea,
            //   finalUpdate
            // }
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


function openFindModal(parent) {
  // Force all conversation messages to fully render so findInPage can
  // reach them.  Runs before the early-return so a re-focused modal
  // re-applies the override if the page navigated while it was hidden.
  enableFindContentVisibility(parent);
  if (findModal && !findModal.isDestroyed()) {
    findModal.show(); findModal.focus(); return;
  }
  findModal = new BrowserWindow({
    parent, modal: true, width: 380, height: 160, resizable: false,
    minimizable: false, maximizable: false, show: false,
    title: 'Find in Page', autoHideMenuBar: true,
    // Enable Node only in the modal; main window remains sandboxed
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });

  // --- Position the find window relative to the parent window (Cinnamon-friendly) ---
  try {
    // Prefer the *restored* bounds if parent is maximized/fullscreen
    const pb = (parent && typeof parent.getNormalBounds === 'function')
      ? parent.getNormalBounds()
      : parent.getBounds();

    const modalW = 380;
    const modalH = 160;

    // Center over parent
    let x = Math.round(pb.x + (pb.width - modalW) / 2);
    let y = Math.round(pb.y + (pb.height - modalH) / 2);

    // Clamp to nearest display workArea so it doesn't end up off-screen
    const display = screen.getDisplayMatching({ x: pb.x, y: pb.y, width: pb.width, height: pb.height });
    const wa = display?.workArea || { x: 0, y: 0, width: 1920, height: 1080 };

    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - modalW));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - modalH));

    findModal.setBounds({ x, y, width: modalW, height: modalH });
  } catch (e) {
    // If anything goes wrong, let the WM decide placement
  }

  // Build plain HTML, then encode only the payload for the data URL
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
 body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:12px}
 .row{display:flex;gap:8px;align-items:center}
 input[type=text]{flex:1;padding:6px 8px}
 .actions{margin-top:10px;display:flex;gap:8px;justify-content:flex-end}
 .status{margin-top:8px;min-height:18px;font-size:12px;color:#555}
 .status.searching{color:#555}
 .status.none{color:#9a3412}
 .status.ok{color:#166534}
 label{font-size:12px;color:#444}
</style></head><body>
  <div class="row">
    <input id="term" type="text" placeholder="Find in page..." autofocus />
    <label><input id="match" type="checkbox"> Match case</label>
  </div>
  <div id="status" class="status">No active search</div>
  <div class="actions">
    <button id="prev">Previous</button>
    <button id="next">Next</button>
    <button id="clear">Clear</button>
    <button id="close">Close</button>
  </div>
  <script>
    const { ipcRenderer } = require('electron');
    const termEl = document.getElementById('term');
    const matchEl = document.getElementById('match');
    const statusEl = document.getElementById('status'); 

    function setStatus(text, cls) {
    try {
    if (!statusEl) return;
    statusEl.textContent = text || ''; 
    statusEl.className = 'status' + (cls ? ' ' + cls : ''); 
    } catch {}
    }

    const send = (kind) => ipcRenderer.send('find-modal-submit', {
      kind, term: termEl.value || '', matchCase: !!matchEl.checked
    });

    function submitFind(kind) {
        if ((termEl.value || '').trim()) setStatus('Searching...', 'searching');
        send(kind);
    }

    document.getElementById('next').onclick = () => submitFind('next');
    document.getElementById('prev').onclick = () => submitFind('prev');
    document.getElementById('clear').onclick = () => {
        setStatus('No active search', '');
        ipcRenderer.send('find-modal-clear');
    };
    document.getElementById('close').onclick = () => ipcRenderer.send('find-modal-close');
    termEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitFind(e.shiftKey ? 'prev' : 'next');
      if (e.key === 'Escape') {
        setStatus('No active search', '');
        ipcRenderer.send('find-modal-clear');
        ipcRenderer.send('find-modal-close');
      }
    });
    termEl.addEventListener('input', () => {
        if (!(termEl.value || '').trim()) setStatus('No active search', '');
    });
    ipcRenderer.on('find-modal-results', (_event, result) => {
        if (!result || result.kind === 'reset') {
            setStatus('No active search', '');
            return;
        }
        if (result.kind === 'searching') {
        setStatus('Searching...', 'searching');
        return;
        }
        const matches = Number(result.matches || 0);
        const active = Number(result.activeMatchOrdinal || 0);
        if (!matches) {
            setStatus('No matches', 'none');
        } else if (active > 0) {
            setStatus(active + ' of ' + matches, 'ok');
        } else {
            setStatus(matches + ' match' + (matches === 1 ? '' : 'es'), 'ok');
        }
    });
  </script>
</body></html>`;
  // Keep the modal clean; no menu bar
  findModal.removeMenu();
  // Encode only the HTML part, not the "data:" URL header
  findModal.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  // Show when ready and log any load failures
  findModal.once('ready-to-show', () => {
    try { findModal.show(); findModal.focus(); } catch {}
  });

  // Restore lazy rendering when modal closes — covers all close paths:
  // user clicks Close, presses Escape, or clicks the WM X button.
  findModal.on('closed', () => {
    resetFindModalResults('closed');
    disableFindContentVisibility();
    findModal = null;
  });

  findModal.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Find modal failed to load:', code, desc, url);
  });
}

// === Find-in-page state ===
let lastFindTerm = '';
let lastFindOpts = { forward: true, matchCase: false, medialCapitalAsWordStart: true, wordStart: true, findNext: false };
let findDebounce;
const FIND_DEBOUNCE_MS = 20;

// --- Find-in-page content-visibility on-demand override ---------------------
// The Copilot web app applies content-visibility:auto to off-screen message
// items for faster initial paint.  Chromium's findInPage() skips those
// unrendered subtrees entirely.  We inject a CSS override only while the
// Find modal is open, then remove it on close so the lazy-render
// optimisation is preserved during normal browsing.
// ---------------------------------------------------------------------------
let findCVKey = null;       // insertCSS key for the override
let findCVTargetWC = null;  // webContents the override was applied to

function buildFindContentVisibilityCSS() {
  return `
    ${CHAT_MESSAGE_LIST_PSEUDO},
    ${CHAT_MESSAGE_LIST_PSEUDO} > *,
    ${CHAT_SCOPE_PSEUDO} > *,
    [role="feed"],
    [role="feed"] > *,
    [role="article"],
    [data-testid*="copilot-message"],
    [id^="copilot-message-" i] {
      content-visibility: visible !important;
      contain-intrinsic-size: auto !important;
    }
  `;
}

function enableFindContentVisibility(win) {
  if (!win?.webContents) return;
  // Already active on this webContents — nothing to do
  if (findCVKey && findCVTargetWC === win.webContents) return;
  // Clean up stale override on a different webContents (if any)
  disableFindContentVisibility();
  const wc = win.webContents;
  wc.insertCSS(buildFindContentVisibilityCSS())
    .then(key => { findCVKey = key; findCVTargetWC = wc; })
    .catch(err => {
      console.error('enableFindContentVisibility insertCSS failed:', err);
      findCVKey = null;
      findCVTargetWC = null;
    });
}

function disableFindContentVisibility() {
  if (!findCVKey || !findCVTargetWC) return;
  const key = findCVKey;
  const wc = findCVTargetWC;
  findCVKey = null;
  findCVTargetWC = null;
  try { wc.removeInsertedCSS(key).catch(() => {}); } catch {}
}

// Build Edit menu as a reusable factory
function appendEditItems(editSubmenu) {
  const template = [
//    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
//    { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
//    { role: 'selectAll' }, { type: 'separator' },
    {
      label: 'Find',
      accelerator: 'Ctrl+F',
      click: () => {
        const w = BrowserWindow.getFocusedWindow() || mainWindow;
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
    { type: 'separator' },
    {
      label: 'Select Chat Pane',
          accelerator: 'Ctrl+Shift+A',
          click: async () => {
            const w = BrowserWindow.getFocusedWindow() || mainWindow;
            if (!w) return;
            try {
              const res = await selectChatPane(w);
              if (!res?.ok) {
                try { dialog.showErrorBox('Select Chat Pane', 'Could not select the chat pane.'); } catch {}
              }
            } catch (err) {
              console.error('Select Chat Pane failed:', err);
              try { dialog.showErrorBox('Select Chat Pane failed', String(err?.message || err)); } catch {}
            }
      }
    },
  ];
  // Merge our items into the existing Edit menu
  Menu.buildFromTemplate(template).items.forEach(i => editSubmenu.append(i));
}

// --- Help menu: add About screen (under the menu bar) ----------------------
function appendHelpItems(helpSubmenu) {
  const template = [
    new MenuItem({
      label: 'About',
      // Optional: make F1 open About; change/remove if you already use F1 elsewhere
      accelerator: 'F1',
      click: async () => {
        try {
          const info = getRuntimeInfo();
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            defaultId: 0,
            title: `About ${info.name}`,
            message: `${info.name}`,
            detail: info.detail,
            noLink: true,
            icon: appIconImage
          });
        } catch (err) {
          console.error('Help  About dialog failed:', err);
        }
      }
    }),
    new MenuItem({ type: 'separator' }),
    // (Optional) quick links; uncomment/adjust as needed:
    // new MenuItem({
    //   label: 'Documentation',
    //   click: () => shell.openExternal('https://your.docs.url/')
    // }),
    // new MenuItem({
    //   label: 'Report Issue',
    //   click: () => shell.openExternal('https://your.issues.url/')
    // }),
  ];
  template.forEach(i => helpSubmenu.append(i));
}



// --- Session menu: reload/cache/auth/current URL troubleshooting ------------
function appendSessionItems(sessionSubmenu) {
  const template = [
    new MenuItem({
      label: 'Reload Copilot',
      accelerator: 'Ctrl+R',
      click: () => reloadCopilot({ ignoreCache: false })
    }),
    new MenuItem({
      label: 'Hard Reload',
      accelerator: 'Ctrl+Shift+R',
      click: () => reloadCopilot({ ignoreCache: true })
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Clear Copilot Cache',
      click: async () => {
        await clearCopilotCache();
      }
    }),
    new MenuItem({
      label: 'Clear Cookies / Sign Out',
      click: async () => {
        await clearCookiesAndSignOut();
      }
    }),
    new MenuItem({
      label: 'Copy Current URL',
      click: () => copyCurrentUrl()
    }),
    new MenuItem({
      label: 'Open Current URL in External Browser',
      click: async () => {
        await openCurrentUrlExternal();
      }
    })
  ];

  template.forEach(i => sessionSubmenu.append(i));
}

// Augment (mutate) the existing app menu rather than replacing it

function augmentApplicationMenu(win) {
  // Start from the current application menu.
  // NOTE: On Windows/Linux this may be null until first set; handle that.
  const appMenu = Menu.getApplicationMenu() ?? new Menu();

  // Ensure "File" submenu exists, then append our items
  let fileSubmenu = appMenu.items.find(i => i.label === 'File')?.submenu;
  if (!fileSubmenu) {
    fileSubmenu = new Menu();
    appMenu.insert(0, new MenuItem({ label: 'File', submenu: fileSubmenu }));
  }
  appendFileItems(fileSubmenu, win);

  // Ensure "Edit" submenu exists, then append our items
  let editSubmenu = appMenu.items.find(i => i.label === 'Edit')?.submenu;
  if (!editSubmenu) {
    editSubmenu = new Menu();
    appMenu.insert(1, new MenuItem({ label: 'Edit', submenu: editSubmenu }));
  }
  appendEditItems(editSubmenu);

  // Ensure "Session" submenu exists, then append reload/cache/auth items.
  let sessionSubmenu = appMenu.items.find(i => i.label === 'Session')?.submenu;
  if (!sessionSubmenu) {
    sessionSubmenu = new Menu();
    const sessionItem = new MenuItem({ label: 'Session', submenu: sessionSubmenu });
    const helpIndex = appMenu.items.findIndex(i => i.label === 'Help');
    if (helpIndex >= 0) appMenu.insert(helpIndex, sessionItem);
    else appMenu.append(sessionItem);
  }
  appendSessionItems(sessionSubmenu);

  // Ensure "Help" submenu exists, then append our items
  let helpSubmenu = appMenu.items.find(i => i.label === 'Help')?.submenu;
  if (!helpSubmenu) {
    helpSubmenu = new Menu();
    // Place Help at the end for Windows/Linux conventions
    appMenu.append(new MenuItem({ label: 'Help', submenu: helpSubmenu }));
  }
  appendHelpItems(helpSubmenu);

  // installQuickChatMenu() rebuilds and applies the full application menu.
  // Call it last so the rebuilt menu includes File/Edit/Help and is not
  // overwritten by re-applying the pre-rebuild appMenu object.
  installQuickChatMenu(appMenu);
}


function ensureSaveState(win) {
  if (win && typeof win.__lastSavePath === 'undefined') win.__lastSavePath = null;
}

async function executeInAllFrames(win, source) {
  if (!win?.webContents) return [];
  const results = [];
 
  try {
    const top = await win.webContents.executeJavaScript(source, true).catch(() => null);
    if (top) results.push({ where: 'top', value: top });
  } catch {}
 
  const frames = win.webContents.mainFrame?.framesInSubtree ?? [];
  for (const frame of frames) {
    try {
      const value = await frame.executeJavaScript(source, true).catch(() => null);
      if (value) results.push({ where: `frame:${frame.routingId}`, value });
    } catch {}
  }
 
  return results;
 }
 
 async function findBestChatRoot(win, { includeHtml = true } = {}) {
  const results = await executeInAllFrames(
    win,
    buildChatPaneDetectionScript({ includeHtml })
  );
  if (!results.length) return null;
 
  results.sort((a, b) => {
    const aScore = Number(a?.value?.score || 0);
    const bScore = Number(b?.value?.score || 0);
    if (bScore !== aScore) return bScore - aScore;
    const aLen = Number(a?.value?.textLength || 0);
    const bLen = Number(b?.value?.textLength || 0);
    return bLen - aLen;
  });
 
  return results[0];
 }
 
 async function getChatPaneSnapshot(win) {
  const best = await findBestChatRoot(win, { includeHtml: true });
  if (!best?.value) {
    return { ok: false, html: '', textLength: 0, selector: null };
  }
  return {
    ok: true,
    html: String(best.value.html || ''),
    textLength: Number(best.value.textLength || 0),
    selector: best.value.selector || null
  };
 }

// ---------- Chat pane selection helper ----------
// Select the entire chat pane content in the renderer and return selection stats
async function selectChatPane(win) {
 const js = buildChatPaneDetectionScript({
   selectContent: true,
   scrollIntoView: true
 });
 const results = await executeInAllFrames(win, js);
 const success = results
   .map(r => r.value)
   .filter(v => v?.ok)
   .sort((a, b) => Number(b.selectedTextLength || 0) - Number(a.selectedTextLength || 0))[0];

 return success || { ok: false, selectedTextLength: 0 }
}

// ---------- Selection  Markdown helpers ----------
// Extract the current selection from the renderer as HTML fragment and text.
async function getSelectionFragment(win) {

 const result = await win.webContents.executeJavaScript(`
 (function() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.rangeCount === 0) {
   return { hasSelection: false, html: "", text: "" };
  }

  // Clone selected contents so we never mutate the live DOM
  const range = sel.getRangeAt(0);
  const container = document.createElement('div');
  container.appendChild(range.cloneContents());
  ${cleanupDOMFragmentScript('container')}
  const html = container.innerHTML;
  const text = String(sel.toString() || '');
  return { hasSelection: true, html, text };
 })();
 `).catch(() => ({ hasSelection: false, html: "", text: "" }));
  return result;
}

// ============================================================================
// Structured selection -> envelope -> quick chat inject (active OR specific #N)
// ============================================================================
async function buildSelectionEnvelope(sourceWin, opts) {
  const { mode, autoSubmit } = normalizeSendOptions(opts);
  const src = sourceWin || mainWindow;
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

  const role = src.__copilotRole || (src === mainWindow ? 'main' : 'unknown');
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
  const { targetQuickId } = normalizeSendOptions(opts);
  const quick = getTargetQuickWindow(targetQuickId, { createIfMissing: true });
  if (!quick || quick.isDestroyed()) return;

  const envelope = await buildSelectionEnvelope(sourceWin, opts);
  if (!envelope) return;

  // Clipboard-based path (iframe-safe):
  // 1) Copy selection content to clipboard
  // 2) Reveal/focus Quick Chat window
  // 3) Wait 3 seconds
  // 4) Paste (Ctrl/Cmd+V)
  // 5) Optional Enter if autoSubmit
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
      // Dynamic wait + paste after load completes
      scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
    });
    } else {
      // Dynamic wait + paste immediately if already ready
      scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
    }
  } catch {
      scheduleQuickPaste(wc, { autoSubmit: !!envelope.autoSubmit }).catch(() => {});
  }
}

async function sendSelectionToSpecificQuickViaDialog(sourceWin, opts) {
  const parent = BrowserWindow.getFocusedWindow() || mainWindow;
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
      // Ensure we target the freshly created window so sendSelectionToQuick()
      // performs clipboard write + reveal + paste scheduling.
      await sendSelectionToQuick(sourceWin, { ...optsBase, targetQuickId: w?.__quickId ?? null });
    }
  });
//  items.push({ label: 'New Quick Chat Window', click: () => reveal(createQuickChatWindow()) });
  return items;
}

ipcMain.on(IPC.SEND_SELECTION, async (event, opts) => {
  const sender = BrowserWindow.fromWebContents(event.sender);
  const source = (sender && sender.__copilotRole === 'main') ? sender : mainWindow;
  try { await sendSelectionToQuick(source, opts); }
  catch (e) { console.error('IPC send selection failed:', e); }
});

ipcMain.on(IPC.DIRECT_OPEN_LINK, (event, payload) => {
  try {
    pruneExpiredDirectOpenRequests();

    const href = String(payload?.href || '').trim();
    if (!href) return;

    directOpenRequests.set(event.sender.id, {
      url: href,
      expiresAt: Date.now() + DIRECT_OPEN_REQUEST_TTL_MS,
    });
  debugDirectOpen('ipc request queued', {
   senderId: event.sender.id,
   href,
  });
  } catch (err) {
    console.error('IPC direct-open-link failed:', err);
  }
});

ipcMain.on(IPC.PRELOAD_PING, (event, payload) => {
  debugDirectOpen('preload ping', {
    senderId: event.sender.id,
    href: payload?.href,
    ts: payload?.ts,
  });
});

ipcMain.on(IPC.QUICK_NEW, () => {
  try { reveal(createQuickChatWindow()); }
  catch (e) { console.error('IPC quick new failed:', e); }
});

// Turndown-backed HTML  Markdown converter.
// Regex is only used here for targeted preprocessing/post-processing around Turndown.
const turndownService = createTurndownService();

function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
    linkReferenceStyle: 'full',
    preformattedCode: true,
  });

  try {
    const { gfm, tables } = turndownPluginGfm;
    // Be explicit that tables must go through the GFM table path.
    if (tables) service.use(tables);
    if (gfm) service.use(gfm)
  } catch (err) {
    console.error('turndown-plugin-gfm setup failed:', err);
  }

  // Remove obvious non-content / executable elements if any survive renderer cleanup.
  try {
    service.remove([
      'script', 'style', 'noscript', 'template',
      'button', 'input', 'select', 'textarea',
      'svg', 'canvas', 'iframe'
    ]);
  } catch (err) {
    console.error('Turndown remove() setup failed:', err);
  }

  // Preserve fenced code blocks exactly, including language hints when present.
  service.addRule('fencedCodeBlocks', {
    filter: 'pre',
    replacement: function (_content, node) {
      const codeNode =
        node.firstElementChild && node.firstElementChild.nodeName === 'CODE'
          ? node.firstElementChild
          : node;
      const raw = String(codeNode.textContent || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\r\n?/g, '\n');
      const className = String(codeNode.getAttribute?.('class') || '');
      const language = (className.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)/) || [])[1] || '';
      const body = raw.replace(/^\n+|\n+$/g, '');
      return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
    }
  });

  // Convert <br> to hard line breaks consistently.
  service.addRule('hardLineBreak', {
    filter: 'br',
    replacement: function () {
      return '  \n';
    }
  });

  // Treat HR explicitly so separators survive cleanup.
  service.addRule('thematicBreak', {
    filter: 'hr',
    replacement: function () {
      return '\n\n---\n\n';
    }
  });

  return service;
}

function splitMarkdownTableRow(line) {
  const trimmed = String(line || '').trim();
  const core = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  return core.split('|').map(cell => cell.trim());
}

function isMarkdownTableSeparatorLine(line) {
  const cells = splitMarkdownTableRow(line);
  if (!cells.length) return false;
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function isLikelyMarkdownTableBlock(lines) {
  if (!Array.isArray(lines) || lines.length < 2) return false;
  const nonEmpty = lines.filter(Boolean);
  if (nonEmpty.length < 2) return false;
  if (!nonEmpty[0].includes('|')) return false;
  if (!isMarkdownTableSeparatorLine(nonEmpty[1])) return false;
  return nonEmpty.every(line => !line || line.includes('|'));
}

function formatMarkdownTableBlock(block) {
  const rawLines = String(block || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

  if (!isLikelyMarkdownTableBlock(rawLines)) return block;

  const rows = rawLines.map(splitMarkdownTableRow);
  const columnCount = Math.max(...rows.map(r => r.length));

  for (const row of rows) {
    while (row.length < columnCount) row.push('');
  }

  const widths = new Array(columnCount).fill(3);
  for (let r = 0; r < rows.length; r += 1) {
    if (r === 1) continue; // separator row rebuilt below
    for (let c = 0; c < columnCount; c += 1) {
      widths[c] = Math.max(widths[c], rows[r][c].length, 3);
    }
  }

  const separatorSource = rows[1];
  const separator = separatorSource.map((cell, idx) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    const dashes = '-'.repeat(Math.max(widths[idx], 3));
    if (left && right) return `:${dashes}:`;
    if (left) return `:${dashes}`;
    if (right) return `${dashes}:`;
    return dashes;
  });

  const formatted = rows.map((row, rowIdx) => {
    const cells = (rowIdx === 1 ? separator : row).map((cell, idx) => {
      const value = rowIdx === 1 ? cell : cell.padEnd(widths[idx], ' ');
      return ` ${value} `;
    });
    return `|${cells.join('|')}|`;
  });

  return formatted.join('\n');
}

function normalizeMarkdownTables(md) {
  const blocks = String(md || '').split(/\n{2,}/);
  const normalized = blocks.map(block => {
    const lines = block.split('\n').map(line => line.trimRight());
    return isLikelyMarkdownTableBlock(lines.filter(Boolean))
      ? formatMarkdownTableBlock(lines.join('\n'))
      : block;
  });
  return normalized.join('\n\n');
}

function preprocessHtmlForMarkdown(html) {
  let out = String(html || '');
  if (!out.trim()) return '';

  out = stripExecutableBlocks(out)
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ');

  // Copilot often renders diff/code lines as adjacent block nodes with no text newlines.
  // Inject line boundaries before Turndown sees the HTML.
  out = out
    .replace(/<\/(div|p|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>\s*</gi, '</$1>\n<')
    .replace(/<(br)\s*\/?\s*>/gi, '<$1 />\n');

  return out.trim();
}

function postProcessMarkdown(md) {
  return normalizeMarkdownTables(
    String(md || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2')
    .replace(/([^\n])\n([-*]\s)/g, '$1\n\n$2')
    .trim()
  );
}

function htmlToMarkdown(html) {
  const preparedHtml = preprocessHtmlForMarkdown(html);
  if (!preparedHtml) return '';

  try {
    return postProcessMarkdown(turndownService.turndown(preparedHtml));
  } catch (err) {
    console.error('Turndown conversion failed; falling back to plain text extraction:', err);
    const safeHtml = stripExecutableBlocks(decodeEntities(preparedHtml));
    return postProcessMarkdown(stripTags(safeHtml));
  }
}

function stripTags(s) {
  // Remove any remaining HTML tags; entity decoding is handled earlier
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00A0/g, ' '); // non-breaking space  regular space
}

// --- Centralized sanitizers ---
function decodeEntities(s) {
  // Remove any remaining HTML tags; entity decoding is handled earlier when needed.
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripExecutableBlocks(input) {
  if (typeof input !== 'string') return input;
  // Real <script>/<style>
  const reScriptTags = /<script[\s\S]*?<\/script>/gi;
  const reStyleTags  = /<style[\s\S]*?<\/style>/gi;

  // Entity-encoded &lt;script&gt;/&lt;style&gt; (in case source was pre-escaped)
  const reEscScript  = /&lt;script[\s\S]*?&lt;\/script&gt;/gi;
  const reEscStyle   = /&lt;style[\s\S]*?&lt;\/style&gt;/gi;

  let out = input.replace(reScriptTags, '')
                 .replace(reStyleTags, '')
                 .replace(reEscScript, '')
                 .replace(reEscStyle, '');

  // Optional: strip inline event handlers like onclick="...", onload='...'
  out = out.replace(/\son\w+=(?:"[^"]*"|'[^']*')/gi, '');
  return out;
}

// --- Save selection as Markdown helper ---
async function saveSelectionAsMarkdown(win) {
  try {
    if (!win) return;
    const { hasSelection, html, text } = await getSelectionFragment(win);
    if (!hasSelection) {
      // Optional: inform user; keep silent if you prefer
      try { dialog.showErrorBox('Save Selection as Markdown', 'No selection found.'); } catch {}
      return;
    }
    const md = htmlToMarkdown(html || text);
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Selection as Markdown',
      defaultPath: 'selection.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (canceled || !filePath) return;
    await fs.promises.writeFile(filePath, md, 'utf8');
  } catch (err) {
    console.error('Save Selection as Markdown failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

// ---------- Chat pane save helpers ----------
// A) Hide everything except the chat pane, then savePage (HTMLOnly/MHTML)
async function saveOnlyPaneWithSavePage(win, filePath, format /* 'HTMLOnly' | 'MHTML' */) {
  const snapshot = await getChatPaneSnapshot(win);
  const selectorGroup = snapshot?.selector ? `:is(${snapshot.selector})` : CHAT_SCOPE_PSEUDO; 
  // Make everything except the chat invisible but still laid out.
  // Using opacity/pointer-events instead of display:none helps virtualized lists keep measurements,
  // reducing "white page" issues when saving.
  const css = `
    html, body {
      overflow: auto !important;
      background: #ffffff !important;
    }
  *:not(${selectorGroup}):not(${selectorGroup} *) { 
      opacity: 0 !important;
      pointer-events: none !important;
    }
  ${selectorGroup} { 
      opacity: 1 !important;
      pointer-events: auto !important;
      width: 100% !important;
      max-width: 100% !important;
    }
  `;

  let key = null;
  try {
    key = await win.webContents.insertCSS(css);
  } catch (_) {}
  try {
    // Give the style a tick to apply before saving
    await new Promise(r => setTimeout(r, 150));
    await win.webContents.savePage(filePath, format);
  } finally {
    if (key) {
      try { await win.webContents.removeInsertedCSS(key); } catch {}
    }
  }
}

// B) Extract chat pane HTML and write a standalone file
async function savePaneAsStandaloneHTML(win, filePath) {
  const url = win.webContents.getURL();
  let origin = '';
  try { origin = new URL(url).origin; } catch {}
  const snapshot = await getChatPaneSnapshot(win);
  const result = {
    ok: !!snapshot?.ok,
    html: String(snapshot?.html || ''),
    title: win.webContents.getTitle?.() || 'Copilot Chat'
  };
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${(result && result.title) ? result.title : 'Copilot Chat'}</title>
  <style>
    html, body { margin: 0; padding: 0; }
    ${EXPORT_ROOT_SELECTOR} { width: 100%; max-width: 100%; } 
  </style>
</head>
<body>
    <div class="${EXPORT_ROOT_CLASS}">${(result && result.html) ? result.html : '<p>Chat pane not found.</p>'}</div> 
</body>
</html>`;
  await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
}

// B2) Clean HTML export: strip noisy classes/styles and add minimal readable CSS
async function savePaneAsCleanHTML(win, filePath) {
  const snapshot = await getChatPaneSnapshot(win);
  if (!snapshot?.ok) {
    try { dialog.showErrorBox('Save Chat Pane', 'Chat pane not found.'); } catch {}
    return;
  }
  const result = await win.webContents.executeJavaScript(`
  (function() {
    const root = document.createElement('div');
    root.innerHTML = ${JSON.stringify(String(snapshot.html || ''))};
    const clone = root.firstElementChild || root;
    clone.querySelectorAll('[class]').forEach(n => n.removeAttribute('class'));
    clone.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
    clone.querySelectorAll('*').forEach(n => {
      [...n.attributes].forEach(a => {
        const name = a.name.toLowerCase();
        if (name.startsWith('data-') || name.startsWith('aria-') || name === 'role' || name === 'tabindex') {
          n.removeAttribute(a.name);
        }
        if (name === 'id' && n !== clone) n.removeAttribute('id');
      });
    });
    clone.querySelectorAll('div').forEach(n => { if (!n.textContent.trim()) n.remove(); });
    return { ok:true, title: document.title, html: clone.innerHTML };
  })();
  `);
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${result.title || 'Copilot Chat'}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.5; color: #222; }
    h1,h2,h3,h4,h5 { margin: 0.6em 0 0.3em; }
    p { margin: 0.4em 0; }
    .message { margin-bottom: 12px; }
    .user { font-weight: 600; color: #333; }
    .copilot { color: #004b9a; }
    /* Generic content spacing */
    ul,ol { margin: 0.4em 0 0.4em 1.2em; }
    pre, code { font-family: Consolas, Menlo, monospace; }
    pre { background: #f5f7fa; border: 1px solid #e3e7ee; padding: 10px; border-radius: 6px; overflow: auto; }
    blockquote { border-left: 3px solid #cbd5e1; margin: 0.4em 0; padding: 0.2em 0.8em; color: #555; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #e5e7eb; padding: 6px 8px; }
    /* Make export wrapper stretch full width */ 
    ${EXPORT_ROOT_SELECTOR} { width: 100%; max-width: 100%; } 
  </style>
  <!-- NOTE: This cleaned export removes hashed classes/inline styles for readability. -->
</head>
<body>
  <div class="${EXPORT_ROOT_CLASS}">${result.html || '<p>No chat content found.</p>'}</div> 
</body>
</html>`;
  await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
}

// Unified chooser by extension
async function saveChatPaneByExtension(win, filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.pdf')) {
  // New: export chat/page view to PDF
  await saveChatPaneAsPDF(win, filePath);
 } else if (lower.endsWith('.html')) {
    // Use cleaned fragment (B2)
    await savePaneAsCleanHTML(win, filePath);
  } else if (lower.endsWith('.mhtml')) {
    // Use savePage with hide-CSS (A)
    await saveOnlyPaneWithSavePage(win, filePath, 'MHTML');
   } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
     // New: export whole chat pane to Markdown
     await saveChatPaneAsMarkdown(win, filePath);
  } else if (lower.endsWith('.txt')) {
    // New: export whole chat pane to Plain Text
    await saveChatPaneAsText(win, filePath);
  } else {
    // Default: cleaned fragment HTML
    await savePaneAsCleanHTML(win, filePath);
  }
}

// --- Shared helper: prompt to Save Chat Pane (HTML or MHTML) ---
async function promptSaveChatPane(win) {
  if (!win) return;
  try {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Chat Pane As',
      defaultPath: 'copilot-chat.md',  // Default to Markdown file name
      // Put Markdown first so it's the preselected filter
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'Web Page, HTML (clean)', extensions: ['html'] },
        { name: 'Web Archive (MHTML)', extensions: ['mhtml'] },
        { name: 'Plain Text', extensions: ['txt'] }
      ],
    });
    if (canceled || !filePath) return;
    await saveChatPaneByExtension(win, filePath);
    // Optionally remember for plain "Save"
    win.__lastSavePath = filePath;
  } catch (err) {
    console.error('Save Chat Pane failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

// --- New helper: save whole chat pane as Markdown ---
async function saveChatPaneAsMarkdown(win, filePath) {
  if (!win) return;
  try {
    const snapshot = await getBestChatRootCleaned(win);
    if (!snapshot?.ok) {
      safeShowError('Save Chat Pane as Markdown', 'Chat pane not found.');
      return;
    }

    // Convert cleaned semantic HTML  Markdown
    // (No entity decoding; structure already preserved)
    const paneHtml = String(snapshot.html ?? '');

    // IMPORTANT:
    // Copilot renders diff lines as separate block elements (div/span)
    // with NO newline text nodes. Inject newlines between blocks so
    // diffs and code retain line structure.
    const withLineBreaks = paneHtml.replace(/></g, '>\n<');
    const safeHtml = stripExecutableBlocks(withLineBreaks);
    const md = htmlToMarkdown(safeHtml);
    await fs.promises.writeFile(filePath, md, 'utf8');
  } catch (err) {
    console.error('Save Chat Pane as Markdown failed:', err);
    safeShowError('Save failed', String(err?.message ?? err));
  }
}

async function getBestChatRootCleaned(win) {
  const results = await executeInAllFrames(
    win,
    buildChatPaneDetectionScript({
      includeHtml: true,
      cleanupJunk: true
    })
  );
  const best = results
    .map(r => r.value)
    .filter(v => v?.ok)
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))[0];
  return best ?? { ok: false, html: '', textLength: 0, selector: null };
}

async function saveChatPaneAsText(win, filePath) {
  if (!win) return;
  try {
    const snapshot = await getChatPaneSnapshot(win);
    const result = {
      ok: !!snapshot?.ok,
      html: String(snapshot?.html || ''),
      title: win.webContents.getTitle?.() || 'Copilot Chat'
    };
    if (!result?.ok) {
      try { dialog.showErrorBox('Save Chat Pane as Text', 'Chat pane not found.'); } catch {}
      return;
    }
    // Convert pane HTML  Plain Text: decode  sanitize  strip tags  normalize
    const paneHtml = String(result.html || '');
    const safeHtml = stripExecutableBlocks(decodeEntities(paneHtml));
    let text = stripTags(safeHtml);
    // normalize whitespace: collapse >2 newlines, trim trailing spaces
    text = text
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    await fs.promises.writeFile(filePath, text, 'utf8');
  } catch (err) {
    console.error('Save Chat Pane as Text failed:', err);
    try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
  }
}

function escapeHtmlForExport(value) {
 return String(value ?? '')
 .replace(/&/g, '&amp;')
 .replace(/</g, '&lt;')
 .replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;')
 .replace(/'/g, '&#39;');
}

function buildPrintableChatPaneHtml({ title = 'Copilot Chat', html = '' } = {}) {
 return `<!DOCTYPE html>
<html lang="en">
<head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <title>${escapeHtmlForExport(title)}</title>
 <style>
 @page {
 margin: 0.5in;
 }

 html,
 body {
 margin: 0;
 padding: 0;
 background: #ffffff;
 color: #111827;
 font-family: Arial, sans-serif;
 font-size: 12pt;
 line-height: 1.45;
 }

 *,
 *::before,
 *::after {
 box-sizing: border-box;
 }

 .${EXPORT_ROOT_CLASS} {
 width: 100%;
 max-width: 100%;
 }

 h1,
 h2,
 h3,
 h4,
 h5,
 h6 {
 break-after: avoid;
 page-break-after: avoid;
 margin: 0.85em 0 0.35em;
 }

 p {
 margin: 0.45em 0;
 }

 a {
 color: #0645ad;
 overflow-wrap: anywhere;
 word-break: break-word;
 }

 pre,
 code,
 kbd,
 samp {
 font-family: Consolas, Menlo, Monaco, monospace;
 white-space: pre-wrap;
 overflow-wrap: anywhere;
 word-break: break-word;
 }

 pre {
 background: #f5f7fa;
 border: 1px solid #e3e7ee;
 border-radius: 6px;
 padding: 10px;
 max-width: 100%;
 overflow: visible;
 break-inside: auto;
 page-break-inside: auto;
 }

 blockquote {
 border-left: 3px solid #cbd5e1;
 margin: 0.5em 0;
 padding: 0.2em 0.8em;
 color: #374151;
 break-inside: avoid;
 page-break-inside: avoid;
 }

 table {
 width: 100%;
 max-width: 100%;
 border-collapse: collapse;
 table-layout: auto;
 break-inside: auto;
 page-break-inside: auto;
 }

 td,
 th {
 border: 1px solid #e5e7eb;
 padding: 6px 8px;
 vertical-align: top;
 overflow-wrap: anywhere;
 word-break: break-word;
 }

 img,
 svg,
 canvas,
 video {
 max-width: 100%;
 height: auto;
 }
 </style>
</head>
<body>
 <div class="${EXPORT_ROOT_CLASS}">${html || '<p>No chat content found.</p>'}</div>
</body>
</html>`;
}

async function saveChatPaneAsPDF(win, filePath) {
 if (!win) return;
 let printWindow = null;
 let tempHtmlPath = null;

 try {
 const snapshot = await getBestChatRootCleaned(win);
 if (!snapshot?.ok) {
 safeShowError('Save Chat Pane as PDF', 'Chat pane not found.');
 return;
 }

 const title = win.webContents.getTitle?.() || 'Copilot Chat';
 const htmlDoc = buildPrintableChatPaneHtml({
 title,
 html: String(snapshot.html ?? '')
 });

 const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
 tempHtmlPath = path.join(app.getPath('temp'), `copilot-chat-pane-print-${stamp}.html`);
 await fs.promises.writeFile(tempHtmlPath, htmlDoc, 'utf8');

 printWindow = new BrowserWindow({
 show: false,
 width: 1200,
 height: 1600,
 webPreferences: {
 nodeIntegration: false,
 contextIsolation: true,
 sandbox: true,
 backgroundThrottling: false
 }
 });

 await printWindow.loadFile(tempHtmlPath);

 const pdf = await printWindow.webContents.printToPDF({
 printBackground: true,
 marginsType: 1,
 pageSize: 'Letter',
 landscape: false,
 preferCSSPageSize: true
 });

 await fs.promises.writeFile(filePath, pdf);
 } catch (err) {
 console.error('Save Chat Pane as PDF failed:', err);
 safeShowError('Save failed', String(err?.message ?? err));
 } finally {
 if (printWindow && !printWindow.isDestroyed()) {
 try { printWindow.destroy(); } catch {}
 }
 if (tempHtmlPath) {
 try { await fs.promises.unlink(tempHtmlPath); } catch {}
 }
 }
}

// ---------- File menu (Save / Save As) ----------
function appendFileItems(fileSubmenu, win) {
  ensureSaveState(win);
  const items = [
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Save Chat Pane',
      accelerator: 'Ctrl+S',
      click: async () => {
        try { await promptSaveChatPane(win); }
        catch (err) {
          console.error('File  Save Chat Pane failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      label: 'Save Selection as Markdown',
      accelerator: 'Ctrl+Shift+M',
      click: async () => {
        try { await saveSelectionAsMarkdown(win); }
        catch (err) {
          console.error('File  Save Selection as Markdown failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),

//    new MenuItem({ type: 'separator' }),
    // Use role for native Quit (macOS label/shortcut handled automatically)
//    new MenuItem({ role: 'quit' }),
  ];
  items.forEach(i => fileSubmenu.append(i));
}

async function saveAsDialog(win) {
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: 'Save Page As',
    defaultPath: 'copilot.html',
    filters: [
      { name: 'Web Page, HTML only', extensions: ['html'] },
      { name: 'Web Archive (MHTML)', extensions: ['mhtml'] },
    ],
  });

  if (canceled || !filePath) return;

  const format = filePath.toLowerCase().endsWith('.mhtml') ? 'MHTML' : 'HTMLOnly';
  await win.webContents.savePage(filePath, format);

  // Remember for plain "Save"
  win.__lastSavePath = filePath;
}
// ---------- end File menu ----------

function createWindow() {
  // Clean up any existing window first
  if (mainWindow) return; // do not destroy/recreate unless needed

 const taIcon = nativeImage.createFromPath(getIconPath('copilot-for-linux.png'));
 /*     console.log('Native path resolved:', taIcon); // Echo to terminal
 if (taIcon.isEmpty()) {
  console.error('ICON FAILED TO LOAD path is wrong or file corrupted');
 } else {
  console.log('ICON LOADED SUCCESSFULLY');
  console.log('Size:', taIcon.getSize());           //    { width: 512, height: 512 }
  console.log('Has alpha channel:', taIcon.hasAlpha?.() ?? true);
 }
*/
  // Cache app icon & tray sizes once
  if (!appIconImage || appIconImage.isEmpty()) {
    appIconImage = taIcon;
  }
  if (!trayImage24 || trayImage24.isEmpty?.()) {
    try { trayImage24 = taIcon.resize({ width: 24, height: 24 }); } catch {}
  }

  // Compute initial bounds from persisted state (if any)
  const boundsKey = 'main';
  // Compute initial bounds from persisted state (if any)
  const initialBounds = getInitialWindowBounds(boundsKey);
  // Assign to the outer-scoped variable (do NOT redeclare with const here)
  mainWindow = new BrowserWindow({
  skipTaskbar: false,
  title: 'Copilot Main Chat',
    width: initialBounds.width,
    height: initialBounds.height,
    x: typeof initialBounds.x === 'number' ? initialBounds.x : undefined,
    y: typeof initialBounds.y === 'number' ? initialBounds.y : undefined,
    show: false, // start hidden; control via tray
//    icon: path.join(__dirname, 'assets', 'copilot-for-linux.png'), // used for window/taskbar on Linux
    icon: appIconImage || taIcon, // cached if available
    webPreferences: {
      nodeIntegration: false,      // renderer cannot use Node APIs
      contextIsolation: true,      // safer: isolates preload from page
      preload: path.join(__dirname, 'preload.js'), // optional: expose safe APIs
      partition: COPILOT_PARTITION,
      devTools: true,
      backgroundThrottling: true,   // reduce CPU when hidden
      spellcheck: false            // disable if not required
    },
    // Linux-specific: ensure proper window identification
    type: 'normal',
    // Help with focus stealing prevention
    autoHideMenuBar: false

  });

  // Ensure menu bar is visible so users can access Edit    Find
  mainWindow.setMenuBarVisibility(true);

  // --- Right-click native context menu with Cut/Copy/Paste/SelectAll ---
  const baseContextMenu = Menu.buildFromTemplate([
    { role: 'cut',        accelerator: 'Ctrl+X', enabled: false },
    { role: 'copy',       accelerator: 'Ctrl+C', enabled: false },
    { role: 'paste',      accelerator: 'Ctrl+V', enabled: false },
    { type: 'separator' },
    { role: 'selectAll',  accelerator: 'Ctrl+A', enabled: true  },
  ]);

  function popupContext(win, params) {
    const menu = Menu.buildFromTemplate(
      buildContextMenuTemplate(win, {
        ...params,
        selectionText: params?.selectionText ?? (params?.hasSelection ? 'x' : '')
      }, {
        includeQuickChatFeatures: false,
        includeChatPaneFeatures: false,
        includeMarkdownExport: false
      })
    );
    menu.popup({ window: win });
  }

  // Guard against duplicate registrations
  if (!ipcMain.listenerCount('show-context-menu')) {
    ipcMain.on('show-context-menu', (event, params) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    popupContext(win, params);
    });
  }   
  // --- end context menu ---

  mainWindow.setIcon(appIconImage || taIcon);

  // If you initially create hidden:
  mainWindow.once('ready-to-show', () => {
  reveal(mainWindow);
  try { mainWindow.__copilotRole = 'main'; } catch {}
  try { mainWindow.__boundsKey = boundsKey; } catch {}
  setRoleTitle(mainWindow, 'main');
  augmentApplicationMenu(mainWindow);  // Augment the existing app menu with our File/Edit items
  });
  // Safety in case it was toggled elsewhere:
  mainWindow.setSkipTaskbar(false);

  // Attach 'did-stop-loading' exactly once for this webContents.
  ensureDidStopLoadingHandler(mainWindow.webContents);

  // Electron internally attaches temporary did-stop-loading listeners
  // during executeJavaScript(); this is expected for SPA apps.
  mainWindow.webContents.setMaxListeners(0);
  // OPTIONAL: uncomment this to trace *where* extra listeners are being added:
  // const _origOn = mainWindow.webContents.on.bind(mainWindow.webContents);
  // mainWindow.webContents.on = (evt, fn) => { if (evt === 'did-stop-loading') console.trace('[TRACE] did-stop-loading on()'); return _origOn(evt, fn); };

  mainWindow.loadURL(COPILOT_URL); // Load your app

  attachCSSAndLayoutHandlers(mainWindow, { role: 'main', revealOnReady: false });
  attachFindResultForwarding(mainWindow);

  // Keep the 'did-stop-loading' handler singular when SPA navigations occur.
  mainWindow.webContents.on('did-start-navigation', () => {
  //   try { attachVWResize(mainWindow); } catch {}
  });
  mainWindow.webContents.on('destroyed', () => {
    try { mainWindow?.webContents?.removeListener('did-stop-loading', onDidStopLoading);
      if (mainWindow?.webContents) {
        delete mainWindow.webContents.__hasDidStopLoadingHandler;
      }
    } catch {}
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    try { 
      menu = Menu.buildFromTemplate(
        buildContextMenuTemplate(mainWindow, params, {
          includeQuickChatFeatures: true,
          includeChatPaneFeatures: true,
          includeMarkdownExport: true
        })
      );
    }
    catch (err) {
      console.error('Context menu template error:', err);
      const hasSelection = !!params?.selectionText && params.selectionText.length > 0;
      menu = Menu.buildFromTemplate([{ role: 'copy', enabled: hasSelection }, { role: 'selectAll' }]);
    }
    try { menu.popup({ window: mainWindow }); }
    catch (err) { console.error('Context menu popup failed:', err); }
  });

  // Control external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => (
    shell.openExternal(url), // open in default browser
    { action: 'deny' }       // block new Electron window
  ));

  // Handle Find modal events (parent-aware)
  if (!ipcMain.listenerCount('find-modal-submit')) {
    ipcMain.on('find-modal-submit', (event, payload) => {
    const wc = getWCFromEventSender(event.sender); if (!wc) return;
    const term = String(payload?.term || '').trim();
    const matchCase = !!payload?.matchCase;
    if (!term) return;
    const isNewTerm = term !== lastFindTerm;
    lastFindTerm = term;

    sendFindModalResults({
        kind: 'searching',
        term,
        finalUpdate: false
    });

    // Clear old highlights when starting a new term
    if (isNewTerm) {
      wc.stopFindInPage('clearSelection');
    }

    lastFindOpts = applyWordStartOptions({
      ...lastFindOpts,
      matchCase,
      // IMPORTANT: seed new search with findNext: false, continue with true
      findNext: isNewTerm ? false : true,
      forward: (payload?.kind !== 'prev')
    });
    clearTimeout(findDebounce);
    findDebounce = setTimeout(() => {
      try {
        wc.findInPage(lastFindTerm, lastFindOpts);
      } catch (_) {
        // ignore
      }
    }, FIND_DEBOUNCE_MS);
    });
  }

  ipcMain.on('find-modal-clear', (event) => {
    const wc = getWCFromEventSender(event.sender); if (!wc) return;
    wc.stopFindInPage('clearSelection');
    resetFindModalResults('clear');
  });

  ipcMain.on('find-modal-close', () => {
    resetFindModalResults('close');
    disableFindContentVisibility();
    if (findModal && !findModal.isDestroyed()) { findModal.close(); }
    findModal = null;
  });

  // Quick keyboard passthrough for Esc to clear highlights even without menu activation
  
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.alt) {
      if (input.key === '=' || input.key === '+') {
        event.preventDefault();
        try { mainWindow.webContents.executeJavaScript('(function(){const cur=window.__copilot_getTargetVW?.() ?? ${VW_SIZE}; window.__copilot_setTargetVW?.(cur+5);})()'); } catch {}
      }
      if (input.key === '-') {
        event.preventDefault();
        try { mainWindow.webContents.executeJavaScript('(function(){const cur=window.__copilot_getTargetVW?.() ?? ${VW_SIZE}; window.__copilot_setTargetVW?.(cur-5);})()'); } catch {}
      }
    }
    if (input.type === 'keyDown' && input.key === 'Escape') {
      const wc = mainWindow.webContents;
      if (wc) wc.stopFindInPage('clearSelection');
      resetFindModalResults('escape');
    }
  });
  attachWindowStatePersistence(mainWindow, boundsKey, { hideOnClose: true });
  // Defensive: recreate window if it gets destroyed unexpectedly
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function getIconPath(filename) {
  // Handle both development and packaged environments
//  const basePath = __dirname;
  const basePath = app.getAppPath(); 
  const iconPath = path.join(basePath, 'assets', filename);
  
  // For packaged apps, try the asar-unpacked path first
  if (app.isPackaged) {
    const asarPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', filename);
    if (require('fs').existsSync(asarPath)) {

//      console.log('Icon path resolved:', asarPath); // Echo to terminal

      return asarPath;
    }
  }

//      console.log('Icon path resolved:', iconPath); // Echo to terminal  
  return iconPath;
}

function createTray() {
  // Use a 24x24 or 32x32 PNG for Cinnamon panel
  const iconPath = getIconPath('copilot-for-linux.png');

  // Validate path during development (optional)
 //  console.log('Tray icon exists?', require('fs').existsSync(iconPath));

  const trayImage = trayImage24 || nativeImage.createFromPath(iconPath);
  const smallImage = trayImage.isEmpty ? null : trayImage.resize({ width: 24, height: 24 });

  // Fall back to app icon if tray image is missing
  tray = new Tray(smallImage || appIconImage || nativeImage.createFromPath(path.join(__dirname, 'assets', 'copilot-for-linux.png')));

  tray.setToolTip('Microsoft Copilot');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => { if (mainWindow) reveal(mainWindow); }
    },
    {
      label: 'Hide',
      click: () => { if (mainWindow) mainWindow.hide(); }
    },
    { type: 'separator' },

    // ---- NEW: About item ----
    {
      label: 'About',
      click: async () => {
        const info = getRuntimeInfo();
        try {
          await dialog.showMessageBox({
            type: 'info',
            buttons: ['OK'],
            defaultId: 0,
            title: `About ${info.name}`,
            message: `${info.name}`,
            detail: info.detail,
            noLink: true,
            icon: appIconImage
          });
        } catch (err) {
          console.error('About dialog failed:', err);
        }
      }
    },

    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true; // so close handler doesn't re-hide
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Left-click toggles window visibility
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      reveal(mainWindow);
    }
  });
}

app.whenReady().then(() => {
  registerDirectOpenDownloadHandler();
  createWindow();
  createTray();
//  createAppMenu();

  // macOS re-activation guard (harmless on Linux)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) { mainWindow.show(); mainWindow.focus(); }

  });
});

// Keep the app running in the tray when all windows are closed
app.on('window-all-closed', () => {
  // Do not quit on Linux; keep tray resident
  // If you want to quit on non-Linux:
  // if (process.platform !== 'linux') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  try {
    pruneExpiredDirectOpenRequests();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(`(function(){
        try {
          if (window.__copilot_layoutObserver) {
            window.__copilot_layoutObserver.disconnect();
            window.__copilot_layoutObserver = null;
          }
        } catch {}
      })();`).catch(() => {});
    }
  
  // Best-effort: close quick windows on quit
  try {
    for (const w of quickChatWindows) {
      try { if (w && !w.isDestroyed()) w.destroy(); } catch {}
    }
  } catch {}
   try {
    for (const p of tempOpenedFiles) {
      try { fs.unlinkSync(p); } catch {}
    }
    tempOpenedFiles.clear();
   } catch {}
} catch {}
});


