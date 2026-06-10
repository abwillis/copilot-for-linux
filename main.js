// main.js
'use strict';

const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');

const appConfig = require('./app.config');
const { createIPC } = require('./lib/ipc');
const { createRuntimeConfig } = require('./lib/runtime-config');

// === Shared modules ===
const { createWindowState } = require('./lib/window-state');
const { createSessionHelpers } = require('./lib/session-helpers');
const { createFindInPage } = require('./lib/find-in-page');
const { createDirectOpen } = require('./lib/direct-open');
const { createExporters, EXPORT_SCOPES } = require('./lib/exporters');
const { createContextMenu } = require('./lib/context-menu');
const { createQuickChatManager } = require('./lib/quick-chat');
const { createAppMenu } = require('./lib/app-menu');
const { createTrayMenu } = require('./lib/tray-menu');
const { createWindowHelpers } = require('./lib/window-helpers');
const { createMainWindowManager } = require('./lib/main-window');
const { createMainBootstrap } = require('./main.bootstrap');
const { createIconHelpers } = require('./lib/icon-helpers');

// === App-specific modules ===
const {
  CHAT_ROOT_SELECTORS, CHAT_MESSAGE_LIST_SELECTORS,
  CHAT_SCOPE_SELECTOR, CHAT_SCOPE_PSEUDO,
  CHAT_MESSAGE_LIST_SELECTOR, CHAT_MESSAGE_LIST_PSEUDO,
  EXPORT_ROOT_CLASS, EXPORT_ROOT_SELECTOR,
  CODE_PREVIEW_IFRAME_SELECTOR, DOM_CLEANUP_SELECTORS, DOM_PRESERVE_CONTENT_SELECTORS,
  cleanupDOMFragmentScript, buildChatPaneDetectionScript,
  buildLocateChatRootScript,
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
// App identity & constants
// ============================================================================
const APP_LABEL = appConfig.appLabel;
const APP_SLUG  = appConfig.appSlug;

const IPC = createIPC(APP_SLUG);

const SEND_MODE = Object.freeze({
  PLAIN: 'plain',
  QUOTE: 'quote',
});
const LAYOUT_OBSERVER_GLOBAL = appConfig.layoutObserverGlobal;

const DEFAULT_APP_CONFIG = Object.freeze({ ...appConfig.defaultAppConfig });

let APP_URL = DEFAULT_APP_CONFIG.appUrl;
let APP_PARTITION = DEFAULT_APP_CONFIG.partition;

let APP_CONFIG = { ...DEFAULT_APP_CONFIG };

// ============================================================================
// Runtime config/logging
// ============================================================================
const runtimeConfig = createRuntimeConfig({
  app,
  fs,
  path,
  defaultAppConfig: DEFAULT_APP_CONFIG,
  partitionEnvVar: appConfig.partitionEnvVar,
  onConfigLoaded(config) {
    APP_CONFIG = config;
    APP_PARTITION = config.partition;
    APP_URL = config.appUrl;
  },
});

const {
  sanitizeLogFileName,
  getConfigFilePath,
  getLogFilePath,
  formatConsoleArg,
  appendConsoleLogToFile,
  makeConsoleMethod,
  applyConsoleLoggingConfig,
  normalizeBooleanConfig,
  normalizePositiveIntegerConfig,
  normalizeExportFormat,
  normalizeExportProfile,
  normalizeAppConfig,
  writeConfigFile,
  loadAppConfig,
  ensureConfigFile,
  getAppConfig,
} = runtimeConfig;

// ============================================================================
// State
// ============================================================================
let mainWindow = null;
let tray = null;
let isQuitting = false;
let appIconImage = null;  // Cached icon images
let trayImage24 = null;  // Cached icon images
let lastSavePath = null;  // (legacy) Remember where "Save" last wrote to (per session/window)

// ============================================================================
// Utility
// ============================================================================
// Unified reveal helper to avoid repeated show/focus chains
let windowHelpersInstance = null;
function initWindowHelpers() {
  if (windowHelpersInstance) return windowHelpersInstance;
  windowHelpersInstance = createWindowHelpers({
    dialog,
    getAppConfig,
    applyMaxLayoutCSS,
    attachVWResize,
  });
  return windowHelpersInstance;
}
function reveal(...args) { return initWindowHelpers().reveal(...args); }
function safeShowError(...args) { return initWindowHelpers().safeShowError(...args); }

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

// === Safe 'did-stop-loading' wiring =========================================
// A named handler so removeListener(...) can reliably detach the same function.
function onDidStopLoading(...args) { return initWindowHelpers().onDidStopLoading(...args); }
function ensureDidStopLoadingHandler(webContents) { return initWindowHelpers().ensureDidStopLoadingHandler(webContents, onDidStopLoading); }
function attachCSSAndLayoutHandlers(win, options = {}) {
  return initWindowHelpers().attachCSSAndLayoutHandlers(win, {
    ...options,
    didStopLoadingHandler: onDidStopLoading,
  });
}

// ---------- Session-helpers module bridge ----------
let sessionHelpersInstance = null;
function initSessionHelpers() {
  if (sessionHelpersInstance) return sessionHelpersInstance;

  sessionHelpersInstance = createSessionHelpers({
    app, BrowserWindow, dialog, shell, session, clipboard, nativeImage,
    fs, path, getAppConfig,
    partition: APP_PARTITION,
    appLabel: APP_LABEL,
    getAppPartition: () => APP_PARTITION,
    getAppUrl: () => APP_URL,
    getConfigFilePath,
    getLogFilePath,
    ensureConfigFile,
    getMainWindow: () => mainWindow,
    getAppIconImage: () => appIconImage,
    safeShowError,
    refreshTrayMenu,
    refreshQuickChatMenu,
  });

  return sessionHelpersInstance;
}
function getRuntimeInfo(...args) { return initSessionHelpers().getRuntimeInfo(...args); }
function getAppSession(...args) { return initSessionHelpers().getAppSession(...args); }
function getActiveAppWindow(...args) { return initSessionHelpers().getActiveAppWindow(...args); }
function getActiveAppWebContents(...args) { return initSessionHelpers().getActiveAppWebContents(...args); }
function reloadApp(...args) { return initSessionHelpers().reloadApp(...args); }
function clearAppCache(...args) { return initSessionHelpers().clearAppCache(...args); }
function clearCookiesAndSignOut(...args) { return initSessionHelpers().clearCookiesAndSignOut(...args); }
function copyCurrentUrl(...args) { return initSessionHelpers().copyCurrentUrl(...args); }
function openCurrentUrlExternal(...args) { return initSessionHelpers().openCurrentUrlExternal(...args); }
function getLogsFolderPath(...args) { return initSessionHelpers().getLogsFolderPath(...args); }
function openPathWithError(...args) { return initSessionHelpers().openPathWithError(...args); }
function openLogsFolder(...args) { return initSessionHelpers().openLogsFolder(...args); }
function openConfigFile(...args) { return initSessionHelpers().openConfigFile(...args); }
function toggleActiveWindowAlwaysOnTop(...args) { return initSessionHelpers().toggleActiveWindowAlwaysOnTop(...args); }
function showAboutDialog(...args) { return initSessionHelpers().showAboutDialog(...args); }
function showApplicationHelp(...args) { return initSessionHelpers().showApplicationHelp(...args); }

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
    getAppPartition: () => APP_PARTITION,
    appSlug: APP_SLUG,
    safeShowError,
  });
  return directOpenInstance;
}

function registerDirectOpenDownloadHandler(...args) { return initDirectOpen().registerDirectOpenDownloadHandler(...args); }
function registerDirectOpenIpcHandler(...args) { return initDirectOpen().registerDirectOpenIpcHandler(...args); }
function pruneExpiredDirectOpenRequests(...args) { return initDirectOpen().pruneExpiredDirectOpenRequests(...args); }
function cleanupTempFiles(...args) { return initDirectOpen().cleanupTempFiles(...args); }
function debugDirectOpen(...args) { return initDirectOpen().debugDirectOpen(...args); }

// ---------- Exporter module bridge ----------
let exportersInstance = null;
function initExporters() {
  if (exportersInstance) return exportersInstance;
  exportersInstance = createExporters({
    app,
    BrowserWindow,
    dialog,
    safeShowError,
    getAppPartition: () => APP_PARTITION,
    buildLocateChatRootScript,
    appSlug: APP_SLUG,
    buildChatPaneDetectionScript,
    cleanupDOMFragmentScript,
    CHAT_SCOPE_PSEUDO,
    EXPORT_ROOT_CLASS,
    EXPORT_ROOT_SELECTOR,
    DOM_PRESERVE_CONTENT_SELECTORS,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    normalizeExportFormat,
    appLabel: APP_LABEL,
    appSlug: APP_SLUG,
  });
  return exportersInstance;
}
async function findBestChatRoot(...args) { return initExporters().findBestChatRoot(...args); }
async function getChatPaneSnapshot(...args) { return initExporters().getChatPaneSnapshot(...args); }
function htmlToMarkdown(...args) { return initExporters().htmlToMarkdown(...args); }
function stripTags(...args) { return initExporters().stripTags(...args); }
function decodeEntities(...args) { return initExporters().decodeEntities(...args); }
function stripExecutableBlocks(...args) { return initExporters().stripExecutableBlocks(...args); }
async function getSelectionFragment(...args) { return initExporters().getSelectionFragment(...args); }
async function getSelectionFragmentRaw(...args) { return initExporters().getSelectionFragmentRaw(...args); }
async function buildSelectionMarkdownForExport(...args) { return initExporters().buildSelectionMarkdownForExport(...args); }
async function selectChatPane(...args) { return initExporters().selectChatPane(...args); }
async function promptSaveChatPane(...args) { return initExporters().promptSaveChatPane(...args); }
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
async function saveChatPaneAsMarkdown(...args) { return initExporters().saveChatPaneAsMarkdown(...args); }
async function saveChatPaneAsRawMarkdown(...args) { return initExporters().saveChatPaneAsRawMarkdown(...args); }
async function saveChatPaneAsMarkdownWithMetadata(...args) { return initExporters().saveChatPaneAsMarkdownWithMetadata(...args); }
async function getBestChatRootCleaned(...args) { return initExporters().getBestChatRootCleaned(...args); }
async function saveChatPaneAsText(...args) { return initExporters().saveChatPaneAsText(...args); }
function escapeHtmlForExport(...args) { return initExporters().escapeHtmlForExport(...args); }
function buildPrintableChatPaneHtml(...args) { return initExporters().buildPrintableChatPaneHtml(...args); }
async function writeHtmlDocumentToPDF(...args) { return initExporters().writeHtmlDocumentToPDF(...args); }
async function printChatPane(...args) { return initExporters().printChatPane(...args); }
async function printSelection(...args) { return initExporters().printSelection(...args); }
async function saveChatPaneAsPDF(...args) { return initExporters().saveChatPaneAsPDF(...args); }
async function saveAsDialog(...args) { return initExporters().saveAsDialog(...args); }

// ---------- Context-menu module bridge ----------
let contextMenuInstance = null;
function initContextMenu() {
  if (contextMenuInstance) return contextMenuInstance;
  contextMenuInstance = createContextMenu({
    Menu, MenuItem, clipboard, shell, BrowserWindow, dialog, ipcMain,
    getAppConfig, SEND_MODE, EXPORT_SCOPES,
    selectChatPane, promptSaveChatPane, getSelectionFragment,
    htmlToMarkdown, buildSendToQuickSubmenu, createQuickChatWindow,
    promptExportWithProfile, buildExportProfileMenuTemplate,
    openFindModal, reveal, safeShowError, saveSelectionAsMarkdown,
  });
  return contextMenuInstance;
}
function buildContextMenuTemplate(...args) {
    return initContextMenu().buildContextMenuTemplate(...args);
}
function registerShowContextMenuIpcHandler(...args) {
    return initContextMenu().registerShowContextMenuIpcHandler(...args);
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
    getAppUrl: () => APP_URL,
    appLabel: APP_LABEL,
    appSlug: APP_SLUG,
    getAppPartition: () => APP_PARTITION,
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

// ============================================================================
// Utility — ensureSaveState
// ============================================================================
function ensureSaveState(...args) { return initWindowHelpers().ensureSaveState(...args); }

// ---------- App-menu module bridge ----------
let appMenuInstance = null;
function initAppMenu() {
  if (appMenuInstance) return appMenuInstance;
  appMenuInstance = createAppMenu({
    Menu, MenuItem, BrowserWindow, dialog, shell,
    getAppConfig, getMainWindow: () => mainWindow,
    appLabel: APP_LABEL,
    openFindModal, initFindInPage,
    reloadApp, clearAppCache, clearCookiesAndSignOut,
    copyCurrentUrl, openCurrentUrlExternal, openLogsFolder, openConfigFile,
    toggleActiveWindowAlwaysOnTop, showAboutDialog, showApplicationHelp,
    getRuntimeInfo, appIconImage,
    buildExportProfileMenuTemplate, promptExportWithProfile,
    selectChatPane, promptSaveChatPane, printChatPane, printSelection, saveSelectionAsMarkdown, EXPORT_SCOPES,
    buildQuickChatManagerMenuTemplate, installQuickChatMenu, refreshQuickChatMenu,
    createQuickChatWindow, buildSendToQuickSubmenu, SEND_MODE,
    ensureSaveState,
  });

  return appMenuInstance;
}
function appendEditItems(...args) { return initAppMenu().appendEditItems(...args); }
function appendHelpItems(...args) { return initAppMenu().appendHelpItems(...args); }
function appendSessionItems(...args) { return initAppMenu().appendSessionItems(...args); }
function augmentApplicationMenu(...args) { return initAppMenu().augmentApplicationMenu(...args); }
function appendFileItems(...args) { return initAppMenu().appendFileItems(...args); }

// ============================================================
// Tray menu (rebuilt when Quick Chat windows change)
// ============================================================
let trayMenuInstance = null;
function initTrayMenu() {
  if (trayMenuInstance) return trayMenuInstance;
  trayMenuInstance = createTrayMenu({
    Menu,
    Tray,
    nativeImage,
    path,
    app,
    appConfig,
    appLabel: APP_LABEL,
    dirname: __dirname,
    getTray: () => tray,
    setTray: (value) => { tray = value; },
    getTrayImage24: () => trayImage24,
    setTrayImage24: (value) => { trayImage24 = value; },
    getAppIconImage: () => appIconImage,
    getIconPath,
    getMainWindow: () => mainWindow,
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
    setIsQuitting: (value) => { isQuitting = !!value; },
  });
  return trayMenuInstance;
}
function buildTrayMenuTemplate(...args) { return initTrayMenu().buildTrayMenuTemplate(...args); }
function refreshTrayMenu(...args) { return initTrayMenu().refreshTrayMenu(...args); }
function createTray(...args) { return initTrayMenu().createTray(...args); }

// ============================================================================
// Structured selection -> envelope -> quick chat inject (active OR specific #N)
// ============================================================================
  initDirectOpen().registerDirectOpenIpcHandler(IPC);

// ============================================================
// Icon helper
// ============================================================
let iconHelpersInstance = null;
function initIconHelpers() {
  if (iconHelpersInstance) return iconHelpersInstance;
  iconHelpersInstance = createIconHelpers({
    app,
    fs,
    path,
    process,
  });
  return iconHelpersInstance;
}
function getIconPath(...args) { return initIconHelpers().getIconPath(...args); }

// ============================================================
// createWindow
// ============================================================
let mainWindowManagerInstance = null;
function initMainWindowManager() {
  if (mainWindowManagerInstance) return mainWindowManagerInstance;
  mainWindowManagerInstance = createMainWindowManager({
    BrowserWindow,
    Menu,
    nativeImage,
    shell,
    path,
    dirname: __dirname,
    appConfig,
    appLabel: APP_LABEL,
    getAppConfig,
    getAppUrl: () => APP_URL,
    getAppPartition: () => APP_PARTITION,
    getMainWindow: () => mainWindow,
    setMainWindow: (value) => { mainWindow = value; },
    getAppIconImage: () => appIconImage,
    setAppIconImage: (value) => { appIconImage = value; },
    getTrayImage24: () => trayImage24,
    setTrayImage24: (value) => { trayImage24 = value; },
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
    registerFindIpcHandlers: () => initFindInPage().registerFindIpcHandlers(),
    handleEscapeStopFind: (...args) => initFindInPage().handleEscapeStopFind(...args),
    enableLayoutWidthKeyboardShortcuts: true,
    layoutWidthKeyboardApiPrefix: `__${APP_SLUG}`,
    defaultVwSize: VW_SIZE,
  });
  return mainWindowManagerInstance;
}
function createWindow(...args) { return initMainWindowManager().createWindow(...args); }

// ============================================================
// App lifecycle
// ============================================================
let mainBootstrapInstance = null;
function initMainBootstrap() {
  if (mainBootstrapInstance) return mainBootstrapInstance;
  mainBootstrapInstance = createMainBootstrap({
    app,
    BrowserWindow,
    appConfig,
    getAppConfig,
    loadAppConfig,
    getLayoutObserverGlobal: () => LAYOUT_OBSERVER_GLOBAL,
    getMainWindow: () => mainWindow,
    setIsQuitting: (value) => { isQuitting = !!value; },
    createWindow,
    createTray,
    registerDirectOpenIpcHandler: () => registerDirectOpenIpcHandler(IPC),
    registerDirectOpenDownloadHandler,
    pruneExpiredDirectOpenRequests,
    cleanupTempFiles,
    closeAllQuickChatWindows,
  });
  return mainBootstrapInstance;
}
function bootstrapApp(...args) { return initMainBootstrap().bootstrapApp(...args); }

bootstrapApp();
