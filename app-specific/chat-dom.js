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
  '[data-testid*="copy" i]',
  '[data-testid*="feedback" i]',
  '[data-testid*="thumb" i]',
  '[data-testid*="reaction" i]',
  '[class*="toolbar" i]',
  '[class*="actionbar" i]',
  '[class*="action-bar" i]'
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

// Which collection selectors identify a user turn and which an assistant turn.
// The shared renderer agent classifies rows with these lists instead of
// guessing from keywords in the selector text.
const DOM_ROLE_SELECTORS = Object.freeze({
  user: Object.freeze([
    '[class*="fai-UserMessage"]',
  ]),
  assistant: Object.freeze([
    '[id^="copilot-message-"]',
    '[class*="fai-AssistantMessage"]',
    '[class*="fai-AnswerCard"]',
  ]),
});

// Visible label that separates a turn's user text from the assistant's answer,
// and the app name that can repeat right after it. Empty / absent means the
// app has no such label.
const ANSWER_MARKER = 'Copilot said:';
const ANSWER_LEADING_LABELS = Object.freeze(['Copilot']);

const DOM_COLLECTION_ROW_SELECTORS = [
  '[class*="fui-Virtualizer"]',
  '[role="article"]',
  '[id^="copilot-message-"]',
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

// Chain-of-thought / "Reasoning completed in N steps" expander controls.
// These collapse the model's reasoning by default. The generic
// expandForPrint() in renderer/agent.js only clicks controls that happen to
// be mounted when it runs; because the Fluent virtualizer keeps only a few
// rows mounted, off-screen reasoning panels are never expanded. The export's
// dedicated reasoning pass (agent.expandReasoningForPrint) runs AFTER
// pdfPrepare() has flattened the virtualizer, when every row is mounted, and
// uses these selectors to open the panels. Project-specific by design.
// Only the TOP-LEVEL "Reasoning completed in N steps" expander. The two broad
// descendant selectors that were here previously ([class*="ChainOfThought"]
// button[aria-expanded="false"] and [class*="fai-Reasoning"] button[...])
// also matched the NESTED sub-step toggles ("Reasoning / Coding and executing"
// children). Clicking a top-level expander re-renders and mounts more of those
// nested collapsed toggles, so the collapsed count oscillated and the expand
// loop never terminated (21-minute hang). Matching only the top-level button
// keeps the collapsed set monotonically shrinking.
const REASONING_EXPAND_SELECTORS = [
  'button[class*="ChainOfThought__expandButton"][aria-expanded="false"]',
  'button[id*="expand-button"][class*="ChainOfThought"][aria-expanded="false"]',
];

// Formal capability contract consumed by renderer/agent.js. Selectors are
// evidence providers, never authoritative matches on their own.
const DOM_ADAPTER_CONTRACT = Object.freeze({
  version: 1,
  thresholds: Object.freeze({ read: 55, interact: 70, destructive: 85 }),
  negativeRegionSelectors: Object.freeze([
    'nav', 'header', 'aside', '[role="navigation"]', '[role="toolbar"]',
    '[role="dialog"]', '[role="search"]', '[role="menu"]'
  ]),
  capabilities: Object.freeze({
    chatRoot: Object.freeze({
      selectors: CHAT_ROOT_SELECTORS,
      semanticSelectors: Object.freeze(['[role="feed"]', '[role="log"]', 'main', '[role="main"]']),
      repeatedDescendants: DOM_COLLECTION_SELECTORS,
      stableAttributeHints: Object.freeze(['chat', 'message', 'feed', 'conversation'])
    }),
    messageRow: Object.freeze({
      selectors: DOM_COLLECTION_SELECTORS,
      semanticSelectors: Object.freeze(['article', '[role="article"]', '[aria-posinset]']),
      stableAttributeHints: Object.freeze(['message', 'turn', 'response', 'request'])
    }),
    composer: Object.freeze({
      selectors: CHAT_INPUT_SELECTORS,
      semanticSelectors: Object.freeze(['textarea', '[contenteditable="true"]', '[role="textbox"]']),
      stableAttributeHints: Object.freeze(['composer', 'prompt', 'chat-input', 'message-input'])
    }),
    disclosureControl: Object.freeze({
      selectors: REASONING_EXPAND_SELECTORS.concat([
        'button[aria-expanded]', '[role="button"][aria-expanded]', 'summary'
      ]),
      semanticSelectors: Object.freeze([
        'button[aria-expanded]', '[role="button"][aria-expanded]', 'summary'
      ]),
      stableAttributeHints: Object.freeze(['expand', 'collapse', 'disclosure', 'reasoning', 'show-more'])
    }),
    virtualizer: Object.freeze({
      selectors: VIRTUALIZER_SELECTORS,
      stableAttributeHints: Object.freeze(['virtual', 'scroll', 'message-list'])
    })
  })
});

const DOM_CLEANUP_POLICY = Object.freeze({
  // Candidate generation may be broad; deletion is decided by the predicate
  // in renderer/agent.js. In particular, matching a class name never removes a
  // subtree by itself.
  candidateSelectors: Object.freeze(DOM_CLEANUP_SELECTORS.concat([
    'button', '[role="button"]', '[role="toolbar"]', '[role="menu"]',
    '[role="menuitem"]', '[aria-haspopup]'
  ])),
  interactiveSelectors: Object.freeze([
    'button', '[role="button"]', '[role="toolbar"]', '[role="menu"]',
    '[role="menuitem"]', '[aria-haspopup]'
  ]),
  preserveSelectors: Object.freeze([
    'a[href]', '[data-preserve]', '[data-testid*="citation" i]',
    '[data-testid*="reference" i]', 'pre', 'code', 'table', 'ul', 'ol',
    'img', 'picture', 'svg', 'canvas', 'video', 'iframe',
    '[data-file-name]', '[data-attachment]', '[class*="attachment" i]'
  ])
});

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
  DOM_CLEANUP_POLICY,
  DOM_ADAPTER_CONTRACT,
  DOM_PRESERVE_CONTENT_SELECTORS,
  VIRTUALIZER_SELECTORS,
  DOM_SCORE_RULES,
  DOM_COLLECTION_SELECTORS,
  DOM_ROLE_SELECTORS,
  ANSWER_MARKER,
  ANSWER_LEADING_LABELS,
  DOM_COLLECTION_ROW_SELECTORS,
  DOM_COLLECTION_EXCLUDE_SELECTORS,
  DOM_COLLECTION_KEY_ATTRIBUTES,
  CHAT_INPUT_SELECTORS,
  REASONING_EXPAND_SELECTORS,
};
