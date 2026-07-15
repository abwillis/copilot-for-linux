'use strict';

const {
    callRendererMethodInAllFrames,
} = require('./renderer-api');


const {
    CHAT_ROOT_SELECTORS,
    CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_PSEUDO,
    CODE_PREVIEW_IFRAME_SELECTOR,
} = require('./chat-dom');

// Parameterized single-message selector
const messageContentById = (id) => `${CHAT_SCOPE_PSEUDO} #${id}, ${CHAT_MESSAGE_LIST_PSEUDO} #${id}, [id="${id}"]`;

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

  // Content targets (do NOT force height: 100vh here)
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
 * Removed the following from the IGNORE List above
 *  `rich-textarea`,
 *  `rich-textarea .ql-editor[contenteditable=\"true\"]`,
 *  `.text-input-field_textarea .ql-editor[contenteditable=\"true\"]`,
 *  `.ql-editor[contenteditable=\"true\"]`,
 *  `div[contenteditable=\"true\"][role=\"textbox\"]`,
 *  `textarea`,
 *  `input`,
 *  `[contenteditable=\"true\"]`,
 *  `[class*="chatinput" i]`,
 *  `[id*="ChatInput" i]`,
 *  `[class*="chat-input" i]`,
 *  `[id*="chat-input" i]`,
 *  `[class*="editorinput" i]` ,
 *  `[class*="usermessage" i]` ,
 *  `[id*="user-message"]` ,
 */

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
    if (win.__appRole === 'quick') {
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

// ---------------------------------------------------------------------------
// Find-in-page content-visibility on-demand override
// ---------------------------------------------------------------------------
// The Copilot / Gemini / Grok web apps apply content-visibility:auto to
// off-screen message items for faster initial paint. Chromium's findInPage()
// skips those unrendered subtrees entirely.  We inject a CSS layer + a
// renderer-agent JS layer only while the Find modal is open, then remove
// both on close so the lazy-render optimisation is preserved during normal
// browsing.
//
// Module-level state is intentional here: only one Find modal can be active
// at a time in this app, so a shared per-webContents key/wc pair is fine.
// ---------------------------------------------------------------------------
let findCVKey = null;
let findCVWebContents = null;

function buildFindContentVisibilityCSS() {
    // :not(#_cv) chains give (0,N,0) specificity — beats any class-based
    // !important rule the web app may use.
    const BOOST = ':not(#_cv):not(#_cv):not(#_cv):not(#_cv):not(#_cv)';
    return `
    /* === Nuclear: override content-visibility on ALL elements === */
    /* Specificity (0,5,1) beats any class/attr !important rule     */
    html${BOOST},
    html${BOOST} * {
        content-visibility: visible !important;
        contain-intrinsic-size: auto !important;
    }
    /* === Remove containment from chat scope elements === */
    ${CHAT_MESSAGE_LIST_PSEUDO} *,
    ${CHAT_SCOPE_PSEUDO} *,
    [role="feed"] *,
    [role="article"] *,
    [data-testid*="copilot-message"] *,
    [id^="copilot-message-" i] * {
        contain: none !important;
    }
    /* === Catch-all: inline content-visibility from app JS === */
    [style*="content-visibility"] {
        content-visibility: visible !important;
        contain-intrinsic-size: auto !important;
        contain: none !important;
    }
    `;
}

// ---------------------------------------------------------------------------
// Factory: createLayoutCSS(deps)
// ---------------------------------------------------------------------------
// deps.rendererApiGlobal (string, optional)
//   The window-side global name used by renderer/agent.js in this app.  When
//   provided, every renderer-agent call made from this module tags its
//   invocation with { __rendererApiOptions: { rendererApiGlobal } } so the
//   shared lib/renderer-api.js does not fall back to its default
//   '__appRenderer'.  This is what keeps this module cross-project safe.
//
// The returned object exposes the same public API this module has always
// exported.  Consumers that already destructure the module directly (main.js,
// find-in-page.js) can migrate incrementally by calling createLayoutCSS(...)
// at startup and destructuring from the returned object.
// ---------------------------------------------------------------------------
function createLayoutCSS(deps = {}) {
    const { rendererApiGlobal, dynamicWidth } = deps;
    const RENDERER_API_OPTIONS = rendererApiGlobal
        ? { __rendererApiOptions: { rendererApiGlobal } }
        : null;

    if (!rendererApiGlobal) {
        try {
            console.warn('[layout-css] createLayoutCSS: rendererApiGlobal not provided; '
                + 'renderer-agent calls will fall back to the shared default '
                + "'__appRenderer'. Pass rendererApiGlobal from app.config.js.");
        } catch {}
    }

    function withRendererApiOptions(args) {
        return RENDERER_API_OPTIONS ? args.concat(RENDERER_API_OPTIONS) : args;
    }

    function callRAFrames(win, method, ...args) {
        return callRendererMethodInAllFrames(
            win,
            method,
            ...withRendererApiOptions(args)
        );
    }

    async function enableFindContentVisibility(win) {
        if (!win?.webContents) return;
        const wc = win.webContents;

        // Layer 1: CSS (specificity boost that beats app !important rules).
        try {
            if (findCVWebContents === wc && findCVKey) {
                try { await wc.removeInsertedCSS(findCVKey).catch(() => {}); } catch {}
                findCVKey = null;
            }
            const css = buildFindContentVisibilityCSS();
            findCVKey = await wc.insertCSS(css);
            findCVWebContents = wc;

            // Same CSS into subframes for iframe-hosted UI.
            try {
                const frames = wc.mainFrame?.framesInSubtree ?? [];
                for (const f of frames) {
                    try { f.insertCSS(css).catch(() => {}); } catch {}
                }
            } catch {}
        } catch (err) {
            console.error('enableFindContentVisibility CSS failed:', err);
        }

        // Layer 2: renderer-agent JS override (targets the app-configured
        // renderer global via rendererApiGlobal).
        try {
            const results = await callRAFrames(
                { webContents: wc },
                'enableFindContentVisibility'
            );
            try { console.log('[find-visibility] enable renderer-agent:', results); } catch {}
            try {
                const missing = (results || []).filter(r => r?.value?.missing);
                if (missing.length) {
                    console.warn('[find-visibility] enable renderer-agent MISSING method on some frames:', missing);
                }
            } catch {}
        } catch (err) {
            console.error('enableFindContentVisibility renderer-agent failed:', err);
        }
    }

    async function disableFindContentVisibility() {
        const wc = findCVWebContents;
        const key = findCVKey;
        findCVKey = null;
        findCVWebContents = null;

        if (!wc) return;

        if (key) {
            try { await wc.removeInsertedCSS(key).catch(() => {}); } catch {}
        }

        try {
            const results = await callRAFrames(
                { webContents: wc },
                'disableFindContentVisibility'
            );
            try { console.log('[find-visibility] disable renderer-agent:', results); } catch {}
            try {
                const missing = (results || []).filter(r => r?.value?.missing);
                if (missing.length) {
                    console.warn('[find-visibility] disable renderer-agent MISSING method on some frames:', missing);
                }
            } catch {}
        } catch {}
    }

    async function applyDynamicWidth(win) {
        if (!win?.webContents) return;
        if (!dynamicWidth || !dynamicWidth.cssVar) {
            try {
                console.warn('[layout-css] applyDynamicWidth: dynamicWidth config missing; skipping.');
            } catch {}
            return;
        }
        try {
            const result = await callRAFrames(
                { webContents: win.webContents },
                'seedTargetVW',
                { vw: Number(dynamicWidth.defaultVw) || 100 }
            );
            try {
                const missing = (result || []).filter(r => r?.value?.missing);
                if (missing.length) {
                    console.warn('[layout-css] applyDynamicWidth: seedTargetVW MISSING on some frames:', missing);
                }
            } catch {}
        } catch (err) {
            console.error('applyDynamicWidth failed:', err);
        }
    }

    async function attachVWResize(win) {
        if (!win?.webContents) return;
        const wc = win.webContents;
        if (wc.__vwResizeAttached) return;
        wc.__vwResizeAttached = true;

        if (!dynamicWidth || !dynamicWidth.cssVar) {
            try {
                console.warn('[layout-css] attachVWResize: dynamicWidth config missing; skipping.');
            } catch {}
            return;
        }

        const install = async () => {
            try {
                const result = await callRAFrames(
                    { webContents: wc },
                    'startVWResize',
                    { screenPercent: Number(dynamicWidth.screenPercent) || dynamicWidth.maxVw || 100 }
                );
                try {
                    const missing = (result || []).filter(r => r?.value?.missing);
                    if (missing.length) {
                        console.warn('[layout-css] attachVWResize: startVWResize MISSING on some frames:', missing);
                    }
                } catch {}
            } catch (err) {
                console.error('attachVWResize failed:', err);
            }
        };

        wc.once('dom-ready', install);
    }

    return {
        // CSS-only helpers pass through unchanged, exposed here so a consumer
        // that only uses the factory does not also have to import layout-css
        // at module scope.
        applyMaxLayoutCSS,
        requestExpandedLayout,
        buildFindContentVisibilityCSS,
        applyDynamicWidth,
        attachVWResize,
        // Renderer-agent-backed helpers now honor the app's rendererApiGlobal.
        enableFindContentVisibility,
        disableFindContentVisibility,
    };
}

module.exports = {
    SELECTORS,
    IGNORE_SELECTORS,
    IGNORE_JOINED,
    messageContentById,
    MAX_CHARS,
    VW_SIZE,
    MIN_VW,
    MAX_VW,
    buildMaxLayoutCSS,
    maxLayoutCssCache,
    injectedFrameIdsByWC,
    insertedMainCssKeyByWC,
    cssApplyDebounceByWC,
    injectCSSOnLoad,
    injectCSSIntoAllFrames,
    applyMaxLayoutCSS,
    requestExpandedLayout,
    buildFindContentVisibilityCSS,
    createLayoutCSS,
};
