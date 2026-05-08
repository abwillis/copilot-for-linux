// main.js
const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const util = require('util');
const { createExporters, EXPORT_SCOPES } = require('./lib/exporters');
const { createQuickChatManager } = require('./lib/quick-chat');
const { createFindInPage } = require('./lib/find-in-page');
const { createDirectOpen } = require('./lib/direct-open');
const { createWindowState } = require('./lib/window-state');
const { createSessionHelpers } = require('./lib/session-helpers');
const { createContextMenu } = require('./lib/context-menu');
const { createAppMenu } = require('./lib/app-menu');

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
let tray = null;
let isQuitting = false;
let lastSavePath = null;  // (legacy) Remember where "Save" last wrote to (per session/window)
let appIconImage = null;  // Cached icon images
let trayImage24 = null;  // Cached icon images

// --- Clipboard-based Quick Chat paste timing ---------------------------------
// Requirement: copy selection -> open/focus Quick Chat -> wait 3s -> paste.


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

// Unified reveal helper to avoid repeated show/focus chains
function reveal(win) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  try { win.moveTop(); } catch {}
}

// ---------- Quick Chat module bridge ----------
let quickChatManager = null;
function initQuickChat() {
  if (quickChatManager) return quickChatManager;
  quickChatManager = createQuickChatManager({
    app,
    BrowserWindow,
    Menu,
    MenuItem,
    ipcMain,
    dialog,
    shell,
    clipboard,
    path,
    dirname: __dirname,
    getMainWindow: () => mainWindow,
    getAppIconImage: () => appIconImage,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    getCopilotUrl: () => COPILOT_URL,
    getCopilotPartition: () => COPILOT_PARTITION,
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
  });
  quickChatManager.registerIpcHandlers();
  return quickChatManager;
}

function normalizeSendOptions(...args) { return initQuickChat().normalizeSendOptions(...args); }
function quoteify(...args) { return initQuickChat().quoteify(...args); }
function getQuickDisplayName(...args) { return initQuickChat().getQuickDisplayName(...args); }
function updateQuickWindowTitle(...args) { return initQuickChat().updateQuickWindowTitle(...args); }
function setRoleTitle(...args) { return initQuickChat().setRoleTitle(...args); }
function closeQuickChatWindow(...args) { return initQuickChat().closeQuickChatWindow(...args); }
function closeAllQuickChatWindows(...args) { return initQuickChat().closeAllQuickChatWindows(...args); }
function getQuickById(...args) { return initQuickChat().getQuickById(...args); }
function listQuickIds(...args) { return initQuickChat().listQuickIds(...args); }
function getActiveQuickChatWindow(...args) { return initQuickChat().getActiveQuickChatWindow(...args); }
function getTargetQuickWindow(...args) { return initQuickChat().getTargetQuickWindow(...args); }
function buildQuickChatManagerMenuTemplate(...args) { return initQuickChat().buildQuickChatManagerMenuTemplate(...args); }
function installQuickChatMenu(...args) { return initQuickChat().installQuickChatMenu(...args); }
function refreshQuickChatMenu(...args) { return initQuickChat().refreshQuickChatMenu(...args); }
function scheduleQuickPaste(...args) { return initQuickChat().scheduleQuickPaste(...args); }
function createQuickChatWindow(...args) { return initQuickChat().createQuickChatWindow(...args); }
async function sendSelectionToQuick(...args) { return initQuickChat().sendSelectionToQuick(...args); }
async function sendSelectionToSpecificQuickViaDialog(...args) { return initQuickChat().sendSelectionToSpecificQuickViaDialog(...args); }
function buildSendToQuickSubmenu(...args) { return initQuickChat().buildSendToQuickSubmenu(...args); }

// ---------- Find-in-page module bridge ----------
let findInPageInstance = null;
function initFindInPage() {
  if (findInPageInstance) return findInPageInstance;
  findInPageInstance = createFindInPage({
    BrowserWindow,
    ipcMain,
    screen,
    getMainWindow: () => mainWindow,
    getAppConfig,
    enableFindContentVisibility,
    disableFindContentVisibility,
  });
  return findInPageInstance;
}
function openFindModal(...args) { return initFindInPage().openFindModal(...args); }
function attachFindResultForwarding(...args) { return initFindInPage().attachFindResultForwarding(...args); }
function resetFindModalResults(...args) { return initFindInPage().resetFindModalResults(...args); }
function sendFindModalResults(...args) { return initFindInPage().sendFindModalResults(...args); }
function getWCFromEventSender(...args) { return initFindInPage().getWCFromEventSender(...args); }
function getWC(...args) { return initFindInPage().getWC(...args); }
function applyWordStartOptions(...args) { return initFindInPage().applyWordStartOptions(...args); }

// ---------- Direct-open module bridge ----------
let directOpenInstance = null;
function initDirectOpen() {
  if (directOpenInstance) return directOpenInstance;
  directOpenInstance = createDirectOpen({
    session, shell, fs, path, app, ipcMain,
    getAppConfig,
    getCopilotPartition: () => COPILOT_PARTITION,
    safeShowError,
  });
  return directOpenInstance;
}
function registerDirectOpenDownloadHandler() { return initDirectOpen().registerDirectOpenDownloadHandler(); }
function pruneExpiredDirectOpenRequests() { return initDirectOpen().pruneExpiredDirectOpenRequests(); }
function debugDirectOpen(...args) { return initDirectOpen().debugDirectOpen(...args); }

// ---------- Window-state module bridge ----------
let windowStateInstance = null;
function initWindowState() {
  if (windowStateInstance) return windowStateInstance;
  windowStateInstance = createWindowState({ app, path, fs, screen, getIsQuitting: () => isQuitting });
  return windowStateInstance;
}
function attachWindowStatePersistence(...args) { return initWindowState().attachWindowStatePersistence(...args); }
function getInitialWindowBounds(...args) { return initWindowState().getInitialWindowBounds(...args); }
function scheduleSaveWindowState(...args) { return initWindowState().scheduleSaveWindowState(...args); }
function loadWindowState(...args) { return initWindowState().loadWindowState(...args); }
function isBoundsOnAnyDisplay(...args) { return initWindowState().isBoundsOnAnyDisplay(...args); }

// ---------- Session-helpers module bridge ----------
let sessionHelpersInstance = null;
function initSessionHelpers() {
  if (sessionHelpersInstance) return sessionHelpersInstance;
  sessionHelpersInstance = createSessionHelpers({
    app, BrowserWindow, dialog, shell, session, clipboard, nativeImage, fs, path,
    getAppConfig, getCopilotPartition: () => COPILOT_PARTITION, getCopilotUrl: () => COPILOT_URL,
    getConfigFilePath, getLogFilePath,
    getMainWindow: () => mainWindow, safeShowError,
  });
  return sessionHelpersInstance;
}
function getRuntimeInfo() { return initSessionHelpers().getRuntimeInfo(); }
function getCopilotSession() { return initSessionHelpers().getCopilotSession(); }
function getActiveCopilotWindow() { return initSessionHelpers().getActiveCopilotWindow(); }
function getActiveCopilotWebContents() { return initSessionHelpers().getActiveCopilotWebContents(); }
function reloadCopilot(...a) { return initSessionHelpers().reloadCopilot(...a); }
function clearCopilotCache() { return initSessionHelpers().clearCopilotCache(); }
function clearCookiesAndSignOut() { return initSessionHelpers().clearCookiesAndSignOut(); }
function copyCurrentUrl() { return initSessionHelpers().copyCurrentUrl(); }
function openCurrentUrlExternal() { return initSessionHelpers().openCurrentUrlExternal(); }
function getLogsFolderPath() { return initSessionHelpers().getLogsFolderPath(); }
function openPathWithError(...a) { return initSessionHelpers().openPathWithError(...a); }
function openLogsFolder() { return initSessionHelpers().openLogsFolder(); }
function openConfigFile() { return initSessionHelpers().openConfigFile(); }
function toggleActiveWindowAlwaysOnTop() { return initSessionHelpers().toggleActiveWindowAlwaysOnTop(); }
function showAboutDialog() { return initSessionHelpers().showAboutDialog(); }
function showApplicationHelp() { return initSessionHelpers().showApplicationHelp(); }


// ---------- Context-menu module bridge ----------
let contextMenuInstance = null;
function initContextMenu() {
  if (contextMenuInstance) return contextMenuInstance;
  contextMenuInstance = createContextMenu({
    Menu, MenuItem, clipboard, shell, BrowserWindow, dialog,
    getAppConfig, SEND_MODE, EXPORT_SCOPES,
    selectChatPane, promptSaveChatPane, getSelectionFragment,
    htmlToMarkdown, buildSendToQuickSubmenu, createQuickChatWindow,
    promptExportWithProfile, buildExportProfileMenuTemplate,
    openFindModal, reveal, safeShowError, saveSelectionAsMarkdown,
  });
  return contextMenuInstance;
}
function buildContextMenuTemplate(...a) { return initContextMenu().buildContextMenuTemplate(...a); }

// ---------- App-menu module bridge ----------
let appMenuInstance = null;
function initAppMenu() {
  if (appMenuInstance) return appMenuInstance;
  appMenuInstance = createAppMenu({
    Menu, MenuItem, BrowserWindow, dialog, shell,
    getAppConfig, getMainWindow: () => mainWindow,
    openFindModal, initFindInPage, reloadCopilot, clearCopilotCache, clearCookiesAndSignOut,
    copyCurrentUrl, openCurrentUrlExternal, openLogsFolder, openConfigFile,
    toggleActiveWindowAlwaysOnTop, showAboutDialog, showApplicationHelp,
    getRuntimeInfo, appIconImage,
    buildExportProfileMenuTemplate, promptExportWithProfile,
    selectChatPane, promptSaveChatPane, EXPORT_SCOPES,
    buildQuickChatManagerMenuTemplate, installQuickChatMenu, refreshQuickChatMenu,
    createQuickChatWindow, buildSendToQuickSubmenu, SEND_MODE,
    ensureSaveState,
  });
  return appMenuInstance;
}
function appendEditItems(...a) { return initAppMenu().appendEditItems(...a); }
function appendHelpItems(...a) { return initAppMenu().appendHelpItems(...a); }
function appendSessionItems(...a) { return initAppMenu().appendSessionItems(...a); }
function augmentApplicationMenu(...a) { return initAppMenu().augmentApplicationMenu(...a); }
function appendFileItems(...a) { return initAppMenu().appendFileItems(...a); }


// ============================================================================





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

async function findBestChatRoot(...args) {
  return initExporters().findBestChatRoot(...args);
}

async function getChatPaneSnapshot(...args) {
  return initExporters().getChatPaneSnapshot(...args);
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


  initDirectOpen().registerDirectOpenIpcHandler(IPC);

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
    let menu;
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
  initFindInPage().registerFindIpcHandlers();

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
      initFindInPage().handleEscapeStopFind(mainWindow);
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

app.on('ready', () => {
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
    try { closeAllQuickChatWindows(); } catch {}
    try { initDirectOpen().cleanupTempFiles(); } catch {}
  } catch {}
});

