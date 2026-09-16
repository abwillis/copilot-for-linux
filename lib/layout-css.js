// lib/layout-css.js  — Copilot-specific layout CSS injection
// This module is NOT shared between apps; each app has its own layout-css.js
// that exports the same shape of API but with app-specific CSS rules.
//
// -----------------------------------------------------------------------------
// DESIGN NOTE (2026 rewrite): why this file no longer names Copilot internals
// -----------------------------------------------------------------------------
// The previous version pinned the expansion to ~30 literal hooks lifted from the
// shipped bundle: .fai-CopilotMessage__content, [data-testid="chatOutput"],
// [data-testid="MessageListContainer"], [id*="chatMessageResponser"],
// [class*="m365-chat-llm-web-ui-chat-chat-message"], ... Every one of those is a
// build artifact of the web app. A Fluent version bump or a component rename
// silently drops a rule and the transcript snaps back to the centered column,
// with no error anywhere.
//
// This version keys on things Copilot cannot change without breaking its own
// accessibility and its own DOM shape:
//
//   1. ARIA roles          role="feed" / role="log" / role="article"
//   2. Structure            "a wrapper that CONTAINS a message must not clamp"
//                           expressed with :has() instead of a class name
//   3. Attribute substrings [class*="message" i] / [data-testid*="message" i]
//                           rather than exact, versioned class strings
//
// The centering is implemented by the app as a max-width clamp + auto side
// margins on the column wrapper(s) above each message. So the whole job is:
// find those wrappers WITHOUT naming them, and null the clamp. The :has()
// ladders below do exactly that, bounded to WRAPPER_DEPTH levels so the
// selector cost stays predictable.
//
// Everything is scoped to a real conversation container. On the empty new-chat
// screen nothing matches and the stylesheet is inert — this is the lesson the
// Grok port learned the hard way (a blanket `main { width:100% }` rule shoved
// the centered composer off screen).
// -----------------------------------------------------------------------------
'use strict';

const {
    callRendererMethodInAllFrames,
} = require('./renderer-api');

const {
    CHAT_SCOPE_PSEUDO,
    CHAT_MESSAGE_LIST_PSEUDO,
    CODE_PREVIEW_IFRAME_SELECTOR,
} = require('./chat-dom');

// Parameterized single-message selector (kept for API compatibility).
const messageContentById = (id) =>
    `${CHAT_SCOPE_PSEUDO} #${id}, ${CHAT_MESSAGE_LIST_PSEUDO} #${id}, [id="${id}"]`;

// --- Dynamic width constants -------------------------------------------------
const MAX_CHARS = 2048;
const VW_SIZE   = 100;
const MIN_VW    = 83;
const MAX_VW    = 100;

// Left gutter for assistant turns. Without it the un-clamped column sits flush
// against the pane edge, which reads as clipped. One character width tracks the
// font size instead of being a fixed pixel value. The right edge is left alone:
// box-sizing is border-box, so this takes its width from inside the CLAMP and
// does not push content rightward.
const CONTENT_PAD_LEFT = '1ch';

// How many wrapper levels between a conversation container and a message we are
// willing to un-clamp with :has(). 6 covers every Copilot layout observed so
// far (scroller > virtualizer > row > card > article). Raise only if a future
// UI nests deeper; each level adds one selector, not one DOM walk per node.
const WRAPPER_DEPTH = 6;

// --- Composer (input box) ----------------------------------------------------
// The composer lives OUTSIDE the conversation scope, so none of the transcript
// rules reach it -- which is why the transcript widened and the input box did
// not. It is widened with the same structural technique and the same CLAMP.
//
// Three guards keep this off the app shell:
//   1. ANCESTOR-OF-EDITOR, by descendant :has(). Deliberately NOT a
//      `:has(> div > div > ...)` depth chain like the transcript ladders use.
//      That chain only matches a run of literal `div` elements, and Copilot
//      nests its editor inside form/span/label wrappers -- so the chain broke
//      at the first non-div and section 7 matched NOTHING. Structure, not tag
//      names, is the durable signal here.
//   2. :not(:has(CONVO_SCOPE)). A wrapper that also contains the transcript IS
//      the shell, excluded structurally rather than by name. This is what
//      bounds the unbounded :has() at the top.
//   3. NO LANDMARKS. A wrapper containing nav/header/banner chrome is also
//      shell. On the empty new-chat screen there is no transcript, so guard 2
//      alone would let the page frame match -- this is the second bound, and
//      the reason the Grok-port failure (centered composer shoved off screen)
//      cannot repeat here.
//   4. MULTILINE EDITORS ONLY. contenteditable / textarea / role=textbox --
//      NOT a bare `input`, which would also match the sidebar search box.
const COMPOSER_SHELL_SELECTORS = [
    'nav',
    'header',
    '[role="navigation"]',
    '[role="banner"]',
];
const COMPOSER_SHELL_IS = `:is(${COMPOSER_SHELL_SELECTORS.join(', ')})`;

const COMPOSER_INPUT_SELECTORS = [
    '[contenteditable="true"]',
    'textarea',
    '[role="textbox"]',
];
const COMPOSER_INPUT_IS = `:is(${COMPOSER_INPUT_SELECTORS.join(', ')})`;

// --- Conversation scope ------------------------------------------------------
// Role-first, id/class-substring second. CHAT_MESSAGE_LIST_PSEUDO is included
// so chat-dom.js stays the single place to add a new root if one is ever
// needed, but nothing here DEPENDS on it matching.
const CONVO_SCOPE_SELECTORS = [
    CHAT_MESSAGE_LIST_PSEUDO,
    '[role="feed"]',
    '[role="log"]',
    '[id*="messagelist" i]',
    '[id*="chatmessagecontainer" i]',
    '[data-testid*="messagelist" i]',
    '[data-testid*="message-list" i]',
];
const CONVO_SCOPE = CONVO_SCOPE_SELECTORS.join(',\n');
const CONVO_SCOPE_IS = `:is(${CONVO_SCOPE_SELECTORS.join(', ')})`;

// --- What counts as a message ------------------------------------------------
// A message is an element the app marks as an article, or whose class/testid
// contains "message" but is not an action bar / toolbar variant of it.
const MESSAGE_SELECTORS = [
    '[role="article"]',
    'article',
    '[data-testid*="message" i]:not([data-testid*="action" i]):not([data-testid*="bar" i])',
    '[class*="message" i]:not([class*="action" i]):not([class*="bar" i]):not([class*="input" i])',
    '[id*="message-" i]',
];
const MESSAGE_IS = `:is(${MESSAGE_SELECTORS.join(', ')})`;

// User turns: right-aligned and shrink-to-fit, so they are excluded from the
// full-width content rule and handled separately.
const USER_MESSAGE_SELECTORS = [
    '[class*="usermessage" i]:not([class*="actionbar" i]):not([class*="action-bar" i])',
    '[class*="user-message" i]:not([class*="action" i])',
    '[data-testid*="usermessage" i]:not([data-testid*="action" i])',
    '[data-testid*="user-message" i]:not([data-testid*="action" i])',
    '[data-testid*="chatquestion" i]',
];
const USER_MESSAGE_IS = `:is(${USER_MESSAGE_SELECTORS.join(', ')})`;

// --- Chrome that must keep its natural size ----------------------------------
// Anything matching these keeps auto sizing even inside an expanded scope.
// Popovers, tooltips, menus and action bars break badly when forced to 100%.
const IGNORE_SELECTORS = [
    'button',
    '[role="button"]',
    '[type="button" i]',
    '[role="toolbar"]',
    '[role="status"]',
    '[role="tooltip"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="tab"]',
    '[role="textbox"]',
    '[contenteditable="true"]',
    'input',
    'textarea',
    'select',
    '[class*="button" i]',
    '[class*="menu" i]',
    '[class*="tooltip" i]',
    '[class*="popover" i]',
    '[class*="flyout" i]',
    '[class*="drawer" i]',
    '[class*="dialog" i]',
    '[class*="toolbar" i]',
    '[class*="actionbar" i]',
    '[class*="actionscontainer" i]',
    '[class*="messagebar" i]',
    '[class*="hovercard" i]',
    '[class*="avatar" i]',
    '[data-testid*="action" i]',
    '[data-testid*="toolbar" i]',
    '[data-testid*="tooltip" i]',
    '[data-tooltip]',
    '[data-popover]',
];
// --- Pasted/attached images --------------------------------------------------
// Attachment thumbnails are sized by the app (explicit width/height, or a
// fixed-size flex chip row). Section 5's blanket media rule
// `img { max-width:100%; height:auto }` overrides that: each thumbnail
// re-expands to the full un-clamped column width, so a two-image paste no
// longer fits side by side and the second one is pushed out of view. Zeroing
// the chip row's margins in section 1 is what drags the first one hard left.
//
// These are excluded from BOTH the un-clamp and the media rule so the app's own
// thumbnail sizing survives. Real inline content images -- screenshots and
// generated pictures in an answer body -- do not match these hooks and still
// get clamped to the column.
const ATTACHMENT_SELECTORS = [
    '[class*="attachment" i]',
    '[class*="thumbnail" i]',
    '[class*="filechip" i]',
    '[class*="file-chip" i]',
    '[class*="imagechip" i]',
    '[class*="image-chip" i]',
    '[data-testid*="attachment" i]',
    '[data-testid*="thumbnail" i]',
];
const ATTACHMENT_IS = `:is(${ATTACHMENT_SELECTORS.join(', ')})`;

const IGNORE_JOINED = IGNORE_SELECTORS.concat(ATTACHMENT_SELECTORS).join(', ');
const IGNORE_IS = `:is(${IGNORE_JOINED})`;

// --- Selector groups (exported for API compatibility) ------------------------
const SELECTORS = Object.freeze({
    chatScope:   CHAT_SCOPE_PSEUDO,
    messageList: CHAT_MESSAGE_LIST_PSEUDO,
    convoScope:  CONVO_SCOPE_IS,
    message:     MESSAGE_IS,
    userMessage: USER_MESSAGE_IS,
});

// -----------------------------------------------------------------------------
// Structural ladders
// -----------------------------------------------------------------------------
// descendantLadder(target, depth)
//   Wrappers INSIDE the conversation scope that contain a message at depth
//   0..depth-1:  div:has(> T), div:has(> div > T), div:has(> div > div > T) ...
//   These are the column wrappers that carry the max-width clamp.
function descendantLadder(target, depth = WRAPPER_DEPTH) {
    return Array.from({ length: depth }, (_, i) =>
        `${CONVO_SCOPE_IS} :is(div, section, article, li):has(> ${'div > '.repeat(i)}${target})`
    );
}
// ancestorLadder(target, depth)
//   Wrappers ABOVE the conversation scope (scroller / pane / column) that also
//   clamp. Anchored at `body` so it never touches html itself.
function ancestorLadder(target, depth = WRAPPER_DEPTH) {
    return Array.from({ length: depth }, (_, i) =>
        `body :is(div, main, section):has(> ${'div > '.repeat(i)}${target})`
    );
}

// composerWrappers(target)
//   Every wrapper that CONTAINS the composer's editor at any depth, minus the
//   app shell. One selector, not a ladder: `:has(target)` is a descendant
//   match, so intervening form/span/label elements no longer break the chain.
//
//   The two :not(:has(...)) guards are what make an unbounded :has() safe --
//   they cut the match off below the transcript container and below any
//   nav/header landmark, which is where the shell begins.
function composerWrappers(target) {
    return `body :is(div, form, section)`
        + `:not(:has(${CONVO_SCOPE_IS}))`
        + `:not(:has(${COMPOSER_SHELL_IS}))`
        + `:has(${target})`;
}

// --- CSS caching & injection bookkeeping -------------------------------------
const maxLayoutCssCache      = new Map();
const injectedFrameIdsByWC   = new WeakMap();
const insertedMainCssKeyByWC = new WeakMap();
const cssApplyDebounceByWC   = new WeakMap();
 
// --- buildMaxLayoutCSS -------------------------------------------------------

function buildMaxLayoutCSS({ specificMessageId } = {}) {
    // Column wrappers to un-clamp: above the transcript and inside it.
    const UNCLAMP = [
        ...ancestorLadder(CONVO_SCOPE_IS),
        ...descendantLadder(MESSAGE_IS),
    ].join(',\n');

    // Content targets: the assistant turns themselves.
    const CONTENT = [
        specificMessageId ? messageContentById(specificMessageId) : null,
        `${CONVO_SCOPE_IS} ${MESSAGE_IS}:not(${USER_MESSAGE_IS})`,
    ].filter(Boolean).join(',\n');

    // Table wrappers: a table's own scroll container is usually clamped too.
    const TABLE_WRAPPERS = Array.from({ length: 3 }, (_, i) =>
        `${CONVO_SCOPE_IS} div:has(> ${'div > '.repeat(i)}table)`
    ).join(',\n');

    const CLAMP = `min(min(var(--copilot-vw, ${VW_SIZE}vw), 92vw), ${MAX_CHARS}ch)`;

    // Composer wrappers, and the editors inside them.
    const COMPOSER_LADDER = composerWrappers(COMPOSER_INPUT_IS);
    const COMPOSER_LADDER_INPUTS = `${COMPOSER_LADDER} ${COMPOSER_INPUT_IS}`;

    return String.raw`
/* === Copilot layout: full-width transcript ================================ */
/* Root var read by renderer/agent.js seedTargetVW / startVWResize.          */
html { --copilot-vw: ${VW_SIZE}vw; }

/* Page level: never allow a horizontal scrollbar to appear from our widening.
   Deliberately no width/height/background overrides here — the app owns those,
   and forcing them is what used to fight the shell on the new-chat screen. */
html, body {
    overflow-x: hidden !important;
    overscroll-behavior-x: none !important;
}
@supports (overflow: clip) {
    html, body { overflow-x: clip !important; }
}

/* -------------------------------------------------------------------------- */
/* 1. Un-clamp the centering column.                                          */
/*                                                                            */
/* This is the whole trick. Instead of naming the wrapper, we select any       */
/* wrapper that CONTAINS a message (or contains the transcript) and null its   */
/* max-width plus its auto side margins. Renaming a class cannot break this;   */
/* only removing role="article"/"feed" and every "message" attribute could.    */
/* -------------------------------------------------------------------------- */
${UNCLAMP} {
    max-width: none !important;
    width: 100% !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    box-sizing: border-box !important;
}

/* Attachment chip rows keep their own width and margins. Un-clamping them
   stretches the row to the full column and zeroes its side margins, which
   dragged pasted images hard left. Placed after the rule above so it wins. */
${CONVO_SCOPE_IS} ${ATTACHMENT_IS},
${CONVO_SCOPE_IS} ${ATTACHMENT_IS} * {
    width: auto !important;
    max-width: none !important;
    margin: initial !important;
}

/* The transcript container itself. */
${CONVO_SCOPE} {
    width: 100% !important;
    max-width: none !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    overflow-x: hidden !important;
    box-sizing: border-box !important;
}

/* Left gutter, applied exactly once. The :not() excludes any conversation
   scope nested inside another conversation scope, so the padding can never
   stack no matter how many CONVO_SCOPE_SELECTORS a given container matches. */
${CONVO_SCOPE_IS}:not(${CONVO_SCOPE_IS} *) {
    padding-left: ${CONTENT_PAD_LEFT} !important;
}

/* Wrapping applies to conversation content only — never the app shell. */
${CONVO_SCOPE_IS},
${CONVO_SCOPE_IS} * {
    box-sizing: border-box !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
}

/* -------------------------------------------------------------------------- */
/* 2. Guard: restore natural sizing for chrome inside the expanded scope.      */
/*    Placed AFTER the un-clamp rules so it wins on equal specificity.         */
/* -------------------------------------------------------------------------- */
${CONVO_SCOPE_IS} ${IGNORE_IS},
${CONVO_SCOPE_IS} ${IGNORE_IS} * {
    width: auto !important;
    max-width: none !important;
    min-width: initial !important;
    margin: initial !important;
    padding: initial !important;
    overflow-wrap: normal !important;
    word-break: normal !important;
}

/* -------------------------------------------------------------------------- */
/* 3. Assistant turns: full width, left aligned, clamped by --copilot-vw.      */
/* -------------------------------------------------------------------------- */
${CONTENT} {
    width: 100% !important;
    max-width: ${CLAMP} !important;
    margin-left: 0 !important;
    margin-right: auto !important;
    padding-left: 0 !important;
    padding-right: 12px !important;
    text-align: left !important;
    box-sizing: border-box !important;
}

/* -------------------------------------------------------------------------- */
/* 4. User turns: shrink-to-fit, right aligned (Copilot's own convention).     */
/* -------------------------------------------------------------------------- */
${CONVO_SCOPE_IS} ${USER_MESSAGE_IS} {
    width: auto !important;
    max-width: ${CLAMP} !important;
    margin-left: auto !important;
    margin-right: 0 !important;
    align-self: flex-end !important;
    justify-self: end !important;
    place-self: end !important;
    display: block !important;
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
}

/* -------------------------------------------------------------------------- */
/* 5. Content primitives inside a turn.                                        */
/* -------------------------------------------------------------------------- */
${CONVO_SCOPE_IS} pre,
${CONVO_SCOPE_IS} code,
${CONVO_SCOPE_IS} kbd,
${CONVO_SCOPE_IS} samp {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    max-width: 100% !important;
}
${CONVO_SCOPE_IS} pre {
    width: 100% !important;
    overflow-x: hidden !important;
    box-sizing: border-box !important;
}

${TABLE_WRAPPERS} {
    width: 100% !important;
    max-width: ${CLAMP} !important;
    margin-left: 0 !important;
    margin-right: auto !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
}
${CONVO_SCOPE_IS} table {
    table-layout: auto !important;
    max-width: ${CLAMP} !important;
    border-collapse: collapse !important;
    display: table !important;
}
${CONVO_SCOPE_IS} th,
${CONVO_SCOPE_IS} td {
    white-space: normal !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    vertical-align: top !important;
    max-width: none !important;
}

/* Inline content media. Attachment thumbnails are excluded: forcing
   height:auto on them re-expands each to the full column width, which is what
   pushed a two-image paste off screen. They keep the app's own sizing. */
${CONVO_SCOPE_IS} img:not(${ATTACHMENT_IS}):not(${ATTACHMENT_IS} *),
${CONVO_SCOPE_IS} svg:not(${ATTACHMENT_IS}):not(${ATTACHMENT_IS} *),
${CONVO_SCOPE_IS} canvas:not(${ATTACHMENT_IS} *),
${CONVO_SCOPE_IS} video:not(${ATTACHMENT_IS} *),
${CONVO_SCOPE_IS} embed:not(${ATTACHMENT_IS} *) {
    max-width: 100% !important;
    height: auto !important;
}

${CONVO_SCOPE_IS} a {
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
}

${CONVO_SCOPE_IS} [class*="katex" i],
${CONVO_SCOPE_IS} [class*="math" i],
${CONVO_SCOPE_IS} math {
    max-width: 100% !important;
    overflow-x: auto !important;
    overflow-y: hidden !important;
}

/* -------------------------------------------------------------------------- */
/* 6. Code-preview iframes. Selector lives in chat-dom.js; JS sets the real    */
/*    height, this only guarantees width and a sane floor.                     */
/* -------------------------------------------------------------------------- */
${CODE_PREVIEW_IFRAME_SELECTOR} {
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    min-height: 333px !important;
    height: auto !important;
    border: 0 !important;
    box-sizing: border-box !important;
    overflow: visible !important;
}
/* -------------------------------------------------------------------------- */
/* 7. Composer (input box).                                                    */
/*                                                                            */
/* Same CLAMP as the transcript so the two edges line up, and the same 1ch     */
/* left gutter. Width only -- height, the send button and the attachment row   */
/* keep whatever the app gives them.                                           */
/*                                                                            */
/* The :not(:has(...)) in the ladder excludes the app shell structurally, so   */
/* this cannot widen the page frame. On the empty new-chat screen the rule     */
/* still matches only the composer's own wrapper, which is the intended        */
/* target there too.                                                          */
/* -------------------------------------------------------------------------- */
${COMPOSER_LADDER} {
    width: 100% !important;
    max-width: ${CLAMP} !important;
    min-width: 0 !important;
    margin-left: 0 !important;
    margin-right: auto !important;
    padding-left: ${CONTENT_PAD_LEFT} !important;
    box-sizing: border-box !important;
}

/* The editor itself fills the widened wrapper. Scoped to the same ladder so
   it can never reach a textbox elsewhere in the app. */
${COMPOSER_LADDER_INPUTS} {
    width: 100% !important;
    max-width: 100% !important;
    min-width: 0 !important;
    box-sizing: border-box !important;
}
`;
}

// --- applyMaxLayoutCSS -------------------------------------------------------
function applyMaxLayoutCSS(win, { specificMessageId } = {}) {
    if (!win) return;
    const cacheKey = specificMessageId || 'default';
    let css = maxLayoutCssCache.get(cacheKey);
    if (!css) {
        // buildMaxLayoutCSS() is one big template literal: a ReferenceError in
        // ANY interpolated section aborts the whole function before it returns
        // a single byte, so no stylesheet is injected and every expansion --
        // transcript, gutter, tables, iframes -- silently reverts.
        //
        // That is exactly what happened when section 7 (composer) was added
        // while COMPOSER_LADDER / COMPOSER_LADDER_INPUTS were left undeclared:
        // "ReferenceError: COMPOSER_LADDER is not defined", swallowed by the
        // caller's try/catch, presenting as "the layout code stopped working"
        // with nothing in the log pointing at the composer rules.
        //
        // Log it loudly and keep going with whatever is cached, so a future
        // edit to one section can never take the other six down with it.
        try {
            css = buildMaxLayoutCSS({ specificMessageId });
        } catch (err) {
            try {
                console.error(
                    '[layout-css] buildMaxLayoutCSS threw; layout CSS NOT applied. '
                    + 'A selector/constant referenced by the template is missing:',
                    err
                );
            } catch {}
            return;
        }
        maxLayoutCssCache.set(cacheKey, css);
    }
    if (win.__appRole === 'quick') {
        injectCSSIntoAllFrames(win, css);
        return;
    }
    if (!win.__maxLayoutKeyHolder) {
        win.__maxLayoutKeyHolder = { key: null, css: '', __wired: false };
    }
    injectCSSOnLoad(win, css, win.__maxLayoutKeyHolder);
}

// --- injectCSSOnLoad ---------------------------------------------------------
function injectCSSOnLoad(win, css, keyHolder) {
    if (!win || !win.webContents) return;
    const wc = win.webContents;
    if (!keyHolder) return;
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

    if (!keyHolder.__wired) {
        keyHolder.__wired = true;
        wc.on('dom-ready', inject);
        wc.on('did-finish-load', inject);
        wc.on('did-navigate-in-page', inject);
        wc.on('did-start-navigation', inject);
    }
    inject();
}

// --- injectCSSIntoAllFrames --------------------------------------------------
function injectCSSIntoAllFrames(win, css) {
    if (!win || !win.webContents) return;
    const wc = win.webContents;
    const apply = () => {
        try {
            const prev = cssApplyDebounceByWC.get(wc);
            if (prev) clearTimeout(prev);
            const t = setTimeout(() => {
                try {
                    // Frames can navigate while keeping the same routingId and
                    // CSS is dropped on navigation, so bookkeeping is reset on
                    // every apply instead of being treated as permanent.
                    const injected = new Set();
                    injectedFrameIdsByWC.set(wc, injected);

                    const frames = wc.mainFrame?.framesInSubtree ?? wc.mainFrame?.frames ?? [];
                    for (const f of frames) {
                        try {
                            const rid = (typeof f?.routingId === 'number') ? f.routingId : null;
                            f.insertCSS(css).then(() => { if (rid !== null) injected.add(rid); }).catch(() => {});
                        } catch {}
                    }

                    const prevKey = insertedMainCssKeyByWC.get(wc);
                    if (prevKey) { try { wc.removeInsertedCSS(prevKey); } catch {} }
                    try {
                        wc.insertCSS(css).then((k) => { insertedMainCssKeyByWC.set(wc, k); }).catch(() => {});
                    } catch {}
                } catch {}
            }, 150);
            cssApplyDebounceByWC.set(wc, t);
        } catch {}
    };
    wc.on('dom-ready', apply);
    wc.on('did-frame-finish-load', apply);
    wc.on('did-navigate-in-page', apply);
    wc.on('did-frame-navigate', apply);
    apply();
}

// --- requestExpandedLayout ---------------------------------------------------
function requestExpandedLayout(win) {
    if (!win || !win.webContents) return;
    const script = `
(function() {
    try {
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
    win.webContents.on('did-finish-load', run);
    win.webContents.on('did-navigate-in-page', run);
}

// -----------------------------------------------------------------------------
// Find-in-page content-visibility on-demand override
// -----------------------------------------------------------------------------
// Copilot applies content-visibility:auto to off-screen rows; Chromium's
// findInPage() skips unrendered subtrees. This CSS layer is inserted only while
// the Find modal is open and removed on close, so the lazy-render optimisation
// survives normal browsing.
// -----------------------------------------------------------------------------
let findCVKey = null;
let findCVWebContents = null;

function buildFindContentVisibilityCSS() {
    // :not(#_cv) chains give (0,N,0) specificity — beats any class-based
    // !important rule the web app may use.
    const BOOST = ':not(#_cv):not(#_cv):not(#_cv):not(#_cv):not(#_cv)';
    return `
    html${BOOST},
    html${BOOST} * {
        content-visibility: visible !important;
        contain-intrinsic-size: auto !important;
    }
    ${CONVO_SCOPE_IS} *,
    ${CHAT_SCOPE_PSEUDO} *,
    [role="feed"] *,
    [role="article"] * {
        contain: none !important;
    }
    [style*="content-visibility"] {
        content-visibility: visible !important;
        contain-intrinsic-size: auto !important;
        contain: none !important;
    }
    `;
}

// -----------------------------------------------------------------------------
// Factory: createLayoutCSS(deps)
// -----------------------------------------------------------------------------
// deps.rendererApiGlobal  window-side global used by renderer/agent.js
// deps.dynamicWidth       app.config.js dynamicWidth block ({ cssVar, ... })
//
// Unchanged from the previous revision: main.js already consumes this shape,
// and it is identical to the Grok/Gemini factories.
// -----------------------------------------------------------------------------
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

        try {
            if (findCVWebContents === wc && findCVKey) {
                try { await wc.removeInsertedCSS(findCVKey).catch(() => {}); } catch {}
                findCVKey = null;
            }
            const css = buildFindContentVisibilityCSS();
            findCVKey = await wc.insertCSS(css);
            findCVWebContents = wc;

            try {
                const frames = wc.mainFrame?.framesInSubtree ?? [];
                for (const f of frames) {
                    try { f.insertCSS(css).catch(() => {}); } catch {}
                }
            } catch {}
        } catch (err) {
            console.error('enableFindContentVisibility CSS failed:', err);
        }

        try {
            const results = await callRAFrames({ webContents: wc }, 'enableFindContentVisibility');
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
            await callRAFrames({ webContents: wc }, 'disableFindContentVisibility');
        } catch {}
    }

    async function applyDynamicWidth(win) {
        if (!win?.webContents) return;
        if (!dynamicWidth || !dynamicWidth.cssVar) {
            try { console.warn('[layout-css] applyDynamicWidth: dynamicWidth config missing; skipping.'); } catch {}
            return;
        }
        try {
            await callRAFrames(
                { webContents: win.webContents },
                'seedTargetVW',
                { vw: Number(dynamicWidth.defaultVw) || VW_SIZE }
            );
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
            try { console.warn('[layout-css] attachVWResize: dynamicWidth config missing; skipping.'); } catch {}
            return;
        }

        const install = async () => {
            try {
                await callRAFrames(
                    { webContents: wc },
                    'startVWResize',
                    { screenPercent: Number(dynamicWidth.screenPercent) || dynamicWidth.maxVw || MAX_VW }
                );
            } catch (err) {
                console.error('attachVWResize failed:', err);
            }
        };

        wc.once('dom-ready', install);
    }

    return {
        applyMaxLayoutCSS,
        requestExpandedLayout,
        buildFindContentVisibilityCSS,
        applyDynamicWidth,
        attachVWResize,
        enableFindContentVisibility,
        disableFindContentVisibility,
    };
}

module.exports = {
    SELECTORS,
    IGNORE_SELECTORS,
    IGNORE_JOINED,
    CONVO_SCOPE_SELECTORS,
    MESSAGE_SELECTORS,
    USER_MESSAGE_SELECTORS,
    WRAPPER_DEPTH,
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
