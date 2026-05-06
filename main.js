// main.js
const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { createExporters, EXPORT_SCOPES } = require('./lib/exporters');

// === Extracted DOM + layout helpers (Tier 3 refactor) ===
const {
  CHAT_ROOT_SELECTORS, CHAT_MESSAGE_LIST_SELECTORS,
  CHAT_SCOPE_SELECTOR, CHAT_SCOPE_PSEUDO,
  CHAT_MESSAGE_LIST_SELECTOR, CHAT_MESSAGE_LIST_PSEUDO,
  EXPORT_ROOT_CLASS, EXPORT_ROOT_SELECTOR,
  CODE_PREVIEW_IFRAME_SELECTOR, DOM_CLEANUP_SELECTORS,
  cleanupDOMFragmentScript, buildChatPaneDetectionScript,
} = require('./lib/chat-dom');

const {
  SELECTORS, IGNORE_SELECTORS, IGNORE_JOINED,
  messageContentById, MAX_CHARS, VW_SIZE, MIN_VW, MAX_VW,
  applyDynamicWidth, attachVWResize, buildMaxLayoutCSS,
  maxLayoutCssCache, injectedFrameIdsByWC, insertedMainCssKeyByWC, cssApplyDebounceByWC,
  injectCSSOnLoad, injectCSSIntoAllFrames, applyMaxLayoutCSS, requestExpandedLayout,
  buildFindContentVisibilityCSS, enableFindContentVisibility, disableFindContentVisibility,
} = require('./lib/layout-css');


// ============================================================================
// User preferences/config under app.getPath('userData')
// ============================================================================
const DEFAULT_APP_CONFIG = Object.freeze({
  copilotUrl: 'https://m365.cloud.microsoft/chat',
  partition: 'persist:copilot-for-linux',
  enableLayoutCss: true,
  enableDirectOpen: true,
  enableQuickChat: true,
  defaultExportFormat: 'md',
  defaultPaneExportProfile: 'cleanMarkdown',
  defaultSelectionExportProfile: 'cleanMarkdown',
  quickPasteDelayMs: 3000,
  findContentVisibilityOverride: true,
  devToolsEnabled: true,
  enableConsoleLogging: true,
  enableFileLogging: true,
  logFileName: 'copilot-for-linux.log'
});

let APP_CONFIG = { ...DEFAULT_APP_CONFIG };
let COPILOT_PARTITION = DEFAULT_APP_CONFIG.partition;
let COPILOT_URL = DEFAULT_APP_CONFIG.copilotUrl;
const ORIGINAL_CONSOLE = Object.freeze({
  log: console.log.bind(console),
                                       info: console.info.bind(console),
                                       debug: console.debug.bind(console),
                                       warn: console.warn.bind(console),
                                       error: console.error.bind(console),
});
let consoleLoggingEnabled = true;
let fileLoggingEnabled = false;
let activeLogFilePath = null;
let isWritingLogFile = false;

function sanitizeLogFileName(name) {
  const raw = String(name || DEFAULT_APP_CONFIG.logFileName).trim() || DEFAULT_APP_CONFIG.logFileName;
  const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || DEFAULT_APP_CONFIG.logFileName;
}

function getLogFilePath() {
  return path.join(getLogsFolderPath(), sanitizeLogFileName(APP_CONFIG.logFileName));
}

function formatConsoleArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || value.message || String(value);
  return util.inspect(value, {
    depth: 6,
    colors: false,
    breakLength: 140,
    maxArrayLength: 100,
    maxStringLength: 10000
  });
}

function appendConsoleLogToFile(level, args) {
  if (!fileLoggingEnabled || isWritingLogFile) return;
  isWritingLogFile = true;
  try {
    const filePath = activeLogFilePath || getLogFilePath();
    const line = `[${new Date().toISOString()}] [${String(level).toUpperCase()}] ${args.map(formatConsoleArg).join(' ')}\n`;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (err) {
    try { ORIGINAL_CONSOLE.error('File logging failed:', err); } catch {}
  } finally {
    isWritingLogFile = false;
  }
}

function makeConsoleMethod(level) {
  return (...args) => {
    if (consoleLoggingEnabled) {
      try { ORIGINAL_CONSOLE[level](...args); } catch {}
    }
    appendConsoleLogToFile(level, args);
  };
}

function applyConsoleLoggingConfig() {
  consoleLoggingEnabled = normalizeBooleanConfig(APP_CONFIG.enableConsoleLogging, DEFAULT_APP_CONFIG.enableConsoleLogging);
  fileLoggingEnabled = normalizeBooleanConfig(APP_CONFIG.enableFileLogging, DEFAULT_APP_CONFIG.enableFileLogging);
  activeLogFilePath = fileLoggingEnabled ? getLogFilePath() : null;

  console.log = makeConsoleMethod('log');
  console.info = makeConsoleMethod('info');
  console.debug = makeConsoleMethod('debug');
  console.warn = makeConsoleMethod('warn');
  console.error = makeConsoleMethod('error');
}

function getConfigFilePath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function normalizeBooleanConfig(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(lowered)) return true;
    if (['false', '0', 'no', 'off'].includes(lowered)) return false;
  }
  return fallback;
}

function normalizePositiveIntegerConfig(value, fallback) {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.round(n);
  return fallback;
}

function normalizeExportFormat(value, fallback) {
  const fmt = String(value ?? fallback).trim().toLowerCase().replace(/^\./, '');
  return ['md', 'markdown', 'pdf', 'html', 'mhtml', 'txt'].includes(fmt) ? fmt : fallback;
}

function normalizeExportProfile(value, fallback) {
  const profile = String(value ?? fallback).trim();
  return ['cleanMarkdown', 'rawMarkdown', 'markdownWithMetadata', 'html', 'htmlArchive', 'plainText', 'pdf'].includes(profile)
    ? profile
    : fallback;
}

function normalizeAppConfig(raw = {}) {
  const source = (raw && typeof raw === 'object') ? raw : {};
  const merged = { ...DEFAULT_APP_CONFIG, ...source };

  merged.copilotUrl = String(merged.copilotUrl || DEFAULT_APP_CONFIG.copilotUrl).trim();
  merged.partition = String(process.env.COPILOT_PARTITION ?? merged.partition ?? DEFAULT_APP_CONFIG.partition).trim();
  merged.enableLayoutCss = normalizeBooleanConfig(merged.enableLayoutCss, DEFAULT_APP_CONFIG.enableLayoutCss);
  merged.enableDirectOpen = normalizeBooleanConfig(merged.enableDirectOpen, DEFAULT_APP_CONFIG.enableDirectOpen);
  merged.enableQuickChat = normalizeBooleanConfig(merged.enableQuickChat, DEFAULT_APP_CONFIG.enableQuickChat);
  merged.defaultExportFormat = normalizeExportFormat(merged.defaultExportFormat, DEFAULT_APP_CONFIG.defaultExportFormat);
  merged.defaultPaneExportProfile = normalizeExportProfile(merged.defaultPaneExportProfile, DEFAULT_APP_CONFIG.defaultPaneExportProfile);
  merged.defaultSelectionExportProfile = normalizeExportProfile(merged.defaultSelectionExportProfile, DEFAULT_APP_CONFIG.defaultSelectionExportProfile);
  merged.quickPasteDelayMs = normalizePositiveIntegerConfig(merged.quickPasteDelayMs, DEFAULT_APP_CONFIG.quickPasteDelayMs);
  merged.findContentVisibilityOverride = normalizeBooleanConfig(merged.findContentVisibilityOverride, DEFAULT_APP_CONFIG.findContentVisibilityOverride);
  merged.devToolsEnabled = normalizeBooleanConfig(merged.devToolsEnabled, DEFAULT_APP_CONFIG.devToolsEnabled);
  merged.enableConsoleLogging = normalizeBooleanConfig(merged.enableConsoleLogging, DEFAULT_APP_CONFIG.enableConsoleLogging);
  merged.enableFileLogging = normalizeBooleanConfig(merged.enableFileLogging, DEFAULT_APP_CONFIG.enableFileLogging);
  merged.logFileName = sanitizeLogFileName(merged.logFileName || DEFAULT_APP_CONFIG.logFileName);

  if (!merged.copilotUrl) merged.copilotUrl = DEFAULT_APP_CONFIG.copilotUrl;
  if (!merged.partition) merged.partition = DEFAULT_APP_CONFIG.partition;

  return merged;
}

function writeConfigFile(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function loadAppConfig() {
  const configPath = getConfigFilePath();
  let parsed = null;

  try {
    if (fs.existsSync(configPath)) {
      parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to read config.json; using defaults:', err);
  }

  APP_CONFIG = normalizeAppConfig(parsed ?? DEFAULT_APP_CONFIG);
  COPILOT_PARTITION = APP_CONFIG.partition;
  COPILOT_URL = APP_CONFIG.copilotUrl;
  QUICK_PASTE_DELAY_MS = APP_CONFIG.quickPasteDelayMs;
  applyConsoleLoggingConfig();

  try {
    // Keep the file self-documenting and add any newly introduced defaults.
    writeConfigFile(configPath, APP_CONFIG);
  } catch (err) {
    console.error('Failed to write config.json:', err);
  }

  return APP_CONFIG;
}

function getAppConfig() {
  return APP_CONFIG;
}

async function ensureConfigFile() {
  loadAppConfig();
  return getConfigFilePath();
}

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
let QUICK_PASTE_DELAY_MS = DEFAULT_APP_CONFIG.quickPasteDelayMs; // NOTE: This is now a fallback timeout only. Primary path waits for input readiness.
const QUICK_PASTE_POST_KEY_DELAY_MS = 40; // tiny gap between paste and optional Enter


// --- Quick Chat / IPC constants --------------------------------------------
// COPILOT_URL is loaded from config.json under userData.

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
  if (!APP_CONFIG.enableDirectOpen) return;
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
  refreshTrayMenu();
}

function onQuickFocus(win) {
  try { activeQuickChatId = win.__quickId || null;
  } catch {}
  refreshQuickChatMenu();
  refreshTrayMenu();
}

function onQuickClosed(win) {
  quickChatWindows = quickChatWindows.filter(w => w && w !== win && !w.isDestroyed());
  if (activeQuickChatId && win && win.__quickId === activeQuickChatId) {
    activeQuickChatId = quickChatWindows.at(-1)?.__quickId || null;
  }
  refreshQuickChatMenu();
  refreshTrayMenu();
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
    title: `Copilot Quick Chat ${id}`,
    icon: appIconImage,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
                                partition: COPILOT_PARTITION,
                                devTools: !!APP_CONFIG.devToolsEnabled,
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
  // --- end context menu ---

  win.webContents.setWindowOpenHandler(({ url }) => (
    shell.openExternal(url),
                                                     { action: 'deny' }
  ));

  return win;
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
  if (!APP_CONFIG.enableLayoutCss) {
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
        label: 'Save Selection As',
        enabled: hasSelection,
        submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(win, EXPORT_SCOPES.SELECTION))
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

// ============================================================================
// Tray maintenance helpers
// ============================================================================
function getLogsFolderPath() {
  try {
    const logsPath = app.getPath('logs');
    fs.mkdirSync(logsPath, { recursive: true });
    return logsPath;
  } catch {
    const fallback = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}


async function openPathWithError(title, targetPath) {
  try {
    const openError = await shell.openPath(targetPath);
    if (openError) safeShowError(title, String(openError));
  } catch (err) {
    console.error(`${title} failed:`, err);
    safeShowError(title, String(err?.message ?? err));
  }
}

async function openLogsFolder() {
  await openPathWithError('Open Logs Folder failed', getLogsFolderPath());
}

async function openConfigFile() {
  const configPath = await ensureConfigFile();
  await openPathWithError('Open Config File failed', configPath);
}

function toggleActiveWindowAlwaysOnTop() {
  try {
    const win = getActiveCopilotWindow();
    if (!win || win.isDestroyed?.()) return;
    win.setAlwaysOnTop(!win.isAlwaysOnTop());
    refreshQuickChatMenu();
    refreshTrayMenu();
  } catch (err) {
    console.error('Toggle Always on Top failed:', err);
    safeShowError('Toggle Always on Top failed', String(err?.message ?? err));
  }
}

function showAboutDialog() {
  try {
    const info = getRuntimeInfo();
    dialog.showMessageBox({
      type: 'info',
      buttons: ['OK'],
      defaultId: 0,
        title: `About ${info.name}`,
        message: `${info.name}`,
        detail: info.detail,
        noLink: true,
        icon: appIconImage
    }).catch(err => {
      console.error('About dialog failed:', err);
    });
  } catch (err) {
    console.error('About dialog failed:', err);
  }
}

function showApplicationHelp() {
  let helpWin;

  try {
    const helpPath = path.join(app.getAppPath(), 'assets', 'help.md');
    const markdown = fs.readFileSync(helpPath, 'utf8');

    // Reuse your Turndown / Markdown-friendly styling philosophy:
    const html = `<!DOCTYPE html>
    <html>
    <head>
    <meta charset="UTF-8" />
    <title>Copilot for Linux — Help</title>
    <style>
    body {
      font-family: system-ui, Segoe UI, Arial, sans-serif;
      margin: 18px;
      line-height: 1.5;
      color: #222;
      background: #fff;
    }
    h1, h2, h3 { margin-top: 1.2em; }
    table {
      border-collapse: collapse;
      margin: 0.8em 0;
      width: 100%;
    }
    th, td {
      border: 1px solid #ddd;
      padding: 6px 8px;
      vertical-align: top;
    }
    code, pre {
      font-family: Consolas, Menlo, monospace;
      background: #f5f7fa;
    }
    pre {
      padding: 10px;
      overflow: auto;
      border-radius: 6px;
    }
    </style>
    </head>
    <body>
    <pre id="md" style="white-space: pre-wrap;"></pre>

    <script>
    // Render markdown as-is (readable, fast, no dependency),
    // OR swap this for marked.js later if you want full HTML rendering.
    document.getElementById('md').textContent = ${JSON.stringify(markdown)};
    </script>
    </body>
    </html>`;

    helpWin = new BrowserWindow({
      width: 900,
      height: 700,
      title: 'Copilot for Linux — Help',
      resizable: true,
      minimizable: true,
      maximizable: true,
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    helpWin.loadURL(
      'data:text/html;charset=UTF-8,' + encodeURIComponent(html)
    );

    helpWin.once('ready-to-show', () => {
      helpWin.show();
      helpWin.focus();
    });

  } catch (err) {
    console.error('Failed to open Help window:', err);
    dialog.showErrorBox(
      'Help Error',
      String(err?.message ?? err)
    );
  }
}

function buildTrayMenuTemplate() {
  const activeWindow = getActiveCopilotWindow();
  const activeQuick = APP_CONFIG.enableQuickChat ? getActiveQuickChatWindow({ createIfMissing: false }) : null;
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
        const win = getActiveCopilotWindow();
        if (win) await promptSaveChatPane(win);
      }
    },
    { type: 'separator' },
    {
      label: 'Reload',
      accelerator: 'Ctrl+R',
      click: () => reloadCopilot({ ignoreCache: false })
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
          label: 'Clear Copilot Cache',
          click: async () => {
            await clearCopilotCache();
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
        isQuitting = true;
        app.quit();
      }
    }
  ];
}

function refreshTrayMenu() {
  try {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()));
  } catch (err) {
    console.error('refreshTrayMenu failed:', err);
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
  if (APP_CONFIG.findContentVisibilityOverride) enableFindContentVisibility(parent);
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
      label: 'Application Help',
      accelerator: 'F1',
      click: () => {
        showApplicationHelp();
      }
    }),
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'About',
      accelerator: 'Shift+F1',
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
  if (APP_CONFIG.enableQuickChat) installQuickChatMenu(appMenu);
  else Menu.setApplicationMenu(appMenu);
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


// ---------- Exporter module bridge ----------
let exportersInstance = null;
function initExporters() {
  if (exportersInstance) return exportersInstance;
  exportersInstance = createExporters({
    app,
    BrowserWindow,
    dialog,
    safeShowError,
    executeInAllFrames,
    buildChatPaneDetectionScript,
    cleanupDOMFragmentScript,
    CHAT_SCOPE_PSEUDO,
    EXPORT_ROOT_CLASS,
    EXPORT_ROOT_SELECTOR,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    normalizeExportFormat,
  });
  return exportersInstance;
}

function htmlToMarkdown(...args) { return initExporters().htmlToMarkdown(...args); }
function stripTags(...args) { return initExporters().stripTags(...args); }
function decodeEntities(...args) { return initExporters().decodeEntities(...args); }
function stripExecutableBlocks(...args) { return initExporters().stripExecutableBlocks(...args); }
async function getSelectionFragment(...args) { return initExporters().getSelectionFragment(...args); }
async function getSelectionFragmentRaw(...args) { return initExporters().getSelectionFragmentRaw(...args); }
async function saveSelectionAsMarkdown(...args) { return initExporters().saveSelectionAsMarkdown(...args); }
async function saveSelectionAsCleanMarkdown(...args) { return initExporters().saveSelectionAsCleanMarkdown(...args); }
async function saveSelectionAsRawMarkdown(...args) { return initExporters().saveSelectionAsRawMarkdown(...args); }
async function saveSelectionAsMarkdownWithMetadata(...args) { return initExporters().saveSelectionAsMarkdownWithMetadata(...args); }
async function saveSelectionAsHTML(...args) { return initExporters().saveSelectionAsHTML(...args); }
async function saveSelectionAsText(...args) { return initExporters().saveSelectionAsText(...args); }
async function saveSelectionAsPDF(...args) { return initExporters().saveSelectionAsPDF(...args); }
async function saveChatPaneByExtension(...args) { return initExporters().saveChatPaneByExtension(...args); }
async function saveChatPaneByProfile(...args) { return initExporters().saveChatPaneByProfile(...args); }
async function saveSelectionByProfile(...args) { return initExporters().saveSelectionByProfile(...args); }
async function promptExportWithProfile(...args) { return initExporters().promptExportWithProfile(...args); }
function buildExportProfileMenuTemplate(...args) { return initExporters().buildExportProfileMenuTemplate(...args); }
async function promptSaveChatPane(...args) { return initExporters().promptSaveChatPane(...args); }
async function saveChatPaneAsMarkdown(...args) { return initExporters().saveChatPaneAsMarkdown(...args); }
async function saveChatPaneAsRawMarkdown(...args) { return initExporters().saveChatPaneAsRawMarkdown(...args); }
async function saveChatPaneAsMarkdownWithMetadata(...args) { return initExporters().saveChatPaneAsMarkdownWithMetadata(...args); }
async function getBestChatRootCleaned(...args) { return initExporters().getBestChatRootCleaned(...args); }
async function saveChatPaneAsText(...args) { return initExporters().saveChatPaneAsText(...args); }
function escapeHtmlForExport(...args) { return initExporters().escapeHtmlForExport(...args); }
function buildPrintableChatPaneHtml(...args) { return initExporters().buildPrintableChatPaneHtml(...args); }
async function writeHtmlDocumentToPDF(...args) { return initExporters().writeHtmlDocumentToPDF(...args); }
async function saveChatPaneAsPDF(...args) { return initExporters().saveChatPaneAsPDF(...args); }
async function saveAsDialog(...args) { return initExporters().saveAsDialog(...args); }

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
  if (!APP_CONFIG.enableQuickChat) return;
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
  if (!APP_CONFIG.enableDirectOpen) return;
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
  if (!APP_CONFIG.enableQuickChat) return;
  try { reveal(createQuickChatWindow()); }
  catch (e) { console.error('IPC quick new failed:', e); }
});



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
      label: 'Export Chat Pane',
      submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(win, EXPORT_SCOPES.PANE))
    }),
    new MenuItem({
      label: 'Export Selection',
      submenu: Menu.buildFromTemplate(buildExportProfileMenuTemplate(win, EXPORT_SCOPES.SELECTION))
    }),
    new MenuItem({ type: 'separator' }),
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

// ---------- end File menu ----------

function createWindow() {
  // Clean up any existing window first
  if (mainWindow) return; // do not destroy/recreate unless needed

  const taIcon = nativeImage.createFromPath(getIconPath('copilot-for-linux.png'));
  /*     console.log('Native path resolved:', taIcon); // Echo to terminal
   * if (taIcon.isEmpty()) {
   *  console.error('ICON FAILED TO LOAD path is wrong or file corrupted');
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
                                 devTools: !!APP_CONFIG.devToolsEnabled,
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
          includeQuickChatFeatures: APP_CONFIG.enableQuickChat,
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
  refreshTrayMenu();
  // Left-click toggles window visibility
  tray.on('click', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      reveal(mainWindow);
    }
    refreshTrayMenu();
  });
}

app.whenReady().then(() => {
  loadAppConfig();
  if (APP_CONFIG.enableDirectOpen) registerDirectOpenDownloadHandler();
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

