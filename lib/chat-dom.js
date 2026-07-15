'use strict';

// === Shared DOM selectors used by layout + export logic ===

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

// Content that should make an otherwise text-empty wrapper worth keeping.
// This is important for export paths because image-only wrappers usually have
// empty textContent, and the old cleanup logic could remove them.
const DOM_PRESERVE_CONTENT_SELECTORS = [
  '[data-preserve]',
  'pre',
  'code',
  'table',
  'ul',
  'ol',
  'img',
  'picture',
  'svg',
  'canvas',
  'video',
  'iframe'
];

// Print-time CSS injected by the shared PDF exporter, scoped to the marked
// pane via [data-pdf-export-target="1"]. Each app provides its own selectors
// because chat-bubble structure is per-app.
//
// Copilot: neutralizes the .fai-UserMessage clamp (overflow:hidden +
// max-height:140px) that caused the PDF to drop user-input text past ~5
// lines, while keeping the live UI untouched (the stylesheet is removed
// in the exporter's finally block).
const PRINT_BUBBLE_CSS = `
  /* ---------------------------------------------------------------------- */
  /* 1. Message clamp neutralizer (user and assistant messages).            */
  /*                                                                        */
  /* Copilot uses overflow:hidden + max-height clamps to implement "Show    */
  /* more lines" on both user inputs and assistant cards (incl. answer      */
  /* cards, citation/reference cards, and reasoning panels). The button     */
  /* that expands them is not ARIA disclosure, so the rules in section 3   */
  /* below do not catch them. Lifting the clamp anywhere inside a .fai-*    */
  /* subtree captures all variants without affecting the Fluent             */
  /* virtualizer internals (handled separately in section 2).               */
  /* ---------------------------------------------------------------------- *
  [data-pdf-export-target="1"] [class*="fai-UserMessage"],
  [data-pdf-export-target="1"] [class*="fai-UserMessage"] *,
  [data-pdf-export-target="1"] [class*="fai-AssistantMessage"],
  [data-pdf-export-target="1"] [class*="fai-AssistantMessage"] *,
  [data-pdf-export-target="1"] [class*="fai-AnswerCard"],
  [data-pdf-export-target="1"] [class*="fai-AnswerCard"] *,
  [data-pdf-export-target="1"] [class*="fai-Reference"],
  [data-pdf-export-target="1"] [class*="fai-Reference"] *,
  [data-pdf-export-target="1"] [class*="fai-Citation"],
  [data-pdf-export-target="1"] [class*="fai-Citation"] *,
  [data-pdf-export-target="1"] [class*="fai-Reasoning"],
  [data-pdf-export-target="1"] [class*="fai-Reasoning"] *,
  [data-pdf-export-target="1"] [class*="fai-Sources"],
  [data-pdf-export-target="1"] [class*="fai-Sources"] * {
    max-height: none !important;
    overflow: visible !important;
    -webkit-line-clamp: unset !important;
    line-clamp: unset !important;
  }
  /* Catch inline-style clamps too — Copilot uses both class-driven and
     style-driven clamps depending on the component. */
  [data-pdf-export-target="1"] [class*="fai-"][style*="max-height"],
  [data-pdf-export-target="1"] [class*="fai-"][style*="-webkit-line-clamp"] {
    max-height: none !important;
    -webkit-line-clamp: unset !important;
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Defeat Fluent virtualization during print.                          */
  /*                                                                        */
  /* The Fluent virtualizer wraps the chat in a container that uses         */
  /*   contain: strict | size                                               */
  /*   content-visibility: auto                                             */
  /*   overflow: auto                                                       */
  /* and absolute-positions item rows so only the viewport-intersecting     */
  /* ones are rendered. For PDF export we need all items rendered at once.  */
  /* Removing those three properties causes the virtualizer's items to lay  */
  /* out in document order with their natural heights.                      */
  /* ---------------------------------------------------------------------- */
  [data-pdf-export-target="1"] [class*="fui-Virtualizer"],
  [data-pdf-export-target="1"] [class*="fui-Virtualizer"] * {
    contain: none !important;
    content-visibility: visible !important;
    overflow: visible !important;
    max-height: none !important;
    height: auto !important;
  }
  /* Items inside the virtualizer are positioned absolutely; force flow. */
  [data-pdf-export-target="1"] [class*="fui-Virtualizer-Scroll-View"] > *,
  [data-pdf-export-target="1"] [class*="fui-Virtualizer"] > * {
    position: static !important;
    transform: none !important;
    top: auto !important;
    left: auto !important;
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Force collapsibles open (citations "Show more", reasoning, etc.).   */
  /*                                                                        */
  /* CSS-only: no clicks, no SPA handlers, no risk of opening menus.        */
  /* Reveals the controlled region directly. Used in citation/sources       */
  /* cards and answer-card reasoning sections that the JS allow-list does   */
  /* not match.                                                             */
  /* ---------------------------------------------------------------------- */
  [data-pdf-export-target="1"] [aria-expanded="false"] + [hidden],
  [data-pdf-export-target="1"] [aria-expanded="false"] ~ [aria-hidden="true"],
  [data-pdf-export-target="1"] [data-state="closed"] {
    display: revert !important;
    visibility: visible !important;
    opacity: 1 !important;
    max-height: none !important;
    overflow: visible !important;
    pointer-events: auto !important;
  }
  /* Whatever the trigger controls inside the marked pane: reveal it.       */
  [data-pdf-export-target="1"] [aria-hidden="true"] {
    display: revert !important;
    visibility: visible !important;
    max-height: none !important;
    overflow: visible !important;
  }
  /* details elements (native disclosure widgets) */
  [data-pdf-export-target="1"] details {
    display: block !important;
  }
  [data-pdf-export-target="1"] details > *:not(summary) {
    display: revert !important;
  }

  /* ---------------------------------------------------------------------- */
  /* 4. Print-paper consistency.                                            */
  /*                                                                        */
  /* (a) Anchor the dark background to <html>/<body> so every printed page  */
  /*     gets the same paper color, not just the pages where Copilot's      */
  /*     dark container happens to extend.                                  */
  /* (b) Suppress the trailing blank page that Chromium's printToPDF emits  */
  /*     when the document height slightly exceeds an exact page multiple. */
  /* ---------------------------------------------------------------------- */
  @media print {
    /* (a) Force the page background so it cannot fall back to paper white
           after the last chat element. The values match Copilot's dark
           theme tokens; if Copilot is in light theme at export time the
           override is identical to its existing background, so no visual
           change. */
    html, body {
      background: #1f1f1f !important;
      color-scheme: dark !important;
    }
    /* Print Chromium honors printBackground:true on direct children of
       <html>; ensure the body actually has a background fill. */
    body {
      background-color: #1f1f1f !important;
    }

    /* (b) Stop trailing whitespace from generating a phantom last page.
           Drop any margin-bottom / padding-bottom on the marked pane and
           its last child, and elide any zero-height sibling at the tail. */
    [data-pdf-export-target="1"] {
      margin-bottom: 0 !important;
      padding-bottom: 0 !important;
    }
    [data-pdf-export-target="1"] > *:last-child,
    [data-pdf-export-target="1"] [class*="fai-"]:last-child {
      margin-bottom: 0 !important;
      padding-bottom: 0 !important;
    }

    /* Page boxes themselves: zero default margins so Chromium does not
       inflate the bottom of the last page. The printToPDF call already
       supplies marginsType: 1 (minimum), but @page is what Chromium reads
       when preferCSSPageSize is set. */
    @page {
      margin: 0.4in;
      background: #1f1f1f;
    }
  }
`;

// Selectors that identify the app's virtualized scroller. Used by the
// shared renderer/agent.js to hydrate off-viewport messages before PDF
// export. Each entry is a CSS selector string; the agent tries them in
// order and picks the first match that also has overflowY: auto/scroll.
//
// Copilot uses Fluent UI's virtualizer. Class names are partial-match
// so they survive hash regenerations across Fluent rebuilds.
const VIRTUALIZER_SELECTORS = [
  '[class*="fui-Virtualizer-Scroll-View-Dynamic"]',
  '[class*="fui-Virtualizer-Scroll-View"]',
  '[class*="fui-Virtualizer"]',
  '[data-virtualizer]'
];

// ---------------------------------------------------------------------------
// Renderer-agent DOM scoring / collection config
// ---------------------------------------------------------------------------
//
// These are intentionally project-specific.  The shared renderer/agent.js
// must not know Copilot DOM fingerprints such as copilot-message-*,
// fai-* hooks, or Fluent/Copilot-specific message structure.
//
// scoreRules:
//   Used by renderer/agent.js scoreElement() when choosing the best chat root.
//   Each selector contributes selector-match-count * weight.
//
// collectionSelectors:
//   Used by renderer/agent.js when collecting rendered message nodes from a
//   mounted / virtualized chat pane.
//
// collectionKeyAttributes:
//   Stable-ish attributes used by renderer/agent.js to dedupe collected nodes.
// ---------------------------------------------------------------------------
const DOM_SCORE_RULES = [
  { selector: '[role="article"]', weight: 25 },
  { selector: '[id^="copilot-message-"]', weight: 25 },
  { selector: '[role="feed"]', weight: 50 },
];

const DOM_COLLECTION_SELECTORS = [
  '[role="article"]',
  '[id^="copilot-message-"]',
  '[data-testid*="message" i]',
  '[class*="fai-UserMessage"]',
  '[class*="fai-AssistantMessage"]',
  '[class*="fai-AnswerCard"]',
];

const DOM_COLLECTION_ROW_SELECTORS = [
  '[class*="fui-Virtualizer"]',
];

const DOM_COLLECTION_EXCLUDE_SELECTORS = [
  '[class*="fui-Virtualizer__before"]',
  '[class*="fui-Virtualizer__after"]',
  '[class*="fui-Virtualizer__beforeContainer"]',
  '[class*="fui-Virtualizer__afterContainer"]',
  '#feedback-heading',
  '[id*="feedback-heading" i]',
];

const DOM_COLLECTION_KEY_ATTRIBUTES = [
  'data-message-id',
  'data-testid',
  'id',
  'aria-label',
];

// Selectors that indicate the Copilot chat input editor has mounted.
// Kept in sync with the fallback probe order lib/quick-chat.js previously
// used, so switching to renderer/agent.js waitForChatInputReady() does not
// change what counts as "ready". Project-specific by design; Gemini/Grok
// supply their own list.
const CHAT_INPUT_SELECTORS = [
  'textarea',
  '[contenteditable="true"]',
  'div[role="textbox"]',
];

module.exports = {
  CHAT_ROOT_SELECTORS,
  CHAT_MESSAGE_LIST_SELECTORS,
  CHAT_SCOPE_SELECTOR,
  CHAT_SCOPE_PSEUDO,
  CHAT_MESSAGE_LIST_SELECTOR,
  CHAT_MESSAGE_LIST_PSEUDO,
  EXPORT_ROOT_CLASS,
  EXPORT_ROOT_SELECTOR,
  CODE_PREVIEW_IFRAME_SELECTOR,
  DOM_CLEANUP_SELECTORS,
  DOM_PRESERVE_CONTENT_SELECTORS,
  PRINT_BUBBLE_CSS,
  VIRTUALIZER_SELECTORS,
  DOM_SCORE_RULES,
  DOM_COLLECTION_SELECTORS,
  DOM_COLLECTION_ROW_SELECTORS,
  DOM_COLLECTION_EXCLUDE_SELECTORS,
  DOM_COLLECTION_KEY_ATTRIBUTES,
  CHAT_INPUT_SELECTORS,
};
