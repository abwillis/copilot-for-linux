// renderer/agent.js
'use strict';

// Renderer-side agent for Electron web wrappers.
//
// When installed, exposes a configured window renderer API with:
//   init({ chatRootSelectors, junkSelectors, preserveSelectors })
//   locateChatRoot(options)  -- behavioral twin of buildLocateChatRootScript
//   clearExportMarker()      -- removes [data-pdf-export-target] tags
//   getSelectionFragment()   -- returns current selection as { html, text }
//   extractScopedImages(ids) -- extracts data URIs for marked export images
//   inlineImageDataUris(html, idToDataUri)
//   pdfPrepare(options)      -- prepares marked chat pane for native PDF print
//   pdfRestore()             -- restores DOM state changed by pdfPrepare()
//   cleanExportHtml(html, preserveSelectors) -- cleans detached export HTML
//   enableFindContentVisibility()  -- force content-visibility open for Find
//   disableFindContentVisibility() -- restore Find visibility overrides
//
// The main process calls it by name instead of shipping the full body of
// buildChatPaneDetectionScript on every export/find/select. The function
// must be valid as a top-level script in the remote page; no Node APIs,
// no contextBridge, no imports.
(function installRendererAgent() {
  var RENDERER_API_GLOBAL = '__appRenderer';
  var RENDERER_AGENT_VERSION = 1;

  try {
    var bootConfig = window.__APP_RENDERER_AGENT_CONFIG__ || {};
    if (bootConfig.rendererApiGlobal || bootConfig.globalName) {
      RENDERER_API_GLOBAL = String(bootConfig.rendererApiGlobal || bootConfig.globalName);
    }
    if (bootConfig.rendererAgentVersion || bootConfig.version) {
      RENDERER_AGENT_VERSION = Number(bootConfig.rendererAgentVersion || bootConfig.version) || 1;
    }
  } catch (e) {}

  if (
    window[RENDERER_API_GLOBAL] &&
    window[RENDERER_API_GLOBAL].__version === RENDERER_AGENT_VERSION
  ) {
    return; // idempotent across SPA navigations
  }

  // App-specific DOM selectors are injected by main.js via init().
  // Keep the agent generic so this file can be shared across Copilot,
  // Gemini, and Grok without embedded host-page fingerprints.
  var CHAT_ROOT_SELECTORS = [];
  var DOM_CLEANUP_SELECTORS = [];
  var DOM_PRESERVE_CONTENT_SELECTORS = [
    '[data-preserve]', 'pre', 'code', 'table', 'ul', 'ol',
    'img', 'picture', 'svg', 'canvas', 'video', 'iframe'
  ];

  // Per-app virtualizer selectors, populated by init() from each app's
  // lib/chat-dom.js. Empty array means generic overflow:auto detection only.
  var VIRTUALIZER_SELECTORS = [];

  // Per-app chat-input selectors, populated by init() from each app's
  // lib/chat-dom.js. Used by waitForChatInputReady() below.  Empty array
  // makes waitForChatInputReady() return { ok:false, error:'...' } so a
  // config drift never silently succeeds.
  var CHAT_INPUT_SELECTORS = [];

  // Per-app dynamic-width config, populated by init() from each app's
  // app.config.js `dynamicWidth` block.  Keeps this file project-neutral.
  var DYNAMIC_WIDTH_CSS_VAR = '';
  var DYNAMIC_WIDTH_MIN_VW = 0;
  var DYNAMIC_WIDTH_MAX_VW = 100;
  var DYNAMIC_WIDTH_DEFAULT_VW = 100;

  // Per-app scoring / collection config, populated by init() from each app's
  // lib/chat-dom.js.  Keep this file generic: no Copilot/Gemini/Grok DOM
  // fingerprints belong here.
  var DOM_SCORE_RULES = [];
  var DOM_COLLECTION_SELECTORS = [];
  var DOM_COLLECTION_KEY_ATTRIBUTES = [];
  var DOM_COLLECTION_ROW_SELECTORS = [];
  var DOM_COLLECTION_EXCLUDE_SELECTORS = [];
  var REASONING_EXPAND_SELECTORS = [];
  var DOM_SCORE_VISIBLE = 1000;
  var DOM_SCORE_TEXT_MAX = 500;

  // Attribute used to disambiguate the chosen pane during PDF export.
  var EXPORT_MARKER_ATTR = 'data-pdf-export-target';

  function visible(el) {
    if (!el) return false;
    var r = null;
    try { r = el.getBoundingClientRect && el.getBoundingClientRect(); } catch (e) {}
    return !!r && r.width > 0 && r.height > 0;
  }

  function safeSelectorList(selectors) {
    if (!Array.isArray(selectors) || !selectors.length) return '';
    return selectors
      .map(function (selector) { return String(selector || '').trim(); })
      .filter(Boolean)
      .join(',');
  }

  function matchesConfiguredSelector(el, selectors) {
    if (!el || el.nodeType !== 1) return false;
    if (!Array.isArray(selectors) || !selectors.length) return false;

    for (var i = 0; i < selectors.length; i++) {
      var selector = String(selectors[i] || '').trim();
      if (!selector) continue;
      try {
        if (el.matches && el.matches(selector)) return true;
      } catch (e) {}
    }

    return false;
  }

  function firstConfiguredDescendant(el, selectors) {
    if (!el || !el.querySelector) return null;
    var selectorList = safeSelectorList(selectors);
    if (!selectorList) return null;
    try { return el.querySelector(selectorList); } catch (e) {}
    return null;
  }

  function countSelectorMatches(el, selector) {
    if (!el || !selector) return 0;
    var count = 0;
    try {
      if (el.querySelectorAll) count += el.querySelectorAll(selector).length || 0;
    } catch (e) {}
    return count;
  }

  function scoreElement(el) {
    var score = 0;
    try {
      if (visible(el)) score += DOM_SCORE_VISIBLE;
      for (var i = 0; i < DOM_SCORE_RULES.length; i++) {
        var rule = DOM_SCORE_RULES[i] || {};
        var selector = String(rule.selector || '').trim();
        var weight = Number(rule.weight || 0);
        if (!selector || !weight) continue;
        score += countSelectorMatches(el, selector) * weight;
      }
      score += Math.min(String(el.innerText || '').length, DOM_SCORE_TEXT_MAX);
    } catch (e) {}
    return score;
  }

  function pickBest() {
    var found = [];
    for (var i = 0; i < CHAT_ROOT_SELECTORS.length; i++) {
      var sel = CHAT_ROOT_SELECTORS[i];
      try {
        document.querySelectorAll(sel).forEach(function (el) {
          found.push({ sel: sel, el: el });
        });
      } catch (e) {}
    }
    if (!found.length) return null;
    var scored = found.map(function (entry) {
      return { sel: entry.sel, el: entry.el, score: scoreElement(entry.el) };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    var best = scored[0];
    return (best && best.el) ? best : null;
  }

  function selectNodeContents(el) {
    try {
      var sel = window.getSelection && window.getSelection();
      if (!sel) return;
      sel.removeAllRanges();
      var range = document.createRange();
      range.selectNodeContents(el);
      sel.addRange(range);
    } catch (e) {}
  }

  function cleanedClone(el, junkSelectors, preserveSelectors) {
    var clone = el.cloneNode(true);
    if (junkSelectors && junkSelectors.length) {
      clone.querySelectorAll(junkSelectors.join(',')).forEach(function (n) {
        try { n.remove(); } catch (e) {}
      });
    }
    if (preserveSelectors && preserveSelectors.length) {
      var preserveSel = preserveSelectors.join(',');
      clone.querySelectorAll(preserveSel).forEach(function (n) {
        try { n.setAttribute('data-preserve', 'true'); } catch (e) {}
      });
      clone.querySelectorAll('div, span').forEach(function (n) {
        try {
          if (!n.textContent.trim() && !n.querySelector(preserveSel)) {
            n.remove();
          }
        } catch (e) {}
      });
    }
    return clone;
  }

  function cleanupDOMFragment(container) {
    if (!container) return;

    try {
      if (DOM_CLEANUP_SELECTORS.length) {
        container.querySelectorAll(DOM_CLEANUP_SELECTORS.join(',')).forEach(function (el) {
          try { el.remove(); } catch (e) {}
        });
      }
    } catch (e) {}

    try {
      if (DOM_PRESERVE_CONTENT_SELECTORS.length) {
        var preserveSel = DOM_PRESERVE_CONTENT_SELECTORS.join(',');

        container.querySelectorAll(preserveSel).forEach(function (el) {
          try { el.setAttribute('data-preserve', 'true'); } catch (e) {}
        });

        container.querySelectorAll('div, span').forEach(function (el) {
          try {
            if (!el.textContent.trim() && !el.querySelector(preserveSel)) {
              el.remove();
            }
          } catch (e) {}
        });
      }
    } catch (e) {}
  }

  function getSelectionFragment(options) {
    var opts = options || {};
    var clean = opts.clean !== false;

    try {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return { ok: true, hasSelection: false, html: '', text: '' };
      }

      var range = sel.getRangeAt(0);
      var container = document.createElement('div');
      container.appendChild(range.cloneContents());
      if (clean) cleanupDOMFragment(container);

      return {
        ok: true,
        hasSelection: true,
        html: container.innerHTML,
        text: String(sel.toString() || '')
      };
    } catch (e) {
      return {
        ok: false,
        hasSelection: false,
        html: '',
        text: '',
        error: String((e && e.message) || e)
      };
    }
  }

  function locateChatRoot(options) {
    var opts = options || {};
    var includeHtml    = opts.includeHtml    !== false;
    var selectContent  = !!opts.selectContent;
    var cleanupJunk    = !!opts.cleanupJunk;
    var scrollIntoView = !!opts.scrollIntoView;
    var markForExport  = !!opts.markForExport;

    var best = pickBest();
    if (!best) return null;

    if (scrollIntoView) {
      try { best.el.scrollIntoView({ block: 'start', inline: 'nearest' }); } catch (e) {}
    }
    if (selectContent) selectNodeContents(best.el);
    if (markForExport) {
      try {
        // Clear any stale marker from a previous interrupted export, then
        // tag the scored winner so the PDF prep script can find it by
        // attribute instead of by an ambiguous CSS selector.
        var stale = document.querySelectorAll('[' + EXPORT_MARKER_ATTR + ']');
        for (var i = 0; i < stale.length; i++) {
          try { stale[i].removeAttribute(EXPORT_MARKER_ATTR); } catch (e) {}
        }
        best.el.setAttribute(EXPORT_MARKER_ATTR, '1');
      } catch (e) {}
    }

    var html = '';
    if (includeHtml) {
      if (cleanupJunk && DOM_CLEANUP_SELECTORS.length) {
        html = cleanedClone(best.el, DOM_CLEANUP_SELECTORS, DOM_PRESERVE_CONTENT_SELECTORS).outerHTML;
      } else {
        html = best.el.outerHTML;
      }
    }

    var selectedTextLength = 0;
    if (selectContent) {
      try {
        selectedTextLength = String(
          (window.getSelection && window.getSelection().toString()) || ''
        ).length;
      } catch (e) {}
    }

    return {
      ok: true,
      selector: best.sel,
      html: html,
      textLength: String(best.el.innerText || '').length,
      score: Number(best.score || 0),
      selectedTextLength: selectedTextLength,
      markerApplied: markForExport,
      markerAttr: markForExport ? EXPORT_MARKER_ATTR : null
    };
  }

  function clearExportMarker() {
    try {
      var nodes = document.querySelectorAll('[' + EXPORT_MARKER_ATTR + ']');
      var cleared = 0;
      for (var i = 0; i < nodes.length; i++) {
        try { nodes[i].removeAttribute(EXPORT_MARKER_ATTR); cleared++; } catch (e) {}
      }
      return { ok: true, cleared: cleared };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function escapeAttributeValue(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"');
  }

  function waitForImageLoad(img, timeoutMs) {
    return new Promise(function (resolve) {
      try {
        if (img.complete && img.naturalWidth > 0) {
          resolve(true);
          return;
        }

        var done = function () { resolve(true); };

        try {
          img.loading = 'eager';
          img.decoding = 'sync';
          img.removeAttribute('loading');

          var rs = img.currentSrc || img.src;
          if (rs) img.src = rs;
        } catch (e) {}

        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        setTimeout(done, Number(timeoutMs || 5000));
      } catch (e) {
        resolve(false);
      }
    });
  }

  async function imageToDataUri(img, src) {
    var dataUri = '';
    var status = 'failed';

    try {
      var c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      dataUri = c.toDataURL('image/png');
      status = 'canvas';
      return { dataUri: dataUri, status: status };
    } catch (ce) {}

    try {
      var resp = await fetch(src);
      var blob = await resp.blob();
      dataUri = await new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () { res(fr.result); };
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      status = 'fetch';
      return { dataUri: dataUri, status: status };
    } catch (fe) {}

    return { dataUri: '', status: 'failed' };
  }

  async function extractScopedImages(ids) {
    try {
      var list = Array.isArray(ids) ? ids : [];
      var images = [];

      for (var i = 0; i < list.length; i++) {
        var id = String(list[i] || '');
        var img = null;

        try {
          img = document.querySelector(
            'img[data-export-image-id="' + escapeAttributeValue(id) + '"]'
          );
        } catch (e) {}

        if (!img) {
          images.push({ id: id, src: '', dataUri: '', status: 'not-found' });
          continue;
        }

        var src = img.currentSrc || img.src || img.getAttribute('src') || '';

        if (!src || src.indexOf('data:') === 0) {
          images.push({
            id: id,
            src: src,
            dataUri: src,
            status: src ? 'already-data-uri' : 'no-src'
          });
          continue;
        }

        if (!img.complete || img.naturalWidth === 0) {
          await waitForImageLoad(img, 5000);
        }

        if (img.naturalWidth === 0) {
          images.push({ id: id, src: src, dataUri: '', status: 'load-failed' });
          continue;
        }

        var converted = await imageToDataUri(img, src);
        images.push({
          id: id,
          src: src,
          dataUri: converted.dataUri,
          status: converted.status
        });
      }

      return { ok: true, images: images };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), images: [] };
    }
  }

  function inlineImageDataUris(html, idToDataUri) {
    try {
      var map = idToDataUri || {};
      var div = document.createElement('div');
      div.innerHTML = String(html || '');

      var imgs = div.querySelectorAll('img[data-export-image-id]');
      for (var i = 0; i < imgs.length; i++) {
        var img = imgs[i];
        var id = img.getAttribute('data-export-image-id');

        if (id && map[id]) {
          img.setAttribute('src', map[id]);
          img.removeAttribute('srcset');
          img.removeAttribute('data-srcset');
          img.removeAttribute('data-src');
          img.removeAttribute('data-original');
          img.removeAttribute('data-url');
          img.removeAttribute('data-image-url');
          img.removeAttribute('data-thumbnail-url');
        }
      }

      return { ok: true, html: div.innerHTML };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), html: String(html || '') };
    }
  }

  // -------------------------------------------------------------------------
  // Native PDF print lifecycle
  //
  // Keep this state in the renderer agent instead of storing ad hoc generated
  // scripts in the main process. The main process still owns printToPDF(), but
  // the page mutation/rollback contract lives here.
  // -------------------------------------------------------------------------
  var pdfPrintState = null;
  var pdfHydrateState = null;
  var pdfLayoutBaseline = null;
  var pdfBeforePrintDiagnostic = null;
  var pdfBeforePrintHandler = null;

  function getPdfTargetPane(fallbackSelector) {
    var chatPane = null;

    try {
      chatPane = document.querySelector('[' + EXPORT_MARKER_ATTR + ']');
    } catch (e) {}

    if (!chatPane && fallbackSelector) {
      try {
        chatPane = document.querySelector(String(fallbackSelector || ''));
      } catch (e) {}
    }

    return chatPane || null;
  }

  function normalizeDiagnosticSelectors(selectors) {
    if (!Array.isArray(selectors)) return [];
    var result = [];
    for (var i = 0; i < selectors.length; i++) {
      var selector = String(selectors[i] || '').trim();
      if (!selector || result.indexOf(selector) !== -1) continue;
      try {
        document.documentElement.matches(selector);
        result.push(selector);
      } catch (e) {}
    }
    return result;
  }
  function matchingDiagnosticSelectors(el, selectors) {
    var matches = [];
    if (!el || !el.matches) return matches;
    for (var i = 0; i < selectors.length; i++) {
      try {
        if (el.matches(selectors[i])) matches.push(selectors[i]);
      } catch (e) {}
    }
    return matches;
  }
  function diagnosticTextSignature(el) {
    try {
      var text = String(el && (el.innerText || el.textContent) || '')
        .replace(/\s+/g, ' ')
        .trim();
      var h = 2166136261;
      for (var i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      }
      return {
        length: text.length,
        hash: String(h >>> 0),
        head: text.slice(0, 240),
        tail: text.slice(-480),
        descendantCount: el && el.querySelectorAll
          ? el.querySelectorAll('*').length
          : 0
      };
    } catch (e) {
      return { length: 0, hash: '0', head: '', tail: '', descendantCount: 0 };
    }
  }
  function containingDiagnosticSelectors(el, root, selectors) {
    var matches = [];
    if (!el || !el.closest) return matches;
    for (var i = 0; i < selectors.length; i++) {
      try {
        var owner = el.closest(selectors[i]);
        if (owner && root.contains(owner)) matches.push(selectors[i]);
      } catch (e) {}
    }
    return matches;
  }
  function diagnosticClientRects(el) {
    try {
      return Array.from(el.getClientRects ? el.getClientRects() : [])
        .slice(0, 20)
        .map(function (rect) {
          return {
            top: Math.round(Number(rect.top || 0)),
            bottom: Math.round(Number(rect.bottom || 0)),
            left: Math.round(Number(rect.left || 0)),
            right: Math.round(Number(rect.right || 0)),
            width: Math.round(Number(rect.width || 0)),
            height: Math.round(Number(rect.height || 0))
          };
        });
    } catch (e) { return []; }
  }
  function measureDiagnosticElement(el, root, selectors) {
    var rect = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var className = '';
    var parent = el.parentElement;
    var childIndex = -1;
    var siblingCount = 0;
    var depthFromRoot = 0;
    try {
      className = typeof el.className === 'string'
        ? el.className
        : String(el.getAttribute('class') || '');
    } catch (e) {}
    try {
      if (parent) {
        var siblings = Array.from(parent.children || []);
        childIndex = siblings.indexOf(el);
        siblingCount = siblings.length;
      }
    } catch (e) {}
    try {
      var depthNode = el;
      while (depthNode && depthNode !== root) {
        depthFromRoot++;
        depthNode = depthNode.parentElement;
      }
      if (depthNode !== root) depthFromRoot = -1;
    } catch (e) {
      depthFromRoot = -1;
    }
    var textSignature = diagnosticTextSignature(el);
    return {
      label: elementLabel(el),
      tagName: String(el.tagName || '').toLowerCase(),
      id: String(el.id || '') || null,
      className: String(className || '').trim().slice(0, 500),
      parentLabel: parent ? elementLabel(parent) : null,
      parentId: parent && parent.id ? String(parent.id) : null,
      childIndex: childIndex,
      siblingCount: siblingCount,
      depthFromRoot: depthFromRoot,
      directChildOfRoot: parent === root,
      top: Math.round(Number(rect.top || 0)),
      bottom: Math.round(Number(rect.bottom || 0)),
      rectHeight: Math.round(Number(rect.height || 0)),
      scrollHeight: Number(el.scrollHeight || 0),
      clientHeight: Number(el.clientHeight || 0),
      offsetHeight: Number(el.offsetHeight || 0),
      clientRects: diagnosticClientRects(el),
      display: String(cs.display || ''),
      position: String(cs.position || ''),
      visibility: String(cs.visibility || ''),
      opacity: String(cs.opacity || ''),
      height: String(cs.height || ''),
      minHeight: String(cs.minHeight || ''),
      maxHeight: String(cs.maxHeight || ''),
      blockSize: String(cs.blockSize || ''),
      minBlockSize: String(cs.minBlockSize || ''),
      maxBlockSize: String(cs.maxBlockSize || ''),
      flex: String(cs.flex || ''),
      flexGrow: String(cs.flexGrow || ''),
      flexShrink: String(cs.flexShrink || ''),
      flexBasis: String(cs.flexBasis || ''),
      alignSelf: String(cs.alignSelf || ''),
      gridRow: String(cs.gridRow || ''),
      gridRowStart: String(cs.gridRowStart || ''),
      gridRowEnd: String(cs.gridRowEnd || ''),
      computedTop: String(cs.top || ''),
      transform: String(cs.transform || ''),
      translate: String(cs.translate || ''),
      overflow: String(cs.overflow || ''),
      overflowX: String(cs.overflowX || ''),
      overflowY: String(cs.overflowY || ''),
      breakBefore: String(cs.breakBefore || ''),
      breakAfter: String(cs.breakAfter || ''),
      breakInside: String(cs.breakInside || ''),
      pageBreakBefore: String(cs.pageBreakBefore || ''),
      pageBreakAfter: String(cs.pageBreakAfter || ''),
      pageBreakInside: String(cs.pageBreakInside || ''),
      orphans: String(cs.orphans || ''),
      widows: String(cs.widows || ''),
      contentVisibility: String(cs.contentVisibility || ''),
      contain: String(cs.contain || ''),
      containIntrinsicSize: String(cs.containIntrinsicSize || ''),
      clip: String(cs.clip || ''),
      clipPath: String(cs.clipPath || ''),
      inlineTop: String((el.style && el.style.top) || ''),
      inlineTransform: String((el.style && el.style.transform) || ''),
      matchedTargetSelectors: matchingDiagnosticSelectors(el, selectors),
      insideTargetSelectors: containingDiagnosticSelectors(el, root, selectors),
      textLength: textSignature.length,
      textHash: textSignature.hash,
      textHead: textSignature.head,
      textTail: textSignature.tail,
      descendantCount: textSignature.descendantCount,
      isConnected: !!el.isConnected,
      isIframe: String(el.tagName || '').toUpperCase() === 'IFRAME'
    };
  }
  function capturePdfLayoutBaseline(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    var targetSelectors = normalizeDiagnosticSelectors(opts.targetSelectors);
    try {
      var root = getPdfTargetPane(fallbackSelector);
      if (!root) return { ok: false, error: 'chat pane not found' };
      var byElement = new Map();
      var measurementErrorCount = 0;
      var firstMeasurementError = null;
      var nodes = [root].concat(Array.from(root.querySelectorAll('*')));
      for (var i = 0; i < nodes.length; i++) {
        var el = nodes[i];
        try {
          byElement.set(
            el,
            measureDiagnosticElement(el, root, targetSelectors)
          );
        } catch (e) {
          measurementErrorCount++;
          if (!firstMeasurementError) {
            firstMeasurementError = {
              label: elementLabel(el),
              error: String((e && e.message) || e)
            };
          }
        }
      }
      var rootMeasurement = byElement.get(root) || null;
      var rowElements = getDiagnosticRows(root);
      pdfLayoutBaseline = {
        root: root,
        byElement: byElement,
        targetSelectors: targetSelectors,
        rootMeasurement: rootMeasurement,
        rowElements: rowElements
      };
      return {
        ok: byElement.size > 0,
        partial: measurementErrorCount > 0,
        elementCount: byElement.size,
        measurementErrorCount: measurementErrorCount,
        firstMeasurementError: firstMeasurementError,
        targetSelectors: targetSelectors,
        root: rootMeasurement,
        rowCount: rowElements.length,
        rows: rowElements.map(function (row, index) {
          return {
            index: index,
            label: elementLabel(row),
            id: row.id ? String(row.id) : null,
            parentLabel: elementLabel(row.parentElement)
          };
        })
      };
    } catch (e) {
      pdfLayoutBaseline = null;
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function diagnosticStyleChanges(liveMeasurement, currentMeasurement) {
    var changes = {};
    if (!liveMeasurement || !currentMeasurement) return changes;
    var props = [
      'display', 'position', 'height', 'minHeight', 'maxHeight',
      'blockSize', 'minBlockSize', 'maxBlockSize',
      'flex', 'flexGrow', 'flexShrink', 'flexBasis', 'alignSelf',
      'gridRow', 'gridRowStart', 'gridRowEnd',
      'computedTop', 'transform', 'translate',
      'overflow', 'overflowX', 'overflowY',
      'breakBefore', 'breakAfter', 'breakInside',
      'pageBreakBefore', 'pageBreakAfter', 'pageBreakInside',
      'orphans', 'widows', 'visibility', 'opacity',
      'contentVisibility', 'contain', 'containIntrinsicSize',
      'clip', 'clipPath', 'inlineTop', 'inlineTransform'
    ];
    for (var i = 0; i < props.length; i++) {
      var prop = props[i];
      var liveValue = String(liveMeasurement[prop] || '');
      var currentValue = String(currentMeasurement[prop] || '');
      if (liveValue !== currentValue) {
        changes[prop] = { live: liveValue, final: currentValue };
      }
    }
    return changes;
  }
  function diagnosticSizingRules(el) {
    var matches = [];
    var inaccessibleStyleSheetCount = 0;
    var properties = [
      'height', 'min-height', 'max-height',
      'block-size', 'min-block-size', 'max-block-size',
      'flex', 'flex-grow', 'flex-shrink', 'flex-basis',
      'align-self', 'position', 'top', 'bottom', 'transform',
      'break-before', 'break-after', 'break-inside',
      'page-break-before', 'page-break-after', 'page-break-inside',
      'orphans', 'widows',
      'overflow', 'overflow-x', 'overflow-y',
      'visibility', 'content-visibility', 'contain',
      'clip', 'clip-path'
    ];
    function matchingDeclarations(style) {
      var declarations = {};
      if (!style) return declarations;
      for (var i = 0; i < properties.length; i++) {
        var property = properties[i];
        var value = String(style.getPropertyValue(property) || '').trim();
        if (!value) continue;
        declarations[property] = {
          value: value,
          priority: String(style.getPropertyPriority(property) || '')
        };
      }
      return declarations;
    }
    function walkRules(rules, source, condition) {
      if (!rules || matches.length >= 24) return;
      for (var i = 0; i < rules.length && matches.length < 24; i++) {
        var rule = rules[i];
        try {
          if (rule.selectorText && el.matches(rule.selectorText)) {
            var declarations = matchingDeclarations(rule.style);
            if (Object.keys(declarations).length) {
              matches.push({
                source: source,
                condition: condition || null,
                selector: String(rule.selectorText || ''),
                declarations: declarations
              });
            }
          }
          if (rule.cssRules) {
            walkRules(
              rule.cssRules,
              source,
              String(rule.conditionText || condition || '')
            );
          }
        } catch (e) {}
      }
    }
    try {
      var inlineDeclarations = matchingDeclarations(el && el.style);
      if (Object.keys(inlineDeclarations).length) {
        matches.push({
          source: 'element.style',
          condition: null,
          selector: null,
          declarations: inlineDeclarations
        });
      }
    } catch (e) {}
    try {
      var sheets = Array.from(document.styleSheets || []);
      for (var i = 0; i < sheets.length && matches.length < 24; i++) {
        var sheet = sheets[i];
        var source = String(sheet.href || 'inline-style-sheet');
        try {
          walkRules(sheet.cssRules, source, '');
        } catch (e) {
          inaccessibleStyleSheetCount++;
        }
      }
    } catch (e) {}
    return {
      matches: matches,
      inaccessibleStyleSheetCount: inaccessibleStyleSheetCount
    };
  }
  function diagnosticParseVirtualY(value) {
    try {
      var s = String(value || '');
      var m3d = s.match(/matrix3d\(([^)]+)\)/i);
      if (m3d) {
        var parts3d = m3d[1].split(',').map(function (x) {
          return Number(String(x).trim());
        });
        if (parts3d.length >= 14 && isFinite(parts3d[13])) {
          return parts3d[13];
        }
      }
      var m2d = s.match(/matrix\(([^)]+)\)/i);
      if (m2d) {
        var parts2d = m2d[1].split(',').map(function (x) {
          return Number(String(x).trim());
        });
        if (parts2d.length >= 6 && isFinite(parts2d[5])) {
          return parts2d[5];
        }
      }
      var translate = s.match(
        /translate(?:3d)?\([^,]+,\s*([-0-9.]+)px/i
      );
      if (translate && isFinite(Number(translate[1]))) {
        return Number(translate[1]);
      }
      var translateY = s.match(/translateY\(\s*([-0-9.]+)px/i);
      if (translateY && isFinite(Number(translateY[1]))) {
        return Number(translateY[1]);
      }
    } catch (e) {}
    return null;
  }
  function getDiagnosticRows(root) {
    try {
      var baselineRows = pdfLayoutBaseline &&
        pdfLayoutBaseline.root === root &&
        Array.isArray(pdfLayoutBaseline.rowElements)
          ? pdfLayoutBaseline.rowElements
          : null;
      if (
        baselineRows &&
        baselineRows.length &&
        baselineRows.every(function (row) {
          return row && row.isConnected && root.contains(row);
        })
      ) {
        return baselineRows.slice();
      }
    } catch (e) {}
    var rows = [];
    var rowSelector = safeSelectorList(DOM_COLLECTION_ROW_SELECTORS);
    var messageSelector = safeSelectorList(DOM_COLLECTION_SELECTORS);
    function meaningfulDirectChildren(container) {
      if (!container || !container.children) return [];
      return Array.from(container.children).filter(function (child) {
        try {
          if (!root.contains(child)) return false;
          if (rowSelector && child.matches(rowSelector)) return true;
          if (messageSelector && child.matches(messageSelector)) return true;
          if (messageSelector && child.querySelector(messageSelector)) return true;
          return false;
        } catch (e) {
          return false;
        }
      });
    }
    // Prefer mounted direct children of a configured virtualizer. A configured
    // row selector can also match the virtualizer itself; querying it first
    // incorrectly collapses every conversation into diagnostic row zero.
    if (VIRTUALIZER_SELECTORS.length) {
      try {
        var virtualizerSelector = safeSelectorList(VIRTUALIZER_SELECTORS);
        var virtualizers = virtualizerSelector
          ? Array.from(root.querySelectorAll(virtualizerSelector))
          : [];
        var bestDirectRows = [];
        for (var i = 0; i < virtualizers.length; i++) {
          var directRows = meaningfulDirectChildren(virtualizers[i]);
          if (directRows.length > bestDirectRows.length) {
            bestDirectRows = directRows;
          }
        }
        if (bestDirectRows.length) rows = bestDirectRows;
      } catch (e) {
        rows = [];
      }
    }
    if (!rows.length && rowSelector) {
      try {
        rows = Array.from(root.querySelectorAll(rowSelector));
        // If the selector found one containing element, promote its meaningful
        // direct children. This preserves generic configuration while avoiding
        // a virtualizer/container being reported as the only conversation row.
        if (rows.length === 1) {
          var promotedRows = meaningfulDirectChildren(rows[0]);
          if (promotedRows.length) rows = promotedRows;
        }
      } catch (e) {
        rows = [];
      }
    }
    if (!rows.length) {
      try {
        var scroller = findBestChatScroller(root, null);
        if (scroller && root.contains(scroller)) {
          rows = meaningfulDirectChildren(scroller);
        }
      } catch (e) {
        rows = [];
      }
    }
    rows = rows.filter(function (row, index, list) {
      return row && root.contains(row) && list.indexOf(row) === index;
    });
    rows.sort(function (a, b) {
      try {
        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
      } catch (e) {
        return 0;
      }
    });
    return rows;
  }
  function findDiagnosticRowOwner(el, rows) {
    for (var i = 0; i < rows.length; i++) {
      try {
        if (rows[i] === el || rows[i].contains(el)) {
          return { row: rows[i], index: i };
        }
      } catch (e) {}
    }
    return null;
  }
  function measureDiagnosticRows(root, baselineByElement) {
    var rowElements = getDiagnosticRows(root);
    var rows = [];
    var previousBottom = null;
    var previousLiveBottom = null;
    var sumOfRowHeights = 0;
    var totalInterRowGap = 0;
    for (var i = 0; i < rowElements.length; i++) {
      var row = rowElements[i];
      try {
        var current = measureDiagnosticElement(row, root, []);
        var live = baselineByElement ? baselineByElement.get(row) : null;
        var gapBefore = previousBottom === null
          ? null
          : current.top - previousBottom;
        var liveGapBefore = previousLiveBottom === null || !live
          ? null
          : live.top - previousLiveBottom;
        var virtualY = diagnosticParseVirtualY(current.inlineTransform);
        if (virtualY === null) {
          virtualY = diagnosticParseVirtualY(current.transform);
        }
        var parent = row.parentElement;
        var parentMeasurement = parent
          ? measureDiagnosticElement(parent, root, [])
          : null;
        var parentStyle = null;
        try { parentStyle = parent ? getComputedStyle(parent) : null; } catch (e) {}
        rows.push({
          index: i,
          label: current.label,
          id: current.id,
          parentLabel: current.parentLabel,
          childIndex: current.childIndex,
          siblingCount: current.siblingCount,
          configuredRowSelectors: DOM_COLLECTION_ROW_SELECTORS.filter(
            function (selector) {
              try { return row.matches(selector); } catch (e) { return false; }
            }
          ),
          top: current.top,
          bottom: current.bottom,
          rectHeight: current.rectHeight,
          scrollHeight: current.scrollHeight,
          offsetHeight: current.offsetHeight,
          liveTop: live ? live.top : null,
          liveBottom: live ? live.bottom : null,
          liveRectHeight: live ? live.rectHeight : null,
          liveScrollHeight: live ? live.scrollHeight : null,
          liveOffsetHeight: live ? live.offsetHeight : null,
          rectHeightDelta: live ? current.rectHeight - live.rectHeight : null,
          scrollHeightDelta: live
            ? current.scrollHeight - live.scrollHeight
            : null,
          offsetHeightDelta: live
            ? current.offsetHeight - live.offsetHeight
            : null,
            textLength: current.textLength,
            liveTextLength: live ? live.textLength : null,
            textLengthDelta: live ? current.textLength - live.textLength : null,
            textHash: current.textHash,
            liveTextHash: live ? live.textHash : null,
            textChanged: live ? current.textHash !== live.textHash : null,
            textTail: current.textTail,
            liveTextTail: live ? live.textTail : null,
            descendantCount: current.descendantCount,
            liveDescendantCount: live ? live.descendantCount : null,
          gapBefore: gapBefore,
          liveGapBefore: liveGapBefore,
          gapDelta: gapBefore !== null && liveGapBefore !== null
            ? gapBefore - liveGapBefore
            : null,
          virtualY: virtualY,
          display: current.display,
          position: current.position,
          height: current.height,
          minHeight: current.minHeight,
          maxHeight: current.maxHeight,
          blockSize: current.blockSize,
          minBlockSize: current.minBlockSize,
          maxBlockSize: current.maxBlockSize,
          liveHeight: live ? live.height : null,
          liveMinHeight: live ? live.minHeight : null,
          liveBlockSize: live ? live.blockSize : null,
          liveMinBlockSize: live ? live.minBlockSize : null,
          flex: current.flex,
          flexGrow: current.flexGrow,
          flexShrink: current.flexShrink,
          flexBasis: current.flexBasis,
          alignSelf: current.alignSelf,
          computedTop: current.computedTop,
          transform: current.transform,
          inlineTop: current.inlineTop,
          inlineTransform: current.inlineTransform,
          parentLayout: parentMeasurement ? {
            label: parentMeasurement.label,
            rectHeight: parentMeasurement.rectHeight,
            scrollHeight: parentMeasurement.scrollHeight,
            offsetHeight: parentMeasurement.offsetHeight,
            height: parentMeasurement.height,
            minHeight: parentMeasurement.minHeight,
            blockSize: parentMeasurement.blockSize,
            minBlockSize: parentMeasurement.minBlockSize,
            display: parentMeasurement.display,
            flex: parentMeasurement.flex,
            flexDirection: String(parentStyle && parentStyle.flexDirection || ''),
            alignItems: String(parentStyle && parentStyle.alignItems || '')
          } : null,
          sizingRules: diagnosticSizingRules(row),
          styleChanges: diagnosticStyleChanges(live, current)
        });
        sumOfRowHeights += current.rectHeight;
        if (gapBefore !== null) totalInterRowGap += gapBefore;
        previousBottom = current.bottom;
        previousLiveBottom = live ? live.bottom : null;
      } catch (e) {}
    }
    var rootRect = root.getBoundingClientRect();
    var firstTop = rows.length ? rows[0].top : null;
    var lastBottom = rows.length ? rows[rows.length - 1].bottom : null;
    var occupiedExtent = firstTop === null || lastBottom === null
      ? 0
      : Math.max(0, lastBottom - firstTop);
    return {
      rows: rows,
      summary: {
          diagnosticVersion: 2,
        rowCount: rows.length,
          rowLabels: rows.map(function (row) { return row.label; }),
          rowIds: rows.map(function (row) { return row.id; }),
          rowParentLabels: rows.map(function (row) { return row.parentLabel; }),
        firstTop: firstTop,
        lastBottom: lastBottom,
        occupiedExtent: occupiedExtent,
        sumOfRowHeights: sumOfRowHeights,
        totalInterRowGap: totalInterRowGap,
        rootHeight: Math.round(Number(rootRect.height || 0)),
        unexplainedRootHeight: Math.max(
          0,
          Math.round(Number(rootRect.height || 0)) - occupiedExtent
        )
      }
    };
  }
  function capturePdfLayoutStage(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    try {
      var root = getPdfTargetPane(fallbackSelector);
      if (!root) return { ok: false, error: 'chat pane not found' };
      var baselineByElement = pdfLayoutBaseline &&
        pdfLayoutBaseline.root === root
          ? pdfLayoutBaseline.byElement
          : null;
      var rowReport = measureDiagnosticRows(root, baselineByElement);
      return {
        ok: true,
        stage: String(opts.stage || ''),
        rootHeight: Math.round(Number(root.getBoundingClientRect().height || 0)),
        rootScrollHeight: Number(root.scrollHeight || 0),
        documentHeight: Number(
          document.documentElement && document.documentElement.scrollHeight || 0
        ),
        conversationSummary: rowReport.summary,
        conversationRows: rowReport.rows
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // Capture coarse document-size and renderer-memory information immediately
  // before native PDF generation. Unlike the detailed layout diagnostics,
  // this intentionally avoids walking and measuring every descendant. It is
  // meant to establish whether a failed print was operating on an unusually
  // large document or under renderer heap pressure.
  function capturePdfResourceDiagnostic(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    try {
      var root = getPdfTargetPane(fallbackSelector);
      if (!root) {
        return {
          ok: false,
          stage: String(opts.stage || ''),
          error: 'chat pane not found'
        };
      }

      var html = document.documentElement;
      var body = document.body;
      var rootRect = root.getBoundingClientRect();
      var bodyTextLength = null;
      var rootTextLength = null;
      var documentNodeCount = null;
      var rootNodeCount = null;

      try {
        bodyTextLength = String(
          body && (body.innerText || body.textContent) || ''
        ).length;
      } catch (e) {}

      try {
        rootTextLength = String(
          root.innerText || root.textContent || ''
        ).length;
      } catch (e) {}

      try {
        documentNodeCount = document.querySelectorAll('*').length;
      } catch (e) {}

      try {
        rootNodeCount = root.querySelectorAll('*').length;
      } catch (e) {}

      var rendererMemory = {
        available: false,
        usedJSHeapSize: null,
        totalJSHeapSize: null,
        jsHeapSizeLimit: null
      };

      try {
        var memory = window.performance && window.performance.memory;
        if (memory) {
          rendererMemory = {
            available: true,
            usedJSHeapSize: Number(memory.usedJSHeapSize || 0),
            totalJSHeapSize: Number(memory.totalJSHeapSize || 0),
            jsHeapSizeLimit: Number(memory.jsHeapSizeLimit || 0)
          };
        }
      } catch (e) {}

      return {
        ok: true,
        diagnosticVersion: 1,
        stage: String(opts.stage || ''),
        capturedAt: new Date().toISOString(),
        document: {
          readyState: String(document.readyState || ''),
          visibilityState: String(document.visibilityState || ''),
          htmlScrollHeight: Number(html && html.scrollHeight || 0),
          htmlClientHeight: Number(html && html.clientHeight || 0),
          htmlOffsetHeight: Number(html && html.offsetHeight || 0),
          bodyScrollHeight: Number(body && body.scrollHeight || 0),
          bodyClientHeight: Number(body && body.clientHeight || 0),
          bodyOffsetHeight: Number(body && body.offsetHeight || 0),
          bodyTextLength: bodyTextLength,
          nodeCount: documentNodeCount
        },
        root: {
          label: elementLabel(root),
          rectHeight: Math.round(Number(rootRect.height || 0)),
          scrollHeight: Number(root.scrollHeight || 0),
          clientHeight: Number(root.clientHeight || 0),
          offsetHeight: Number(root.offsetHeight || 0),
          textLength: rootTextLength,
          nodeCount: rootNodeCount
        },
        rendererMemory: rendererMemory
      };
    } catch (e) {
      return {
        ok: false,
        stage: String(opts.stage || ''),
        error: String((e && e.message) || e)
      };
    }
  }

  function capturePdfTerminalContent(root, targetSelectors) {
    var errors = [];
    try {
      var rows = getDiagnosticRows(root);
      var finalRow = rows.length ? rows[rows.length - 1] : root;
      var selectors = normalizeDiagnosticSelectors(targetSelectors);
      var contentOwner = finalRow;
      var bestTextLength = diagnosticTextSignature(finalRow).length;
      for (var i = 0; i < selectors.length; i++) {
        try {
          Array.from(finalRow.querySelectorAll(selectors[i])).forEach(function (el) {
            var length = diagnosticTextSignature(el).length;
            if (length >= bestTextLength) {
              bestTextLength = length;
              contentOwner = el;
            }
          });
        } catch (e) {
          errors.push({ selector: selectors[i], error: String((e && e.message) || e) });
        }
      }
      var semanticSelector = [
        'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p',
        'ul', 'ol', 'li', 'pre', 'code', 'table', 'thead',
        'tbody', 'tr', 'blockquote', 'details', 'summary'
      ].join(',');
      var semantic = Array.from(contentOwner.querySelectorAll(semanticSelector));
      var terminalElements = semantic.slice(-20).map(function (el) {
        var measurement = measureDiagnosticElement(el, root, selectors);
        measurement.sizingRules = diagnosticSizingRules(el);
        return measurement;
      });
      var lists = semantic.filter(function (el) {
        var tag = String(el.tagName || '').toLowerCase();
        return tag === 'ul' || tag === 'ol';
      });
      var finalList = lists.length ? lists[lists.length - 1] : null;
      var directItems = [];
      var listAncestors = [];
      if (finalList) {
        directItems = Array.from(finalList.children || [])
          .filter(function (el) {
            return String(el.tagName || '').toLowerCase() === 'li';
          })
          .map(function (el, index) {
            var measurement = measureDiagnosticElement(el, root, selectors);
            measurement.index = index;
            measurement.sizingRules = diagnosticSizingRules(el);
            return measurement;
          });
        var ancestor = finalList;
        while (ancestor && root.contains(ancestor)) {
          var ancestorMeasurement = measureDiagnosticElement(ancestor, root, selectors);
          ancestorMeasurement.sizingRules = diagnosticSizingRules(ancestor);
          listAncestors.push(ancestorMeasurement);
          if (ancestor === finalRow || ancestor === root) break;
          ancestor = ancestor.parentElement;
        }
      }
      return {
        ok: true,
        finalRowLabel: elementLabel(finalRow),
        contentOwnerLabel: elementLabel(contentOwner),
        terminalElements: terminalElements,
        finalList: finalList ? {
          measurement: measureDiagnosticElement(finalList, root, selectors),
          sizingRules: diagnosticSizingRules(finalList),
          directItemCount: directItems.length,
          directItems: directItems,
          ancestors: listAncestors
        } : null,
        errors: errors
      };
    } catch (e) {
      return {
        ok: false,
        error: String((e && e.message) || e),
        errors: errors
      };
    }
  }
  function capturePdfPrintFragmentDiagnostic(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    try {
      var root = getPdfTargetPane(fallbackSelector);
      if (!root) return { ok: false, error: 'chat pane not found' };
      var baselineByElement = pdfLayoutBaseline && pdfLayoutBaseline.root === root
        ? pdfLayoutBaseline.byElement
        : null;
      var rowReport = measureDiagnosticRows(root, baselineByElement);
      return {
        ok: true,
        diagnosticVersion: 3,
        stage: String(opts.stage || 'beforeprint'),
        captured: true,
        media: {
          print: !!(window.matchMedia && window.matchMedia('print').matches),
          screen: !!(window.matchMedia && window.matchMedia('screen').matches)
        },
        rootHeight: Math.round(Number(root.getBoundingClientRect().height || 0)),
        rootScrollHeight: Number(root.scrollHeight || 0),
        documentHeight: Number(document.documentElement && document.documentElement.scrollHeight || 0),
        conversationSummary: rowReport.summary,
        conversationRows: rowReport.rows,
        terminalContent: capturePdfTerminalContent(root, opts.targetSelectors || [])
      };
    } catch (e) {
      return { ok: false, captured: true, error: String((e && e.message) || e) };
    }
  }
  function armPdfBeforePrintDiagnostic(options) {
    var opts = options || {};
    try {
      if (pdfBeforePrintHandler) {
        window.removeEventListener('beforeprint', pdfBeforePrintHandler);
      }
    } catch (e) {}
    pdfBeforePrintDiagnostic = null;
    pdfBeforePrintHandler = function () {
      pdfBeforePrintDiagnostic = capturePdfPrintFragmentDiagnostic({
        fallbackSelector: String(opts.fallbackSelector || ''),
        targetSelectors: Array.isArray(opts.targetSelectors)
          ? opts.targetSelectors.slice()
          : [],
        stage: 'beforeprint'
      });
      pdfBeforePrintHandler = null;
    };
    try {
      window.addEventListener('beforeprint', pdfBeforePrintHandler, { once: true });
      return { ok: true, armed: true };
    } catch (e) {
      pdfBeforePrintHandler = null;
      return { ok: false, armed: false, error: String((e && e.message) || e) };
    }
  }
  function getPdfBeforePrintDiagnostic() {
    return pdfBeforePrintDiagnostic || {
      ok: false,
      captured: false,
      reason: 'beforeprint-not-observed'
    };
  }

  function rememberStyle(el, props) {
    var entry = { el: el };
    try {
      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        entry[p] = el.style[p];
      }
    } catch (e) {}
    return entry;
  }

  function restoreStyleEntry(entry, props) {
    try {
      var el = entry && entry.el;
      if (!el || !el.style) return;

      for (var i = 0; i < props.length; i++) {
        var p = props[i];
        if (typeof entry[p] === 'string') {
          el.style[p] = entry[p];
        }
      }
    } catch (e) {}
  }

  function pdfPrepare(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');

    try {
      // Clear stale state if a previous interrupted export left it around.
      pdfRestore();
    } catch (e) {}

    try {
      var chatPane = getPdfTargetPane(fallbackSelector);
      if (!chatPane) {
        return { ok: false, error: 'chat pane not found' };
      }

      var hidden = [];
      var overridden = [];
      var rootOverrides = [];
      var rowMinSizeStyle = null;
      var current = chatPane;
      while (current && current !== document.documentElement) {
        var parent = current.parentElement;

        if (parent) {
          for (var i = 0; i < parent.children.length; i++) {
            var sibling = parent.children[i];
            if (sibling !== current && sibling.style) {
              hidden.push({
                el: sibling,
                display: sibling.style.display,
                visibility: sibling.style.visibility
              });
              sibling.style.setProperty('display', 'none', 'important');
            }
          }
        }

        current = parent;
      }

      var layoutProps = [
        'overflow',
        'overflowY',
        'height',
        'maxHeight',
        'position',
        'contentVisibility',
        'contain'
      ];

      current = chatPane;
      while (current && current !== document.documentElement) {
        if (current.style) {
          overridden.push(rememberStyle(current, layoutProps));
          current.style.setProperty('overflow', 'visible', 'important');
          current.style.setProperty('overflow-y', 'visible', 'important');
          current.style.setProperty('height', 'auto', 'important');
          current.style.setProperty('max-height', 'none', 'important');
          current.style.setProperty('position', 'static', 'important');
          current.style.setProperty('content-visibility', 'visible', 'important');
          current.style.setProperty('contain', 'none', 'important');
        }
        current = current.parentElement;
      }

      try {
        chatPane.querySelectorAll('*').forEach(function (el) {
          try {
            var cs = getComputedStyle(el);
            if (cs.contentVisibility === 'auto' || cs.contentVisibility === 'hidden') {
              overridden.push(rememberStyle(el, ['contentVisibility', 'contain']));
              el.style.setProperty('content-visibility', 'visible', 'important');
              el.style.setProperty('contain', 'none', 'important');
            }
          } catch (e) {}
        });
      } catch (e) {}

      try {
        rootOverrides.push({
          el: document.documentElement,
          overflow: document.documentElement.style.overflow,
          overflowY: document.documentElement.style.overflowY,
          height: document.documentElement.style.height,
          maxHeight: document.documentElement.style.maxHeight
        });
        rootOverrides.push({
          el: document.body,
          overflow: document.body.style.overflow,
          overflowY: document.body.style.overflowY,
          height: document.body.style.height,
          maxHeight: document.body.style.maxHeight
        });

        ['overflow', 'overflow-y', 'height', 'max-height'].forEach(function (p) {
          document.documentElement.style.setProperty(
            p,
            p.indexOf('height') >= 0 ? 'auto' : 'visible',
            'important'
          );
          document.body.style.setProperty(
            p,
            p.indexOf('height') >= 0 ? 'auto' : 'visible',
            'important'
          );
        });
        document.documentElement.style.setProperty('max-height', 'none', 'important');
        document.body.style.setProperty('max-height', 'none', 'important');
      } catch (e) {}

      // Some host virtualizers maintain an inline min-height on each mounted
      // conversation row. Once the scroll container is flattened for print,
      // that cached virtual extent can be rewritten as the row's min-height,
      // turning one conversation into tens of thousands of pixels of blank
      // printable space. Neutralize only the app-configured collection rows;
      // their content continues to determine their natural printed height.
      try {
        var rowSelector = safeSelectorList(DOM_COLLECTION_ROW_SELECTORS);
        if (rowSelector) {
          rowMinSizeStyle = document.createElement('style');
          rowMinSizeStyle.setAttribute('data-pdf-export-row-min-size', '1');
          rowMinSizeStyle.textContent =
            '[' + EXPORT_MARKER_ATTR + '="1"]:is(' + rowSelector + '),' +
            '[' + EXPORT_MARKER_ATTR + '="1"] :is(' + rowSelector + ')' +
            '{min-height:0!important;min-block-size:0!important;}';
          (document.head || document.documentElement).appendChild(rowMinSizeStyle);
        }
      } catch (e) {
        rowMinSizeStyle = null;
      }

      pdfPrintState = {
        hidden: hidden,
        overridden: overridden,
        rootOverrides: rootOverrides,
        rowMinSizeStyle: rowMinSizeStyle
      };

      return {
        ok: true,
        hiddenCount: hidden.length,
        overriddenCount: overridden.length,
        rootOverrideCount: rootOverrides.length,
        rowMinSizeOverrideApplied: !!rowMinSizeStyle
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function pdfRestore() {
    try {
      try {
        if (pdfBeforePrintHandler) {
          window.removeEventListener('beforeprint', pdfBeforePrintHandler);
        }
      } catch (e) {}
      pdfBeforePrintHandler = null;
      var state = pdfPrintState || window.__pdfPrintState;
      if (!state) return { ok: false, restored: false, reason: 'no-state' };

      var hiddenRestored = 0;
      var overriddenRestored = 0;
      var rootRestored = 0;

      try {
        if (state.rowMinSizeStyle && state.rowMinSizeStyle.parentNode) {
          state.rowMinSizeStyle.parentNode.removeChild(state.rowMinSizeStyle);
        }
      } catch (e) {}

      try {
        var hidden = state.hidden || [];
        for (var i = 0; i < hidden.length; i++) {
          var h = hidden[i];
          try {
            h.el.style.display = h.display || '';
            h.el.style.visibility = h.visibility || '';
            hiddenRestored++;
          } catch (e) {}
        }
      } catch (e) {}

      try {
        var overridden = state.overridden || [];
        for (var j = 0; j < overridden.length; j++) {
          restoreStyleEntry(overridden[j], [
            'overflow',
            'overflowY',
            'height',
            'maxHeight',
            'position',
            'contentVisibility',
            'contain'
          ]);
          overriddenRestored++;
        }
      } catch (e) {}

      try {
        var roots = state.rootOverrides || [];
        for (var k = 0; k < roots.length; k++) {
          restoreStyleEntry(roots[k], ['overflow', 'overflowY', 'height', 'maxHeight']);
          rootRestored++;
        }
      } catch (e) {}

      var scrollerRestored = false;
      try {
        if (pdfHydrateState?.scroller) {
          try {
            pdfHydrateState.scroller.scrollTop = Number(pdfHydrateState.originalScrollTop || 0);
            scrollerRestored = true;
          } catch (e) {}
        }
      } catch (e) {}

      pdfPrintState = null;
      pdfHydrateState = null;
      pdfLayoutBaseline = null;
      pdfBeforePrintDiagnostic = null;
      try { delete window.__pdfPrintState; } catch (e) {}

      return {
        ok: true,
        restored: true,
        hiddenRestored: hiddenRestored,
        overriddenRestored: overriddenRestored,
        rootRestored: rootRestored,
        scrollerRestored: scrollerRestored
      };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // -------------------------------------------------------------------------
  // Detached export HTML cleanup
  //
  // This intentionally operates on serialized HTML in a detached container.
  // It does not mutate the live page. The main process owns writing
  // the resulting standalone HTML document.
  // -------------------------------------------------------------------------
  function cleanExportHtml(html, preserveSelectors) {
    try {
      var root = document.createElement('div');
      root.innerHTML = String(html || '');

      var preserve = Array.isArray(preserveSelectors)
        ? preserveSelectors.slice()
        : DOM_PRESERVE_CONTENT_SELECTORS.slice();

      var preserveSel = preserve.join(',');
      var clone = root.firstElementChild || root;

      try {
        clone.querySelectorAll('[class]').forEach(function (n) {
          try { n.removeAttribute('class'); } catch (e) {}
        });
      } catch (e) {}

      try {
        clone.querySelectorAll('[style]').forEach(function (n) {
          try { n.removeAttribute('style'); } catch (e) {}
        });
      } catch (e) {}

      try {
        clone.querySelectorAll('*').forEach(function (n) {
          try {
            Array.from(n.attributes || []).forEach(function (a) {
              var name = String(a.name || '').toLowerCase();
              if (
                name.indexOf('data-') === 0 ||
                name.indexOf('aria-') === 0 ||
                name === 'role' ||
                name === 'tabindex'
              ) {
                n.removeAttribute(a.name);
              }

              if (name === 'id' && n !== clone) {
                n.removeAttribute('id');
              }
            });
          } catch (e) {}
        });
      } catch (e) {}

      if (preserveSel) {
        try {
          clone.querySelectorAll(preserveSel).forEach(function (n) {
            try { n.setAttribute('data-preserve', 'true'); } catch (e) {}
          });
        } catch (e) {}

        try {
          clone.querySelectorAll('div, span').forEach(function (n) {
            try {
              if (!String(n.textContent || '').trim() && !n.querySelector(preserveSel)) {
                n.remove();
              }
            } catch (e) {}
          });
        } catch (e) {}
      }

      return {
        ok: true,
        title: String(document.title || ''),
        html: clone.innerHTML
      };
    } catch (e) {
      return {
        ok: false,
        error: String((e && e.message) || e),
        title: String(document.title || ''),
        html: ''
      };
    }
  }

  // -------------------------------------------------------------------------
  // Shared virtualized-scroller discovery
  //
  // hydrateVirtualizer() and collectVirtualizedChatHtml() must choose the same
  // scroll owner. Earlier code used a simple ancestor-first search in hydrate
  // and a stronger ranked candidate search in collect, which allowed hydrate
  // to report a shallow 1-viewport scroller while collect later found the real
  // Fluent virtualizer.
  // -------------------------------------------------------------------------
  function isScrollableStyle(el) {
    try {
      var cs = window.getComputedStyle(el);
      return /(auto|scroll)/.test(cs.overflowY);
    } catch (e) {
      return false;
    }
  }

  function matchesAnyVirtualizerSelector(el) {
    if (!el || el.nodeType !== 1 || !VIRTUALIZER_SELECTORS.length) return false;
    for (var i = 0; i < VIRTUALIZER_SELECTORS.length; i++) {
      try {
        if (el.matches(VIRTUALIZER_SELECTORS[i])) return true;
      } catch (e) {}
    }
    return false;
  }

  function elementLabel(el) {
    try {
      if (!el) return '';
      var id = el.id ? ('#' + el.id) : '';
      var cls = String(el.className || '').trim().replace(/\s+/g, '.');
      if (cls) cls = '.' + cls.slice(0, 120);
      var tid = el.getAttribute && el.getAttribute('data-testid');
      if (tid) tid = '[data-testid="' + tid + '"]';
      return String(el.tagName || '').toLowerCase() + id + (tid || '') + cls;
    } catch (e) {
      return '';
    }
  }

  function scrollRange(el) {
    try {
      return Math.max(
        0,
        Number(el.scrollHeight || 0) - Number(el.clientHeight || 0)
      );
    } catch (e) {
      return 0;
    }
  }

  function visibleBox(el) {
    try {
      var r = el.getBoundingClientRect && el.getBoundingClientRect();
      return !!r && r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  function addScrollCandidate(list, diag, root, el, reason) {
    try {
      if (!el || el.nodeType !== 1) return;
      if (list.indexOf(el) !== -1) return;

      var range = scrollRange(el);
      var containsRoot = !!(el.contains && el.contains(root));
      var insideRoot = !!(root.contains && root.contains(el));
      var virtualizerMatch = matchesAnyVirtualizerSelector(el);
      var styleScrollable = isScrollableStyle(el);

      // Do not require overflow:auto/scroll here. Fluent/React virtualizers
      // can expose useful scrollHeight/clientHeight even when the computed
      // overflow style is not the obvious one.
      if (range <= 8 && !virtualizerMatch) return;
      if (!visibleBox(el) && el !== document.scrollingElement) return;

      list.push(el);

      if (diag) {
        diag.push({
          reason: reason,
          label: elementLabel(el),
          range: range,
          scrollHeight: Number(el.scrollHeight || 0),
          clientHeight: Number(el.clientHeight || 0),
          containsRoot: containsRoot,
          insideRoot: insideRoot,
          virtualizerMatch: virtualizerMatch,
          styleScrollable: styleScrollable
        });
      }
    } catch (e) {}
  }

  function scoreScrollCandidate(root, el) {
    var s = scrollRange(el);
    try {
      if (el.contains && el.contains(root)) s += 1000000;
      if (root.contains && root.contains(el)) s += 500000;
      if (matchesAnyVirtualizerSelector(el)) s += 250000;
      if (isScrollableStyle(el)) s += 10000;
    } catch (e) {}
    return s;
  }

  function findBestChatScroller(root, diag) {
    var candidates = [];
    var n = root;

    // 1. The document scroller can be the real scroll owner in SPA shells.
    try {
      addScrollCandidate(candidates, diag, root, document.scrollingElement, 'document.scrollingElement');
    } catch (e) {}

    // 2. Ancestors of the marked pane.
    while (n && n !== document.body) {
      addScrollCandidate(candidates, diag, root, n, 'ancestor');
      n = n.parentElement;
    }

    // 3. Configured virtualizer selectors under the marked root.
    if (VIRTUALIZER_SELECTORS.length) {
      try {
        var sel = VIRTUALIZER_SELECTORS.join(',');
        Array.from(root.querySelectorAll(sel)).forEach(function (el) {
          addScrollCandidate(candidates, diag, root, el, 'virtualizer-inside-root');
        });
      } catch (e) {}
    }

    // 4. Configured virtualizer selectors anywhere in the document.
    // This catches layouts where the selected MessageListContainer and the
    // scroll viewport are adjacent rather than strict ancestor/descendant.
    if (VIRTUALIZER_SELECTORS.length) {
      try {
        var docSel = VIRTUALIZER_SELECTORS.join(',');
        Array.from(document.querySelectorAll(docSel)).forEach(function (el) {
          addScrollCandidate(candidates, diag, root, el, 'virtualizer-document');
        });
      } catch (e) {}
    }

    // 5. Generic visible scroll scan.
    try {
      Array.from(document.querySelectorAll('body *')).forEach(function (el) {
        if (scrollRange(el) > 80) {
          addScrollCandidate(candidates, diag, root, el, 'generic-scroll-scan');
        }
      });
    } catch (e) {}

    if (!candidates.length) return null;

    candidates.sort(function (a, b) {
      return scoreScrollCandidate(root, b) - scoreScrollCandidate(root, a);
    });

    // Probe the highest scoring candidates to make sure scrollTop can move.
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      try {
        var range = scrollRange(el);
        if (range <= 8) continue;
        var before = el.scrollTop;
        var probe = Math.min(range, Math.max(20, before + Math.min(250, range)));
        el.scrollTop = probe;
        var moved = Math.abs(Number(el.scrollTop || 0) - Number(before || 0)) > 1;
        el.scrollTop = before;
        if (moved || range > 1000) return el;
      } catch (e) {}
    }

    return candidates[0];
  }

  function findCollapsedVirtualizerInsideRoot(root) {
    if (!root || !root.querySelectorAll || !VIRTUALIZER_SELECTORS.length) {
      return null;
    }
    try {
      var selectorList = safeSelectorList(VIRTUALIZER_SELECTORS);
      if (!selectorList) return null;
      var candidates = Array.from(root.querySelectorAll(selectorList));
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        if (!el || el.nodeType !== 1) continue;
        if (!visibleBox(el)) continue;
        if (!matchesAnyVirtualizerSelector(el)) continue;
        // pdfPrepare() deliberately removes the virtualizer's height and
        // overflow constraints. At that point its range collapses to zero and
        // document.scrollingElement inherits the printable document height.
        // Treat that as an expanded print layout, not as a new scroll owner.
        if (
          scrollRange(el) <= 8 &&
          Number(el.scrollHeight || 0) > 0 &&
          Number(el.clientHeight || 0) > 0
        ) {
          return el;
        }
      }
    } catch (e) {}
    return null;
  }

  // -------------------------------------------------------------------------
  // Hydrate virtualized content under the marked pane.
  //
  // The shared agent does not know which virtualizer the host app uses;
  // each app's lib/chat-dom.js exports VIRTUALIZER_SELECTORS, which arrives
  // here via init(). We:
  //   1. Walk the ancestor chain and prefer a configured virtualizer match.
  //   2. Fall back to any scrollable ancestor (overflow:auto/scroll).
  //   3. Fall back to a configured virtualizer found inside the pane.
  // We pre-scroll to the top so the virtualizer mounts the earliest items,
  // then walk down in viewport-sized steps, watching for scrollHeight to
  // grow as new items mount. Original scrollTop is restored on exit.
  // -------------------------------------------------------------------------
  function hydrateVirtualizer(options) {
    var opts = options || {};
    var stepDelayMs = Number(opts.stepDelayMs || 150);
    var maxSteps = Number(opts.maxSteps || 600);
    var maxStuckPasses = Number(opts.maxStuckPasses || 4);
    var restoreScrollTop = opts.restoreScrollTop !== false;
    var root = null;
    try { root = document.querySelector('[' + EXPORT_MARKER_ATTR + '="1"]'); } catch (e) {}
    if (!root) return Promise.resolve({ ok: false, reason: 'no-marked-pane' });
    var scrollerCandidatesForDiag = [];
    var scroller = findBestChatScroller(root, scrollerCandidatesForDiag);

    // pdfPrepare() can flatten a real nested virtualizer before hydration:
    // its scroll range becomes zero while HTML becomes scrollable. Scrolling
    // HTML in that state feeds the document's growing print height back into
    // the virtualizer, so every bottom nudge increases scrollHeight again.
    // Do not hydrate the synthetic document range. The expanded pane is
    // already laid out for print, and walking HTML would manufacture blank
    // printable space rather than reveal additional mounted rows.
    var documentScroller = null;
    try { documentScroller = document.scrollingElement; } catch (e) {}
    var collapsedVirtualizer = null;
    if (scroller && documentScroller && scroller === documentScroller) {
      collapsedVirtualizer = findCollapsedVirtualizerInsideRoot(root);
    }
    if (collapsedVirtualizer) {
      return Promise.resolve({
        ok: true,
        reason: 'expanded-print-layout',
        steps: 0,
        scrollerLabel: elementLabel(scroller),
        collapsedVirtualizerLabel: elementLabel(collapsedVirtualizer),
        scrollerRange: scrollRange(scroller),
        scrollerCandidates: scrollerCandidatesForDiag.slice(0, 12)
      });
    }

    if (!scroller || scroller === document.body) {
      return Promise.resolve({
        ok: true,
        reason: 'no-virtualized-scroller',
        steps: 0,
        scrollerCandidates: scrollerCandidatesForDiag.slice(0, 12)
      });
    }

    var originalScrollTop = scroller.scrollTop;

    // Wait helper: two RAFs + a setTimeout. Lets layout commit, paint, and
    // gives the Fluent virtualizer's idle reconciler a chance to mount items.
    function settle(ms) {
      return new Promise(function (res) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { setTimeout(res, ms); });
        });
      });
    }

    return new Promise(function (resolve) {
      var steps = 0;
      var maxObservedHeight = scroller.scrollHeight;
      var stuckPasses = 0;

      function finish(reason) {

        try {
          if (restoreScrollTop) {
            try { scroller.scrollTop = originalScrollTop; } catch (e) {}
          } else {
            try {
              pdfHydrateState = {
                scroller: scroller,
                originalScrollTop: originalScrollTop
              };
            } catch (e) {
              pdfHydrateState = null;
              try {
                console.warn('[renderer-agent] hydrateVirtualizer failed to record pdfHydrateState:', {
                  error: String((e && e.message) || e)
                });
              } catch (_) {}
            }
          }

          resolve({
            ok: true,
            steps: steps,
            stoppedAt: reason,
            finalHeight: maxObservedHeight,
            scrollerRange: scrollRange(scroller),
            scrollerTag: scroller.tagName,
            scrollerClass: String(scroller.className || '').slice(0, 80),
            scrollerLabel: elementLabel(scroller),
            scrollerCandidates: scrollerCandidatesForDiag.slice(0, 12),
            restoredScrollTop: !!restoreScrollTop
          });
        } catch (e) {
          try {
            console.warn('[renderer-agent] hydrateVirtualizer finish-error defensive resolve:', {
              error: String((e && e.message) || e),
              steps: steps,
              stoppedAt: reason,
              finalHeight: maxObservedHeight,
              restoredScrollTop: !!restoreScrollTop
            });
          } catch (_) {}
          try {
            resolve({
              ok: false,
              reason: 'finish-error',
              error: String((e && e.message) || e),
              steps: steps,
              stoppedAt: reason,
              finalHeight: maxObservedHeight,
              restoredScrollTop: !!restoreScrollTop
            });
          } catch (_) {}
        }
      }

      async function run() {
        try {
          // Phase 1: scroll to top, settle, record height.
          try { scroller.scrollTop = 0; } catch (e) {}
          await settle(stepDelayMs * 2);
          maxObservedHeight = Math.max(maxObservedHeight, scroller.scrollHeight);
          // Phase 2: walk forward by viewport-sized steps. After each step
          // record the maximum scrollHeight we have *ever* observed. Walk
          // beyond the *current* scrollHeight too, because the virtualizer
          // expands the inner container as we approach its edge.
          var step = Math.max(200, scroller.clientHeight - 100);
          var target = 0;
          while (steps < maxSteps) {
            try { scroller.scrollTop = target; } catch (e) {}
            steps++;
            await settle(stepDelayMs);
            var h = scroller.scrollHeight;
            if (h > maxObservedHeight) {
              maxObservedHeight = h;
              stuckPasses = 0;
            }
            // Decide whether to keep walking. We do not exit when target
            // reaches scroller.scrollHeight, because the virtualizer often
            // sets scrollHeight = scrollTop + clientHeight + a small margin
            // until we push past it. We exit when the maxObservedHeight has
            // stopped growing across several consecutive long settles.
            if (target + step >= h) {
              // Push to current bottom and let it grow.
              try { scroller.scrollTop = h; } catch (e) {}
              await settle(stepDelayMs * 3);
              var h2 = scroller.scrollHeight;
              if (h2 > maxObservedHeight + 4) {
                maxObservedHeight = h2;
                stuckPasses = 0;
                target = scroller.scrollTop;
                continue;
              }
              stuckPasses++;
              if (stuckPasses >= maxStuckPasses) {
                finish('bottom');
                return;
              }
              // Try once more after a longer pause; some Fluent builds defer
              // mounts behind a debounced idle callback.
              await settle(stepDelayMs * 4);
              var h3 = scroller.scrollHeight;
              if (h3 > maxObservedHeight + 4) {
                maxObservedHeight = h3;
                stuckPasses = 0;
                target = scroller.scrollTop;
                continue;
              }
              target = h3;  // keep nudging
              continue;
            }
            target += step;
          }

          finish('max-steps');
        } catch (e) {
          try {
            console.warn('[renderer-agent] hydrateVirtualizer run-error defensive resolve:', {
              error: String((e && e.message) || e),
              steps: steps,
              finalHeight: maxObservedHeight,
              restoredScrollTop: !!restoreScrollTop
            });
          } catch (_) {}
          try {
            resolve({
              ok: false,
              reason: 'run-error',
              error: String((e && e.message) || e),
              steps: steps,
              finalHeight: maxObservedHeight,
              restoredScrollTop: !!restoreScrollTop
            });
          } catch (_) {}
        }
      }

      run();
    });
  }

  // -------------------------------------------------------------------------
  // Pre-print expansion of collapsibles.
  //
  // Handles, inside the marked pane (or document if no marker is set):
  //   1. <details>                          -> set .open = true
  //   2. [aria-expanded="false"] (buttons)  -> click(), then set aria-expanded
  //   3. [data-state="closed"]              -> .click() if it has a handler
  // Returns counts. The actual openings are intentionally not undone --
  // the prep/restore lifecycle is responsible for any rollback the caller
  // wants. For PDF the snapshot is read-only so leaving them open is fine.
  // -------------------------------------------------------------------------
  function expandForPrint(options) {
    var opts = options || {};
    // When true, leave chain-of-thought reasoning controls alone so the
    // dedicated expandReasoningForPrint() pass can handle them.
    //
    // WHY: this function's allow-list matches any class containing "expand",
    // and the reasoning control's class is scc-ChainOfThought__expandButton, so
    // it clicks those open as a side effect. Because
    // REASONING_EXPAND_SELECTORS only match [aria-expanded="false"],
    // expandReasoningForPrint then finds nothing to do -- observed as
    // "found: 0, clicked: 0" -- and its per-panel capture and materialization
    // machinery never runs. Opening a panel is not the same as rendering its
    // body, so the export ends up with reasoning headlines and no content.
    //
    // Defaults to FALSE so existing callers are unchanged. Only callers that
    // are certain to run expandReasoningForPrint afterwards pass true;
    // otherwise skipping here would mean reasoning is never expanded at all.
    var skipReasoning = !!opts.skipReasoning;
    var reasoningSel = skipReasoning
      ? safeSelectorList(REASONING_EXPAND_SELECTORS)
      : '';
    function isReasoningControl(el) {
      if (!reasoningSel) return false;
      try { return !!(el && el.matches && el.matches(reasoningSel)); }
      catch (e) { return false; }
    }
    var root = null;
    try {
      root = document.querySelector('[' + EXPORT_MARKER_ATTR + '="1"]');
    } catch (e) {}
    if (!root) return { ok: false, reason: 'no-marked-pane' };

    // Snapshot menus that already exist so we can detect new ones we open.
    var menusBefore = new Set();
    try {
      document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]')
        .forEach(function (n) { menusBefore.add(n); });
    } catch (e) {}

    // ---- Allow-list helpers ----
    function controlledRegionInsideRoot(btn) {
      try {
        var id = btn.getAttribute('aria-controls');
        if (!id) return null;
        // aria-controls can be space-separated.
        var ids = id.split(/\s+/).filter(Boolean);
        for (var i = 0; i < ids.length; i++) {
          var target = document.getElementById(ids[i]);
          if (target && root.contains(target)) return target;
        }
      } catch (e) {}
      return null;
    }
    function looksLikeMenuTrigger(btn) {
      try {
        if ((btn.getAttribute('aria-haspopup') || '').toLowerCase() === 'menu') return true;
        if ((btn.getAttribute('aria-haspopup') || '').toLowerCase() === 'true') return true;
        if ((btn.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox') return true;
        if ((btn.getAttribute('aria-haspopup') || '').toLowerCase() === 'dialog') return true;
        var role = (btn.getAttribute('role') || '').toLowerCase();
        if (role === 'menu' || role === 'menuitem' || role === 'tab' ||
            role === 'combobox' || role === 'listbox') return true;
        var label = String(
          btn.getAttribute('aria-label') ||
          btn.getAttribute('title') ||
          btn.textContent ||
          ''
        ).toLowerCase();
        if (/more options|more actions|overflow|options menu|attach|model|agent|voice|microphone/.test(label)) {
          return true;
        }
      } catch (e) {}
      return false;
    }
    function looksLikeContentDisclosure(btn) {
      // (a) Has aria-controls pointing inside the marked pane AND not a menu.
      var ctrl = controlledRegionInsideRoot(btn);
      if (ctrl) {
        var ctrlRole = (ctrl.getAttribute('role') || '').toLowerCase();
        if (ctrlRole === 'menu' || ctrlRole === 'listbox' || ctrlRole === 'dialog') return false;
        return true;
      }
      // (b) Has a recognised content-disclosure data-testid / class hook.
      try {
        var tid = String(btn.getAttribute('data-testid') || '').toLowerCase();
        if (/show-more|show_more|expand|collapse|read-more|see-more/.test(tid)) return true;
        var cls = String(btn.className || '');
        if (/show-?more|read-?more|see-?more|expand/i.test(cls)) return true;
      } catch (e) {}
      // (c) Visible label is a known twisty phrase.
      try {
        var label = String(
          btn.getAttribute('aria-label') ||
          btn.textContent ||
          ''
        ).trim().toLowerCase();
          if (
            /^show more$|^see more$|^read more$|^show all$|^expand$/.test(label) ||
            /^(?:copilot\s+)?reasoning completed in \d+ steps?[!.]?$/.test(label)
          ) {
            return true;
          }
      } catch (e) {}
      return false;
    }

    var details = 0, ariaButtons = 0, dataState = 0, skipped = 0, rolledBack = 0, reasoningSkipped = 0;
    var opened = []; // for rollback on menu detection

    // 1) <details> -- always safe, never opens a portal.
    try {
      var ds = root.querySelectorAll('details:not([open])');
      for (var i = 0; i < ds.length; i++) {
        try { ds[i].open = true; details++; } catch (e) {}
      }
    } catch (e) {}

    // 2) Content-disclosure buttons inside the marked pane.
    try {
      var btns = root.querySelectorAll('[aria-expanded="false"]');
      for (var j = 0; j < btns.length; j++) {
        var b = btns[j];
        if (isReasoningControl(b)) { reasoningSkipped++; continue; }
        if (looksLikeMenuTrigger(b)) { skipped++; continue; }
        if (!looksLikeContentDisclosure(b)) { skipped++; continue; }
        try {
          b.click();
          opened.push({ el: b, kind: 'aria' });
          ariaButtons++;
        } catch (e) {}
        try { b.setAttribute('aria-expanded', 'true'); } catch (e) {}
      }
    } catch (e) {}

    // 3) data-state="closed" -- only when it's NOT a Radix popover/menu.
    //    Radix popovers have data-radix-popper-content-wrapper ancestors;
    //    pure disclosure (accordion item content trigger) does not.
    try {
      var closed = root.querySelectorAll('[data-state="closed"]');
      for (var k = 0; k < closed.length; k++) {
        var c = closed[k];
        if (looksLikeMenuTrigger(c)) { skipped++; continue; }
        // Accept only accordion-shaped triggers: has aria-controls into root.
        if (!controlledRegionInsideRoot(c)) { skipped++; continue; }
        try {
          c.click();
          opened.push({ el: c, kind: 'dataState' });
          dataState++;
        } catch (e) {}
      }
    } catch (e) {}

    // 4) Sanity sweep: if anything we clicked caused a new menu/dialog/listbox
    //    to appear, roll those clicks back. This catches the failure mode
    //    where a button looked safe but its handler opens a portal.
    var newMenu = null;
    try {
      var menusAfter = document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]');
      for (var m = 0; m < menusAfter.length; m++) {
        if (!menusBefore.has(menusAfter[m])) { newMenu = menusAfter[m]; break; }
      }
    } catch (e) {}
    if (newMenu) {
      for (var o = opened.length - 1; o >= 0; o--) {
        try {
          opened[o].el.click();          // toggle closed
          opened[o].el.setAttribute('aria-expanded', 'false');
          rolledBack++;
        } catch (e) {}
      }
      // Belt and suspenders: dispatch Escape on the menu's owner if still open.
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      } catch (e) {}
    }

    return {
      ok: true,
      details: details,
      ariaButtons: ariaButtons - (newMenu ? rolledBack : 0),
      dataState: dataState,
      skipped: skipped,
      reasoningSkipped: reasoningSkipped,
      rolledBack: rolledBack,
      menuDetected: !!newMenu
    };
  }

  // -------------------------------------------------------------------------
  // Collect virtualized chat HTML for static exports.
  //
  // hydrateVirtualizer() is useful for PDF because Chromium prints the live
  // page after the export CSS/layout changes. It is not sufficient for a
  // Markdown snapshot because Fluent can unmount off-viewport rows again after
  // scrollTop is restored.
  //
  // This collector walks the virtualized scroller and accumulates mounted
  // message-like nodes at each scroll position. The main process can then feed
  // the assembled HTML to Turndown instead of taking one outerHTML snapshot.
  // -------------------------------------------------------------------------
  function collectVirtualizedChatHtml(options) {
    var opts = options || {};
    var stepDelayMs = Number(opts.stepDelayMs || 120);
    var maxSteps = Number(opts.maxSteps || 800);
    var maxStuckPasses = Number(opts.maxStuckPasses || 5);
    var scrollerCandidatesForDiag = [];

    var root = null;
    try { root = document.querySelector('[' + EXPORT_MARKER_ATTR + '="1"]'); } catch (e) {}
    if (!root) return Promise.resolve({ ok: false, reason: 'no-marked-pane', html: '' });

    var scroller = findBestChatScroller(root, scrollerCandidatesForDiag);

    function settle(ms) {
      return new Promise(function (res) {
        requestAnimationFrame(function () {
          requestAnimationFrame(function () { setTimeout(res, ms); });
        });
      });
    }

    function stableTextHash(text) {
      var s = String(text || '').replace(/\s+/g, ' ').trim();
      var h = 2166136261;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
      }
      return String(h >>> 0);
    }

    function parseVirtualY(value) {
      try {
        var s = String(value || '');

        var m3d = s.match(/matrix3d\(([^)]+)\)/i);
        if (m3d) {
          var parts3d = m3d[1].split(',').map(function (x) {
            return Number(String(x).trim());
          });
          if (parts3d.length >= 14 && isFinite(parts3d[13])) return parts3d[13];
        }

        var m2d = s.match(/matrix\(([^)]+)\)/i);
        if (m2d) {
          var parts2d = m2d[1].split(',').map(function (x) {
            return Number(String(x).trim());
          });
          if (parts2d.length >= 6 && isFinite(parts2d[5])) return parts2d[5];
        }

        var ty = s.match(/translate(?:3d)?\([^,]+,\s*([-0-9.]+)px/i);
        if (ty && isFinite(Number(ty[1]))) return Number(ty[1]);

        var tyOnly = s.match(/translateY\(\s*([-0-9.]+)px/i);
        if (tyOnly && isFinite(Number(tyOnly[1]))) return Number(tyOnly[1]);
      } catch (e) {}

      return null;
    }

    function virtualPosition(node, scroller) {
      try {
        var n = node;
        while (n && n !== root && n !== document.body) {
          var st = (n.getAttribute && n.getAttribute('style')) || '';
          var y = parseVirtualY(st);
          if (y !== null) return Math.round(y);

          var topAttr = '';
          try { topAttr = n.style && n.style.top; } catch (e) {}
          if (topAttr && /px/.test(topAttr)) {
            var top = Number(String(topAttr).replace(/px.*/, ''));
            if (isFinite(top)) return Math.round(top);
          }

          n = n.parentElement;
        }

        var r = node.getBoundingClientRect && node.getBoundingClientRect();
        var sr = scroller && scroller.getBoundingClientRect && scroller.getBoundingClientRect();
        if (r && sr) {
          return Math.round((scroller.scrollTop || 0) + (r.top - sr.top));
        }
      } catch (e) {}

      return null;
    }

    function meaningfulExportNode(node) {
      try {
        if (!node || !root.contains(node)) return false;

        var text = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
        var hasPreserved = !!node.querySelector && !!node.querySelector(
          DOM_PRESERVE_CONTENT_SELECTORS.join(',')
        );

        if (!text && !hasPreserved) return false;

        var cls = String(node.className || '');
        if (matchesConfiguredSelector(node, DOM_COLLECTION_EXCLUDE_SELECTORS)) return false;

        return true;
      } catch (e) {
        return false;
      }
    }

    function rowKey(row, scroller, fallbackOrdinal) {
      try {
        var id = row.getAttribute && row.getAttribute('id');
        if (id) return 'id:' + id;

        var child = firstConfiguredDescendant(row, DOM_COLLECTION_SELECTORS);
        if (child) {
          for (var i = 0; i < DOM_COLLECTION_KEY_ATTRIBUTES.length; i++) {
            var childAttr = String(DOM_COLLECTION_KEY_ATTRIBUTES[i] || '').trim();
            if (!childAttr) continue;
            var childValue = child.getAttribute && child.getAttribute(childAttr);
            if (childValue) return 'child-' + childAttr + ':' + childValue;
          }
          if (child.id) return 'child-id:' + child.id;
        }

        var dataIndex =
          (row.getAttribute && (
            row.getAttribute('data-index') ||
            row.getAttribute('data-item-index') ||
            row.getAttribute('aria-posinset')
          )) || '';

        if (dataIndex) return 'idx:' + dataIndex;

        var y = virtualPosition(row, scroller);
        if (y !== null) return 'y:' + y;

        var text = String(row.innerText || row.textContent || '').replace(/\s+/g, ' ').trim();
        return 'sig:' + stableTextHash(text) + ':' + String(text.length || 0) + ':' + fallbackOrdinal;
      } catch (e) {
        return 'fallback:' + fallbackOrdinal;
      }
    }

    function collectMountedMessages(map, scroller) {
      var rows = [];

      // Primary strategy: collect mounted virtualizer rows/items. In Fluent
      // virtualizer, the durable export unit is usually a mounted row, not a
      // specific message-looking descendant.
      try {
        Array.from(scroller.children || []).forEach(function (child) {
          if (meaningfulExportNode(child)) rows.push(child);
        });
      } catch (e) {}

      // Fallback/augmentation: promote message-ish descendants to their
      // nearest virtualizer row so card variants not exposed as direct children
      // still survive the export.
      var messageSelector = safeSelectorList(DOM_COLLECTION_SELECTORS);
      if (messageSelector) {
        try {
          var descendants = Array.from(root.querySelectorAll(messageSelector));
        descendants.forEach(function (node) {
          var row = node;
          var p = node.parentElement;

          while (p && p !== root && p !== scroller) {
            try {
              var pst = (p.getAttribute && p.getAttribute('style')) || '';
              if (
                parseVirtualY(pst) !== null ||
                matchesConfiguredSelector(p, DOM_COLLECTION_ROW_SELECTORS) ||
                p.parentElement === scroller
              ) {
                row = p;
              }
            } catch (e) {}
            p = p.parentElement;
          }

          if (meaningfulExportNode(row) && rows.indexOf(row) === -1) {
            rows.push(row);
          }
        });
        } catch (e) {}
      }

      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        try {
          if (!meaningfulExportNode(row)) continue;

          var y = virtualPosition(row, scroller);
          var key = rowKey(row, scroller, i);

          if (!map.has(key)) {
            map.set(key, {
              y: y === null ? Number.MAX_SAFE_INTEGER : y,
              html: row.outerHTML,
              textPreview: String(row.innerText || row.textContent || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 120)
            });
          }
        } catch (e) {}
      }
    }

    if (!scroller || scroller === document.body) {
      return Promise.resolve({
        ok: true,
        reason: 'no-virtualized-scroller',
        html: root.outerHTML,
        collected: 1,
        steps: 0,
        scrollerCandidates: scrollerCandidatesForDiag.slice(0, 12)
      });
    }

    var originalScrollTop = scroller.scrollTop;
    var collected = new Map();

    return new Promise(function (resolve) {
      async function run() {
        var steps = 0;
        var maxObservedHeight = scroller.scrollHeight;
        var stuckPasses = 0;
        var step = Math.max(200, scroller.clientHeight - 100);
        var target = 0;

        try { scroller.scrollTop = 0; } catch (e) {}
        await settle(stepDelayMs * 2);
        collectMountedMessages(collected, scroller);

        while (steps < maxSteps) {
          try { scroller.scrollTop = target; } catch (e) {}
          steps++;
          await settle(stepDelayMs);
          collectMountedMessages(collected, scroller);

          var h = scroller.scrollHeight;
          if (h > maxObservedHeight + 4) {
            maxObservedHeight = h;
            stuckPasses = 0;
          }

          if (target + step >= h) {
            try { scroller.scrollTop = h; } catch (e) {}
            await settle(stepDelayMs * 3);
            collectMountedMessages(collected, scroller);

            var h2 = scroller.scrollHeight;
            if (h2 > maxObservedHeight + 4) {
              maxObservedHeight = h2;
              stuckPasses = 0;
              target = scroller.scrollTop;
              continue;
            }

            stuckPasses++;
            if (stuckPasses >= maxStuckPasses) break;

            await settle(stepDelayMs * 4);
            collectMountedMessages(collected, scroller);
            target = scroller.scrollHeight;
            continue;
          }

          target += step;
        }

        // Final bottom sweep.
        //
        // The forward walk can observe the full virtualizer height while still
        // missing the final mounted rows. Fluent's dynamic virtualizer may
        // defer bottom row mounts until scrollTop is explicitly driven through
        // the tail range.
        try {
          var bottomRange = scrollRange(scroller);
          var tailStep = Math.max(200, Math.floor((scroller.clientHeight || 1200) / 2));
          var tailStart = Math.max(0, bottomRange - ((scroller.clientHeight || 1200) * 4));

          for (var tail = tailStart; tail <= bottomRange; tail += tailStep) {
            try { scroller.scrollTop = tail; } catch (e) {}
            await settle(stepDelayMs * 2);
            collectMountedMessages(collected, scroller);
          }

          // Force exact-bottom pressure multiple times. Some virtualizer builds
          // do not mount the last rows on the first bottom clamp.
          for (var bottomPass = 0; bottomPass < 5; bottomPass++) {
            try { scroller.scrollTop = bottomRange; } catch (e) {}
            await settle(stepDelayMs * 3);
            collectMountedMessages(collected, scroller);

            var newBottomRange = scrollRange(scroller);
            if (newBottomRange > bottomRange + 4) {
              bottomRange = newBottomRange;
              tailStart = Math.max(0, bottomRange - ((scroller.clientHeight || 1200) * 4));

              for (var tail2 = tailStart; tail2 <= bottomRange; tail2 += tailStep) {
                try { scroller.scrollTop = tail2; } catch (e) {}
                await settle(stepDelayMs * 2);
                collectMountedMessages(collected, scroller);
              }
            }
          }
        } catch (e) {}

        try { scroller.scrollTop = originalScrollTop; } catch (e) {}

        var ordered = Array.from(collected.values()).sort(function (a, b) {
          return Number(a.y || 0) - Number(b.y || 0);
        });

        var finalRange = scrollRange(scroller);
        var lastY = ordered.length ? Number(ordered[ordered.length - 1].y || 0) : null;
        var bottomCoverageGap =
          lastY === null || lastY === Number.MAX_SAFE_INTEGER
            ? null
            : Math.max(0, finalRange - lastY);

        var html = '<div data-collected-chat-export="1">' +
          ordered.map(function (x) { return x.html; }).join('\n') +
          '</div>';

        resolve({
          ok: true,
          reason: 'collected',
          html: html,
          collected: collected.size,
          steps: steps,
          finalHeight: maxObservedHeight,
          scrollerRange: scrollRange(scroller),
          scrollerTag: scroller.tagName,
          scrollerClass: String(scroller.className || '').slice(0, 80),
          scrollerLabel: elementLabel(scroller),
          firstCollectedY: ordered.length ? ordered[0].y : null,
          lastCollectedY: ordered.length ? ordered[ordered.length - 1].y : null,
          bottomCoverageGap: bottomCoverageGap,
          firstCollectedPreview: ordered.length ? ordered[0].textPreview : '',
          lastCollectedPreview: ordered.length ? ordered[ordered.length - 1].textPreview : '',
          scrollerCandidates: scrollerCandidatesForDiag.slice(0, 12)
        });
      }

      run();
    });
  }

  function init(config) {
    var c = config || {};
    if (Array.isArray(c.chatRootSelectors) && c.chatRootSelectors.length) {
      CHAT_ROOT_SELECTORS = c.chatRootSelectors.slice();
    }
    if (Array.isArray(c.junkSelectors)) {
      DOM_CLEANUP_SELECTORS = c.junkSelectors.slice();
    }
    if (Array.isArray(c.preserveSelectors) && c.preserveSelectors.length) {
      DOM_PRESERVE_CONTENT_SELECTORS = c.preserveSelectors.slice();
    }
    if (Array.isArray(c.virtualizerSelectors)) {
      VIRTUALIZER_SELECTORS = c.virtualizerSelectors.slice();
    }
    if (Array.isArray(c.chatInputSelectors)) {
      CHAT_INPUT_SELECTORS = c.chatInputSelectors
        .map(function (s) { return String(s || '').trim(); })
        .filter(Boolean);
    }
    if (typeof c.dynamicWidthCssVar === 'string' && c.dynamicWidthCssVar.trim()) {
      DYNAMIC_WIDTH_CSS_VAR = c.dynamicWidthCssVar.trim();
    }
    if (Number.isFinite(Number(c.dynamicWidthMinVw))) {
      DYNAMIC_WIDTH_MIN_VW = Number(c.dynamicWidthMinVw);
    }
    if (Number.isFinite(Number(c.dynamicWidthMaxVw))) {
      DYNAMIC_WIDTH_MAX_VW = Number(c.dynamicWidthMaxVw);
    }
    if (Number.isFinite(Number(c.dynamicWidthDefaultVw))) {
      DYNAMIC_WIDTH_DEFAULT_VW = Number(c.dynamicWidthDefaultVw);
    }
    if (Array.isArray(c.scoreRules)) {
      DOM_SCORE_RULES = c.scoreRules
        .map(function (rule) {
          return {
            selector: String((rule && rule.selector) || '').trim(),
            weight: Number((rule && rule.weight) || 0)
          };
        })
        .filter(function (rule) {
          return !!rule.selector && !!rule.weight;
        });
    }
    if (Array.isArray(c.collectionSelectors)) {
      DOM_COLLECTION_SELECTORS = c.collectionSelectors
        .map(function (selector) { return String(selector || '').trim(); })
        .filter(Boolean);
    }
    if (Array.isArray(c.collectionKeyAttributes)) {
      DOM_COLLECTION_KEY_ATTRIBUTES = c.collectionKeyAttributes
        .map(function (attr) { return String(attr || '').trim(); })
        .filter(Boolean);
    }
    if (Array.isArray(c.collectionRowSelectors)) {
      DOM_COLLECTION_ROW_SELECTORS = c.collectionRowSelectors
        .map(function (selector) { return String(selector || '').trim(); })
        .filter(Boolean);
    }
    if (Array.isArray(c.collectionExcludeSelectors)) {
      DOM_COLLECTION_EXCLUDE_SELECTORS = c.collectionExcludeSelectors
        .map(function (selector) { return String(selector || '').trim(); })
        .filter(Boolean);
    }
    if (Array.isArray(c.reasoningExpandSelectors)) {
      REASONING_EXPAND_SELECTORS = c.reasoningExpandSelectors
        .map(function (selector) { return String(selector || '').trim(); })
        .filter(Boolean);
    }
    if (Number.isFinite(Number(c.visibleScore))) {
      DOM_SCORE_VISIBLE = Number(c.visibleScore);
    }
    if (Number.isFinite(Number(c.textScoreMax))) {
      DOM_SCORE_TEXT_MAX = Number(c.textScoreMax);
    }
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Find-in-page: force content-visibility open under the configured chat root
  //
  // This is the JS half of the Find visibility override. The CSS half lives
  // in lib/layout-css.js and is injected by the main process. This method
  // is called by layout-css.js via the renderer-agent seam so it also runs
  // in every subframe.
  //
  // State is stored on window with generic __appRenderer_* keys so the
  // shared agent stays project-neutral.
  // -------------------------------------------------------------------------
  function findVisibilityRoot() {
    try {
      for (var i = 0; i < CHAT_ROOT_SELECTORS.length; i++) {
        var el = document.querySelector(CHAT_ROOT_SELECTORS[i]);
        if (el) return el;
      }
    } catch (e) {}
    return null;
  }

  function findVisibilityForce(el, counter) {
    try {
      if (!el || el.nodeType !== 1) return;
      var cs = getComputedStyle(el);
      if (cs.contentVisibility === 'auto' || cs.contentVisibility === 'hidden') {
        el.style.setProperty('content-visibility', 'visible', 'important');
        el.style.setProperty('contain-intrinsic-size', 'auto', 'important');
        el.style.setProperty('contain', 'none', 'important');
        if (counter) counter.n = (counter.n || 0) + 1;
      }
    } catch (e) {}
  }

  function findVisibilityGetScrollParent(el) {
    try {
      var p = el && el.parentElement;
      while (p && p !== document.body) {
        var s = getComputedStyle(p);
        if (
          (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
          p.scrollHeight > p.clientHeight + 10
        ) {
          return p;
        }
        p = p.parentElement;
      }
    } catch (e) {}
    return el || document.body;
  }

  function enableFindContentVisibility() {
    return (async function () {
      try {
        var chatRoot = findVisibilityRoot();
        var counter = { n: 0 };

        // Walk ancestors of chat root.
        if (chatRoot) {
          var node = chatRoot.parentElement;
          while (node && node !== document.documentElement) {
            findVisibilityForce(node, counter);
            node = node.parentElement;
          }
        }

        // Walk all descendants.
        var scope = chatRoot || document.body;
        try {
          scope.querySelectorAll('*').forEach(function (el) {
            findVisibilityForce(el, counter);
          });
        } catch (e) {}

        // One-time scroll-to-render pass so IntersectionObserver-based
        // virtualization mounts every row before Find highlights them.
        if (!window.__appRenderer_findVisScrollDone && chatRoot) {
          window.__appRenderer_findVisScrollDone = true;

          try {
            var sp = findVisibilityGetScrollParent(chatRoot);
            var savedTop = sp.scrollTop;
            var origOF = sp.style.overflow;
            var origMH = sp.style.maxHeight;

            sp.style.setProperty('overflow', 'visible', 'important');
            sp.style.setProperty('max-height', 'none', 'important');
            void sp.offsetHeight;

            await new Promise(function (r) {
              requestAnimationFrame(function () {
                requestAnimationFrame(r);
              });
            });

            var total = sp.scrollHeight;
            var view = sp.clientHeight || 500;
            var step = Math.max(view * 0.75, 200);

            for (var pos = 0; pos <= total; pos += step) {
              sp.scrollTop = pos;
              await new Promise(function (r) { setTimeout(r, 30); });
            }

            sp.scrollTop = total;
            await new Promise(function (r) { setTimeout(r, 30); });

            try {
              scope.querySelectorAll('*').forEach(function (el) {
                findVisibilityForce(el, counter);
              });
            } catch (e) {}

            sp.style.overflow = origOF;
            sp.style.maxHeight = origMH;
            sp.scrollTop = savedTop;
          } catch (e) {
            try {
              console.warn('[renderer-agent] enableFindContentVisibility scroll-to-render failed:', {
                error: String((e && e.message) || e)
              });
            } catch (_) {}
          }
        }

        try { void document.body.offsetHeight; } catch (e) {}

        // MutationObserver: keep new nodes overridden while Find is open.
        if (window.__appRenderer_findVisObs) {
          try { window.__appRenderer_findVisObs.disconnect(); } catch (e) {}
        }

        var obs = new MutationObserver(function (muts) {
          for (var m = 0; m < muts.length; m++) {
            var mut = muts[m];
            if (mut.type === 'attributes') {
              findVisibilityForce(mut.target, counter);
            }
            if (mut.type === 'childList') {
              var added = mut.addedNodes || [];
              for (var n = 0; n < added.length; n++) {
                if (added[n].nodeType !== 1) continue;
                findVisibilityForce(added[n], counter);
                try {
                  added[n].querySelectorAll('*').forEach(function (el) {
                    findVisibilityForce(el, counter);
                  });
                } catch (e) {}
              }
            }
          }
        });

        obs.observe(document.body, {
          attributes: true,
          attributeFilter: ['style', 'class'],
          childList: true,
          subtree: true
        });

        window.__appRenderer_findVisObs = obs;

        // Periodic sweep to catch anything the observer missed (Fluent's
        // virtualizer sometimes re-hides rows after a short debounce).
        if (window.__appRenderer_findVisInterval) {
          try { clearInterval(window.__appRenderer_findVisInterval); } catch (e) {}
        }

        window.__appRenderer_findVisInterval = setInterval(function () {
          try {
            var s = findVisibilityRoot() || document.body;
            s.querySelectorAll('*').forEach(function (el) {
              findVisibilityForce(el);
            });
          } catch (e) {}
        }, 2000);

        return { ok: true, overridden: counter.n || 0 };
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }
    })();
  }

  function disableFindContentVisibility() {
    try {
      if (window.__appRenderer_findVisObs) {
        try { window.__appRenderer_findVisObs.disconnect(); } catch (e) {}
        try { delete window.__appRenderer_findVisObs; } catch (e) {
          window.__appRenderer_findVisObs = null;
        }
      }

      if (window.__appRenderer_findVisInterval) {
        try { clearInterval(window.__appRenderer_findVisInterval); } catch (e) {}
        try { delete window.__appRenderer_findVisInterval; } catch (e) {
          window.__appRenderer_findVisInterval = null;
        }
      }

      try { delete window.__appRenderer_findVisScrollDone; } catch (e) {
        window.__appRenderer_findVisScrollDone = false;
      }

      document.querySelectorAll('[style]').forEach(function (el) {
        try {
          if (
            el.style.getPropertyValue('content-visibility') === 'visible' &&
            el.style.getPropertyPriority('content-visibility') === 'important'
          ) {
            el.style.removeProperty('content-visibility');
            el.style.removeProperty('contain-intrinsic-size');
            el.style.removeProperty('contain');
          }
        } catch (e) {}
      });

      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // -------------------------------------------------------------------------
  // Quick Chat: resolve when the app's chat input has mounted.
  //
  // Replaces the old main-side pattern of shipping a probe script every
  // 200 ms.  Ships one script per open, then listens via MutationObserver
  // and resolves on first match.  Uses selectors provided by init() so this
  // file remains project-neutral.
  //
  // Return shape:
  //   { ok: true, ready: true,  selector }
  //   { ok: true, ready: false, timeout: true }
  //   { ok: false, error }
  // -------------------------------------------------------------------------
  function findFirstChatInput() {
    if (!Array.isArray(CHAT_INPUT_SELECTORS) || !CHAT_INPUT_SELECTORS.length) {
      return null;
    }
    for (var i = 0; i < CHAT_INPUT_SELECTORS.length; i++) {
      var selector = CHAT_INPUT_SELECTORS[i];
      if (!selector) continue;
      try {
        var el = document.querySelector(selector);
        if (!el) continue;
        var r = el.getBoundingClientRect && el.getBoundingClientRect();
        var visible = !!r && r.width > 0 && r.height > 0;
        if (!visible) continue;
        return { el: el, selector: selector };
      } catch (e) {}
    }
    return null;
  }

  function waitForChatInputReady(options) {
    var opts = options || {};
    var timeoutMs = Number(opts.timeoutMs || 4000);

    return new Promise(function (resolve) {
      var settled = false;
      var obs = null;
      var timer = null;

      function finish(payload) {
        if (settled) return;
        settled = true;
        try { if (obs) obs.disconnect(); } catch (e) {}
        try { if (timer) clearTimeout(timer); } catch (e) {}
        try { delete window.__appRenderer_chatInputReadyObs; } catch (e) {
          window.__appRenderer_chatInputReadyObs = null;
        }
        resolve(payload);
      }

      var immediate = findFirstChatInput();
      if (immediate) {
        resolve({ ok: true, ready: true, selector: immediate.selector });
        return;
      }

      if (!Array.isArray(CHAT_INPUT_SELECTORS) || !CHAT_INPUT_SELECTORS.length) {
        resolve({
          ok: false,
          error: 'no chatInputSelectors configured; call init({ chatInputSelectors: [...] })'
        });
        return;
      }

      try {
        if (window.__appRenderer_chatInputReadyObs) {
          try { window.__appRenderer_chatInputReadyObs.disconnect(); } catch (e) {}
        }

        obs = new MutationObserver(function () {
          var hit = findFirstChatInput();
          if (hit) finish({ ok: true, ready: true, selector: hit.selector });
        });

        obs.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['contenteditable', 'role', 'style', 'class']
        });

        window.__appRenderer_chatInputReadyObs = obs;
      } catch (e) {
        finish({ ok: false, error: String((e && e.message) || e) });
        return;
      }

      timer = setTimeout(function () {
        finish({ ok: true, ready: false, timeout: true });
      }, timeoutMs);
    });
  }

// -------------------------------------------------------------------------
// Print-window asset readiness.
//
// Called from lib/exporters.js after loading a print `BrowserWindow` with a
// generated HTML document, and immediately before printToPDF / print().
// Waits for document.fonts.ready and every img in document.images (with a
// per-image nudge + timeout).  Returns the same diagnostic shape the old
// inline script returned so caller log messages are unchanged:
//
//   { ok: true, imageCount, loadedImageCount, before, after }
//   { ok: false, error }
// -------------------------------------------------------------------------
function waitForPrintableAssets(options) {
  var opts = options || {};
  var timeoutMs = Number(opts.timeoutMs || 5000);
  return (async function () {
    try {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready.catch(function () {}); } catch (e) {}
      }
      var imgs = [];
      try { imgs = Array.from(document.images || []); } catch (e) { imgs = []; }
      var before = imgs.map(function (img, index) {
        return {
          index: index,
          src: img.currentSrc || img.src || (img.getAttribute && img.getAttribute('src')) || '',
          attrSrc: (img.getAttribute && img.getAttribute('src')) || '',
          loading: (img.getAttribute && img.getAttribute('loading')) || '',
          complete: !!img.complete,
          naturalWidth: Number(img.naturalWidth || 0),
          naturalHeight: Number(img.naturalHeight || 0)
        };
      });
      await Promise.all(imgs.map(function (img) {
        return new Promise(function (resolve) {
          try {
            if (img.complete && img.naturalWidth > 0) { resolve(true); return; }
            var done = function () { resolve(true); };
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            try {
              img.loading = 'eager';
              img.decoding = 'sync';
              if (img.removeAttribute) img.removeAttribute('loading');
              var src = img.currentSrc || img.src;
              if (src) img.src = src;
              try {
                if (img.scrollIntoView) {
                  img.scrollIntoView({ block: 'center', inline: 'nearest' });
                }
              } catch (e) {}
            } catch (e) {}
            setTimeout(done, timeoutMs);
          } catch (e) { resolve(false); }
        });
      }));
      await new Promise(function (resolve) {
        try {
          requestAnimationFrame(function () {
            requestAnimationFrame(resolve);
          });
        } catch (e) { resolve(); }
      });
      var after = imgs.map(function (img, index) {
        return {
          index: index,
          src: img.currentSrc || img.src || (img.getAttribute && img.getAttribute('src')) || '',
          complete: !!img.complete,
          naturalWidth: Number(img.naturalWidth || 0),
          naturalHeight: Number(img.naturalHeight || 0)
        };
      });
      return {
        ok: true,
        imageCount: imgs.length,
        loadedImageCount: after.filter(function (x) {
          return x.complete && x.naturalWidth > 0;
        }).length,
        before: before,
        after: after
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  })();
}

  function diagnosePdfLayout(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    var expectedHeight = Number(opts.expectedHeight || 0);
    var limit = Math.max(1, Number(opts.limit || opts.maxEntries || 20));
    var minimumExcess = Math.max(0, Number(opts.minimumExcess || 500));
    var topDescendantLimit = Math.max(
      1,
      Number(opts.topDescendantLimit || 20)
    );

    var topGrowthLimit = Math.max(
      1,
      Number(opts.topGrowthLimit || 30)
    );

    try {
      var root = getPdfTargetPane(fallbackSelector);
      if (!root) {
        return {
          ok: false,
          error: 'chat pane not found'
        };
      }

      var targetSelectors = normalizeDiagnosticSelectors(
        Array.isArray(opts.targetSelectors) && opts.targetSelectors.length
          ? opts.targetSelectors
          : (pdfLayoutBaseline && pdfLayoutBaseline.targetSelectors) || []
      );
      var baselineByElement = pdfLayoutBaseline &&
        pdfLayoutBaseline.root === root
          ? pdfLayoutBaseline.byElement
          : null;

      var rootRect = root.getBoundingClientRect();
      var rootTop = Number(rootRect.top || 0);
      var rootBottom = Number(rootRect.bottom || 0);
      var baselineRoot = pdfLayoutBaseline &&
        pdfLayoutBaseline.root === root
          ? pdfLayoutBaseline.rootMeasurement
          : null;
      var liveExpectedHeight = Math.max(
        expectedHeight,
        Number(baselineRoot && baselineRoot.rectHeight || 0),
        Number(baselineRoot && baselineRoot.scrollHeight || 0),
        Number(baselineRoot && baselineRoot.offsetHeight || 0)
      );
      if (!liveExpectedHeight) {
        liveExpectedHeight = Math.round(Number(rootRect.height || 0));
      }
      var expectedBottom = rootTop + liveExpectedHeight;
      var diagnosticRowElements = getDiagnosticRows(root);
      var rowReport = measureDiagnosticRows(root, baselineByElement);

      var suspicious = [];
      var duplicateIds = {};
      var ids = Object.create(null);

      Array.from(root.querySelectorAll('*')).forEach(function (el) {
        try {
          var cs = getComputedStyle(el);
          var rect = el.getBoundingClientRect();
          var id = String(el.id || '');
          var position = String(cs.position || '');
          var transform = String(cs.transform || '');
          var backgroundImage = String(cs.backgroundImage || '');
          var maskImage = String(
            cs.maskImage ||
            cs.webkitMaskImage ||
            ''
          );
          var farBelow =
            Number(rect.top || 0) > expectedBottom + minimumExcess ||
            Number(rect.bottom || 0) > expectedBottom + minimumExcess;
          var liveMeasurement = baselineByElement
            ? baselineByElement.get(el)
            : null;
          var largeAbsolute =
            Number(rect.height || 0) > 10000 ||
            Number(el.scrollHeight || 0) > 10000 ||
            Number(el.offsetHeight || 0) > 10000;
          var largerThanLive = !!liveMeasurement && (
            Number(rect.height || 0) >
              Number(liveMeasurement.rectHeight || 0) + minimumExcess ||
            Number(el.offsetHeight || 0) >
              Number(liveMeasurement.offsetHeight || 0) + minimumExcess
          );
          var largerThanExpected =
            Number(rect.height || 0) > liveExpectedHeight + minimumExcess ||
            Number(el.offsetHeight || 0) > liveExpectedHeight + minimumExcess;
          var oversized = largerThanLive || largerThanExpected;
          var positioned =
            position === 'fixed' ||
            position === 'sticky' ||
            position === 'absolute';
          var transformed = transform && transform !== 'none';
          var painted =
            backgroundImage && backgroundImage !== 'none' ||
            maskImage && maskImage !== 'none';
          var meaningfulPositioned =
            positioned &&
            (
              Number(rect.width || 0) > 256 ||
              Number(rect.height || 0) > 256 ||
              farBelow ||
              oversized ||
              painted ||
              transformed
            );
          if (id) {
            ids[id] = Number(ids[id] || 0) + 1;
          }

          if (
            meaningfulPositioned ||
            transformed ||
            farBelow ||
            oversized ||
            painted
          ) {
            suspicious.push({
              label: elementLabel(el),
              id: id || null,
              position: position,
              transform: transform,
              top: Math.round(Number(rect.top || 0)),
              bottom: Math.round(Number(rect.bottom || 0)),
              width: Math.round(Number(rect.width || 0)),
              height: Math.round(Number(rect.height || 0)),
              scrollHeight: Number(el.scrollHeight || 0),
              clientHeight: Number(el.clientHeight || 0),
              offsetHeight: Number(el.offsetHeight || 0),
              backgroundImage:
                backgroundImage === 'none'
                  ? ''
                  : backgroundImage.slice(0, 240),
              maskImage:
                maskImage === 'none'
                  ? ''
                  : maskImage.slice(0, 240),
              farBelow: farBelow,
              oversized: oversized,
              largeAbsolute: largeAbsolute,
              largerThanLive: largerThanLive,
              largerThanExpected: largerThanExpected
            });
          }
        } catch (e) {}
      });

      var largestDescendants = [];
      Array.from(root.querySelectorAll('*')).forEach(function (el) {
        try {
          var currentMeasurement = measureDiagnosticElement(
            el,
            root,
            targetSelectors
          );
          var liveMeasurement = baselineByElement
            ? baselineByElement.get(el)
            : null;
          var rowOwner = findDiagnosticRowOwner(el, diagnosticRowElements);
          largestDescendants.push({
            label: currentMeasurement.label,
            tagName: currentMeasurement.tagName,
            id: currentMeasurement.id,
            className: currentMeasurement.className,
            parentLabel: currentMeasurement.parentLabel,
            parentId: currentMeasurement.parentId,
            childIndex: currentMeasurement.childIndex,
            siblingCount: currentMeasurement.siblingCount,
            depthFromRoot: currentMeasurement.depthFromRoot,
            directChildOfRoot: currentMeasurement.directChildOfRoot,
            rowIndex: rowOwner ? rowOwner.index : null,
            rowLabel: rowOwner ? elementLabel(rowOwner.row) : null,
            rowId: rowOwner && rowOwner.row.id ? String(rowOwner.row.id) : null,
            rectHeight: currentMeasurement.rectHeight,
            scrollHeight: currentMeasurement.scrollHeight,
            clientHeight: currentMeasurement.clientHeight,
            offsetHeight: currentMeasurement.offsetHeight,
            liveRectHeight: liveMeasurement
              ? liveMeasurement.rectHeight
              : null,
            liveScrollHeight: liveMeasurement
              ? liveMeasurement.scrollHeight
              : null,
            liveOffsetHeight: liveMeasurement
              ? liveMeasurement.offsetHeight
              : null,
            rectHeightDelta: liveMeasurement
              ? currentMeasurement.rectHeight - liveMeasurement.rectHeight
              : null,
            scrollHeightDelta: liveMeasurement
              ? currentMeasurement.scrollHeight - liveMeasurement.scrollHeight
              : null,
            offsetHeightDelta: liveMeasurement
              ? currentMeasurement.offsetHeight - liveMeasurement.offsetHeight
              : null,
            matchedTargetSelectors:
              currentMeasurement.matchedTargetSelectors,
            insideTargetSelectors:
              currentMeasurement.insideTargetSelectors,
            isIframe: currentMeasurement.isIframe,
            styleChanges: diagnosticStyleChanges(liveMeasurement, currentMeasurement)
          });
        } catch (e) {}
      });
      largestDescendants.sort(function (a, b) {
        var heightDifference =
          Number(b.offsetHeight || 0) - Number(a.offsetHeight || 0);
        if (heightDifference) return heightDifference;
        return Number(b.offsetHeightDelta || 0) -
          Number(a.offsetHeightDelta || 0);
      });

      var largestGrowthDescendants = largestDescendants.slice();
      largestGrowthDescendants.sort(function (a, b) {
        var aDelta = a.offsetHeightDelta;
        var bDelta = b.offsetHeightDelta;
        if (aDelta === null && bDelta === null) return 0;
        if (aDelta === null) return 1;
        if (bDelta === null) return -1;
        var deltaDifference = Number(bDelta || 0) - Number(aDelta || 0);
        if (deltaDifference) return deltaDifference;
        return Number(b.offsetHeight || 0) - Number(a.offsetHeight || 0);
      });
      Object.keys(ids).forEach(function (id) {
        if (ids[id] > 1) {
          duplicateIds[id] = ids[id];
        }
      });
      var ancestors = [];
      var ancestor = root;
      while (ancestor) {
        try {
          var ancestorStyle = getComputedStyle(ancestor);
          var ancestorRect = ancestor.getBoundingClientRect();
          var beforeStyle = getComputedStyle(ancestor, '::before');
          var afterStyle = getComputedStyle(ancestor, '::after');
          ancestors.push({
            label: elementLabel(ancestor),
            display: String(ancestorStyle.display || ''),
            position: String(ancestorStyle.position || ''),
            overflow: String(ancestorStyle.overflow || ''),
            overflowY: String(ancestorStyle.overflowY || ''),
            height: String(ancestorStyle.height || ''),
            minHeight: String(ancestorStyle.minHeight || ''),
            maxHeight: String(ancestorStyle.maxHeight || ''),
            blockSize: String(ancestorStyle.blockSize || ''),
            minBlockSize: String(ancestorStyle.minBlockSize || ''),
            maxBlockSize: String(ancestorStyle.maxBlockSize || ''),
            contain: String(ancestorStyle.contain || ''),
            contentVisibility: String(ancestorStyle.contentVisibility || ''),
            top: Math.round(Number(ancestorRect.top || 0)),
            bottom: Math.round(Number(ancestorRect.bottom || 0)),
            rectHeight: Math.round(Number(ancestorRect.height || 0)),
            scrollHeight: Number(ancestor.scrollHeight || 0),
            clientHeight: Number(ancestor.clientHeight || 0),
            offsetHeight: Number(ancestor.offsetHeight || 0),
            before: {
              content: String(beforeStyle.content || ''),
              display: String(beforeStyle.display || ''),
              position: String(beforeStyle.position || ''),
              height: String(beforeStyle.height || ''),
              minHeight: String(beforeStyle.minHeight || ''),
              backgroundImage: String(beforeStyle.backgroundImage || '')
            },
            after: {
              content: String(afterStyle.content || ''),
              display: String(afterStyle.display || ''),
              position: String(afterStyle.position || ''),
              height: String(afterStyle.height || ''),
              minHeight: String(afterStyle.minHeight || ''),
              backgroundImage: String(afterStyle.backgroundImage || '')
            }
          });
        } catch (e) {}
        ancestor = ancestor.parentElement;
      }
      suspicious.sort(function (a, b) {
        if (a.farBelow !== b.farBelow) return a.farBelow ? -1 : 1;
        if (a.oversized !== b.oversized) return a.oversized ? -1 : 1;
        return Math.max(
          b.bottom,
          b.height,
          b.scrollHeight
        ) - Math.max(
          a.bottom,
          a.height,
          a.scrollHeight
        );
      });

      return {
        ok: true,
        root: {
          label: elementLabel(root),
          top: Math.round(rootTop),
          bottom: Math.round(rootBottom),
          rectHeight: Math.round(Number(rootRect.height || 0)),
          scrollHeight: Number(root.scrollHeight || 0),
          clientHeight: Number(root.clientHeight || 0),
          offsetHeight: Number(root.offsetHeight || 0),
          expectedHeight: expectedHeight,
          liveExpectedHeight: Math.round(liveExpectedHeight),
          expectedBottom: Math.round(expectedBottom),
          currentBottom: Math.round(rootBottom),
          excessHeight: Math.max(0, Math.round(rootRect.height - liveExpectedHeight))
        },
        document: {
          scrollHeight: Number(
            document.documentElement &&
            document.documentElement.scrollHeight || 0
          ),
          bodyScrollHeight: Number(
            document.body &&
            document.body.scrollHeight || 0
          ),
          htmlRectHeight: Math.round(Number(
            document.documentElement.getBoundingClientRect().height || 0
          )),
          bodyRectHeight: Math.round(Number(
            document.body.getBoundingClientRect().height || 0
          )),
          htmlMinHeight: String(
            getComputedStyle(document.documentElement).minHeight || ''
          ),
          bodyMinHeight: String(
            getComputedStyle(document.body).minHeight || ''
          )
        },
        baseline: pdfLayoutBaseline && pdfLayoutBaseline.root === root
          ? {
              elementCount: pdfLayoutBaseline.byElement.size,
              targetSelectors: targetSelectors,
              root: pdfLayoutBaseline.rootMeasurement
            }
          : null,
        largestDescendants: largestDescendants.slice(
          0,
          topDescendantLimit
        ),
        largestGrowthDescendants: largestGrowthDescendants.slice(
          0,
          topGrowthLimit
        ),
        conversationSummary: rowReport.summary,
        conversationRows: rowReport.rows,
        ancestors: ancestors,
        duplicateIds: duplicateIds,
        suspiciousCount: suspicious.length,
        suspicious: suspicious.slice(0, limit)
      };
    } catch (e) {
      return {
        ok: false,
        error: String((e && e.message) || e)
      };
    }
  }

  // -------------------------------------------------------------------------
  // Dynamic width helpers
  //
  // The host app owns the CSS variable name and clamp range (supplied via
  // init()); the agent owns the read/write logic and the responsive resize
  // listener.  State on window uses generic __appRenderer_* names so this
  // file stays project-neutral.
  // -------------------------------------------------------------------------
  function getTargetVW() {
    try {
      if (!DYNAMIC_WIDTH_CSS_VAR) {
        return { ok: false, error: 'no dynamicWidthCssVar; call init({ dynamicWidthCssVar: "..." })', vw: DYNAMIC_WIDTH_DEFAULT_VW };
      }
      var raw = getComputedStyle(document.documentElement)
        .getPropertyValue(DYNAMIC_WIDTH_CSS_VAR).trim();
      var m = /^(\d+)vw$/.exec(raw);
      var vw = m ? parseInt(m[1], 10) : DYNAMIC_WIDTH_DEFAULT_VW;
      return { ok: true, vw: vw };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), vw: DYNAMIC_WIDTH_DEFAULT_VW };
    }
  }

  function setTargetVW(options) {
    try {
      if (!DYNAMIC_WIDTH_CSS_VAR) {
        return { ok: false, error: 'no dynamicWidthCssVar; call init({ dynamicWidthCssVar: "..." })' };
      }
      var opts = options || {};
      var vw = Number(opts.vw || 0);
      var clamped = Math.max(DYNAMIC_WIDTH_MIN_VW, Math.min(DYNAMIC_WIDTH_MAX_VW, Math.round(vw)));
      document.documentElement.style.setProperty(DYNAMIC_WIDTH_CSS_VAR, clamped + 'vw');
      return { ok: true, vw: clamped };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function seedTargetVW(options) {
    try {
      if (!DYNAMIC_WIDTH_CSS_VAR) {
        return { ok: false, error: 'no dynamicWidthCssVar; call init({ dynamicWidthCssVar: "..." })' };
      }
      var root = document.documentElement;
      var current = getComputedStyle(root).getPropertyValue(DYNAMIC_WIDTH_CSS_VAR).trim();
      if (current) return { ok: true, seeded: false, vw: null };
      var opts = options || {};
      var vw = Number(opts.vw || DYNAMIC_WIDTH_DEFAULT_VW);
      var clamped = Math.max(DYNAMIC_WIDTH_MIN_VW, Math.min(DYNAMIC_WIDTH_MAX_VW, Math.round(vw)));
      root.style.setProperty(DYNAMIC_WIDTH_CSS_VAR, clamped + 'vw');
      return { ok: true, seeded: true, vw: clamped };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function startVWResize(options) {
    try {
      if (!DYNAMIC_WIDTH_CSS_VAR) {
        return { ok: false, error: 'no dynamicWidthCssVar; call init({ dynamicWidthCssVar: "..." })' };
      }
      var opts = options || {};
      var screenPercent = Number(opts.screenPercent || DYNAMIC_WIDTH_MAX_VW);

      // Idempotent: remove any prior listener so repeat calls do not stack.
      try { stopVWResize(); } catch (e) {}

      function computeVW() {
        try {
          var screenW = (window.screen && window.screen.width) ? window.screen.width : window.innerWidth;
          var winW = window.innerWidth;
          var vw = Math.round((winW / screenW) * screenPercent);
          vw = Math.max(DYNAMIC_WIDTH_MIN_VW, Math.min(DYNAMIC_WIDTH_MAX_VW, vw));
          document.documentElement.style.setProperty(DYNAMIC_WIDTH_CSS_VAR, vw + 'vw');
        } catch (e) {}
      }

      computeVW();
      window.addEventListener('resize', computeVW, { passive: true });
      window.addEventListener('orientationchange', computeVW, { passive: true });

      window.__appRenderer_vwResizeHandler = computeVW;
      window.__appRenderer_vwResizeInstalled = true;

      return { ok: true, installed: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function stopVWResize() {
    try {
      var handler = window.__appRenderer_vwResizeHandler;
      if (handler) {
        try { window.removeEventListener('resize', handler); } catch (e) {}
        try { window.removeEventListener('orientationchange', handler); } catch (e) {}
      }
      try { delete window.__appRenderer_vwResizeHandler; } catch (e) {
        window.__appRenderer_vwResizeHandler = null;
      }
      try { delete window.__appRenderer_vwResizeInstalled; } catch (e) {
        window.__appRenderer_vwResizeInstalled = false;
      }
      return { ok: true, uninstalled: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // -------------------------------------------------------------------------
  // Conversation export diagnostic.
  //
  // Purpose: answer two questions with runtime DOM facts instead of inference.
  //
  //   PRIMARY  -- Why are Copilot (assistant) responses missing from the PDF?
  //     Enumerates the conversation rows (reusing getDiagnosticRows so it sees
  //     exactly what the exporter's other diagnostics see), classifies each as
  //     user / assistant / mixed / unknown, and records connectivity, geometry
  //     and the styles that can suppress content (display, visibility, opacity,
  //     content-visibility, contain, max-height, overflow) plus a text preview.
  //     Run at several export stages, the per-stage assistantSummary shows the
  //     exact stage at which assistant rows vanish, collapse to zero height,
  //     are hidden, or are disconnected from the DOM.
  //
  //   SECONDARY -- Why does "Reasoning completed in N steps" not expand?
  //     Dumps every reasoning control's full attribute set and resolves its
  //     aria-controls target, reporting whether that target exists, is
  //     connected, and has rendered text. A missing/empty target means the
  //     body is lazy-rendered (a click is required; CSS cannot reveal it); a
  //     present-but-hidden target means CSS/allow-list can reveal it.
  //
  // This is read-only. It mutates nothing and never clicks. Classification is
  // derived from the caller-configured DOM_COLLECTION_SELECTORS (by keyword),
  // so it introduces no new app-specific fingerprints into the shared agent.
  // -------------------------------------------------------------------------
  function capturePdfConversationDiagnostic(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    var stage = String(opts.stage || '');
    var maxRows = Number(opts.maxRows || 300);
    var previewLen = Number(opts.previewLen || 180);
    var maxReasoningPerRow = Number(opts.maxReasoningPerRow || 6);
    // Marker separating a turn's user text from the assistant's answer.
    // Caller-supplied so this shared file stays project-neutral.
    var answerMarker = String(opts.answerMarker || 'Copilot said:');

    try {
      var root = getPdfTargetPane(fallbackSelector);
      if (!root) return { ok: false, stage: stage, error: 'chat pane not found' };

      // Split the configured collection selectors into role hints by keyword.
      var userHints = [];
      var assistantHints = [];
      try {
        for (var s = 0; s < DOM_COLLECTION_SELECTORS.length; s++) {
          var sel = String(DOM_COLLECTION_SELECTORS[s] || '');
          if (/user/i.test(sel)) userHints.push(sel);
          if (/assistant|copilot|answer/i.test(sel)) assistantHints.push(sel);
        }
      } catch (e) {}

      function matchesAny(el, list) {
        for (var i = 0; i < list.length; i++) {
          try {
            if (el.matches && el.matches(list[i])) return true;
            if (el.querySelector && el.querySelector(list[i])) return true;
          } catch (e) {}
        }
        return false;
      }
      function guessRole(el) {
        var u = matchesAny(el, userHints);
        var a = matchesAny(el, assistantHints);
        if (u && a) return 'mixed';
        if (u) return 'user';
        if (a) return 'assistant';
        return 'unknown';
      }

      function dumpAttributes(el) {
        var out = {};
        try {
          for (var i = 0; i < el.attributes.length; i++) {
            var at = el.attributes[i];
            out[at.name] = String(at.value || '').slice(0, 160);
          }
        } catch (e) {}
        return out;
      }

      function describeControlledRegion(el) {
        try {
          var controls = el.getAttribute && el.getAttribute('aria-controls');
          if (!controls) return null;
          var firstId = String(controls).split(/\s+/).filter(Boolean)[0];
          if (!firstId) return null;
          var target = document.getElementById(firstId);
          if (!target) {
            return { id: firstId, exists: false };
          }
          var trect = null;
          try { trect = target.getBoundingClientRect(); } catch (e) {}
          var ttext = '';
          try { ttext = String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) {}
          var tcs = null;
          try { tcs = getComputedStyle(target); } catch (e) {}
          return {
            id: firstId,
            exists: true,
            isConnected: !!target.isConnected,
            insideRoot: !!(root.contains && root.contains(target)),
            rectHeight: trect ? Math.round(trect.height) : 0,
            textLength: ttext.length,
            display: tcs ? String(tcs.display) : '',
            visibility: tcs ? String(tcs.visibility) : '',
            contentVisibility: tcs ? String(tcs.contentVisibility) : '',
            ariaHidden: target.getAttribute ? target.getAttribute('aria-hidden') : null,
            hiddenAttr: !!(target.hasAttribute && target.hasAttribute('hidden')),
            dataState: target.getAttribute ? target.getAttribute('data-state') : null
          };
        } catch (e) {
          return { error: String((e && e.message) || e) };
        }
      }

      // Find reasoning controls within a scope. A control is a candidate if its
      // class mentions "reasoning", or its (short) visible text/aria-label looks
      // like a reasoning twisty ("reasoning", "completed in N steps",
      // "thought/thinking"). Read-only; we never click here.
      var reasoningTextRe = /reasoning|thought|thinking|completed in\s*\d+\s*steps?/i;
      function scanReasoningControls(scope) {
        var results = [];
        try {
          var pool = scope.querySelectorAll(
            '[class*="Reasoning" i],[class*="reasoning" i],' +
            '[aria-expanded],[data-state],button,[role="button"],summary'
          );
          for (var i = 0; i < pool.length && results.length < maxReasoningPerRow; i++) {
            var el = pool[i];
            var cls = '';
            try { cls = String(el.className || ''); } catch (e) {}
            var label = '';
            try {
              label = String(
                (el.getAttribute && el.getAttribute('aria-label')) ||
                el.innerText || el.textContent || ''
              ).replace(/\s+/g, ' ').trim();
            } catch (e) {}
            var isReasoning = /reasoning/i.test(cls) ||
              (label.length <= 80 && reasoningTextRe.test(label));
            if (!isReasoning) continue;
            results.push({
              label: elementLabel(el),
              tagName: String(el.tagName || '').toLowerCase(),
              text: label.slice(0, previewLen),
              attributes: dumpAttributes(el),
              controlledRegion: describeControlledRegion(el)
            });
          }
        } catch (e) {}
        return results;
      }

      var rowEls = getDiagnosticRows(root);
      var rows = [];
      var summary = {
        assistantVisible: 0,
        assistantZeroHeight: 0,
        assistantHidden: 0,
        assistantDisconnected: 0,
        assistantEmptyText: 0,
        userVisible: 0,
        unknownVisible: 0
      };

      // ANSWER-BODY measurement: the text AFTER the last answer marker, with
      // the bare assistant name and the "Sources" chip label removed, so an
      // unanswered turn scores ~0.
      //
      // WHY: the row-level textLength cannot tell whether an answer exists.
      // Each row is a whole turn wrapper, and in this workload the user's
      // pasted logs/code dominate it -- so every row measured as "populated"
      // (assistantVisible: 45, assistantEmptyText: 0) while every answer body
      // was in fact empty. That false signal hid the real failure repeatedly.
      //
      // The SOURCE matters as much as the slice. innerText is CSS-aware: it
      // omits text hidden by content-visibility/display, but only returns ''
      // for a row when the whole row is hidden. A row holding visible user
      // text therefore yields non-empty innerText even when the answer subtree
      // is suppressed. textContent ignores CSS entirely.
      //
      // Measuring both separates two failure modes needing OPPOSITE fixes:
      //   contentLen ~0, innerLen ~0    -> answer is NOT in the DOM
      //                                    (needs rendering/materialization)
      //   contentLen large, innerLen ~0 -> answer IS in the DOM but hidden
      //                                    (needs a CSS/visibility override)
      function answerBodyOf(el) {
        function bodyFrom(raw) {
          var t = String(raw || '').replace(/\s+/g, ' ').trim();
          var idx = t.lastIndexOf(answerMarker);
          if (idx < 0) return { present: false, len: 0, preview: '' };
          var after = t.slice(idx + answerMarker.length).trim();
          after = after.replace(/^copilot\b/i, '').trim();
          after = after.replace(/\bsources\b/gi, '').trim();
          return { present: true, len: after.length, preview: after.slice(0, previewLen) };
        }
        var c = { present: false, len: 0, preview: '' };
        var i = { present: false, len: 0, preview: '' };
        try { c = bodyFrom(el.textContent); } catch (e) {}
        try { i = bodyFrom(el.innerText); } catch (e) {}
        return {
          hasMarker: c.present || i.present,
          contentLen: c.len,
          innerLen: i.len,
          hiddenChars: Math.max(0, c.len - i.len),
          preview: c.preview || i.preview
        };
      }

      var answerStats = {
        turnsWithMarker: 0,
        answersPresent: 0,
        answersEmpty: 0,
        answersHiddenByCss: 0,
        totalAnswerChars: 0,
        totalHiddenChars: 0
      };

      for (var r = 0; r < rowEls.length && r < maxRows; r++) {
        var el2 = rowEls[r];
        var cs2 = null;
        try { cs2 = getComputedStyle(el2); } catch (e) {}
        var rect2 = null;
        try { rect2 = el2.getBoundingClientRect(); } catch (e) {}
        var txt2 = '';
        try { txt2 = String(el2.innerText || el2.textContent || '').replace(/\s+/g, ' ').trim(); } catch (e) {}
        var body2 = answerBodyOf(el2);
        var role = guessRole(el2);
        var rectH = rect2 ? Math.round(rect2.height) : 0;
        var display2 = cs2 ? String(cs2.display) : '';
        var visibility2 = cs2 ? String(cs2.visibility) : '';
        var opacity2 = cs2 ? String(cs2.opacity) : '';
        var hiddenLike =
          display2 === 'none' ||
          visibility2 === 'hidden' ||
          (cs2 && Number(cs2.opacity) === 0);

        rows.push({
          index: r,
          role: role,
          label: elementLabel(el2),
          isConnected: !!el2.isConnected,
          rectHeight: rectH,
          offsetHeight: Number(el2.offsetHeight || 0),
          scrollHeight: Number(el2.scrollHeight || 0),
          display: display2,
          visibility: visibility2,
          opacity: opacity2,
          contentVisibility: cs2 ? String(cs2.contentVisibility) : '',
          contain: cs2 ? String(cs2.contain) : '',
          maxHeight: cs2 ? String(cs2.maxHeight) : '',
          overflow: cs2 ? String(cs2.overflow) : '',
          textLength: txt2.length,
          textHead: txt2.slice(0, previewLen),
          textTail: txt2.slice(-previewLen),
          // Answer-body measurements. answerLen is the CSS-independent truth;
          // answerVisibleLen is what CSS currently exposes; the difference is
          // text present in the DOM but suppressed from rendering.
          hasAnswerMarker: body2.hasMarker,
          answerLen: body2.contentLen,
          answerVisibleLen: body2.innerLen,
          answerHiddenChars: body2.hiddenChars,
          answerPreview: body2.preview,
          reasoningControls: scanReasoningControls(el2)
        });

        if (body2.hasMarker) {
          answerStats.turnsWithMarker++;
          answerStats.totalAnswerChars += body2.contentLen;
          answerStats.totalHiddenChars += body2.hiddenChars;
          if (body2.contentLen < 40) answerStats.answersEmpty++;
          else answerStats.answersPresent++;
          if (body2.hiddenChars > 40) answerStats.answersHiddenByCss++;
        }

        if (role === 'assistant' || role === 'mixed') {
          if (!el2.isConnected) summary.assistantDisconnected++;
          else if (hiddenLike) summary.assistantHidden++;
          else if (rectH < 4) summary.assistantZeroHeight++;
          else if (txt2.length < 2) summary.assistantEmptyText++;
          else summary.assistantVisible++;
        } else if (role === 'user') {
          if (el2.isConnected && !hiddenLike && rectH >= 4) summary.userVisible++;
        } else {
          if (el2.isConnected && !hiddenLike && rectH >= 4) summary.unknownVisible++;
        }
      }

      return {
        ok: true,
        stage: stage,
        rootLabel: elementLabel(root),
        answerMarker: answerMarker,
        answerStats: answerStats,
        userHints: userHints,
        assistantHints: assistantHints,
        rowCount: rowEls.length,
        reported: rows.length,
        assistantSummary: summary,
        rows: rows
      };
    } catch (e) {
      return { ok: false, stage: stage, error: String((e && e.message) || e) };
    }
  }

  // -------------------------------------------------------------------------
  // Expand chain-of-thought / reasoning panels for export.
  //
  // WHY THIS EXISTS SEPARATELY FROM expandForPrint():
  // The "Reasoning completed in N steps" control collapses the model's
  // reasoning by default. expandForPrint() only clicks controls mounted at the
  // moment it runs; the Fluent virtualizer keeps just a few rows mounted, so
  // off-screen reasoning panels are never opened. This method is intended to
  // run AFTER pdfPrepare() has flattened the virtualizer -- at that point every
  // row is mounted, so a single sweep can open all reasoning panels.
  //
  // It clicks ONLY controls matching the app-configured
  // REASONING_EXPAND_SELECTORS (populated by init() from lib/chat-dom.js), so
  // no Copilot/Gemini/Grok DOM fingerprint lives in this shared file. Reasoning
  // panels expand inline (they are not portal menus); as a defence-in-depth
  // measure, if a click unexpectedly opens a role=menu/dialog/listbox we send
  // Escape. Read-only otherwise: it does not edit content.
  //
  // Returns counts plus a coarse before/after root text length so the caller's
  // log shows whether expansion actually revealed additional content (useful
  // if the reasoning body turns out to be lazily rendered).
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Expansion cancellation (Escape key)
  //
  // Expanding a long conversation can take a minute or more, and it runs as one
  // long renderer-side loop. These give the user a way out: beginExpandCancel()
  // installs a capture-phase keydown listener that sets a flag; the expansion
  // loops check that flag every iteration and stop cleanly, keeping whatever
  // was already expanded and captured. endExpandCancel() always removes the
  // listener so it cannot leak into normal typing.
  //
  // The listener is capture-phase and on window so it sees Escape before the
  // hosted web app can swallow it. It does NOT preventDefault: cancelling the
  // expansion should not also break the app's own Escape handling.
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Expansion progress overlay
  //
  // Expanding a long conversation can take a minute or more with no visible
  // sign that anything is happening. This draws a small fixed-position banner
  // in the page reporting the current phase and per-panel progress, and telling
  // the user that Escape cancels.
  //
  // It lives in the renderer because the expansion loop runs there: the main
  // process is blocked awaiting a single callRA() and cannot report progress
  // mid-flight. Updating a DOM node directly from the loop needs no IPC.
  //
  // The node is tagged data-app-expand-overlay and pointer-events:none so it
  // cannot intercept clicks, and it is always removed when expansion ends, so
  // it can never appear in an export.
  // -------------------------------------------------------------------------
  var expandOverlayEl = null;

  function showExpandOverlay(text) {
    try {
      if (!expandOverlayEl || !expandOverlayEl.isConnected) {
        expandOverlayEl = document.createElement('div');
        expandOverlayEl.setAttribute('data-app-expand-overlay', '1');
        expandOverlayEl.setAttribute('aria-live', 'polite');
        expandOverlayEl.style.cssText = [
          'position:fixed',
          'top:16px',
          'left:50%',
          'transform:translateX(-50%)',
          'z-index:2147483647',
          'background:rgba(20,20,20,0.92)',
          'color:#fff',
          'font:13px/1.45 system-ui,-apple-system,Segoe UI,sans-serif',
          'padding:10px 16px',
          'border-radius:8px',
          'border:1px solid rgba(255,255,255,0.18)',
          'box-shadow:0 4px 16px rgba(0,0,0,0.45)',
          'pointer-events:none',
          'white-space:pre-line',
          'text-align:center',
          'max-width:80vw'
        ].join(';');
        (document.body || document.documentElement).appendChild(expandOverlayEl);
      }
      expandOverlayEl.textContent = String(text || '');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function hideExpandOverlay() {
    try {
      if (expandOverlayEl && expandOverlayEl.parentNode) {
        expandOverlayEl.parentNode.removeChild(expandOverlayEl);
      }
    } catch (e) {}
    expandOverlayEl = null;
    // Belt and braces: remove any stray overlay from an interrupted run so it
    // can never be captured by a later export.
    try {
      var strays = document.querySelectorAll('[data-app-expand-overlay]');
      for (var i = 0; i < strays.length; i++) {
        try { strays[i].parentNode.removeChild(strays[i]); } catch (e) {}
      }
    } catch (e) {}
    return { ok: true };
  }

  var expandCancelRequested = false;
  var expandCancelHandler = null;

  function beginExpandCancel() {
    expandCancelRequested = false;
    try {
      if (expandCancelHandler) {
        window.removeEventListener('keydown', expandCancelHandler, true);
      }
    } catch (e) {}
    expandCancelHandler = function (ev) {
      try {
        if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) {
          expandCancelRequested = true;
          try { console.log('[renderer-agent] expand: cancel requested (Escape)'); } catch (e) {}
        }
      } catch (e) {}
    };
    try {
      window.addEventListener('keydown', expandCancelHandler, true);
      return { ok: true, armed: true };
    } catch (e) {
      return { ok: false, armed: false, error: String((e && e.message) || e) };
    }
  }

  function endExpandCancel() {
    try {
      if (expandCancelHandler) {
        window.removeEventListener('keydown', expandCancelHandler, true);
      }
    } catch (e) {}
    expandCancelHandler = null;
    var was = expandCancelRequested;
    expandCancelRequested = false;
    return { ok: true, wasCancelled: was };
  }

  function isExpandCancelled() {
    return expandCancelRequested === true;
  }

  // Set the cancel flag without a keyboard event. Used by the main-process
  // before-input-event fallback, which sees Escape even when the renderer's own
  // keydown listener does not (e.g. focus sits outside the document).
  function requestExpandCancel() {
    expandCancelRequested = true;
    try { console.log('[renderer-agent] expand: cancel requested (main process)'); } catch (e) {}
    return { ok: true, cancelled: true };
  }

  function expandReasoningForPrint(options) {
    var opts = options || {};
    var fallbackSelector = String(opts.fallbackSelector || '');
    var settleMs = Number(opts.settleMs || 120);
    var maxClicks = Number(opts.maxClicks || 800);
    // CAPTURE-AS-YOU-GO. Runtime logs proved that on large conversations a
    // reasoning panel's BODY (the "Coding and executing" code + output, nested
    // in scc-ChainOfThought__activitiesPanel) renders only transiently while it
    // is the freshly-opened / in-view panel, then is torn down as the loop
    // moves on -- a post-loop stabilization poll saw reasoningGrew: 0 because
    // the bodies were already gone. So we snapshot each panel's body DURING the
    // loop, immediately after opening it, and later re-inject the richest
    // snapshot into the live DOM so it survives to printToPDF.
    // Adaptive capture tunables (see the capture block below).
    // capturePollMs      - interval between body-length samples.
    // captureStableTicks - consecutive unchanged samples that mean "settled".
    // capturePanelMaxMs  - per-panel ceiling so one slow panel cannot starve
    //                      the rest of the conversation.
    // captureThinChars   - below this the body is treated as not-yet-rendered
    //                      and gets one hydration scroll attempt.
    var capturePollMs = Number(opts.capturePollMs || 100);
    var captureStableTicks = Number(opts.captureStableTicks || 2);
    // Deliberately modest: the first pass should TRIGGER renders quickly, not
    // wait serially for each one. Waiting is done by the materialization pass
    // below, where all panels render concurrently instead of one at a time.
    // (At 1500ms x 30 panels the first pass alone would exhaust a 60s budget.)
    var capturePanelMaxMs = Number(opts.capturePanelMaxMs || 600);
    var captureThinChars = Number(opts.captureThinChars || 1000);
    // Materialization pass: how long to wait between re-check rounds, and how
    // many rounds to attempt, while stragglers finish rendering asynchronously.
    var materializeRoundMs = Number(opts.materializeRoundMs || 1200);
    var materializeMaxRounds = Number(opts.materializeMaxRounds || 12);
    // Hard wall-clock ceiling for the whole expand loop. Belt-and-suspenders
    // against any DOM behavior that keeps the collapsed set from emptying
    // (the 21-minute hang had no absolute bound). The processed-id set below
    // is the primary termination guarantee; this is the backstop.
    // Wall-clock ceiling for the whole pass. Supplied by lib/exporters.js from
    // APP_CONFIG.reasoningExpandBudgetMs; the fallback here is generous because
    // a too-small budget silently truncates the tail of the export (panels are
    // processed top-to-bottom, so late panels are the ones lost).
    var reasoningBudgetMs = Number(opts.reasoningBudgetMs) > 0
      ? Number(opts.reasoningBudgetMs)
      : 60000;

    var root = null;
    try { root = document.querySelector('[' + EXPORT_MARKER_ATTR + '="1"]'); } catch (e) {}
    if (!root) { try { root = getPdfTargetPane(fallbackSelector); } catch (e) {} }
    if (!root) return Promise.resolve({ ok: false, reason: 'no-marked-pane' });

    var selectorList = safeSelectorList(REASONING_EXPAND_SELECTORS);
    if (!selectorList) {
      return Promise.resolve({
        ok: true, reason: 'no-reasoning-selectors', found: 0, clicked: 0
      });
    }

    // Timer-based wait. This MUST NOT depend on requestAnimationFrame: during
    // PDF export (pdfPrepare has flattened the pane / the frame loop can be
    // starved) rAF callbacks may never be delivered, so the previous
    // rAF-then-setTimeout version could park forever on a single `await
    // settle(...)`. Because the loop's wall-clock budget is only checked
    // BETWEEN awaits, one non-resolving await hung the whole export (observed:
    // 54 minutes, no expandReasoningForPrint result line, budget never fired).
    // A plain setTimeout fires regardless of rAF, guaranteeing every await
    // resolves and the loop always reaches its budget/termination checks.
    function settle(ms) {
      return new Promise(function (res) {
        setTimeout(res, Math.max(0, Number(ms) || 0));
      });
    }
    function rootTextLen() {
      try { return String(root.innerText || root.textContent || '').length; }
      catch (e) { return 0; }
    }
    // Total text length of the reasoning subtree only. This is the signal we
    // stabilize on: as step bodies render progressively, this grows; when it
    // stops growing the reasoning is fully populated. Using textContent (not
    // innerText) so it counts text regardless of CSS/scroll clipping.
    function reasoningTextLen() {
      var total = 0;
      try {
        var panels = root.querySelectorAll('[class*="ChainOfThought"]');
        for (var i = 0; i < panels.length; i++) {
          try { total += String(panels[i].textContent || '').length; } catch (e) {}
        }
      } catch (e) {}
      return total;
    }
    // From an expander button, walk up to its owning ChainOfThought container
    // (the wrapper that also holds the activitiesPanel), skipping the button
    // itself (whose class also contains "ChainOfThought").
    function cotContainer(btn) {
      var n = btn;
      try {
        while (n && n !== root) {
          var cls = String((n.className && n.className.baseVal) || n.className || '');
          if (/ChainOfThought/.test(cls) && !/expandButton/.test(cls)) return n;
          n = n.parentElement;
        }
      } catch (e) {}
      try { return btn.closest('[class*="ChainOfThought"]:not([class*="expandButton"])'); }
      catch (e) { return null; }
    }
    // The activitiesPanel is the scroll container that holds the step bodies.
    function activitiesPanelOf(container) {
      if (!container) return null;
      try {
        var cls = String((container.className && container.className.baseVal) || container.className || '');
        if (/activitiesPanel/.test(cls)) return container;
        return container.querySelector('[class*="activitiesPanel"]');
      } catch (e) { return null; }
    }
    // Stable key shared between capture (loop) and re-injection (post-loop).
    // Prefer the button id (always present: e.g. "cot-r7rk-expand-button"),
    // then the container id, then a positional ordinal as last resort.
    function panelKey(btn, container, ordinal) {
      try { if (btn && btn.id) return 'b:' + String(btn.id).replace(/-expand-button.*$/, ''); } catch (e) {}
      try { if (container && container.id) return 'c:' + String(container.id); } catch (e) {}
      return 'o:' + ordinal;
    }
    // Force scroll-gated / virtualized nested steps inside ONE open panel to
    // mount by walking its scroll range top-to-bottom, then restoring.
    function hydrateOnePanel(p) {
      if (!p) return;
      try {
        var range = Math.max(0, (p.scrollHeight || 0) - (p.clientHeight || 0));
        if (range > 8) {
          var stepPx = Math.max(200, (p.clientHeight || 400) - 50);
          for (var y = 0; y <= range; y += stepPx) {
            try { p.scrollTop = y; } catch (e) {}
          }
          try { p.scrollTop = range; } catch (e) {}
          try { p.scrollTop = 0; } catch (e) {}
        }
      } catch (e) {}
    }
    function bodyTextLen(p) {
      try { return String((p && p.textContent) || '').length; } catch (e) { return 0; }
    }

    // Capture-as-you-go state, keyed by panelKey(). captured holds the richest
    // body snapshot ever seen for each panel; panelDiag is the per-panel
    // diagnostic surfaced in the result.
    //
    // These MUST be declared here, in expandReasoningForPrint. They were
    // previously declared in expandForPrint by mistake (both functions contain
    // an identical "var menusBefore = new Set();" anchor). Because they were
    // out of scope, the first unguarded use -- Object.keys(captured) inside the
    // final resolve({...}) -- threw "ReferenceError: captured is not defined".
    // That rejected the promise WITHOUT ever calling resolve(), so the main
    // process await on this renderer call never settled and the export appeared
    // to hang indefinitely (observed as 10/11/21/54-minute hangs). The loop
    // itself was fine: renderer logs show loop-start -> loop-done in 0.8s.
    var captured = {};
    var panelDiag = [];
    // Live references to every reasoning panel we opened, so the
    // materialization pass below can revisit them. Clicking a panel only
    // TRIGGERS its body render; the content arrives asynchronously and can take
    // far longer than the per-panel capture window on a cold app start.
    var openedPanels = [];

    var menusBefore = new Set();
    try {
      document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]')
        .forEach(function (n) { menusBefore.add(n); });
    } catch (e) {}

    return new Promise(function (resolve) {
      (async function run() {
        var found = 0, clicked = 0, attempts = 0, ordinal = 0, budgetHit = false, cancelled = false;
        var beforeLen = rootTextLen();
        // Set of expander identities already handled this run. This is the
        // PRIMARY termination guarantee: we act on each unique expander at most
        // once, so the loop runs at most (number of distinct expanders) times
        // regardless of how the app re-renders or how the collapsed COUNT
        // oscillates. Identity is the button id (always present, e.g.
        // "cot-r7rk-expand-button"); a keyless button is neutralized instead.
        var processed = {};
        var startTime = Date.now();
        try {
          var collapsedAtStart = root.querySelectorAll(selectorList).length;
          console.log('[renderer-agent] expandReasoning: loop-start', {
            collapsedExpanders: collapsedAtStart, budgetMs: reasoningBudgetMs
          });
        } catch (e) {}
        try {
          // Expand ONE panel per iteration, re-querying the live DOM each time
          // (clicking re-renders and detaches nodes, so a frozen NodeList goes
          // stale). Each iteration we take the topmost collapsed expander whose
          // identity has NOT been processed yet.
          while (attempts < maxClicks) {
            attempts++;

            // User pressed Escape: stop cleanly, keeping what we already have.
            if (isExpandCancelled()) { cancelled = true; break; }

            // Wall-clock backstop.
            if (Date.now() - startTime >= reasoningBudgetMs) { budgetHit = true; break; }

            var all = null;
            try { all = root.querySelectorAll(selectorList); } catch (e) {}
            var count = all ? all.length : 0;
            if (!count) break; // nothing collapsed remains

            // Live progress. `found` is how many we have handled; `count` is
            // how many remain collapsed, so found+count is the running total.
            // Placed after count is computed -- reading it earlier would show
            // NaN, since var-hoisting leaves it undefined at the loop top.
            try {
              showExpandOverlay(
                'Expanding reasoning\u2026  ' + (found + 1) + ' / ' + (found + count) +
                '\nPress Esc to cancel'
              );
            } catch (e) {}

            // Find the first collapsed expander we have not handled yet.
            var next = null;
            for (var qi = 0; qi < all.length; qi++) {
              var cand = all[qi];
              var cid = '';
              try { cid = String(cand.id || ''); } catch (e) {}
              var idkey = cid || ('noid:' + qi);
              if (!processed[idkey]) { next = cand; next.__cotKey = idkey; break; }
            }
            // Every collapsed expander remaining has already been processed
            // (its click did not flip aria-expanded and it has no distinct id).
            // Neutralize them so they drop out, then we are done.
            if (!next) {
              try {
                for (var ni = 0; ni < all.length; ni++) {
                  try { all[ni].setAttribute('aria-expanded', 'true'); } catch (e) {}
                }
              } catch (e) {}
              break;
            }

            processed[next.__cotKey] = true;
            found++;
            // Bring it into view in case its body is viewport-gated.
            try { next.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
            try { next.click(); } catch (e) {}
            await settle(settleMs);

            var after = count;
            try { after = root.querySelectorAll(selectorList).length; } catch (e) {}
            var opened = after < count;
            if (opened) {
              clicked++; // a panel actually opened
            } else {
              // Click did not open it (node replaced, lazy, or a menu-style
              // control). Neutralize this node so it cannot block the panels
              // below it, then continue.
              try { next.setAttribute('aria-expanded', 'true'); } catch (e) {}
            }

            // --- Capture-as-you-go -------------------------------------------
            // Snapshot THIS panel's body now, while it is the freshly-opened /
            // in-view panel and its body is (transiently) rendered. Waiting
            // until after the whole loop misses it: at scale the app tears the
            // body back down once the loop moves on.
            ordinal++;
            var container = cotContainer(next);
            var panel = activitiesPanelOf(container);
            var key = panelKey(next, container, ordinal);
            if (panel) {
              // Adaptive capture. The previous version paid a fixed
              // 2 x captureSettleMs (~600ms) per panel whether or not the body
              // was already rendered. On a 30-panel conversation that consumed
              // the entire wall-clock budget after 10 panels, so the remaining
              // 20 were never expanded -- the export degraded from full bodies,
              // to headline-only, to no reasoning at all, top to bottom.
              //
              // Instead: poll the body length and stop as soon as it stops
              // growing. An already-rendered panel settles in ~2 polls (~200ms);
              // only panels that still look unrendered pay the hydration scroll
              // and the longer wait, capped per panel by capturePanelMaxMs. The
              // global budget is still honored inside the loop so one slow panel
              // cannot starve the rest.
              var panelStart = Date.now();
              var liveLen = bodyTextLen(panel);
              var lastLen = -1;
              var stable = 0;
              var polls = 0;
              var hydrated = false;
              while (
                (Date.now() - startTime) < reasoningBudgetMs &&
                (Date.now() - panelStart) < capturePanelMaxMs
              ) {
                // "Unchanged" only means SETTLED once the body actually has
                // content. A body that has not STARTED rendering is also
                // unchanged, and the previous version treated that as settled
                // and moved on after ~200ms -- which is why a fresh app start
                // captured all 30 panels at 9-626 chars (headlines) with
                // polls:2. Thin panels now keep waiting until they either
                // materialize or hit capturePanelMaxMs.
                if (liveLen === lastLen && liveLen >= captureThinChars) {
                  stable++;
                  if (stable >= captureStableTicks) break; // body has settled
                } else {
                  stable = 0;
                  lastLen = liveLen;
                }
                // One hydration attempt, only for panels that still look
                // unrendered. The internal scroll walk is the expensive part, so
                // panels whose body is already present skip it entirely.
                if (!hydrated && liveLen < captureThinChars) {
                  hydrateOnePanel(panel);
                  hydrated = true;
                }
                await settle(capturePollMs);
                polls++;
                liveLen = bodyTextLen(panel);
              }
              // Keep the richest snapshot ever seen for this key.
              if (!captured[key] || liveLen > captured[key].len) {
                try { captured[key] = { html: panel.innerHTML, len: liveLen }; } catch (e) {}
              }
              openedPanels.push({ key: key, panel: panel, index: ordinal });
              panelDiag.push({
                index: ordinal,
                key: key,
                opened: opened,
                liveBodyLenAtCapture: liveLen,
                capturedBodyLen: captured[key] ? captured[key].len : 0,
                polls: polls,
                hydrated: hydrated,
                thin: liveLen < captureThinChars,
                msSpent: (Date.now() - panelStart)
              });
            } else {
              panelDiag.push({
                index: ordinal,
                key: key,
                opened: opened,
                noPanel: true,
                liveBodyLenAtCapture: 0,
                capturedBodyLen: 0
              });
            }
          }
        } catch (e) {}

        // --- Adopt already-open panels ---------------------------------------
        // The click loop only tracks panels IT opened. But by the time this
        // function runs, expandForPrint() has usually already clicked every
        // chain-of-thought control open: its allow-list matches any class
        // containing "expand", and the control's class is
        // scc-ChainOfThought__expandButton. Because REASONING_EXPAND_SELECTORS
        // only match [aria-expanded="false"], this function then finds nothing
        // -- measured: found 0, clicked 0, elapsedMs 5, materializeRounds 0.
        //
        // "Open" is not the same as "rendered", though. The bodies still render
        // asynchronously, and with openedPanels empty the materialization pass
        // below had nothing to wait on, so the export captured headlines only
        // (DOM text stuck at ~696K where a later PDF run measured ~1.14M).
        //
        // So: adopt every reasoning panel present in the DOM, regardless of who
        // opened it. The materialization pass then waits for all of them.
        var adopted = 0;
        try {
          var known = {};
          for (var ai = 0; ai < openedPanels.length; ai++) {
            known[openedPanels[ai].key] = true;
          }
          var allCots = root.querySelectorAll('[class*="ChainOfThought"]');
          for (var ci2 = 0; ci2 < allCots.length; ci2++) {
            var cont = allCots[ci2];
            var pnl = activitiesPanelOf(cont);
            if (!pnl) continue; // buttons / non-panel matches
            var btn2 = null;
            try { btn2 = cont.querySelector('[class*="expandButton"]'); } catch (e) {}
            var k2 = panelKey(btn2, cont, -1);
            if (known[k2]) continue;
            known[k2] = true;
            openedPanels.push({ key: k2, panel: pnl, index: -1 });
            adopted++;
          }
        } catch (e) {}
        try {
          console.log('[renderer-agent] expandReasoning: adopted-open-panels', {
            adopted: adopted, tracked: openedPanels.length
          });
        } catch (e) {}

        // --- Materialization pass --------------------------------------------
        // Clicking a reasoning panel only TRIGGERS its body render; the content
        // arrives asynchronously. On a cold app start the whole conversation is
        // under-rendered (a measured fresh run had 156K chars of pane text and
        // 64K of reasoning; the SAME conversation minutes later had 981K and
        // 5.7M), so every panel was still a headline when its capture window
        // closed and the export faithfully printed headlines.
        //
        // This pass revisits panels that are still thin AFTER all clicks have
        // been issued -- by then the earliest clicks have had the entire click
        // loop's duration to render. It re-checks them in rounds, capturing
        // whatever has materialized, until nothing thin remains or the budget
        // runs out. This is the same effect that made the user's SECOND export
        // succeed, without needing a second export.
        var matRounds = 0, matCaptured = 0, matStillThin = 0;
        try {
          while ((Date.now() - startTime) < reasoningBudgetMs) {
            if (isExpandCancelled()) { cancelled = true; break; }
            try {
              showExpandOverlay(
                'Waiting for reasoning to render\u2026  round ' + (matRounds + 1) +
                '\nPress Esc to cancel'
              );
            } catch (e) {}
            var thinOnes = [];
            for (var mi = 0; mi < openedPanels.length; mi++) {
              var rec = openedPanels[mi];
              var curLen = bodyTextLen(rec.panel);
              if (curLen < captureThinChars) thinOnes.push(rec);
              // Always keep the richest version seen, even if still thin.
              if (!captured[rec.key] || curLen > captured[rec.key].len) {
                try {
                  captured[rec.key] = { html: rec.panel.innerHTML, len: curLen };
                  matCaptured++;
                } catch (e) {}
              }
            }
            matStillThin = thinOnes.length;
            if (!thinOnes.length) break;   // everything materialized
            if (matRounds >= materializeMaxRounds) break;
            // Nudge the stragglers, then give the app time to render.
            for (var ti = 0; ti < thinOnes.length; ti++) {
              try {
                thinOnes[ti].panel.scrollIntoView({ block: 'center', inline: 'nearest' });
              } catch (e) {}
              hydrateOnePanel(thinOnes[ti].panel);
            }
            // Sleep in short slices so Escape is noticed promptly instead of
            // after the full round delay.
            var waited = 0;
            while (waited < materializeRoundMs) {
              if (isExpandCancelled()) { cancelled = true; break; }
              var slice = Math.min(150, materializeRoundMs - waited);
              await settle(slice);
              waited += slice;
            }
            if (cancelled) break;
            matRounds++;
          }
        } catch (e) {}

        try {
          console.log('[renderer-agent] expandReasoning: materialize-done', {
            rounds: matRounds, captured: matCaptured, stillThin: matStillThin,
            elapsedMs: (Date.now() - startTime)
          });
        } catch (e) {}

        try {
          console.log('[renderer-agent] expandReasoning: loop-done', {
            found: found, clicked: clicked, attempts: attempts,
            uniqueProcessed: Object.keys(processed).length,
            budgetHit: budgetHit, elapsedMs: (Date.now() - startTime)
          });
        } catch (e) {}

        // --- Re-injection pass ----------------------------------------------
        // Native printToPDF snapshots the LIVE DOM. Any panel whose body was
        // captured richer than its current live state (because the app tore the
        // body down after we moved on) is written back from the snapshot so it
        // survives to print. Best-effort and guarded: it only ever GROWS a
        // panel (never shrinks), and is a no-op when the live body already
        // matches the capture. Re-injected panels are tagged
        // data-cot-captured="1" for post-hoc inspection.
        var reinjected = 0, examined = 0, reasoningStart = reasoningTextLen();
        try {
          var containers = root.querySelectorAll('[class*="ChainOfThought"]');
          for (var ci = 0; ci < containers.length; ci++) {
            var c = containers[ci];
            var p = activitiesPanelOf(c);
            if (!p) continue; // buttons / non-panel matches
            examined++;
            var cbtn = null;
            try { cbtn = c.querySelector('[class*="expandButton"]'); } catch (e) {}
            var ckey = panelKey(cbtn, c, -1);
            var snap = captured[ckey];
            if (!snap) continue;
            var liveNow = bodyTextLen(p);
            if (snap.len > liveNow + 4) {
              try {
                p.innerHTML = snap.html;
                p.setAttribute('data-cot-captured', '1');
                reinjected++;
              } catch (e) {}
            }
          }
        } catch (e) {}
        var reasoningEnd = reasoningTextLen();
        try {
          console.log('[renderer-agent] expandReasoning: reinject-done', {
            examined: examined, reinjected: reinjected,
            capturedPanels: Object.keys(captured).length
          });
        } catch (e) {}

        var newMenu = null;
        try {
          var menusAfter = document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"]');
          for (var m = 0; m < menusAfter.length; m++) {
            if (!menusBefore.has(menusAfter[m])) { newMenu = menusAfter[m]; break; }
          }
        } catch (e) {}
        if (newMenu) {
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); } catch (e) {}
        }

        var afterLen = rootTextLen();
        resolve({
          ok: true,
          selectorCount: REASONING_EXPAND_SELECTORS.length,
          found: found,
          clicked: clicked,
          neutralized: (found - clicked),
          attempts: attempts,
          uniqueProcessed: Object.keys(processed).length,
          budgetHit: budgetHit,
          budgetMs: reasoningBudgetMs,
          elapsedMs: (Date.now() - startTime),
          rootTextBefore: beforeLen,
          rootTextAfter: afterLen,
          grew: afterLen - beforeLen,
          menuDetected: !!newMenu,
          // Capture-as-you-go metrics.
          capturedPanels: Object.keys(captured).length,
          materializeRounds: matRounds,
          materializeCaptured: matCaptured,
          materializeStillThin: matStillThin,
          adoptedOpenPanels: adopted,
          cancelled: cancelled,
          examinedPanels: examined,
          reinjectedPanels: reinjected,
          reasoningTextBeforeReinject: reasoningStart,
          reasoningTextAfterReinject: reasoningEnd,
          reasoningGrew: reasoningEnd - reasoningStart,
          // Per-panel diagnostic (bounded) for reasoning body capture.
          panels: panelDiag.slice(0, 100)
        });
      })().catch(function (e) {
        // NEVER leave this promise unsettled. The async body above builds its
        // result outside the inner try/catch blocks, so any unexpected throw
        // (e.g. the out-of-scope `captured` ReferenceError that caused the
        // multi-minute "hangs") would otherwise reject silently and leave the
        // main process awaiting a call that never returns. Resolving with an
        // error object keeps the export moving and surfaces the fault in the
        // main-process log.
        try {
          resolve({
            ok: false,
            reason: 'expand-threw',
            error: String((e && e.message) || e),
            stack: String((e && e.stack) || '').slice(0, 600)
          });
        } catch (_) {}
      });
    });
  }

  Object.defineProperty(window, RENDERER_API_GLOBAL, {
    value: Object.freeze({
      __version: RENDERER_AGENT_VERSION,
      init: init,
      getSelectionFragment: getSelectionFragment,
      locateChatRoot: locateChatRoot,
      clearExportMarker: clearExportMarker,
      expandForPrint: expandForPrint,
      hydrateVirtualizer: hydrateVirtualizer,
      collectVirtualizedChatHtml: collectVirtualizedChatHtml,
      extractScopedImages: extractScopedImages,
      inlineImageDataUris: inlineImageDataUris,
      pdfPrepare: pdfPrepare,
      pdfRestore: pdfRestore,
      cleanExportHtml: cleanExportHtml,
      enableFindContentVisibility: enableFindContentVisibility,
      disableFindContentVisibility: disableFindContentVisibility,
      waitForChatInputReady: waitForChatInputReady,
      getTargetVW: getTargetVW,
      setTargetVW: setTargetVW,
      seedTargetVW: seedTargetVW,
      startVWResize: startVWResize,
      capturePdfLayoutBaseline: capturePdfLayoutBaseline,
      capturePdfLayoutStage: capturePdfLayoutStage,
      capturePdfResourceDiagnostic: capturePdfResourceDiagnostic,
      armPdfBeforePrintDiagnostic: armPdfBeforePrintDiagnostic,
      getPdfBeforePrintDiagnostic: getPdfBeforePrintDiagnostic,
      stopVWResize: stopVWResize,
      waitForPrintableAssets: waitForPrintableAssets,
      diagnosePdfLayout: diagnosePdfLayout,
      capturePdfConversationDiagnostic: capturePdfConversationDiagnostic,
      expandReasoningForPrint: expandReasoningForPrint,
      beginExpandCancel: beginExpandCancel,
      endExpandCancel: endExpandCancel,
      isExpandCancelled: isExpandCancelled,
      requestExpandCancel: requestExpandCancel,
      showExpandOverlay: showExpandOverlay,
      hideExpandOverlay: hideExpandOverlay
    }),
    writable: false,
    configurable: true,
    enumerable: false
  });
})();

