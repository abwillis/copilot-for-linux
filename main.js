// main.js
const { app, BrowserWindow, Menu, MenuItem, Tray, nativeImage, shell, ipcMain, dialog, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let lastSavePath = null;  // (legacy) Remember where "Save" last wrote to (per session/window)
let findModal = null;  // === Find modal ===
let appIconImage = null;  // Cached icon images
let trayImage24 = null;  // Cached icon images

// --- Make the site use the full viewport by injecting CSS (CSP-safe) ---
const CHAT_SELECTOR = '#mainChat';  // Root container for the chat UI
const MESSAGE_LIST_SCOPE = '#mainChat div[id*="messagelist" i]';

// Parameterized single-message selector
const messageContentById = (id) => `#mainChat #${id}`;

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

/**
 * Remove any non-Copilot 'did-stop-loading' listeners and re-add a single instance
 * of our handler. This guarantees exactly one active handler and prevents
 * MaxListenersExceededWarning even when other code attempts to attach duplicates.
 */
function dedupeDidStopLoadingHandlers(webContents) {
  if (!webContents) return;
  // Enumerate current listeners for did-stop-loading
  const current = webContents.listeners('did-stop-loading');
  // Remove everything that is not our named handler
  for (const fn of current) {
    if (fn !== onDidStopLoading) {
      try { webContents.removeListener('did-stop-loading', fn); } catch {}
    }
  }
  // Ensure our handler is attached exactly once
  try { webContents.removeListener('did-stop-loading', onDidStopLoading); } catch {}
  webContents.on('did-stop-loading', onDidStopLoading);
}

/**
 * Diagnostic rewire: print counts before/after, then hard-dedupe.
 * Keep the defaultMaxListeners bump only while you diagnose upstream duplicates.
 */
function refreshDidStopLoadingHandler(webContents) {
  if (!webContents) return;
  try {
    // TEMP: avoid noisy warnings during diagnosis; remove when stable.
    const { EventEmitter } = require('events');
    if (EventEmitter.defaultMaxListeners < 50) {
      EventEmitter.defaultMaxListeners = 50;
    }
  } catch {}

  const before = webContents.listenerCount('did-stop-loading');
//  console.warn('[refreshDidStopLoadingHandler] listeners present before refresh:', before);

  dedupeDidStopLoadingHandlers(webContents);

  const after = webContents.listenerCount('did-stop-loading');
//  console.warn('[refreshDidStopLoadingHandler] listeners after refresh:', after);
}

// 7 options grouped into containers vs content for correct layout application
const SELECTORS = {
  // Containers (safe to apply full-viewport/layout rules)
  feedContainer:           '${MESSAGE_LIST_SCOPE} [data-testid="MessageListContainer"] [role="feed"]',
  listContainer:           '${MESSAGE_LIST_SCOPE} [data-testid="MessageListContainer"]',
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
    '${MESSAGE_LIST_SCOPE} [role="feed"] .fai-CopilotMessage .fai-CopilotMessage__content',
  allMessageContent_class_lowSpecificity:
    '${MESSAGE_LIST_SCOPE} :where([role="feed"]) :where(.fai-CopilotMessage) :where(.fai-CopilotMessage__content)',
  allMessageContent_attr:
    '${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"][aria-labelledby*="copilot-message-" i] > div[id^="copilot-message-" i]',
  linksInContent_class:
    '${MESSAGE_LIST_SCOPE} [role="feed"] .fai-CopilotMessage__content a',
  linksInContent_attr:
    '${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] > div[id^="copilot-message-"] a',
  minimalSemantic:
    '${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] > [id^="copilot-message-"]',
};
/*
const PREFERRED_CONTAINER_SELECTORS = [
  SELECTORS.feedContainer,
  SELECTORS.copilotChatClass,
  SELECTORS.layoutMainPane,
  SELECTORS.chatMessageResponserId,
  SELECTORS.markdownReplyTestId,
];
*/
// --- Centralized ignore list: ALWAYS excluded from layout adjustments ---
const IGNORE_SELECTORS = [
  `[class*="Drawer" i]`,
  `[class*="chatinput" i]`,
  `[id*="ChatInput" i]`,
  `[class*="chat-input" i]`,
  `[id*="chat-input" i]`,
  `[class*="button" i]`,
  `[type*="button" i]` ,
  `[role="button" i]` ,
  `[class*="Menu" i]`,
  `[class*="MessageBar" i]`,
  `[class*="editorinput" i]` ,
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
  `[class*="usermessage" i] ` ,
  `[id*="user-message"]` ,
  `[class*="actionsContainer"]`
];
const IGNORE_JOINED = IGNORE_SELECTORS.join(', ');


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

// Responsive VW: keep --copilot-vw tied to window size (95 → 30vw)
function attachVWResize(win) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;
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
  wc.on('dom-ready', run);
  wc.on('did-frame-finish-load', run);
  wc.on('did-navigate-in-page', run);
  wc.on('did-finish-load', run);
  run();
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
    CHAT_SELECTOR,
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
   `${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"]`,
    SELECTORS.linksInContent_class,
    SELECTORS.linksInContent_attr,
    SELECTORS.minimalSemantic,
  ].filter(Boolean).join(',\n');

  return String.raw`

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

    /* Neutral wrappers: full width, no clamp */
    main, #root, #app,
    .container, .wrapper, [class*="container"], [class*="wrapper"],
    [class*="content"], [class*="shell"], [class*="layout"], [class*="gutter"] {
      width: min(min(var(--copilot-vw, ${VW_SIZE}vw), 91vw), ${MAX_CHARS}ch) !important;
      max-width: 100% !important;
      margin-left: 0 !important;
      margin-right: 0 !important;
      padding-left: 0 !important;
      padding-right: 0 !important;
      table {
        margin-left: 12px !important;
        padding-left: 12px !important;
      }
      justify-self: start !important;
      place-self: start !important;
      box-sizing: border-box !important;
      overflow-x: visible !important;
      overflow-y: visible !important;
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
      max-width: auto !important;
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
   ${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] {
     width: 100% !important;
     max-width: none !important;
     box-sizing: border-box !important;
     text-align: left !important;
     overflow-wrap: anywhere !important;
     word-break: break-word !important;
     white-space: normal !important;
   }

    /* Ensure plain text elements wrap within message articles */
    ${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] p,
    ${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] li,
    ${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] ul,
    ${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] ol,
    ${MESSAGE_LIST_SCOPE} [role="feed"] [role="article"] blockquote {
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

  [class*="tooltip" i],
  [class*="fui-Tab__content"] {
  display: inline-block !important;   /* Allows width to fit content */
  width: fit-content !important;      /* Shrinks to text width */
  height: fit-content !important;     /* Shrinks to text height */
  padding: 0 !important;              /* Optional: remove extra space */
  margin: 0 !important;               /* Optional: remove extra space */
      overflow-wrap: anywhere !important;
      word-break: break-word !important;
}

    /* Tables: auto layout & full width to reduce clipping overflow */
    ${SELECTORS.feedContainer} table {
      table-layout: auto !important;
      width: 100% !important;
    }
    }
  `;
}

// CSP-safe injection with re-inject on SPA navigations (and cleanup)
function injectCSSOnLoad(win, css, keyHolder) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;
  const inject = () => {
    if (keyHolder.key) {
      try { wc.removeInsertedCSS(keyHolder.key); } catch {}
      keyHolder.key = null;
    }
    try { wc.insertCSS(css).then(k => { keyHolder.key = k; }).catch(() => {}); }
    catch (err) { console.error('insertCSS failed:', err); }
  };
  wc.on('dom-ready', inject);
  wc.on('did-finish-load', inject);
  wc.on('did-navigate-in-page', inject);
  wc.on('did-start-navigation', inject);
  inject();
}

// Inject CSS into all frames (main + iframes), and re-inject on frame loads.
function injectCSSIntoAllFrames(win, css) {
  if (!win || !win.webContents) return;
  const wc = win.webContents;
  const apply = () => {
    try {
      // Iterate over the whole frame subtree (Electron 20+)
      const frames = wc.mainFrame?.framesInSubtree ?? wc.mainFrame?.frames ?? [];
      for (const f of frames) {
        try { f.insertCSS(css).catch(() => {}); } catch {}
      }
      // Also apply to main frame explicitly (harmless if duplicated)
      wc.insertCSS(css).catch(() => {});
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
  const css = buildMaxLayoutCSS({ specificMessageId });
  // Apply across all frames so we catch real content surfaces inside iframes
  injectCSSIntoAllFrames(win, css);
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
const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');
let mainWindowState = null;
let saveStateDebounce = null;
const SAVE_STATE_DEBOUNCE_MS = 20;

function loadWindowState() {
  try {
    const raw = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
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
    // Require some intersection with the display workArea
    const wa = disp.workArea;
    const intersects =
      rect.x < (wa.x + wa.width) &&
      (rect.x + rect.width) > wa.x &&
      rect.y < (wa.y + wa.height) &&
      (rect.y + rect.height) > wa.y;
    return intersects;
  } catch {
    return true; // fail open; Electron will clamp later
  }
}

function getInitialWindowBounds() {
  // Try previously persisted bounds
  const persisted = loadWindowState();
  if (persisted && persisted.width && persisted.height) {
    // Validate that the bounds are on a visible display; if not, ignore position
    if (isBoundsOnAnyDisplay(persisted)) {
      return {
        width: Math.max(600, persisted.width),   // minimum reasonable size
        height: Math.max(400, persisted.height),
        x: typeof persisted.x === 'number' ? persisted.x : undefined,
        y: typeof persisted.y === 'number' ? persisted.y : undefined
      };
    }
    // If position invalid, keep size but let OS pick position
    return {
      width: Math.max(600, persisted.width),
      height: Math.max(400, persisted.height)
    };
  }
  // Fallback defaults (your current values)
  return { width: 1200, height: 800 };
}

function scheduleSaveWindowState(win) {
  if (saveStateDebounce) clearTimeout(saveStateDebounce);
  saveStateDebounce = setTimeout(() => {
    try {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const state = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      fs.mkdirSync(path.dirname(WINDOW_STATE_FILE), { recursive: true });
      fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(state), 'utf8');
      mainWindowState = state;
    } catch (err) {
      console.error('Failed to persist window state:', err);
    }
  }, SAVE_STATE_DEBOUNCE_MS);
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
      `V8: ${v8Version}` +
      `Electron: ${electronVersion}\n` +
      `Chromium: ${chromeVersion}\n`
  };
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

function openFindModal(parent) {
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
  // Build plain HTML, then encode only the payload for the data URL
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
  body{font-family:system-ui,Segoe UI,Arial,sans-serif;margin:12px}
  .row{display:flex;gap:8px;align-items:center}
  input[type=text]{flex:1;padding:6px 8px}
  .actions{margin-top:10px;display:flex;gap:8px;justify-content:flex-end}
  label{font-size:12px;color:#444}
</style></head><body>
  <div class="row">
    <input id="term" type="text" placeholder="Find in page..." autofocus />
    <label><input id="match" type="checkbox"> Match case</label>
  </div>
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
    const send = (kind) => ipcRenderer.send('find-modal-submit', {
      kind, term: termEl.value || '', matchCase: !!matchEl.checked
    });
    document.getElementById('next').onclick = () => send('next');
    document.getElementById('prev').onclick = () => send('prev');
    document.getElementById('clear').onclick = () => ipcRenderer.send('find-modal-clear');
    document.getElementById('close').onclick = () => ipcRenderer.send('find-modal-close');
    termEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send('next');
      if (e.key === 'Escape') {
        ipcRenderer.send('find-modal-clear');
        ipcRenderer.send('find-modal-close');
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
  findModal.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error('Find modal failed to load:', code, desc, url);
  });
}

// === Find-in-page state ===
let lastFindTerm = '';
let lastFindOpts = { forward: true, matchCase: false, medialCapitalAsWordStart: true, wordStart: true, findNext: false };
let findDebounce;
const FIND_DEBOUNCE_MS = 20;

// Build Edit menu as a reusable factory
function appendEditItems(editSubmenu) {
  const template = [
//    { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
//    { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
//    { role: 'selectAll' }, { type: 'separator' },
    {
      label: 'Find…',
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

// --- Help menu: add About… screen (under the menu bar) ----------------------
function appendHelpItems(helpSubmenu) {
  const template = [
    new MenuItem({
      label: 'About…',
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
          console.error('Help→About dialog failed:', err);
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
    //   label: 'Report Issue…',
    //   click: () => shell.openExternal('https://your.issues.url/')
    // }),
  ];
  template.forEach(i => helpSubmenu.append(i));
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

  // Ensure "Help" submenu exists, then append our items
  let helpSubmenu = appMenu.items.find(i => i.label === 'Help')?.submenu;
  if (!helpSubmenu) {
    helpSubmenu = new Menu();
    // Place Help at the end for Windows/Linux conventions
    appMenu.append(new MenuItem({ label: 'Help', submenu: helpSubmenu }));
  }
  appendHelpItems(helpSubmenu);

  // Re-apply the mutated menu so the OS picks up changes
  Menu.setApplicationMenu(appMenu);
}

function ensureSaveState(win) {
  if (win && typeof win.__lastSavePath === 'undefined') win.__lastSavePath = null;
}

// ---------- Chat pane selection helper ----------
// Select the entire chat pane content in the renderer and return selection stats
async function selectChatPane(win) {
  const res = await win.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector('${CHAT_SELECTOR}');
      if (!el) return { ok:false, selectedTextLength:0 };
      try {
        // Try to reveal as much content as possible before selecting (helps some virtualized views)
        el.scrollTo({ top: 0, behavior: 'auto' });
      } catch {}
      try {
        const sel = window.getSelection && window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          const range = document.createRange();
          range.selectNodeContents(el);
          sel.addRange(range);
          const txt = String(sel.toString() || '');
          return { ok:true, selectedTextLength: txt.length };
        }
      } catch (e) {
        return { ok:false, selectedTextLength:0, err: String(e) };
      }
      return { ok:false, selectedTextLength:0 };
    })();
  `);
  return res;
}

// ---------- Selection → Markdown helpers ----------
// Extract the current selection from the renderer as HTML fragment and text.
async function getSelectionFragment(win) {
  const result = await win.webContents.executeJavaScript(`
    (function() {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return { hasSelection: false, html: "", text: "" };
      }
      const range = sel.getRangeAt(0);
      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      const html = container.innerHTML;
      const text = String(sel.toString() || '');
      return { hasSelection: true, html, text };
    })();
  `).catch(() => ({ hasSelection: false, html: "", text: "" }));
  return result;
}

// Minimal HTML → Markdown converter (headings, paragraphs, lists, code, links, quotes)
function htmlToMarkdown(html) {
  if (!html || !html.trim()) return '';
  // 1) Decode common entities so we operate on real tags
  let md = decodeEntities(html);
  // 2) Remove executable/unsafe blocks first
  md = stripExecutableBlocks(md);

  // 3) Blockquotes
  md = md.replace(/<blockquote[^>]*>/gi, '\n> ')
         .replace(/<\/blockquote>/gi, '\n');

  // 4) Headings
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, c) => `\n# ${stripTags(c)}\n`);
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, c) => `\n## ${stripTags(c)}\n`);
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, c) => `\n### ${stripTags(c)}\n`);
  md = md.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, (_, c) => `\n#### ${stripTags(c)}\n`);
  md = md.replace(/<h5[^>]*>([\s\S]*?)<\/h5>/gi, (_, c) => `\n##### ${stripTags(c)}\n`);
  md = md.replace(/<h6[^>]*>([\s\S]*?)<\/h6>/gi, (_, c) => `\n###### ${stripTags(c)}\n`);

  // 5) Paragraphs & line breaks
  md = md.replace(/<p[^>]*>/gi, '\n')
         .replace(/<\/p>/gi, '\n')
         .replace(/<br\s*\/?>/gi, '\n');

  // 6) Lists
  md = md.replace(/<ul[^>]*>/gi, '\n')
         .replace(/<\/ul>/gi, '\n');
  md = md.replace(/<ol[^>]*>/gi, '\n')
         .replace(/<\/ol>/gi, '\n');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, c) => `- ${stripTags(c)}\n`);

  // 7) Bold / Italic
  md = md.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, c) => `**${stripTags(c)}**`);
  md = md.replace(/<(i|em)[^>]*>([\s\S]*?)<\/\1>/gi,   (_, __, c) => `*${stripTags(c)}*`);

  // 8) Inline code
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_, c) => '`' + stripTags(c).replace(/\n+/g, ' ') + '`');

  // 9) Preformatted blocks → fenced code
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => {
    const inner = c.replace(/<\/?code[^>]*>/gi, '');
    const clean = stripTags(inner).replace(/\r?\n/g, '\n');
    return `\n\`\`\`\n${clean.trim()}\n\`\`\`\n`;
  });

  // 10) Links (emit bare href if no text)
  md = md.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => {
    const t = stripTags(text).trim();
    const h = href.trim();
    return t ? `[${t}](${h})` : h;
  });

  // 11) Images → alt + URL, or URL
  md = md.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, alt, src) => {
    const a = alt.trim(); const s = src.trim();
    return a ? `![${a}](${s})` : s;
  });

  // 12) Strip remaining tags and normalize whitespace
  md = stripTags(md)
       .replace(/[ \t]+\n/g, '\n')
       .replace(/\n{3,}/g, '\n\n')
       .trim();

  return md;
}

function stripTags(s) {
  // Remove any remaining HTML tags; entity decoding is handled earlier
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00A0/g, ' '); // non-breaking space → regular space
}

// --- Centralized sanitizers ---
function decodeEntities(s) {
  // Minimal entity decode to operate on real tags and readable text
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
  // Make everything except the chat invisible but still laid out.
  // Using opacity/pointer-events instead of display:none helps virtualized lists keep measurements,
  // reducing "white page" issues when saving.
  const css = `
    html, body {
      overflow: auto !important;
      background: #ffffff !important;
    }
    *:not(${CHAT_SELECTOR}):not(${CHAT_SELECTOR} *) {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    ${CHAT_SELECTOR} {
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
  const result = await win.webContents.executeJavaScript(`
    (function() {
      const el = document.querySelector('${CHAT_SELECTOR}');
      if (!el) return { ok:false, html:'', title: document.title };
      return { ok:true, html: el.outerHTML, title: document.title };
    })();
  `);
  const htmlDoc = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${(result && result.title) ? result.title : 'Copilot Chat'}</title>
  <style>
    html, body { margin: 0; padding: 0; }
    ${CHAT_SELECTOR} { width: 100%; max-width: 100%; }
  </style>
</head>
<body>
${(result && result.html) ? result.html : '<p>Chat pane not found.</p>'}
</body>
</html>`;
  await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
}

// B2) Clean HTML export: strip noisy classes/styles and add minimal readable CSS
async function savePaneAsCleanHTML(win, filePath) {
  const result = await win.webContents.executeJavaScript(`
    (function() {
      const root = document.querySelector('${CHAT_SELECTOR}');
      if (!root) return { ok:false, title: document.title, html:'' };
      // clone and sanitize
      const clone = root.cloneNode(true);
      // remove hashed classes & inline styles (keeps text content)
      clone.querySelectorAll('[class]').forEach(n => n.removeAttribute('class'));
      clone.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
      // remove noisy attributes
      clone.querySelectorAll('*').forEach(n => {
        // drop data-* and aria-* and role, tabindex
        [...n.attributes].forEach(a => {
          const name = a.name.toLowerCase();
          if (name.startsWith('data-') || name.startsWith('aria-') || name === 'role' || name === 'tabindex') {
            n.removeAttribute(a.name);
          }
          // drop ephemeral ids except the root
          if (name === 'id' && n !== clone) n.removeAttribute('id');
        });
      })
      // remove empty containers to reduce noise
      clone.querySelectorAll('div').forEach(n => { if (!n.textContent.trim()) n.remove(); });
      // attempt to keep message semantics if present
      // (optional heuristics can be added here)
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
    /* Make top-level container stretch full width */
    ${CHAT_SELECTOR} { width: 100%; max-width: 100%; }
  </style>
  <!-- NOTE: This cleaned export removes hashed classes/inline styles for readability. -->
</head>
<body>
${result.html || '<p>No chat content found.</p>'}
</body>
</html>`;
  await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
}

// Unified chooser by extension
async function saveChatPaneByExtension(win, filePath) {
  const lower = String(filePath).toLowerCase();
  if (lower.endsWith('.html')) {
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
      title: 'Save Chat Pane As…',
      defaultPath: 'copilot-chat.md',  // Default to Markdown file name
      // Put Markdown first so it's the preselected filter
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
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

async function saveChatPaneAsText(win, filePath) {
  if (!win) return;
  try {
    const result = await win.webContents.executeJavaScript(`
      (function() {
        const el = document.querySelector('${CHAT_SELECTOR}');
        if (!el) return { ok:false, html:'', title: document.title };
        return { ok:true, html: el.innerHTML, title: document.title };
      })();
    `);
    if (!result?.ok) {
      try { dialog.showErrorBox('Save Chat Pane as Text', 'Chat pane not found.'); } catch {}
      return;
    }
    // Convert pane HTML → Plain Text: decode → sanitize → strip tags → normalize
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

// ---------- File menu (Save / Save As…) ----------
function appendFileItems(fileSubmenu, win) {
  ensureSaveState(win);
  const items = [
    new MenuItem({ type: 'separator' }),
    new MenuItem({
      label: 'Save Chat Pane…',
      accelerator: 'Ctrl+S',
      click: async () => {
        try { await promptSaveChatPane(win); }
        catch (err) {
          console.error('File→Save Chat Pane failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      label: 'Save Selection as Markdown…',
      accelerator: 'Ctrl+Shift+M',
      click: async () => {
        try { await saveSelectionAsMarkdown(win); }
        catch (err) {
          console.error('File→Save Selection as Markdown failed:', err);
          try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
        }
      }
    }),
    new MenuItem({
      label: 'Toggle DevTools',
      accelerator: 'Ctrl+Shift+I',
      click: () => {
        try { if (mainWindow) mainWindow.webContents.toggleDevTools(); }
        catch (err) { console.error('Toggle DevTools failed:', err); }
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
    title: 'Save Page As…',
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
  console.error('ICON FAILED TO LOAD — path is wrong or file corrupted');
 } else {
  console.log('ICON LOADED SUCCESSFULLY');
  console.log('Size:', taIcon.getSize());           // → { width: 512, height: 512 }
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
  const initialBounds = getInitialWindowBounds();
  // Assign to the outer-scoped variable (do NOT redeclare with const here)
  mainWindow = new BrowserWindow({
    skipTaskbar: false,
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
      devTools: true,
      backgroundThrottling: true,   // reduce CPU when hidden
      spellcheck: false            // disable if not required
    },
    // Linux-specific: ensure proper window identification
    type: 'normal',
    // Help with focus stealing prevention
    autoHideMenuBar: false

  });

  // Ensure menu bar is visible so users can access Edit → Find…
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
    const menu = Menu.buildFromTemplate([
      { role: 'cut',        accelerator: 'Ctrl+X', enabled: !!params?.isEditable },
      { role: 'copy',       accelerator: 'Ctrl+C', enabled: !!(params?.hasSelection || params?.isEditable) },
      { role: 'paste',      accelerator: 'Ctrl+V', enabled: !!params?.isEditable },
      { type: 'separator' },
      { role: 'selectAll',  accelerator: 'Ctrl+A', enabled: true  },
    ]);
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

  // Unified reveal helper to avoid repeated show/focus chains
  function reveal(win) {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
    try { win.moveTop(); } catch {}
  }

  mainWindow.setIcon(appIconImage || taIcon);

  // If you initially create hidden:
  mainWindow.once('ready-to-show', () => {
    reveal(mainWindow);
    augmentApplicationMenu(mainWindow);  // Augment the existing app menu with our File/Edit items
  });
  // Safety in case it was toggled elsewhere:
  mainWindow.setSkipTaskbar(false);

  // ✅ Attach 'did-stop-loading' once and hard-dedupe any foreign handlers.
  // Do this immediately after the window is created (before/after loadURL is fine).
  refreshDidStopLoadingHandler(mainWindow.webContents);
  // OPTIONAL: uncomment this to trace *where* extra listeners are being added:
  // const _origOn = mainWindow.webContents.on.bind(mainWindow.webContents);
  // mainWindow.webContents.on = (evt, fn) => { if (evt === 'did-stop-loading') console.trace('[TRACE] did-stop-loading on()'); return _origOn(evt, fn); };

  mainWindow.loadURL('https://m365.cloud.microsoft/chat');  // Load your app

  try { applyDynamicWidth(mainWindow); } catch (e) { console.error('applyDynamicWidth failed:', e); }
  try { applyMaxLayoutCSS(mainWindow); } catch (e) { console.error('applyMaxLayoutCSS (outer) failed:', e); }
//  try { applyMaxLayoutJS(mainWindow); } catch (e) { console.error('applyMaxLayoutJS (outer) failed:', e); }
//  try { enforceNoHScroll(mainWindow); } catch (e) { console.error('enforceNoHScroll failed:', e); }
  try { attachVWResize(mainWindow); } catch (e) { console.error('attachVWResize failed:', e); }
  try { requestExpandedLayout(mainWindow); } catch (e) { console.error('requestExpandedLayout (outer) failed:', e); }
//  try { enforceVisibleSelectionInShadows(mainWindow); } catch (e) { console.error('selection shadow inject failed:', e); }
//  try { installSelectionOverlay(mainWindow); } catch (e) { console.error('installSelectionOverlay failed:', e); }
   // Fallback (no-op if Custom Highlight API exists)
//  try { installSelectionFallback(mainWindow); } catch (e) { console.error('installSelectionFallback failed:', e); }

  // Build native context menu purely from main, based on Chromium's params

  // Keep the 'did-stop-loading' handler singular when SPA navigations occur.
  // Rewire on each navigation start to ensure exactly one active listener.
  mainWindow.webContents.on('did-start-navigation', () => {
    try { refreshDidStopLoadingHandler(mainWindow.webContents); } catch {}
    try { attachVWResize(mainWindow); } catch {}
  });
  mainWindow.webContents.on('destroyed', () => {
    try { mainWindow?.webContents?.removeListener('did-stop-loading', onDidStopLoading); } catch {}
  });

  mainWindow.webContents.on('context-menu', (_event, params) => {
    // params: { isEditable, selectionText, selectionTextIsEditable, mediaType, linkURL, inputFieldType, x, y, ... }
    const isEditable = !!params.isEditable;
    const hasSelection = !!params.selectionText && params.selectionText.length > 0;

    // Always offer at least a minimal fallback menu so users are not left without options
    const minimalTemplate = [
      { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        accelerator: 'Ctrl+Shift+C',
        click: () => {
          try {
            mainWindow.webContents.inspectElement(params.x, params.y);
            if (!mainWindow.webContents.isDevToolsOpened()) {
              mainWindow.webContents.openDevTools({ mode: 'right' });
            }
          } catch (err) {
            console.error('Inspect failed:', err);
          }
        }
      }
    ];

    const template = [
      { role: 'cut',   accelerator: 'Ctrl+X', enabled: isEditable },
      { role: 'copy',  accelerator: 'Ctrl+C', enabled: (hasSelection || isEditable) },
      { role: 'paste', accelerator: 'Ctrl+V', enabled: isEditable },
      { type: 'separator' },
      { role: 'selectAll', accelerator: 'Ctrl+A', enabled: true },
      { type: 'separator' },
      {
        label: 'Select Chat Pane',
        accelerator: 'Ctrl+Shift+A',
        enabled: true, // ✅ Always enabled regardless of selection
        click: async () => {
          try {
            const res = await selectChatPane(mainWindow);
            if (!res?.ok) {
              try { dialog.showErrorBox('Select Chat Pane', 'Could not select the chat pane.'); } catch {}
            }
          } catch (err) {
            console.error('Select Chat Pane failed:', err);
            try { dialog.showErrorBox('Select Chat Pane failed', String(err?.message || err)); } catch {}
          }
        }
      },

      // ---- NEW: Save Chat Pane… (right-click) ----
      {
        label: 'Save Chat Pane…',
        click: async () => {
          await promptSaveChatPane(mainWindow);
        }
      },
      { type: 'separator' },
      {
        label: 'Copy Selection as Markdown',
        accelerator: 'Ctrl+Shift+M',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(mainWindow);
            if (!ok) return;
            const md = htmlToMarkdown(html || text);
            clipboard.writeText(md);
          } catch (err) {
            console.error('Copy Selection as Markdown failed:', err);
          }
        }
      },
      {
        label: 'Save Selection as Markdown…',
        enabled: hasSelection,
        click: async () => {
          await saveSelectionAsMarkdown(mainWindow);
        }
      },
      {
        label: 'Save Selection as Plain Text…',
        enabled: hasSelection,
        click: async () => {
          try {
            const { hasSelection: ok, html, text } = await getSelectionFragment(mainWindow);
            if (!ok) {
              try { dialog.showErrorBox('Save Selection as Text', 'No selection found.'); } catch {}
              return;
            }
            const safeHtml = stripExecutableBlocks(decodeEntities(html || text));
            let plain = stripTags(safeHtml)
              .replace(/[ \t]+\n/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
              title: 'Save Selection as Plain Text',
              defaultPath: 'selection.txt',
              filters: [{ name: 'Plain Text', extensions: ['txt'] }]
            });
            if (canceled || !filePath) return;
            await fs.promises.writeFile(filePath, plain, 'utf8');
          } catch (err) {
            console.error('Save Selection as Plain Text failed:', err);
            try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Inspect Element',
        accelerator: 'Ctrl+Shift+C',
        click: () => {
          try {
            // Focus the element under the right-click position
            mainWindow.webContents.inspectElement(params.x, params.y);
            // Ensure DevTools is open so the Elements panel is visible
            if (!mainWindow.webContents.isDevToolsOpened()) {
              // Dock to the right; you can use 'bottom' or omit the mode
              mainWindow.webContents.openDevTools({ mode: 'right' });
            }
          } catch (err) {
            console.error('Inspect failed:', err);
          }
        }
      }
    ];
    try { 
      menu = Menu.buildFromTemplate(template);
    }
    catch (err) {
      console.error('Context menu template error:', err);
      // Fallback: minimal safe menu
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

  // Optional: monitor find results (count, active match); useful for logging or future UI
  mainWindow.webContents.on('found-in-page', (event, result) => {
    // result = { requestId, activeMatchOrdinal, matches, selectionArea, finalUpdate }
    // You can log or use this info to show status in a future overlay.
    // console.log('find:', result);
  });

  // Handle Find modal events (parent-aware)
  if (!ipcMain.listenerCount('find-modal-submit')) {
    ipcMain.on('find-modal-submit', (event, payload) => {
    const wc = getWCFromEventSender(event.sender); if (!wc) return;
    const term = String(payload?.term || '').trim();
    const matchCase = !!payload?.matchCase;
    if (!term) return;
    const isNewTerm = term !== lastFindTerm;
    lastFindTerm = term;

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
  });

  ipcMain.on('find-modal-close', () => {
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
    }
  });

  // Persist window state on move/resize; debounce to avoid churn
  mainWindow.on('resize', () => scheduleSaveWindowState(mainWindow));
  mainWindow.on('move', () => scheduleSaveWindowState(mainWindow));
  // Also persist just before quit or close (in case of no recent move/resize)
  mainWindow.on('close', () => scheduleSaveWindowState(mainWindow));

  // Optional: hide instead of close when user closes window
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });


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

    // ---- NEW: About… item ----
    {
      label: 'About…',
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
        isQuitting = true; // so close handler doesn’t re-hide
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
  } catch {}
});

