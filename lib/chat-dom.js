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

function cleanupDOMFragmentScript(containerName = 'container') {
  const selectorsJson = JSON.stringify(DOM_CLEANUP_SELECTORS);
  const preserveSelectorsJson = JSON.stringify(DOM_PRESERVE_CONTENT_SELECTORS);
  return `
  (function() {
    const __target = ${containerName};
    const __selectors = ${selectorsJson};
    const __preserveSelectors = ${preserveSelectorsJson};
    if (!__target) return;
    __target.querySelectorAll(__selectors.join(',')).forEach(el => {
      try { el.remove(); } catch {}
    });
    __target.querySelectorAll(__preserveSelectors.join(',')).forEach(el => {
      try { el.setAttribute('data-preserve', 'true'); } catch {}
    });
    __target.querySelectorAll('div, span').forEach(el => {
      try {
        if (
          !el.textContent.trim() &&
          !el.querySelector(__preserveSelectors.join(','))
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
  const preserveSelectorsJson = JSON.stringify(DOM_PRESERVE_CONTENT_SELECTORS);

  return `
  (function () {
    const candidates = ${candidatesJson};
    const junkSelectors = ${junkSelectorsJson};
    const preserveSelectors = ${preserveSelectorsJson};

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
        clone.querySelectorAll(preserveSelectors.join(',')).forEach(el => {
          try { el.setAttribute('data-preserve', 'true'); } catch {}
        });
        clone.querySelectorAll('div, span').forEach(el => {
          try {
            if (
              !el.textContent.trim() &&
              !el.querySelector(preserveSelectors.join(','))
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

function buildLocateChatRootScript(options = {}) {
  return buildChatPaneDetectionScript({
    includeHtml: options.includeHtml !== false,
    cleanupJunk: !!options.cleanupJunk,
    selectContent: !!options.selectContent,
    scrollIntoView: !!options.scrollIntoView,
  });
}

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
  cleanupDOMFragmentScript,
  buildLocateChatRootScript,
  buildChatPaneDetectionScript,
};
