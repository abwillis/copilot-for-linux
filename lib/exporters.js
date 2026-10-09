'use strict';

const fs = require('fs');
const path = require('path');
const TurndownService = require('turndown');
const turndownPluginGfm = require('turndown-plugin-gfm');
const {
  callRendererMethod,
  callRendererMethodInFrame,
  callRendererMethodInAllFrames,
} = require('./renderer-api');
const {
  ExportJob,
  ExportCancelledError,
  ConversationSnapshot,
} = require('./export-job');
const {
  resolveExportPaperPalette: resolveExportPaperPaletteCore,
} = require('./export-validation');
const {
  createCanonicalConversationStore,
  validateCanonicalCapture,
} = require('./canonical-conversation');
const { captureConversation } = require('./conversation-capture');

const EXPORT_SCOPES = Object.freeze({
  PANE: 'pane',
  SELECTION: 'selection',
});

function createExporters(deps = {}) {
  const {
    app,
    BrowserWindow,
    dialog,
    safeShowError,
    PRINT_BUBBLE_CSS,
    CHAT_SCOPE_PSEUDO,
    EXPORT_ROOT_CLASS,
    EXPORT_ROOT_SELECTOR,
    DOM_PRESERVE_CONTENT_SELECTORS,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    normalizeExportFormat,
    // File-only verbose logger for large diagnostic dumps. Falls back to
    // console.log when the host did not supply one (keeps this module usable
    // standalone / in the other projects that share it).
    logVerbose = (...a) => console.log(...a),
    appLabel = 'Chat',
    appSlug = 'chat',
    rendererApiGlobal,
  } = deps;

  // Renderer-API call options. All renderer-agent calls in this module must
  // pass the app-configured global name so the shared renderer-api.js does
  // not fall back to its default (__appRenderer). This is what keeps this
  // file cross-project compatible: main.js hands us the app's globalName,
  // we never hardcode Copilot/Gemini/Grok anything here.
  const RENDERER_API_OPTIONS = rendererApiGlobal
    ? { __rendererApiOptions: { rendererApiGlobal } }
    : null;

  function withRendererApiOptions(args) {
    return RENDERER_API_OPTIONS ? args.concat(RENDERER_API_OPTIONS) : args;
  }

  function callRA(win, method, ...args) {
    return callRendererMethod(win, method, ...withRendererApiOptions(args));
  }

  function callRAFrames(win, method, ...args) {
    return callRendererMethodInAllFrames(win, method, ...withRendererApiOptions(args));
  }

  function callRAFrame(win, frameId, method, ...args) {
    return callRendererMethodInFrame(win, frameId, method, ...withRendererApiOptions(args));
  }

  function captureMainProcessMemoryDiagnostic() {
    try {
      const usage = process.memoryUsage();
      return {
        ok: true,
        rss: Number(usage.rss || 0),
        heapTotal: Number(usage.heapTotal || 0),
        heapUsed: Number(usage.heapUsed || 0),
        external: Number(usage.external || 0),
        arrayBuffers: Number(usage.arrayBuffers || 0),
      };
    } catch (err) {
      return {
        ok: false,
        error: String(err?.message || err),
      };
    }
  }


  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });







  async function findBestChatRoot(win, { includeHtml = true } = {}) {
    const results = await callRAFrames(
      win,
      'locateChatRoot',
      { includeHtml }
    );

    if (!results.length) {
      try {
        console.warn('[export-root] locateChatRoot returned no frame results');
      } catch {}
      return null;
    }

    const rendererErrors = results.filter(r => r?.value?.ok === false || r?.value?.missing);
    if (rendererErrors.length) {
      try {
        console.warn('[export-root] locateChatRoot renderer errors:', rendererErrors);
      } catch {}
    }

    const candidates = results.filter(r => {
      const value = r?.value;
      if (!value?.ok) return false;
      if (!includeHtml) return true;
      return !!(
        String(value.html || '').trim() ||
        Number(value.textLength || 0) > 0
      );
    });

    if (!candidates.length) {
      try {
        console.warn('[export-root] locateChatRoot returned no usable candidates:', results);
      } catch {}
      return null;
    }

    candidates.sort((a, b) => {
      const aConfidence = Number(a?.value?.confidence || 0);
      const bConfidence = Number(b?.value?.confidence || 0);
      if (bConfidence !== aConfidence) return bConfidence - aConfidence;
      const aScore = Number(a?.value?.score || 0);
      const bScore = Number(b?.value?.score || 0);
      if (bScore !== aScore) return bScore - aScore;
      const aLen = Number(a?.value?.textLength || 0);
      const bLen = Number(b?.value?.textLength || 0);
      return bLen - aLen;
    });

    return candidates[0];
  }

  async function getChatPaneSnapshot(win) {
    const best = await findBestChatRoot(win, { includeHtml: true });

    if (!best?.value?.ok) {
      return { ok: false, html: '', textLength: 0, selector: null };
    }

    return {
      ok: true,
      html: String(best.value.html || ''),
      textLength: Number(best.value.textLength || 0),
      selector: best.value.selector || null,
      confidence: Number(best.value.confidence || 0),
      cleanupReport: best.value.cleanupReport || null,
    };
  }

  // --- Build selection markdown for export (used by context menu) ---
  async function buildSelectionMarkdownForExport(win) {
    if (!win) return '';
    const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
    if (!hasSelection) return '';
    return htmlToMarkdown(html || text);
  }

  // --- Select Chat Pane (highlight chat content in renderer) ---
  // --- Expand Chat Pane (user-invoked, from the View > Expand menu) ---------
  //
  // Expands the conversation IN THE LIVE APP, outside any export. This exists
  // because expansion can never work reliably inside the export pipeline:
  //
  //   * After pdfPrepare(): every reasoning panel is mounted, but pdfPrepare
  //     flattens the virtualizer's scroll container, and the web app renders
  //     reasoning bodies lazily off that container -- so the bodies never
  //     render. Measured: 31/31 panels clicked, 12 materialization rounds,
  //     0 bodies captured; they appeared only after pdfRestore(), i.e. after
  //     the PDF was already written.
  //   * Before pdfPrepare(): the scroll container is alive and CAN render, but
  //     the virtualizer has only ~10 rows mounted, so most panels do not exist
  //     yet. Measured: found 0 expanders, 24 ChainOfThought elements vs 93.
  //
  // No position in the export satisfies both constraints. Running here does:
  // the app is fully live and interactive, hydration mounts every row, the
  // scroll container still works so lazy bodies render, and there is no export
  // deadline. The export then simply prints what is already on screen, and
  // Find benefits from the same expanded, rendered DOM.
  //
  // Returns a summary so the caller can report what happened.
  // True if the user pressed Escape during an in-progress expansion. Queries
  // every frame because the chat pane may live in a subframe.
  // Update / clear the in-page progress banner. Best-effort: never let overlay
  // problems break the expansion itself.
  async function setExpandOverlay(win, text) {
    try { await callRAFrames(win, 'showExpandOverlay', String(text || '')); } catch {}
  }
  async function clearExpandOverlay(win) {
    try { await callRAFrames(win, 'hideExpandOverlay'); } catch {}
  }

  async function isExpandCancelled(win) {
    try {
      const results = await callRAFrames(win, 'isExpandCancelled');
      return results.some(r => r?.value === true);
    } catch {
      return false;
    }
  }

  async function expandChatPane(win, options = {}) {
    const includeReasoning = options.includeReasoning !== false;
    if (!win?.webContents) return { ok: false, reason: 'no-window' };

    let escapeHandler = null;
    const summary = {
      ok: false,
      includeReasoning,
      markerApplied: false,
      hydrated: null,
      reasoning: null,
      cancelled: false,
    };

    try {
      // 1. Tag the chat pane. The renderer methods below are all scoped to the
      //    marked pane, exactly as the export path does it.
      const markResults = await callRAFrames(
        win,
        'locateChatRoot',
        { includeHtml: false, markForExport: true }
      );
      summary.markerApplied = markResults.some(r => r?.value?.markerApplied);
      if (!summary.markerApplied) {
        summary.reason = 'chat-pane-not-found';
        return summary;
      }

      // 1b. Arm Escape-to-cancel. Expanding a long conversation can take a
      //     minute or more; this lets the user abort and keep whatever has
      //     already been expanded. Disarmed in the finally block below.
      try { await callRAFrames(win, 'beginExpandCancel'); } catch {}

      // Main-process Escape fallback. The renderer keydown listener only fires
      // when the page itself has keyboard focus; before-input-event sees the
      // key for the whole webContents, which is more reliable right after the
      // menu closes. Removed in the finally block.
      escapeHandler = (_e, input) => {
        try {
          if (input && input.type === 'keyDown' &&
              (input.key === 'Escape' || input.code === 'Escape')) {
            callRAFrames(win, 'requestExpandCancel').catch(() => {});
          }
        } catch {}
      };
      try { win.webContents.on('before-input-event', escapeHandler); } catch {}

      await setExpandOverlay(win, 'Preparing conversation\u2026\nPress Esc to cancel');

      // 2. Keep off-screen subtrees rendered. Without this the app re-applies
      //    content-visibility to anything scrolled out of view and the work
      //    below is undone as we walk. This is the same override Find uses.
      try { await callRAFrames(win, 'enableFindContentVisibility'); } catch {}

      // 3. Mount every conversation row. restoreScrollTop:false keeps the rows
      //    mounted afterwards instead of snapping back to the bottom.
      try {
        await setExpandOverlay(
          win,
          'Loading all messages\u2026 this can take a minute\nPress Esc to cancel'
        );
        summary.hydrated = await callRA(
          win,
          'hydrateVirtualizer',
          { stepDelayMs: 60, restoreScrollTop: false }
        );
      } catch (e) {
        console.warn('[expand-pane] hydrateVirtualizer failed:', e);
      }

      // Cancelled during hydration? Stop here; the rows already mounted stay.
      if (await isExpandCancelled(win)) {
        summary.cancelled = true;
        summary.ok = true;
        return summary;
      }

      // 4. Open the ordinary collapsibles ("show more", citations, details).
      await setExpandOverlay(win, 'Expanding sections\u2026\nPress Esc to cancel');
      // Defer reasoning controls to step 5 below, but only when step 5 runs
      // (i.e. the "including reasoning" menu variant). For the
      // "except reasoning" variant nothing would expand them, so let
      // expandForPrint handle them as before.
      try {
        await callRA(win, 'expandForPrint', { skipReasoning: includeReasoning });
      } catch (e) {
        console.warn('[expand-pane] expandForPrint failed:', e);
      }

      if (await isExpandCancelled(win)) {
        summary.cancelled = true;
        summary.ok = true;
        return summary;
      }

      // 5. Optionally open the chain-of-thought reasoning panels. This is the
      //    slow part (~1s per panel) and is what the two menu variants select
      //    between.
      if (includeReasoning) {
        const reasoningBudgetMs = Number(APP_CONFIG.reasoningExpandBudgetMs) > 0
          ? Number(APP_CONFIG.reasoningExpandBudgetMs)
          : undefined;
        try {
          summary.reasoning = await callRA(
            win,
            'expandReasoningForPrint',
            { reasoningBudgetMs }
          );
          console.log('[expand-pane] expandReasoningForPrint:', summary.reasoning);
          if (summary.reasoning && summary.reasoning.cancelled) summary.cancelled = true;
        } catch (e) {
          console.warn('[expand-pane] expandReasoningForPrint failed:', e);
        }
      }

      summary.ok = true;
      return summary;
    } catch (err) {
      console.error('Expand Chat Pane failed:', err);
      summary.reason = String(err?.message ?? err);
      return summary;
    } finally {
      // Remove the export marker; the expansion itself is left in place. The
      // content-visibility override is deliberately NOT disabled -- it is what
      // keeps the expanded bodies rendered for the subsequent export/Find.
      // Detach the main-process Escape fallback.
      if (escapeHandler) {
        try { win.webContents.removeListener('before-input-event', escapeHandler); } catch {}
        escapeHandler = null;
      }

      // Always remove the progress banner so it can never appear in an export.
      await clearExpandOverlay(win);

      // Always disarm the Escape listener so it cannot leak into normal typing.
      try {
        const ends = await callRAFrames(win, 'endExpandCancel');
        if (ends.some(r => r?.value?.wasCancelled)) summary.cancelled = true;
      } catch {}
      if (summary.markerApplied) {
        try { await callRAFrames(win, 'clearExportMarker'); } catch {}
      }
    }
  }

  async function selectChatPane(win) {
    if (!win) return { ok: false, selectedTextLength: 0 };
    try {
      // Single-path: the renderer agent locates the scored best.el in the
      // frame where it was found and applies selectContent/scrollIntoView
      // in-place. No per-app fallback or selector re-query needed because
      // all three apps now share the same chat-root location code in the
      // shared renderer/agent.js, parameterized by per-app selectors.
      const results = await callRAFrames(
        win,
        'locateChatRoot',
        {
          includeHtml: false,
          selectContent: true,
          scrollIntoView: true,
        }
      );
      const best = results
        .map(r => ({ frameId: r.frameId, where: r.where, value: r.value }))
        .filter(r => r.value?.ok && Number(r.value?.selectedTextLength ?? 0) > 0)
        .sort((a, b) => {
          const aSelected = Number(a.value?.selectedTextLength ?? 0);
          const bSelected = Number(b.value?.selectedTextLength ?? 0);
          if (bSelected !== aSelected) return bSelected - aSelected;
          const aScore = Number(a.value?.score ?? 0);
          const bScore = Number(b.value?.score ?? 0);
          if (bScore !== aScore) return bScore - aScore;

          const aLen = Number(a.value?.textLength ?? 0);
          const bLen = Number(b.value?.textLength ?? 0);
          return bLen - aLen;
        })[0];
      if (best?.value) {
        return {
          ok: true,
          selectedTextLength: Number(best.value.selectedTextLength ?? 0),
          selector: best.value.selector ?? null,
          frameId: best.frameId,
          where: best.where,
          mode: 'renderer-agent',
        };
      }

      return { ok: false, selectedTextLength: 0 };
    } catch (err) {
      console.error('selectChatPane failed:', err);
      return { ok: false, selectedTextLength: 0 };
    }
  }

  // ---------- Selection  Markdown helpers ----------
  // Extract the current selection from the renderer as HTML fragment and text.
  async function getSelectionFragment(win) {
    if (!win?.webContents) return { hasSelection: false, html: '', text: '' };

    const result = await callRA(win, 'getSelectionFragment', { clean: true });

    if (!result?.ok) return { hasSelection: false, html: '', text: '' };

    return {
      hasSelection: !!result.hasSelection,
      html: String(result.html || ''),
      text: String(result.text || ''),
      cleanupReport: result.cleanupReport || null,
    };
  }

  async function getSelectionFragmentRaw(win) {
    if (!win) return { hasSelection: false, html: '', text: '' };

    const result = await callRA(win, 'getSelectionFragment', { clean: false });

    if (!result?.ok) return { hasSelection: false, html: '', text: '' };

    return {
      hasSelection: !!result.hasSelection,
      html: String(result.html || ''),
      text: String(result.text || ''),
    };
  }

  function normalizeSelectionForExport(selection) {
    const html = String(selection?.html || '');
    const text = String(selection?.text || '');
    const hasContent = !!(html.trim() || text.trim());

    return {
      hasSelection: !!selection?.hasSelection && hasContent,
      html,
      text,
      cleanupReport: selection?.cleanupReport || null,
    };
  }

  // Turndown-backed HTML  Markdown converter.
  // Regex is only used here for targeted preprocessing/post-processing around Turndown.
  const turndownService = createTurndownService();

  function createTurndownService() {
    const service = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      fence: '```',
      bulletListMarker: '-',
      emDelimiter: '*',
      strongDelimiter: '**',
      linkStyle: 'inlined',
      linkReferenceStyle: 'full',
      preformattedCode: true,
    });

    try {
      const { gfm, tables } = turndownPluginGfm;
      // Be explicit that tables must go through the GFM table path.
      if (tables) service.use(tables);
      if (gfm) service.use(gfm)
    } catch (err) {
      console.error('turndown-plugin-gfm setup failed:', err);
    }

    // Remove obvious non-content / executable elements if any survive renderer cleanup.
    try {
        service.remove([
        'script', 'style', 'noscript', 'template',
        'input', 'select', 'textarea',
        'svg', 'canvas', 'iframe'
      ]);

      // Unwrap buttons rather than removing them, so images inside
      // clickable wrappers survive into markdown.
      service.addRule('unwrapButtons', {
        filter: 'button',
        replacement: function (content) {
          return content || '';
        }
      });
    } catch (err) {
      console.error('Turndown remove() setup failed:', err);
    }

    // Preserve fenced code blocks exactly, including language hints when present.
    service.addRule('fencedCodeBlocks', {
      filter: 'pre',
      replacement: function (_content, node) {
        const codeNode =
        node.firstElementChild && node.firstElementChild.nodeName === 'CODE'
        ? node.firstElementChild
        : node;
        const raw = String(codeNode.textContent || '')
        .replace(/\u00A0/g, ' ')
        .replace(/\r\n?/g, '\n');
        const className = String(codeNode.getAttribute?.('class') || '');
        const language = (className.match(/(?:^|\s)language-([A-Za-z0-9_+-]+)/) || [])[1] || '';
        const body = raw.replace(/^\n+|\n+$/g, '');
        return `\n\n\`\`\`${language}\n${body}\n\`\`\`\n\n`;
      }
    });

    // Convert <br> to hard line breaks consistently.
    service.addRule('hardLineBreak', {
      filter: 'br',
      replacement: function () {
        return '  \n';
      }
    });

    // Treat HR explicitly so separators survive cleanup.
    service.addRule('thematicBreak', {
      filter: 'hr',
      replacement: function () {
        return '\n\n---\n\n';
      }
    });


    // Convert <img> to markdown image syntax with data-* fallback support.
    // Decorative UI icons (file-type glyphs on attachment/reference chips,
    // favicons, and similar chrome) carry no conversation content but dominate
    // the exported file once inlined as base64. A measured export contained 104
    // images -- every one a file-type glyph (alt: js/pdf/txt/json/log) -- for
    // 291,180 of 853,955 chars, i.e. 34% of the file was icon data.
    //
    // Detection uses several independent signals, so a change to any one of
    // them does not silently reopen the bloat:
    //   * the app's own reference-graphic class hook
    //   * the CDN path Office uses for file-type glyphs
    //   * declared dimensions at icon scale (<= 32px)
    //   * an alt that is just a bare file extension, or a known chrome label
    //
    // Real content images (screenshots, generated pictures, charts) match none
    // of these: they are larger, are not served from the item-types icon path,
    // and do not have bare-extension alt text.
    function isDecorativeIconImage(node) {
      try {
        var cls = String((node.getAttribute && node.getAttribute('class')) || '');
        if (/fai-Reference__graphicChild|__graphicChild|\bfavicon\b/i.test(cls)) return true;

        var src = String((node.getAttribute && node.getAttribute('src')) || '');
        if (/\/assets\/item-types\//i.test(src)) return true;

        // Dimension cap of 24px, not 32px. Every decorative glyph observed in a
        // real export declared width="20" height="20", so 24 still catches them
        // with headroom, while 32 would also discard genuine 32x32 content such
        // as avatars and small thumbnails. Erring low costs nothing here: an
        // icon missed by this signal is still caught by the class, src-path and
        // alt-text checks around it.
        var w = parseInt(String((node.getAttribute && node.getAttribute('width')) || ''), 10);
        var h = parseInt(String((node.getAttribute && node.getAttribute('height')) || ''), 10);
        if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 && w <= 24 && h <= 24) {
          return true;
        }

        var alt = String((node.getAttribute && node.getAttribute('alt')) || '').trim();
        // Bare file-extension alt text ("js", "pdf", "txt", "json", "log") is
        // how these chips label their glyph; real images have descriptive alts.
        if (/^[a-z0-9]{1,5}$/i.test(alt) && !/^\d+$/.test(alt)) return true;
        if (/^(favicon|favicon type|file|document|attachment)$/i.test(alt)) return true;
      } catch (e) {}
      return false;
    }

    service.addRule('markdownImages', {
      filter: 'img',
      replacement: function (_content, node) {
        // Drop decorative chrome before doing any work: these would otherwise
        // be inlined as multi-kilobyte base64 blobs apiece.
        if (APP_CONFIG.stripDecorativeIcons !== false && isDecorativeIconImage(node)) {
          return '';
        }

        var rawSrc =
          (node.getAttribute && node.getAttribute('src')) ||
          (node.getAttribute && node.getAttribute('data-src')) ||
          (node.getAttribute && node.getAttribute('data-original')) ||
          (node.getAttribute && node.getAttribute('data-url')) ||
          (node.getAttribute && node.getAttribute('data-image-url')) ||
          (node.getAttribute && node.getAttribute('data-thumbnail-url')) ||
          '';
        var src = escapeMarkdownImageUrl(rawSrc);
        if (!src) return '';
        var alt = escapeMarkdownImageText(
          (node.getAttribute && node.getAttribute('alt')) ||
          (node.getAttribute && node.getAttribute('aria-label')) ||
          (node.getAttribute && node.getAttribute('title')) ||
          'image'
        );
        var title = escapeMarkdownImageTitle(
          (node.getAttribute && node.getAttribute('title')) || ''
        );
        return title ? '![' + alt + '](' + src + ' "' + title + '")' : '![' + alt + '](' + src + ')';
      }
    });

    return service;
  }

  function splitMarkdownTableRow(line) {
    const trimmed = String(line || '').trim();
    const core = trimmed.replace(/^\|/, '').replace(/\|$/, '');
    return core.split('|').map(cell => cell.trim());
  }

  function isMarkdownTableSeparatorLine(line) {
    const cells = splitMarkdownTableRow(line);
    if (!cells.length) return false;
    return cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  function isLikelyMarkdownTableBlock(lines) {
    if (!Array.isArray(lines) || lines.length < 2) return false;
    const nonEmpty = lines.filter(Boolean);
    if (nonEmpty.length < 2) return false;
    if (!nonEmpty[0].includes('|')) return false;
    if (!isMarkdownTableSeparatorLine(nonEmpty[1])) return false;
    return nonEmpty.every(line => !line || line.includes('|'));
  }

  function formatMarkdownTableBlock(block) {
    const rawLines = String(block || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);

    if (!isLikelyMarkdownTableBlock(rawLines)) return block;

    const rows = rawLines.map(splitMarkdownTableRow);
    const columnCount = Math.max(...rows.map(r => r.length));

    for (const row of rows) {
      while (row.length < columnCount) row.push('');
    }

    const widths = new Array(columnCount).fill(3);
    for (let r = 0; r < rows.length; r += 1) {
      if (r === 1) continue; // separator row rebuilt below
      for (let c = 0; c < columnCount; c += 1) {
        widths[c] = Math.max(widths[c], rows[r][c].length, 3);
      }
    }

    const separatorSource = rows[1];
    const separator = separatorSource.map((cell, idx) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      const dashes = '-'.repeat(Math.max(widths[idx], 3));
      if (left && right) return `:${dashes}:`;
      if (left) return `:${dashes}`;
      if (right) return `${dashes}:`;
      return dashes;
    });

    const formatted = rows.map((row, rowIdx) => {
      const cells = (rowIdx === 1 ? separator : row).map((cell, idx) => {
        const value = rowIdx === 1 ? cell : cell.padEnd(widths[idx], ' ');
        return ` ${value} `;
      });
      return `|${cells.join('|')}|`;
    });

    return formatted.join('\n');
  }

  function normalizeMarkdownTables(md) {
    const blocks = String(md || '').split(/\n{2,}/);
    const normalized = blocks.map(block => {
      const lines = block.split('\n').map(line => line.trimRight());
      return isLikelyMarkdownTableBlock(lines.filter(Boolean))
      ? formatMarkdownTableBlock(lines.join('\n'))
      : block;
    });
    return normalized.join('\n\n');
  }

  function preprocessHtmlForMarkdown(html) {
    let out = String(html || '');
    if (!out.trim()) return '';

    out = stripExecutableBlocks(out)
    .replace(/<!--([\s\S]*?)-->/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00A0/g, ' ');

    // The app often renders diff/code lines as adjacent block nodes with no text newlines.
    // Inject line boundaries before Turndown sees the HTML.
    out = out
    .replace(/<\/(div|p|li|tr|h[1-6]|blockquote|pre|table|ul|ol)>\s*</gi, '</$1>\n<')
    .replace(/<(br)\s*\/?\s*>/gi, '<$1 />\n');

    return out.trim();
  }

  function postProcessMarkdown(md) {
    return normalizeMarkdownTables(
      String(md || '')
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/([^\n])\n(#{1,6}\s)/g, '$1\n\n$2')
      .replace(/([^\n])\n([-*]\s)/g, '$1\n\n$2')
      .trim()
    );
  }

  function htmlToMarkdown(html, options) {
    const baseHref = String((options && options.baseHref) || '');
    const normalizedHtml = normalizeMarkdownImageHtml(html, baseHref);
    const preparedHtml = preprocessHtmlForMarkdown(normalizedHtml);
    if (!preparedHtml) return '';

    try {
      var rawMd = turndownService.turndown(preparedHtml);
      console.log('[archival-image] Turndown output length: ' + rawMd.length + ' contains ![: ' + rawMd.includes('!['));
      return postProcessMarkdown(rawMd);
    } catch (err) {
      console.error('Turndown conversion failed; falling back to plain text extraction:', err);
      const safeHtml = stripExecutableBlocks(decodeEntities(preparedHtml));
      return postProcessMarkdown(stripTags(safeHtml));
    }
  }

  function stripTags(s) {
    // Remove any remaining HTML tags; entity decoding is handled earlier
    return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00A0/g, ' '); // non-breaking space  regular space
  }

  // --- Centralized sanitizers ---
  function decodeEntities(s) {
    // Remove any remaining HTML tags; entity decoding is handled earlier when needed.
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
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!hasSelection) {
        // Optional: inform user; keep silent if you prefer
        try { dialog.showErrorBox('Save Selection as Markdown', 'No selection found.'); } catch {}
        return;
      }
      let archivalHtml = html || text;
      try {
        const materialized = await materializeInlineImageAssets(win, archivalHtml, 'selection-markdown');
        archivalHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveSelectionAsMarkdown image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(archivalHtml, { baseHref: getDocumentBaseHref(win) });
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: 'Save Selection as Markdown',
        defaultPath: 'selection.md',
          filters: [{ name: 'Markdown', extensions: ['md'] }]
      });
      if (canceled || !filePath) return;
      await writeExportFileAtomically(filePath, md);
    } catch (err) {
      console.error('Save Selection as Markdown failed:', err);
      try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
    }
  }

  async function saveSelectionAsCleanMarkdown(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      let archivalHtml = html || text;
      try {
        const materialized = await materializeInlineImageAssets(win, archivalHtml, 'selection-clean-markdown');
        archivalHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveSelectionAsCleanMarkdown image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(archivalHtml, { baseHref: getDocumentBaseHref(win) });
      await writeExportFileAtomically(filePath, md);
    } catch (err) {
      console.error('Save Selection as Clean Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveSelectionAsRawMarkdown(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragmentRaw(win));
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      let safeHtml = stripExecutableBlocks(String(html || text || ''));
      try {
        const materialized = await materializeInlineImageAssets(win, safeHtml, 'selection-raw-markdown');
        safeHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveSelectionAsRawMarkdown image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(safeHtml, { baseHref: getDocumentBaseHref(win) });
      await writeExportFileAtomically(filePath, md);
    } catch (err) {
      console.error('Save Selection as Raw Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  function buildExportMetadataHeader(win, { scope, profileKey, format } = {}) {
    let title = (deps.appLabel || 'Chat') + ' Chat';
    let sourceUrl = '';

    try { title = win?.webContents?.getTitle?.() || title; } catch {}
    try { sourceUrl = win?.webContents?.getURL?.() || ''; } catch {}

    const metadata = [
      '---',
      `title: ${JSON.stringify(title)}`,
      `scope: ${JSON.stringify(scope || '')}`,
      `sourceUrl: ${JSON.stringify(sourceUrl)}`,
      `exportedAt: ${JSON.stringify(new Date().toISOString())}`,
      `profile: ${JSON.stringify(profileKey || '')}`,
      `format: ${JSON.stringify(format || '')}`,
      '---',
      ''
    ];

    return metadata.join('\n');
  }

  async function saveSelectionAsMarkdownWithMetadata(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      let archivalHtml = html || text;
      try {
        const materialized = await materializeInlineImageAssets(win, archivalHtml, 'selection-markdown-metadata');
        archivalHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveSelectionAsMarkdownWithMetadata image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(archivalHtml, { baseHref: getDocumentBaseHref(win) });
      const header = buildExportMetadataHeader(win, {
        scope: EXPORT_SCOPES.SELECTION,
        profileKey: 'markdownWithMetadata',
        format: 'markdown'
      });

      await writeExportFileAtomically(filePath, `${header}\n${md}\n`);
    } catch (err) {
      console.error('Save Selection as Markdown with metadata failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveSelectionAsHTML(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      const title = win.webContents.getTitle?.() || appLabel + ' Selection';
      const bodySource = html || `<pre>${escapeHtmlForExport(text)}</pre>`;
      const sanitized = await callRA(win, 'sanitizeExportHtml', bodySource, {
        baseUrl: getDocumentBaseHref(win),
        removeRemoteResources: false,
      });
      const body = sanitized?.ok ? sanitized.html : escapeHtmlForExport(text || '');
      const htmlDoc = `<!DOCTYPE html>
  <html lang="en">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
  <title>${escapeHtmlForExport(title)}</title>
  <style>
  body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.5; color: #222; }
  h1,h2,h3,h4,h5 { margin: 0.6em 0 0.3em; }
  p { margin: 0.4em 0; }
  ul,ol { margin: 0.4em 0 0.4em 1.2em; }
  pre, code { font-family: Consolas, Menlo, monospace; }
  pre { background: #f5f7fa; border: 1px solid #e3e7ee; padding: 10px; border-radius: 6px; overflow: auto; }
  blockquote { border-left: 3px solid #cbd5e1; margin: 0.4em 0; padding: 0.2em 0.8em; color: #555; }
  table { border-collapse: collapse; }
  td, th { border: 1px solid #e5e7eb; padding: 6px 8px; }
  </style>
  </head>
  <body>
  ${body}
  </body>
  </html>`;

      await writeExportFileAtomically(filePath, htmlDoc);
    } catch (err) {
      console.error('Save Selection as HTML failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveSelectionAsText(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      const safeHtml = stripExecutableBlocks(decodeEntities(html || text));
      const plain = stripTags(safeHtml)
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      await writeExportFileAtomically(filePath, plain);
    } catch (err) {
      console.error('Save Selection as Text failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  // ---------- Chat pane save helpers ----------
  // A) Hide everything except the chat pane, then savePage (HTMLOnly/MHTML)
  async function saveOnlyPaneWithSavePage(win, filePath, format /* 'HTMLOnly' | 'MHTML' */) {
    const snapshot = await getChatPaneSnapshot(win);
    const selectorGroup = snapshot?.selector ? `:is(${snapshot.selector})` : CHAT_SCOPE_PSEUDO;
    // Make everything except the chat invisible but still laid out.
    // Using opacity/pointer-events instead of display:none helps virtualized lists keep measurements,
    // reducing "white page" issues when saving.
    const css = `
    html, body {
      overflow: auto !important;
      background: #ffffff !important;
    }
    *:not(${selectorGroup}):not(${selectorGroup} *) {
      opacity: 0 !important;
      pointer-events: none !important;
    }
    ${selectorGroup} {
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

  function getDocumentBaseHref(win) {
    try {
      const currentUrl = win?.webContents?.getURL?.() || '';
      const u = new URL(currentUrl);
      return u.href;
    } catch {}
    return '';
  }

  function getExportWebPreferences() {
    const prefs = {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false
    };

    try {
      if (typeof deps.getAppPartition === 'function') {
        const partition = String(deps.getAppPartition() || '').trim();
        if (partition) prefs.partition = partition;
      }
    } catch {}

    return prefs;
  }

  function buildBaseTagForExport(win) {
    const baseHref = getDocumentBaseHref(win);
    return baseHref ? `<base href="${escapeHtmlForExport(baseHref)}">` : '';
  }

  // B) Extract chat pane HTML and write a standalone file
  async function savePaneAsStandaloneHTML(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'html', filePath);
  }

  // B2) Clean HTML export: strip noisy classes/styles and add minimal readable CSS
  async function savePaneAsCleanHTML(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'html', filePath);
  }

  // Unified chooser by extension
  async function saveChatPaneByExtension(win, filePath) {
    const lower = String(filePath).toLowerCase();
    if (lower.endsWith('.pdf')) {
      await runConversationExportJob(win, 'pdf', filePath);
    } else if (lower.endsWith('.html')) {
      await runConversationExportJob(win, 'html', filePath);
    } else if (lower.endsWith('.mhtml')) {
      // Use savePage with hide-CSS (A)
      await saveOnlyPaneWithSavePage(win, filePath, 'MHTML');
    } else if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      await runConversationExportJob(win, 'cleanMarkdown', filePath);
    } else if (lower.endsWith('.txt')) {
      await runConversationExportJob(win, 'plainText', filePath);
    } else {
      await runConversationExportJob(win, 'html', filePath);
    }
  }

  function getDefaultExportExtension() {
    const fmt = normalizeExportFormat(APP_CONFIG.defaultExportFormat, DEFAULT_APP_CONFIG.defaultExportFormat);
    return fmt === 'markdown' ? 'md' : fmt;
  }

  function getSaveDialogFilters() {
    const filters = [
      { name: 'Markdown', extensions: ['md', 'markdown'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'Web Page, HTML (clean)', extensions: ['html'] },
      { name: 'Web Archive (MHTML)', extensions: ['mhtml'] },
      { name: 'Plain Text', extensions: ['txt'] }
    ];
    const ext = getDefaultExportExtension();
    const idx = filters.findIndex(f => f.extensions.includes(ext));
    if (idx > 0) {
      const [preferred] = filters.splice(idx, 1);
      filters.unshift(preferred);
    }
    return filters;
  }


  const EXPORT_PROFILE_ORDER = Object.freeze([
    'cleanMarkdown',
    'rawMarkdown',
    'markdownWithMetadata',
    'markdownExternalImages',
    'html',
    'htmlArchive',
    'plainText',
    'pdf',
  ]);

  const EXPORT_PROFILES = Object.freeze({
    cleanMarkdown: {
      label: 'Clean Markdown',
      defaultExtension: 'md',
      extensions: ['md', 'markdown'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      paneWriter: saveChatPaneAsMarkdown,
      selectionWriter: saveSelectionAsCleanMarkdown,
    },

    rawMarkdown: {
      label: 'Raw Markdown',
      defaultExtension: 'md',
      extensions: ['md', 'markdown'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      paneWriter: saveChatPaneAsRawMarkdown,
      selectionWriter: saveSelectionAsRawMarkdown,
    },

    markdownWithMetadata: {
      label: 'Markdown with metadata header',
      defaultExtension: 'md',
      extensions: ['md', 'markdown'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      paneWriter: saveChatPaneAsMarkdownWithMetadata,
      selectionWriter: saveSelectionAsMarkdownWithMetadata,
    },

    markdownExternalImages: {
      label: 'Markdown (external images)',
      defaultExtension: 'md',
      extensions: ['md', 'markdown'],
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      paneWriter: saveChatPaneAsMarkdownExternalImages,
      selectionWriter: saveSelectionAsCleanMarkdownExternalImages,
    },

    html: {
      label: 'Linked HTML (remote resources)',
      defaultExtension: 'html',
      extensions: ['html'],
      filters: [{ name: 'Linked HTML', extensions: ['html'] }],
      paneWriter: savePaneAsCleanHTML,
      selectionWriter: saveSelectionAsHTML,
    },

    htmlArchive: {
      label: 'Self-contained HTML archive',
      defaultBaseSuffix: '-archive',
      defaultExtension: 'html',
      extensions: ['html'],
      filters: [{ name: 'Self-contained HTML', extensions: ['html'] }],
      paneWriter: savePaneAsCleanHTML,
      selectionWriter: null,
    },

    plainText: {
      label: 'Plain text',
      defaultExtension: 'txt',
      extensions: ['txt'],
      filters: [{ name: 'Plain Text', extensions: ['txt'] }],
      paneWriter: saveChatPaneAsText,
      selectionWriter: saveSelectionAsText,
    },

    pdf: {
      label: 'PDF',
      defaultExtension: 'pdf',
      extensions: ['pdf'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      paneWriter: saveChatPaneAsPDF,
      selectionWriter: saveSelectionAsPDF,
    },
  });

  function getExportProfile(profileKey, fallbackKey = 'cleanMarkdown') {
    return EXPORT_PROFILES[profileKey] || EXPORT_PROFILES[fallbackKey] || EXPORT_PROFILES.cleanMarkdown;
  }

  function getWriterForExportScope(profile, scope) {
    if (!profile) return null;
    return scope === EXPORT_SCOPES.SELECTION ? profile.selectionWriter : profile.paneWriter;
  }

  function getExportScopeLabel(scope) {
    return scope === EXPORT_SCOPES.SELECTION ? 'Selection' : 'Chat Pane';
  }

  function getDefaultExportPathForProfile(scope, profile) {
    const base = scope === EXPORT_SCOPES.SELECTION ? (deps.appSlug || 'chat') + '-selection' : (deps.appSlug || 'chat') + '-chat';
    return `${base}${profile.defaultBaseSuffix || ''}.${profile.defaultExtension}`;
  }

  function ensureProfileFileExtension(filePath, profile) {
    const targetExt = String(profile?.defaultExtension || '').replace(/^\./, '').trim();
    if (!targetExt) return filePath;

    const allowed = new Set((profile?.extensions || [targetExt]).map(ext => String(ext).replace(/^\./, '').toLowerCase()));
    const parsed = path.parse(filePath);
    const currentExt = String(parsed.ext || '').replace(/^\./, '').toLowerCase();

    if (currentExt && allowed.has(currentExt)) return filePath;

    return path.join(parsed.dir, `${parsed.name}.${targetExt}`);
  }

  async function replaceFileFromTemporary(tempPath, filePath) {
    // tempPath is deliberately created in filePath's directory. rename() can
    // therefore perform the filesystem's atomic replace operation; moving the
    // old file aside first creates a visible no-destination window and a crash
    // recovery problem without improving Windows compatibility.
    await fs.promises.rename(tempPath, filePath);
  }

  async function writeExportFileAtomically(filePath, data, signal) {
    if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    const directory = path.dirname(filePath);
    const base = path.basename(filePath);
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const tempPath = path.join(directory, `.${base}.${stamp}.tmp`);
    try {
      await fs.promises.writeFile(tempPath, data, { flag: 'wx' });
      if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
      await replaceFileFromTemporary(tempPath, filePath);
    } finally {
      try { await fs.promises.unlink(tempPath); } catch {}
    }
  }

  async function copyExportFileAtomically(filePath, sourcePath, signal) {
    if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    const sourceStat = await fs.promises.stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error('Staged export is empty.');
    const directory = path.dirname(filePath);
    const base = path.basename(filePath);
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const tempPath = path.join(directory, `.${base}.${stamp}.tmp`);
    try {
      await fs.promises.copyFile(sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
      const tempStat = await fs.promises.stat(tempPath);
      if (tempStat.size !== sourceStat.size) throw new Error('Staged export copy was truncated.');
      if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
      await replaceFileFromTemporary(tempPath, filePath);
    } finally {
      try { await fs.promises.unlink(tempPath); } catch {}
    }
  }

  async function installStagedDirectory(stagedDirectory, finalDirectory, signal) {
    let stagedStat = null;
    try { stagedStat = await fs.promises.stat(stagedDirectory); } catch {}
    if (!stagedStat?.isDirectory()) {
      return { installed: false, commit: async () => {}, rollback: async () => {} };
    }
    if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    const parent = path.dirname(finalDirectory);
    const base = path.basename(finalDirectory);
    const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`;
    const temporary = path.join(parent, `.${base}.${stamp}.tmpdir`);
    const backup = path.join(parent, `.${base}.${stamp}.backup`);
    let hadExisting = false;
    await fs.promises.cp(stagedDirectory, temporary, { recursive: true, force: true });
    if (signal?.aborted) {
      await fs.promises.rm(temporary, { recursive: true, force: true });
      throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    }
    try {
      await fs.promises.rename(finalDirectory, backup);
      hadExisting = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        await fs.promises.rm(temporary, { recursive: true, force: true });
        throw error;
      }
    }
    try {
      await fs.promises.rename(temporary, finalDirectory);
    } catch (error) {
      const recoveryErrors = [error];
      if (hadExisting) {
        try { await fs.promises.rename(backup, finalDirectory); } catch (restoreError) {
          recoveryErrors.push(restoreError);
        }
      }
      try { await fs.promises.rm(temporary, { recursive: true, force: true }); } catch (cleanupError) {
        recoveryErrors.push(cleanupError);
      }
      if (recoveryErrors.length > 1) {
        throw new AggregateError(recoveryErrors, 'Could not install or restore the external image directory.');
      }
      throw error;
    }
    let state = 'installed';
    return {
      installed: true,
      commit: async () => {
        if (state !== 'installed') return { cleanupError: null };
        state = 'committed';
        if (!hadExisting) return { cleanupError: null };
        try {
          await fs.promises.rm(backup, { recursive: true, force: true });
          return { cleanupError: null };
        } catch (cleanupError) {
          // The new directory is already live and consistent with the export.
          // Report backup cleanup separately; rolling back now would make the
          // newly written document point at the old image set.
          return { cleanupError };
        }
      },
      rollback: async () => {
        if (state !== 'installed') return;
        state = 'rolled-back';
        const rollbackErrors = [];
        try {
          await fs.promises.rm(finalDirectory, { recursive: true, force: true });
        } catch (removeError) {
          rollbackErrors.push(removeError);
        }
        if (hadExisting) {
          try { await fs.promises.rename(backup, finalDirectory); } catch (restoreError) {
            rollbackErrors.push(restoreError);
          }
        }
        try {
          await fs.promises.rm(temporary, { recursive: true, force: true });
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError);
        }
        if (rollbackErrors.length) {
          throw new AggregateError(rollbackErrors, 'Could not roll back the external image directory.');
        }
      },
    };
  }

  function buildExportHtmlDocumentParts(snapshot, options = {}) {
    const marker = `__CANONICAL_EXPORT_CONTENT_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    const document = buildExportHtmlDocument(
      new ConversationSnapshot({ ...snapshot, cleanSemanticHtml: marker }),
      options
    );
    const markerIndex = document.indexOf(marker);
    if (markerIndex < 0) throw new Error('Could not create the staged HTML document shell.');
    return {
      prefix: document.slice(0, markerIndex),
      suffix: document.slice(markerIndex + marker.length),
    };
  }

  function snapshotMetadataHeader(snapshot, profileKey) {
    return [
      '---',
      `title: ${JSON.stringify(snapshot.title || '')}`,
      `sourceUrl: ${JSON.stringify(snapshot.url || '')}`,
      `capturedAt: ${JSON.stringify(snapshot.capturedAt || '')}`,
      `captureStatus: ${JSON.stringify(snapshot.captureStatus || 'complete')}`,
      `profile: ${JSON.stringify(profileKey || '')}`,
      '---',
      '',
    ].join('\n');
  }

  async function confirmIncompleteExport(win, completeness = {}) {
    const failures = (completeness.failures || []).slice(0, 8);
    const options = {
      type: 'warning',
      buttons: ['Save Anyway', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Export may be incomplete',
      message: `Captured ${Number(completeness.logicalTurnsAfter || 0)} conversation turn(s), but completeness could not be verified.`,
      detail: failures.map(item => `\u2022 ${item}`).join('\n') +
        '\n\nSave Anyway writes the captured turns and marks the export as incomplete.',
    };
    try {
      const result = win && !win.isDestroyed?.()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 0;
    } catch {
      return false;
    }
  }

  async function createConversationExportJob(win, profileKey, filePath) {
    const controller = new AbortController();
    const includeRaw = profileKey === 'rawMarkdown';
    const expansionOptions = {
      expandReasoning: APP_CONFIG.expandReasoningForSnapshot !== false,
      reasoningBudgetMs: Number(APP_CONFIG.reasoningExpandBudgetMs || 0),
    };
    const job = new ExportJob({
      controller,
      context: {
        win,
        profileKey,
        filePath,
        includeRaw,
        expansionOptions,
        snapshot: null,
        cacheHit: false,
        committed: false,
      },
      messages: {
        locate: 'Locating the conversation',
        hydrate: 'Hydrating conversation rows',
        expand: 'Expanding conversation content',
        capture: 'Capturing one reusable snapshot',
        validate: 'Validating capture completeness',
        transform: 'Transforming the requested format',
        render: 'Rendering the export',
        write: 'Writing the export file',
      },
      reportProgress: async progress => {
        try {
          const frameId = job?.context?.captureFrameId;
          if (frameId === undefined || frameId === null) await callRA(win, 'updateExportJobProgress', progress);
          else await callRAFrame(win, frameId, 'updateExportJobProgress', progress);
        } catch {}
      },
    });

    job.handlers.locate = async currentJob => {
      if (!win?.webContents || win.webContents.isDestroyed?.()) throw new Error('The source window is no longer available.');

      const markResults = await callRAFrames(win, 'locateChatRoot', { includeHtml: false, markForExport: true });
      const markedCandidates = markResults
        .filter(result => result?.value?.markerApplied)
        .sort((a, b) => {
          const confidence = Number(b.value?.confidence || 0) - Number(a.value?.confidence || 0);
          if (confidence) return confidence;
          return Number(b.value?.textLength || 0) - Number(a.value?.textLength || 0);
        });
      const selected = markedCandidates[0];
      if (!selected) throw new Error('Chat pane not found.');
      currentJob.context.captureFrameId = Number(selected.frameId || 0);
      currentJob.addCleanup(async () => {
        try { await callRAFrames(win, 'clearExportMarker'); } catch {}
      });

      const frameId = currentJob.context.captureFrameId;
      const started = await callRAFrame(win, frameId, 'beginExportJob', { jobId: currentJob.id });
      if (!started?.ok) throw new Error('Could not initialize the renderer export session.');
      currentJob.addCleanup(async () => {
        try { await callRAFrame(win, frameId, 'endExportJob', { jobId: currentJob.id }); } catch {}
      });

      const onAbort = () => {
        callRAFrame(win, frameId, 'cancelExportJob', { jobId: currentJob.id }).catch(() => {});
      };
      currentJob.signal.addEventListener('abort', onAbort, { once: true });
      currentJob.addCleanup(() => currentJob.signal.removeEventListener('abort', onAbort));

      let polling = false;
      const cancelPoll = setInterval(async () => {
        if (polling || currentJob.signal.aborted) return;
        polling = true;
        try {
          const state = await callRAFrame(win, frameId, 'isExportJobCancelled', { jobId: currentJob.id });
          if (state?.cancelled) currentJob.abort('Export cancelled');
        } catch {}
        polling = false;
      }, 250);
      if (typeof cancelPoll.unref === 'function') cancelPoll.unref();
      currentJob.addCleanup(() => clearInterval(cancelPoll));

      const rendererContext = await callRAFrame(win, frameId, 'getExportJobContext', {});
      if (!rendererContext?.ok) throw new Error('Could not read the conversation export context.');
      currentJob.context.rendererContext = rendererContext;
      return { marked: true, frameId, selector: selected.value?.selector || '' };
    };

    job.handlers.hydrate = async currentJob => {
      currentJob.throwIfCancelled();
      return {
        delegatedToCanonicalTraversal: true,
        detail: 'Rows are expanded and persisted at each bounded traversal position.',
      };
    };

    job.handlers.expand = async currentJob => {
      currentJob.throwIfCancelled();
      return {
        delegatedToCanonicalTraversal: true,
        reasoningBudgetReached: false,
      };
    };

    job.handlers.capture = async currentJob => {
      currentJob.throwIfCancelled();
      const frameId = currentJob.context.captureFrameId;
      const sessionId = `export-${currentJob.id}`;
      const store = await createCanonicalConversationStore({
        tempRoot: app.getPath('temp'),
        prefix: `${deps.appSlug || 'chat'}-export`,
      });
      currentJob.context.canonicalStore = store;
      currentJob.addCleanup(async () => {
        try { await store.dispose(); } catch {}
      });
      const callTimeoutMs = Math.max(1000, Number(APP_CONFIG.exportCaptureCallTimeoutMs || 30000));
      const callCaptureRenderer = async (method, payload) => {
        let timer = null;
        try {
          return await Promise.race([
            callRAFrame(win, frameId, method, payload),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                const error = new Error(`Renderer export call timed out after ${callTimeoutMs}ms: ${method}`);
                error.code = 'EXPORT_RENDERER_TIMEOUT';
                reject(error);
              }, callTimeoutMs);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const begin = await callCaptureRenderer('beginCanonicalConversationCapture', { sessionId });
      if (!begin?.ok) {
        throw new Error(`Could not start conversation capture: ${String(begin?.reason || begin?.error || 'the page did not respond')}`);
      }
      currentJob.addCleanup(async () => {
        try { await callCaptureRenderer('endCanonicalConversationCapture', { sessionId, restoreScrollTop: true }); } catch {}
      });

      const captured = await captureConversation({
        store,
        signal: currentJob.signal,
        config: APP_CONFIG,
        callBatch: payload => callCaptureRenderer('captureCanonicalConversationBatch', {
          sessionId,
          streamRecords: true,
          ...payload,
        }),
        readRecordChunk: payload => callCaptureRenderer('readCanonicalConversationRecordChunk', { sessionId, ...payload }),
        releaseRecords: payload => callCaptureRenderer('releaseCanonicalConversationRecords', { sessionId, ...payload }),
        onProgress: info => currentJob.updateProgress(
          info.pass === 'stream'
            ? `Streaming conversation turn ${info.turnInBatch} of ${info.batchTurns}`
            : `${info.pass === 'verify' ? 'Verifying' : 'Capturing'} conversation: ${info.turns} turns, ${info.percent}%`,
          info
        ),
        log: (message, data) => { try { console.log('[export-capture] ' + message + ':', data); } catch {} },
      });
      try { await callCaptureRenderer('endCanonicalConversationCapture', { sessionId, restoreScrollTop: true }); } catch {}

      const manifest = store.buildManifest();
      const completeness = validateCanonicalCapture(manifest);
      currentJob.context.canonicalManifest = manifest;
      try {
        console.log('[export-capture] result:', {
          turns: manifest.turnCount,
          expected: manifest.expectedTotal,
          passes: manifest.passes.length,
          continuityBreaks: manifest.continuityBreaks,
          ordinalsComplete: manifest.ordinalsComplete,
          failures: completeness.failures,
          warnings: completeness.warnings,
          elapsedMs: captured.elapsedMs,
          steps: captured.steps,
        });
      } catch {}

      const rendererContext = currentJob.context.rendererContext || {};
      currentJob.context.snapshot = new ConversationSnapshot({
        cleanSemanticHtml: '',
        rawHtml: includeRaw ? '' : null,
        plainText: '',
        messageFingerprints: completeness.messageFingerprints || [],
        orderFingerprints: completeness.messageFingerprints || [],
        title: rendererContext.title || appLabel + ' Chat',
        url: rendererContext.url || '',
        capturedAt: rendererContext.capturedAt || new Date().toISOString(),
        theme: rendererContext.theme || {},
        sourceMetadata: {
          ...(rendererContext.sourceMetadata || {}),
          webContentsId: Number(win.webContents.id || 0),
          captureArchitecture: 'continuity-verified-v2',
          captureFrameId: frameId,
        },
        completeness,
        captureStatus: completeness.lowConfidence ? 'incomplete' : 'complete',
        warnings: [...completeness.failures, ...completeness.warnings],
      });
      return {
        logicalTurns: completeness.logicalTurnsAfter,
        passes: completeness.capturePasses,
        elapsedMs: captured.elapsedMs,
        warnings: completeness.warnings,
      };
    };

    job.handlers.validate = async currentJob => {
      const snapshot = currentJob.context.snapshot;
      const manifest = currentJob.context.canonicalManifest;
      if (!snapshot || !manifest) throw new Error('No conversation capture is available to validate.');
      const completeness = snapshot.completeness || {};
      if (!manifest.turnCount) {
        const error = new Error('No conversation content was captured.');
        error.code = 'EXPORT_EMPTY';
        throw error;
      }
      if (completeness.lowConfidence) {
        // Never discard a long capture silently. Show exactly what could not
        // be proven and let the user keep the export, labelled as incomplete.
        const keep = await confirmIncompleteExport(win, completeness);
        if (!keep) throw new ExportCancelledError('Export cancelled: capture could not be verified as complete.');
        currentJob.addWarning('Export saved although completeness could not be verified.');
        return { accepted: true, status: 'incomplete', logicalTurns: manifest.turnCount };
      }
      return {
        accepted: true,
        status: 'complete',
        logicalTurns: manifest.turnCount,
        verificationSeenTurns: completeness.verificationSeenTurns,
      };
    };

    job.handlers.transform = async currentJob => {
      const snapshot = currentJob.context.snapshot;
      const store = currentJob.context.canonicalStore;
      const manifest = currentJob.context.canonicalManifest;
      if (!snapshot || !store || !manifest) throw new Error('Canonical snapshot state is unavailable.');
      currentJob.throwIfCancelled();

      const isMarkdown = ['cleanMarkdown', 'rawMarkdown', 'markdownWithMetadata', 'markdownExternalImages'].includes(profileKey);
      const isHtml = ['html', 'htmlArchive', 'pdf'].includes(profileKey);
      const isPdf = profileKey === 'pdf';
      const linkedHtml = profileKey === 'html';
      const stageExtension = isHtml ? 'html' : (isMarkdown ? 'md' : 'txt');
      const stagePath = isPdf ? '' : await store.createStageFile(`transformed.${stageExtension}`);
      let serializedTurns = 0;
      let externalImageIndex = 0;
      let externalImagesDirectory = '';
      const inlineAssetCache = new Map();
      const pdfShards = [];
      const pdfShardMaxTurns = Math.max(1, Number(APP_CONFIG.pdfShardMaxTurns || 24));
      const pdfShardMaxHtmlBytes = Math.max(262144, Number(APP_CONFIG.pdfShardMaxHtmlBytes || 6291456));
      let activePdfShard = null;
      if (profileKey === 'markdownExternalImages') {
        const parsed = path.parse(filePath);
        const finalImagesDirectory = path.join(parsed.dir, parsed.name + '_images');
        externalImagesDirectory = path.join(store.directory, 'external-images');
        currentJob.context.externalImages = {
          stagedDirectory: externalImagesDirectory,
          finalDirectory: finalImagesDirectory,
        };
      }

      const sanitizeFragment = async entry => {
        currentJob.throwIfCancelled();
        const raw = await store.readRaw(entry);
        const rawSanitized = await callRAFrame(win, currentJob.context.captureFrameId, 'sanitizeExportHtml', raw, {
          baseUrl: snapshot.url,
          removeRemoteResources: false,
        });
        if (!rawSanitized?.ok) {
          throw new Error(`Sanitization failed for conversation turn ${entry.sequence}: ${String(rawSanitized?.error || 'the page did not respond')}`);
        }
        if (Number(entry.textLength || 0) > 0 && String(rawSanitized.plainText || '').length < Math.max(1, Math.floor(Number(entry.textLength || 0) * 0.35))) {
          currentJob.addWarning(`Turn ${entry.sequence}: part of the text was inside non-exportable elements.`);
        }

        let selected = rawSanitized;
        if (profileKey !== 'rawMarkdown' && APP_CONFIG.cleanMarkdownStripsJunk !== false) {
          const cleaned = await callRAFrame(
            win,
            currentJob.context.captureFrameId,
            'cleanExportHtml',
            raw,
            DOM_PRESERVE_CONTENT_SELECTORS || []
          );
          if (cleaned?.ok) {
            const cleanSanitized = await callRAFrame(win, currentJob.context.captureFrameId, 'sanitizeExportHtml', String(cleaned.html || ''), {
              baseUrl: snapshot.url,
              removeRemoteResources: false,
            });
            const cleanLength = String(cleanSanitized?.plainText || '').length;
            const rawLength = String(rawSanitized.plainText || '').length;
            if (cleanSanitized?.ok && (!rawLength || cleanLength >= Math.floor(rawLength * 0.5))) selected = cleanSanitized;
          }
        }
        return selected;
      };

      let htmlParts = null;
      let pdfShardSuffix = '';
      if (isHtml) {
        htmlParts = buildExportHtmlDocumentParts(snapshot, {
          linked: linkedHtml,
          paperMode: APP_CONFIG.exportPaperMode,
        });
        if (isPdf) {
          pdfShardSuffix = buildExportHtmlDocumentParts(snapshot, {
            linked: false,
            paperMode: APP_CONFIG.exportPaperMode,
            omitFooter: true,
          }).suffix;
        } else {
          await fs.promises.appendFile(stagePath, htmlParts.prefix, 'utf8');
        }
      } else if (profileKey === 'markdownWithMetadata') {
        await fs.promises.appendFile(stagePath, snapshotMetadataHeader(snapshot, profileKey), 'utf8');
      }

      const appendPdfTurn = async (wrapped, fingerprint) => {
        const wrappedBytes = Buffer.byteLength(wrapped, 'utf8');
        const mustRotate = activePdfShard && activePdfShard.turns > 0 && (
          activePdfShard.turns >= pdfShardMaxTurns ||
          activePdfShard.htmlBytes + wrappedBytes > pdfShardMaxHtmlBytes
        );
        if (mustRotate) {
          await fs.promises.appendFile(activePdfShard.path, pdfShardSuffix, 'utf8');
          pdfShards.push(activePdfShard);
          activePdfShard = null;
        }
        if (!activePdfShard) {
          const shardDirectory = path.join(store.directory, 'pdf-shards');
          await fs.promises.mkdir(shardDirectory, { recursive: true });
          const shardNumber = pdfShards.length + 1;
          const shardPath = path.join(shardDirectory, `shard-${String(shardNumber).padStart(6, '0')}.html`);
          await fs.promises.writeFile(shardPath, htmlParts.prefix, 'utf8');
          activePdfShard = {
            path: shardPath,
            turns: 0,
            htmlBytes: Buffer.byteLength(htmlParts.prefix, 'utf8'),
            expectedFingerprints: [],
          };
        }
        await fs.promises.appendFile(activePdfShard.path, wrapped, 'utf8');
        activePdfShard.turns += 1;
        activePdfShard.htmlBytes += wrappedBytes;
        activePdfShard.expectedFingerprints.push(String(fingerprint || ''));
      };

      for (let index = 0; index < manifest.entries.length; index += 1) {
        currentJob.throwIfCancelled();
        const entry = manifest.entries[index];
        const sanitized = await sanitizeFragment(entry);
        let fragmentHtml = String(sanitized.html || '');

        if (!linkedHtml && (isMarkdown || profileKey === 'htmlArchive' || profileKey === 'pdf')) {
          if (profileKey === 'markdownExternalImages') {
            const materialized = await materializeExternalImageAssets(win, fragmentHtml, filePath, {
              signal: currentJob.signal,
              startIndex: externalImageIndex,
              imagesDirectory: externalImagesDirectory,
            });
            fragmentHtml = materialized.html;
            externalImageIndex = Number(materialized.nextIndex || externalImageIndex);
            if (materialized.failures?.length) {
              currentJob.addWarning(`Turn ${entry.sequence}: ${materialized.failures.length} image(s) could not be saved; unavailable sources were omitted.`);
              fragmentHtml = dropUnresolvedRemoteImageSources(fragmentHtml);
            }
          } else {
            const materialized = await materializeInlineImageAssets(win, fragmentHtml, `canonical-turn-${entry.sequence}`, {
              signal: currentJob.signal,
              assetCache: inlineAssetCache,
            });
            fragmentHtml = materialized.html;
            if (materialized.failures?.length) {
              currentJob.addWarning(`Turn ${entry.sequence}: ${materialized.failures.length} image(s) could not be embedded; unavailable sources were omitted.`);
              fragmentHtml = dropUnresolvedRemoteImageSources(fragmentHtml);
            }
          }
        }

        if (isHtml) {
          const wrapped = `<section data-export-logical-turn="1" data-export-order="${index}" data-export-fingerprint="${escapeHtmlForExport(entry.fingerprint || '')}">${fragmentHtml}</section>\n`;
          if (isPdf) await appendPdfTurn(wrapped, entry.fingerprint);
          else await fs.promises.appendFile(stagePath, wrapped, 'utf8');
        } else if (isMarkdown) {
          const markdown = htmlToMarkdown(fragmentHtml, { baseHref: snapshot.url });
          if (!markdown.trim() && Number(entry.textLength || 0) > 0) {
            currentJob.addWarning(`Turn ${entry.sequence}: Markdown conversion produced no text.`);
          }
          await fs.promises.appendFile(stagePath, `${index ? '\n\n' : ''}${markdown}`, 'utf8');
        } else if (profileKey === 'plainText') {
          const plain = String(sanitized.plainText || '').trim();
          if (!plain && Number(entry.textLength || 0) > 0) {
            currentJob.addWarning(`Turn ${entry.sequence}: no plain text was produced.`);
          }
          await fs.promises.appendFile(stagePath, `${index ? '\n\n' : ''}${plain}`, 'utf8');
        } else {
          throw new Error(`Unsupported export profile: ${profileKey}`);
        }
        serializedTurns += 1;

        if (index % 25 === 0) {
          await currentJob.updateProgress('Serializing canonical conversation turns', {
            completedTurns: index + 1,
            totalTurns: manifest.entries.length,
          });
        }
      }

      if (serializedTurns !== manifest.turnCount) {
        throw new Error(`Staged serialization wrote ${serializedTurns} of ${manifest.turnCount} canonical turns.`);
      }

      if (isHtml) {
        if (isPdf) {
          if (activePdfShard) {
            await fs.promises.appendFile(activePdfShard.path, htmlParts.suffix, 'utf8');
            pdfShards.push(activePdfShard);
            activePdfShard = null;
          }
          if (!pdfShards.length) throw new Error('PDF transformation produced no render shards.');
        } else {
          await fs.promises.appendFile(stagePath, htmlParts.suffix, 'utf8');
        }
      } else if (isMarkdown && APP_CONFIG.exportIncludeCaptureMetadata !== false) {
        await fs.promises.appendFile(stagePath, `\n\n<!-- ${buildCaptureStatusText(snapshot)} -->\n`, 'utf8');
      } else if (profileKey === 'plainText' && APP_CONFIG.exportIncludeCaptureMetadata !== false) {
        await fs.promises.appendFile(stagePath, `\n\n---\n${buildCaptureStatusText(snapshot)}\n`, 'utf8');
      }

      const stagedBytes = isPdf
        ? pdfShards.reduce((sum, shard) => sum + Number(shard.htmlBytes || 0), 0)
        : Number((await fs.promises.stat(stagePath)).size || 0);
      if (stagedBytes <= 0) throw new Error('Staged export is empty.');
      currentJob.context.transformed = isPdf
        ? { kind: 'pdf-html-shards', shards: pdfShards, bytes: stagedBytes }
        : { kind: 'staged-file', path: stagePath, bytes: stagedBytes };
      return {
        kind: currentJob.context.transformed.kind,
        bytes: stagedBytes,
        logicalTurns: manifest.turnCount,
        shards: pdfShards.length,
      };
    };

    job.handlers.render = async currentJob => {
      const transformed = currentJob.context.transformed;
      if (!transformed || (!transformed.path && !Array.isArray(transformed.shards))) {
        throw new Error('Nothing was transformed for export.');
      }
      currentJob.throwIfCancelled();
      if (transformed.kind === 'pdf-html-shards') {
        const rendered = await renderHtmlShardsToPDF(
          transformed.shards,
          currentJob.context.canonicalStore,
          {
            signal: currentJob.signal,
            job: currentJob,
            logPrefix: 'export-job-pdf',
          }
        );
        currentJob.context.renderedPath = rendered.path;
        currentJob.context.pdfValidation = {
          pageCount: rendered.pageCount,
          shardCount: rendered.shardCount,
        };
        return {
          bytes: rendered.bytes,
          pageCount: rendered.pageCount,
          shardCount: rendered.shardCount,
        };
      }
      if (transformed.kind === 'pdf-html-file') {
        currentJob.context.rendered = await renderHtmlFileToPDF(transformed.path, {
          signal: currentJob.signal,
          logPrefix: 'export-job-pdf',
          expectedFingerprints: currentJob.context.canonicalManifest.entries.map(entry => entry.fingerprint),
        });
        currentJob.context.pdfValidation = await validateRenderedPdfBuffer(currentJob.context.rendered);
        return {
          bytes: Number(currentJob.context.rendered?.length || 0),
          pageCount: Number(currentJob.context.pdfValidation?.pageCount || 0),
        };
      }
      currentJob.context.renderedPath = transformed.path;
      return { bytes: transformed.bytes, pageCount: 0 };
    };

    job.handlers.write = async currentJob => {
      // The final path is touched only after capture, fixed-point verification,
      // per-turn transformation, and format-level validation all succeed.
      let imageTransaction = null;
      try {
        const images = currentJob.context.externalImages;
        if (images) {
          imageTransaction = await installStagedDirectory(
            images.stagedDirectory,
            images.finalDirectory,
            currentJob.signal
          );
        }
        if (currentJob.context.rendered) {
          await writeExportFileAtomically(filePath, currentJob.context.rendered, currentJob.signal);
        } else if (currentJob.context.renderedPath) {
          await copyExportFileAtomically(filePath, currentJob.context.renderedPath, currentJob.signal);
        } else {
          throw new Error('Rendered export is empty.');
        }
        if (imageTransaction) {
          const committedImages = await imageTransaction.commit();
          if (committedImages?.cleanupError) {
            currentJob.addWarning(`The previous external image backup could not be removed: ${String(committedImages.cleanupError?.message || committedImages.cleanupError)}`);
          }
        }
      } catch (error) {
        if (imageTransaction) {
          try {
            await imageTransaction.rollback();
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'The export failed and its external image directory could not be fully restored.'
            );
          }
        }
        throw error;
      }
      currentJob.context.committed = true;
      const finalStat = await fs.promises.stat(filePath);
      return {
        filePath,
        bytes: finalStat.size,
        captureStatus: currentJob.context.snapshot.captureStatus,
        logicalTurns: currentJob.context.canonicalManifest.turnCount,
        warnings: [...currentJob.warnings],
      };
    };

    return job;
  }

  // One conversation export per window at a time: two traversals would fight
  // over the same scroll position and corrupt each other's continuity.
  const activeExportJobs = new WeakMap();

  async function runConversationExportJob(win, profileKey, filePath) {
    if (win && activeExportJobs.has(win)) {
      throw new Error('An export is already running for this window. Press Escape in the chat window to cancel it.');
    }
    const job = await createConversationExportJob(win, profileKey, filePath);
    if (win) activeExportJobs.set(win, job);
    try {
      return await job.run();
    } finally {
      if (win) activeExportJobs.delete(win);
    }
  }

  async function reportExportOutcome(win, result, finalPath) {
    const status = result?.results?.write?.captureStatus || 'complete';
    const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
    if (status === 'complete' && !warnings.length) return;
    const turns = Number(result?.results?.write?.logicalTurns || 0);
    const options = {
      type: status === 'complete' ? 'info' : 'warning',
      buttons: ['OK'],
      noLink: true,
      title: 'Export saved with warnings',
      message: `Saved ${turns} conversation turn(s) to ${path.basename(finalPath || '')}.`,
      detail: warnings.slice(0, 10).map(item => `\u2022 ${item}`).join('\n') +
        (warnings.length > 10 ? `\n\u2026 and ${warnings.length - 10} more` : ''),
    };
    try {
      if (win && !win.isDestroyed?.()) await dialog.showMessageBox(win, options);
      else await dialog.showMessageBox(options);
    } catch {}
  }

  async function saveChatPaneByProfile(win, profileKey, filePath) {
    const profile = getExportProfile(profileKey, APP_CONFIG.defaultPaneExportProfile);
    const writer = getWriterForExportScope(profile, EXPORT_SCOPES.PANE);
    if (typeof writer !== 'function') {
      safeShowError('Export unavailable', `${profile.label} is not available for chat pane export.`);
      return filePath;
    }

    const finalPath = ensureProfileFileExtension(filePath, profile);
    const result = await runConversationExportJob(win, profileKey, finalPath);
    await reportExportOutcome(win, result, finalPath);
    return finalPath;
  }

  async function saveSelectionByProfile(win, profileKey, filePath) {
    const profile = getExportProfile(profileKey, APP_CONFIG.defaultSelectionExportProfile);
    const writer = getWriterForExportScope(profile, EXPORT_SCOPES.SELECTION);
    if (typeof writer !== 'function') {
      safeShowError('Export unavailable', `${profile.label} is not available for selection export.`);
      return filePath;
    }

    const finalPath = ensureProfileFileExtension(filePath, profile);
    await writer(win, finalPath);
    return finalPath;
  }

  async function promptExportWithProfile(win, scope, profileKey) {
    if (!win) return;

    const fallbackKey = scope === EXPORT_SCOPES.SELECTION
      ? APP_CONFIG.defaultSelectionExportProfile
      : APP_CONFIG.defaultPaneExportProfile;
    const profile = getExportProfile(profileKey, fallbackKey);
    const writer = getWriterForExportScope(profile, scope);

    if (typeof writer !== 'function') {
      safeShowError('Export unavailable', `${profile.label} is not available for ${getExportScopeLabel(scope).toLowerCase()} export.`);
      return;
    }

    try {
      const { filePath, canceled } = await dialog.showSaveDialog(win, {
        title: `Export ${getExportScopeLabel(scope)} - ${profile.label}`,
        defaultPath: getDefaultExportPathForProfile(scope, profile),
        filters: profile.filters,
      });

      if (canceled || !filePath) return;

      const finalPath = scope === EXPORT_SCOPES.SELECTION
        ? await saveSelectionByProfile(win, profileKey, filePath)
        : await saveChatPaneByProfile(win, profileKey, filePath);

      win.__lastSavePath = finalPath;
    } catch (err) {
      if (err instanceof ExportCancelledError || err?.code === 'EXPORT_CANCELLED') {
        console.log(`${profile.label} ${scope} export cancelled:`, String(err?.message || ''));
        return;
      }
      console.error(`${profile.label} ${scope} export failed:`, err);
      safeShowError('Export failed', String(err?.message ?? err));
    }
  }

  function buildExportProfileMenuTemplate(win, scope) {
    return EXPORT_PROFILE_ORDER
      .map(profileKey => ({ profileKey, profile: EXPORT_PROFILES[profileKey] }))
      .filter(({ profile }) => typeof getWriterForExportScope(profile, scope) === 'function')
      .map(({ profileKey, profile }) => ({
        label: `${profile.label}...`,
        click: async () => {
          // Resolve win at click time — win may be a getter function
          // (from app-menu) or a direct BrowserWindow (from context-menu).
          const resolvedWin = typeof win === 'function' ? win() : win;
          await promptExportWithProfile(resolvedWin, scope, profileKey);
        }
      }));
  }

  // --- Shared helper: prompt to Save Chat Pane (HTML or MHTML) ---
  async function promptSaveChatPane(win) {
    if (!win) return;
    try {
      await promptExportWithProfile(win, EXPORT_SCOPES.PANE, APP_CONFIG.defaultPaneExportProfile);
    } catch (err) {
      console.error('Save Chat Pane failed:', err);
      try { dialog.showErrorBox('Save failed', String(err?.message || err)); } catch {}
    }
  }

  // --- New helper: save whole chat pane as Markdown ---
  async function saveChatPaneAsMarkdown(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'cleanMarkdown', filePath);
  }

  async function saveChatPaneAsRawMarkdown(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'rawMarkdown', filePath);
  }

  async function saveChatPaneAsMarkdownWithMetadata(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'markdownWithMetadata', filePath);
  }

  async function saveChatPaneAsMarkdownExternalImages(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'markdownExternalImages', filePath);
  }

  async function saveSelectionAsCleanMarkdownExternalImages(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }
      let archivalHtml = html || text;
      try {
        const materialized = await materializeExternalImageAssets(win, archivalHtml, filePath);
        archivalHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image-ext] saveSelectionAsCleanMarkdownExternalImages failed:', imgErr);
      }
      const md = htmlToMarkdown(archivalHtml, { baseHref: getDocumentBaseHref(win) });
      await writeExportFileAtomically(filePath, md);
    } catch (err) {
      console.error('Save Selection as Markdown (external images) failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function getBestChatRootCleaned(win) {
    const results = await callRAFrames(
      win,
      'locateChatRoot',
      {
        includeHtml: true,
        cleanupJunk: true,
      }
    );
    const best = results
      .map(r => r.value)
      .filter(v => (
        v?.ok &&
        (
          String(v?.html || '').trim() ||
          Number(v?.textLength || 0) > 0
        )
      ))
      .sort((a, b) => {
        const confidenceDelta = Number(b.confidence ?? 0) - Number(a.confidence ?? 0);
        return confidenceDelta || (Number(b.score ?? 0) - Number(a.score ?? 0));
      })[0];

    if (!best) return { ok: false, html: '', textLength: 0, selector: null };
    return { ok: true, ...best };
  }

  async function saveChatPaneAsText(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'plainText', filePath);
  }

  function escapeHtmlForExport(value) {
    return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
  }

  // ===========================================================================
  // Markdown image helpers
  // ===========================================================================

  function escapeMarkdownImageText(value) {
    return String(value ?? '')
      .replace(/\r\n?/g, '\n')
      .replace(/\n+/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]')
      .trim();
  }

  function escapeMarkdownImageUrl(value) {
    return String(value ?? '')
      .replace(/\r\n?/g, '')
      .replace(/\n/g, '')
      .replace(/\)/g, '\\)')
      .trim();
  }

  function escapeMarkdownImageTitle(value) {
    return String(value ?? '')
      .replace(/\r\n?/g, ' ')
      .replace(/\n+/g, ' ')
      .replace(/"/g, '\\"')
      .trim();
  }

  function normalizeImageUrlForMarkdown(src, baseHref) {
    const raw = String(src ?? '').trim();
    if (!raw) return '';
    if (/^(data|blob|file|https?|mailto|tel):/i.test(raw)) return raw;
    try {
      if (baseHref) return new URL(raw, baseHref).href;
    } catch {}
    return raw;
  }

  function normalizeMarkdownImageHtml(html, baseHref) {
    return String(html || '').replace(/<img\b([^>]*)>/gi, function(match, attrs) {
      var attr = String(attrs || '');
      var hasSrc = /\ssrc\s*=/i.test(attr);
      if (hasSrc) return match;

      var srcsetMatch = attr.match(/\s(?:srcset|data-srcset)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      var srcset = srcsetMatch ? String(srcsetMatch[2] || srcsetMatch[3] || srcsetMatch[4] || '').trim() : '';
      var firstSrcsetUrl = srcset ? String(srcset.split(',')[0] || '').trim().split(/\s+/)[0] : '';

      var dataSrcMatch = attr.match(/\s(?:data-src|data-original|data-url|data-image-url|data-thumbnail-url)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      var dataSrc = dataSrcMatch ? String(dataSrcMatch[2] || dataSrcMatch[3] || dataSrcMatch[4] || '').trim() : '';

      var resolved = normalizeImageUrlForMarkdown(firstSrcsetUrl || dataSrc, baseHref || '');
      if (!resolved) return match;
      return '<img src="' + escapeHtmlForExport(resolved) + '"' + attr + '>';
    });
  }

  // Fetch one image with shared cancellation, timeout, MIME, and size checks.
  // Inline and external-image exports use the same safety limits and statuses.
  async function fetchExportImage(ses, url, signal) {
    if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    const controller = new AbortController();
    const forwardAbort = () => { try { controller.abort(signal?.reason); } catch {} };
    if (signal) signal.addEventListener('abort', forwardAbort, { once: true });
    const timeoutMs = Math.max(1000, Number(APP_CONFIG.exportAssetFetchTimeoutMs || 20000));
    const maxBytes = Math.max(1024, Number(APP_CONFIG.exportAssetMaxBytes || 26214400));
    const timer = setTimeout(() => { try { controller.abort('asset-fetch-timeout'); } catch {} }, timeoutMs);
    try {
      let referer = '';
      try { referer = new URL(String(APP_CONFIG.appUrl || '')).origin + '/'; } catch {}
      const response = await ses.fetch(url, {
        ...(referer ? { headers: { Referer: referer } } : {}),
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false, status: `http-${response.status}` };
      const contentType = response.headers.get('content-type') || 'image/png';
      if (!contentType.startsWith('image/')) return { ok: false, status: 'not-image' };
      const declaredBytes = Number(response.headers.get('content-length') || 0);
      if (declaredBytes > maxBytes) return { ok: false, status: 'image-too-large', bytes: declaredBytes };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > maxBytes) return { ok: false, status: 'image-too-large', bytes: bytes.length };
      return { ok: true, response, contentType, bytes };
    } catch (error) {
      if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
      return {
        ok: false,
        status: controller.signal.aborted ? 'asset-fetch-timeout' : String(error?.message || error),
      };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', forwardAbort);
    }
  }

  async function materializeInlineImageAssets(win, html, label = 'archival-image', options = {}) {
    const signal = options.signal;
    const assetCache = options.assetCache instanceof Map ? options.assetCache : null;
    if (!html || !win?.webContents) return { html, inlined: 0, failures: [], imageMap: {} };
    if (!/<img\b/i.test(html)) {
      console.log('[' + label + '] No <img> tags found in HTML (' + html.length + ' chars)');
      return { html, inlined: 0, failures: [], imageMap: {} };
    }

    try {
      // Diagnostic: show the first <img> tag in the HTML
      var firstImgMatch = html.match(/<img\b[^>]*>/i);
      console.log('[' + label + '] First <img> tag: ' + (firstImgMatch ? firstImgMatch[0].substring(0, 500) : '(none)'));

      // Step 1: Parse all unique img src URLs — support both quote styles.
      var srcPattern = /<img\b[^>]*\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
      var uniqueSrcs = new Map();
      var m;
      var skippedIcons = 0;
      while ((m = srcPattern.exec(html)) !== null) {
        var rawSrc = String(m[1] || m[2] || '').trim();
        if (!rawSrc || rawSrc.startsWith('data:') || uniqueSrcs.has(rawSrc)) continue;
        // Skip decorative file-type glyphs here as well as in the Turndown
        // rule. Filtering only at Turndown time would still pay to fetch and
        // base64-encode every icon before discarding it; skipping at the source
        // avoids that work entirely.
        if (APP_CONFIG.stripDecorativeIcons !== false &&
            /\/assets\/item-types\//i.test(rawSrc)) {
          skippedIcons++;
          continue;
        }
        uniqueSrcs.set(rawSrc, null);
      }
      if (skippedIcons) {
        console.log('[' + label + '] skipped ' + skippedIcons + ' decorative icon URL(s)');
      }

      console.log('[archival-image] Found ' + uniqueSrcs.size + ' unique non-data img src URL(s) in ' + html.length + ' chars of HTML');
      for (var [debugUrl] of uniqueSrcs) {
        console.log('[archival-image]   src: ' + debugUrl.substring(0, 150));
      }

      if (!uniqueSrcs.size) return { html, inlined: 0, failures: [], imageMap: {} };

      // Decode HTML entities that outerHTML serialization introduces into URLs.
      function decodeHtmlEntitiesInUrl(s) {
        return String(s || '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'");
      }

      // Step 2: Fetch each image from the main process using session.fetch().
      var electronSession = require('electron').session;
      var partition = (typeof deps.getAppPartition === 'function')
        ? String(deps.getAppPartition() || '').trim()
        : '';
      var ses = partition
        ? electronSession.fromPartition(partition)
        : electronSession.defaultSession;

      console.log('[archival-image] Using session partition: ' + JSON.stringify(partition));

      var failures = [];
      var fetchCount = 0;
      for (var [encodedSrc] of uniqueSrcs) {
        if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
        var decodedSrc = decodeHtmlEntitiesInUrl(encodedSrc);

        var cached = assetCache && assetCache.get(decodedSrc);
        if (cached) {
          if (cached.dataUri) uniqueSrcs.set(encodedSrc, cached.dataUri);
          else failures.push({ src: decodedSrc, status: cached.status || 'cached-fetch-failure' });
          continue;
        }

        if (/^(blob:|file:|javascript:|#)/i.test(decodedSrc)) {
          console.log('[archival-image] Skipping unfetchable: ' + decodedSrc.substring(0, 80));
          failures.push({ src: decodedSrc, status: 'unfetchable-scheme' });
          if (assetCache) assetCache.set(decodedSrc, { status: 'unfetchable-scheme' });
          continue;
        }

        console.log('[archival-image] Fetching: ' + decodedSrc.substring(0, 150));
        var fetched = await fetchExportImage(ses, decodedSrc, signal);
        if (!fetched.ok) {
          failures.push({ src: decodedSrc, status: fetched.status, bytes: fetched.bytes });
          if (assetCache) assetCache.set(decodedSrc, { status: fetched.status });
          continue;
        }
        try {
          var resp = fetched.response;
          console.log('[archival-image] Response: ' + resp.status + ' content-type=' + (resp.headers.get('content-type') || '(none)'));
          var contentType = fetched.contentType;
          var buf = fetched.bytes;
          console.log('[archival-image] Fetched ' + buf.length + ' bytes (' + contentType + ')');
          var dataUri = 'data:' + contentType + ';base64,' + buf.toString('base64');
          uniqueSrcs.set(encodedSrc, dataUri);
          if (assetCache) {
            var cacheBudget = Math.max(0, Number(APP_CONFIG.exportAssetCacheMaxBytes || 16777216));
            var cacheBytes = Math.max(0, Number(assetCache.__exportBytes || 0));
            var dataBytes = Buffer.byteLength(dataUri, 'utf8');
            if (cacheBytes + dataBytes <= cacheBudget) {
              assetCache.set(decodedSrc, { dataUri: dataUri });
              assetCache.__exportBytes = cacheBytes + dataBytes;
            }
          }
          fetchCount++;
        } catch (fetchErr) {
          if (signal?.aborted || fetchErr instanceof ExportCancelledError) throw fetchErr;
          console.error('[archival-image] Fetch failed:', fetchErr);
          var failureStatus = String(fetchErr?.message || fetchErr);
          failures.push({ src: decodedSrc, status: failureStatus });
          if (assetCache) assetCache.set(decodedSrc, { status: failureStatus });
        }
      }

      console.log('[archival-image] Fetched ' + fetchCount + '/' + uniqueSrcs.size + ' images, ' + failures.length + ' failure(s)');

      // Step 3: Replace each original src with its data URI — both quote styles.
      var result = html;
      var inlined = 0;
      for (var [originalSrc, dataUri] of uniqueSrcs) {
        if (!dataUri) continue;
        var before = result;
        if (originalSrc.startsWith('data:')) {
          // Data URIs can be hundreds of KB — far too large for RegExp.
          // Use string-based replacement instead.
          result = result.split(originalSrc).join(dataUri);
        } else {
          var escaped = originalSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          var reDouble = new RegExp('(src\\s*=\\s*")' + escaped + '(")', 'g');
          var reSingle = new RegExp("(src\\s*=\\s*')" + escaped + "(')", 'g');
          result = result.replace(reDouble, '$1' + dataUri + '$2');
          result = result.replace(reSingle, '$1' + dataUri + '$2');
        }
        if (result !== before) inlined++;
      }

      console.log('[archival-image] Inlined ' + inlined + ' image(s) into HTML');
      if (failures.length) {
        console.error('[archival-image] Failures:', JSON.stringify(failures));
      }

      var imageMap = {};
      for (var [sourceUrl, materializedData] of uniqueSrcs) {
        if (materializedData) imageMap[sourceUrl] = materializedData;
      }
      return { html: result, inlined: inlined, failures: failures, imageMap: imageMap };
    } catch (err) {
      if (signal?.aborted || err instanceof ExportCancelledError) throw err;
      console.error('[archival-image] materializeInlineImageAssets failed:', err);
      return { html, inlined: 0, failures: [{ error: String(err?.message ?? err) }], imageMap: {} };
    }
  }

async function materializeExternalImageAssets(win, html, mdFilePath, options = {}) {
    const signal = options.signal;
    if (!html || !win?.webContents) return { html, saved: 0, failures: [] };
    if (!/<img\b/i.test(html)) return { html, saved: 0, failures: [] };

    try {
      var srcPattern = /<img\b[^>]*\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
      var uniqueSrcs = new Map();
      var m;
      while ((m = srcPattern.exec(html)) !== null) {
        var rawSrc = String(m[1] || m[2] || '').trim();
        if (rawSrc && !rawSrc.startsWith('data:') && !uniqueSrcs.has(rawSrc)) {
          uniqueSrcs.set(rawSrc, null);
        }
      }

      // Also capture data: URIs for external saving
      srcPattern.lastIndex = 0;
      var dataPattern = /<img\b[^>]*\ssrc\s*=\s*(?:"(data:[^"]+)"|'(data:[^']+)')/gi;
      var dataIdx = 0;
      while ((m = dataPattern.exec(html)) !== null) {
        var dataSrc = String(m[1] || m[2] || '').trim();
        if (dataSrc && dataSrc.startsWith('data:') && !uniqueSrcs.has(dataSrc)) {
          uniqueSrcs.set(dataSrc, null);
          dataIdx++;
        }
      }

      console.log('[archival-image-ext] Found ' + uniqueSrcs.size + ' image(s) to externalize');
      if (!uniqueSrcs.size) return { html, saved: 0, failures: [] };

      function decodeHtmlEntitiesInUrl(s) {
        return String(s || '')
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      }

      // Create the images directory
      var parsed = path.parse(mdFilePath);
      var imagesDir = String(options.imagesDirectory || path.join(parsed.dir, parsed.name + '_images'));
      await fs.promises.mkdir(imagesDir, { recursive: true });

      var electronSession = require('electron').session;
      var partition = (typeof deps.getAppPartition === 'function')
        ? String(deps.getAppPartition() || '').trim() : '';
      var ses = partition ? electronSession.fromPartition(partition) : electronSession.defaultSession;

      var failures = [];
      var savedCount = 0;
      var imgIndex = Math.max(0, Number(options.startIndex || 0));

      for (var [originalSrc] of uniqueSrcs) {
        if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
        imgIndex++;
        var pad = String(imgIndex).padStart(3, '0');
        var ext = 'png';
        var imageBytes = null;

        try {
          if (originalSrc.startsWith('data:')) {
            // Decode inline data URI
            var dataMatch = originalSrc.match(/^data:(image\/[^;]+);base64,(.+)$/);
            if (dataMatch) {
              var mime = dataMatch[1];
              ext = mime.split('/')[1] || 'png';
              if (ext === 'jpeg') ext = 'jpg';
              if (ext === 'svg+xml') ext = 'svg';
              imageBytes = Buffer.from(dataMatch[2], 'base64');
            }
          } else {
            // Fetch remote URL
            var decodedSrc = decodeHtmlEntitiesInUrl(originalSrc);
            if (/^(blob:|file:|javascript:|#)/i.test(decodedSrc)) {
              failures.push({ src: decodedSrc, status: 'unfetchable-scheme' });
              continue;
            }
            var fetched = await fetchExportImage(ses, decodedSrc, signal);
            if (!fetched.ok) {
              failures.push({ src: decodedSrc, status: fetched.status, bytes: fetched.bytes });
              continue;
            }
            var contentType = fetched.contentType;
            ext = (contentType.split('/')[1] || 'png').split(';')[0];
            if (ext === 'jpeg') ext = 'jpg';
            if (ext === 'svg+xml') ext = 'svg';
            imageBytes = fetched.bytes;
          }

          if (!imageBytes || !imageBytes.length) {
            failures.push({ src: originalSrc.substring(0, 80), status: 'empty' });
            continue;
          }

          var fileName = 'image_' + pad + '.' + ext;
          var filePath = path.join(imagesDir, fileName);
          await fs.promises.writeFile(filePath, imageBytes);

          var relativePath = parsed.name + '_images/' + fileName;
          uniqueSrcs.set(originalSrc, relativePath);
          savedCount++;
          console.log('[archival-image-ext] Saved ' + fileName + ' (' + imageBytes.length + ' bytes)');
        } catch (err) {
          if (signal?.aborted || err instanceof ExportCancelledError) throw err;
          console.error('[archival-image-ext] Failed to save image ' + imgIndex + ':', err);
          failures.push({ src: originalSrc.substring(0, 80), status: String(err?.message || err) });
        }
      }

      // Replace src in HTML.
      // Do not build a RegExp from large data: URI values. V8 can throw
      // "Regular expression too large" when the image src is multi-megabyte
      // base64. For large or inline src values, replace the quoted attribute
      // value with plain string operations instead.
      var result = html;
      function replaceQuotedSrcValue(input, originalValue, replacementValue) {
        var output = input;
        output = output.split('src="' + originalValue + '"').join('src="' + replacementValue + '"');
        output = output.split("src='" + originalValue + "'").join("src='" + replacementValue + "'");
        return output;
      }
      for (var [origSrc, relPath] of uniqueSrcs) {
        if (!relPath) continue;
        if (origSrc.startsWith('data:') || origSrc.length > 8192) {
          result = replaceQuotedSrcValue(result, origSrc, relPath);
          continue;
        }
        var escaped = origSrc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var reDouble = new RegExp('(src\\s*=\\s*")' + escaped + '(")', 'g');
        var reSingle = new RegExp("(src\\s*=\\s*')" + escaped + "(')", 'g');
        result = result.replace(reDouble, '$1' + relPath + '$2');
        result = result.replace(reSingle, '$1' + relPath + '$2');
      }

      console.log('[archival-image-ext] Saved ' + savedCount + ' images to ' + imagesDir);
      return { html: result, saved: savedCount, failures: failures, nextIndex: imgIndex };
    } catch (err) {
      if (signal?.aborted || err instanceof ExportCancelledError) throw err;
      console.error('[archival-image-ext] materializeExternalImageAssets failed:', err);
      return { html, saved: 0, failures: [{ error: String(err?.message ?? err) }] };
    }
  }

  function dropUnresolvedRemoteImageSources(html) {
    return String(html || '').replace(
      /\s(?:src|srcset)\s*=\s*(["'])https?:\/\/.*?\1/gi,
      ''
    );
  }

  function resolveExportPaperPalette(theme = {}, mode = APP_CONFIG.exportPaperMode) {
    return resolveExportPaperPaletteCore(theme, mode);
  }

  function buildCaptureStatusText(snapshot) {
    const completeness = snapshot?.completeness || {};
    const status = snapshot?.captureStatus || (completeness.lowConfidence ? 'needs-review' : 'complete');
    const turns = Number(completeness.logicalTurnsAfter ?? completeness.logicalTurnCount ?? 0);
    const capturedAt = String(snapshot?.capturedAt || '');
    const warnings = Array.isArray(snapshot?.warnings) ? snapshot.warnings.length : 0;
    return `Capture status: ${status}; logical turns: ${turns}; warnings: ${warnings}; captured: ${capturedAt}`;
  }

  function buildExportHtmlDocument(snapshot, options = {}) {
    const linked = options.linked === true;
    const palette = resolveExportPaperPalette(snapshot?.theme, options.paperMode);
    const csp = linked
      ? "default-src 'none'; img-src data: https: http:; media-src data: https: http:; font-src data: https:; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"
      : "default-src 'none'; img-src data:; media-src data:; font-src data:; style-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'";
    const footer = APP_CONFIG.exportIncludeCaptureMetadata === false || options.omitFooter === true
      ? ''
      : `<footer class="capture-status">${escapeHtmlForExport(buildCaptureStatusText(snapshot))}</footer>`;
    return `<!DOCTYPE html>
<html lang="en" style="color-scheme:${escapeHtmlForExport(palette.colorScheme)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escapeHtmlForExport(csp)}">
<title>${escapeHtmlForExport(snapshot?.title || appLabel + ' Chat')}</title>
<style>
@page { margin: 0.5in; }
:root { --fg:${palette.foreground}; --bg:${palette.background}; --muted:${palette.muted}; --border:${palette.border}; --code:${palette.code}; --link:${palette.link}; }
html,body { margin:0; padding:0; background:var(--bg); color:var(--fg); font-family:Arial,sans-serif; font-size:12pt; line-height:1.45; }
body { padding:20px; }
*,*::before,*::after { box-sizing:border-box; }
.${EXPORT_ROOT_CLASS} { width:100%; max-width:100%; }
[data-collected-chat-export="1"] { display:block; width:100%; max-width:100%; }
[data-export-logical-turn="1"] {
  display:block !important;
  position:static !important;
  transform:none !important;
  inset:auto !important;
  contain:none !important;
  content-visibility:visible !important;
  width:100% !important;
  max-width:100% !important;
  min-height:0 !important;
  height:auto !important;
  overflow:visible !important;
  margin:0 0 1.1rem !important;
  padding:0 !important;
  break-inside:auto;
  page-break-inside:auto;
}
[data-export-logical-turn="1"]:last-child { margin-bottom:0 !important; }
h1,h2,h3,h4,h5,h6 { break-after:avoid; page-break-after:avoid; margin:.85em 0 .35em; }
p { margin:.45em 0; }
a { color:var(--link); overflow-wrap:anywhere; word-break:break-word; }
pre,code,kbd,samp { font-family:Consolas,Menlo,Monaco,monospace; white-space:pre-wrap; overflow-wrap:anywhere; word-break:break-word; }
pre { background:var(--code); border:1px solid var(--border); border-radius:6px; padding:10px; max-width:100%; overflow:visible; }
blockquote { border-left:3px solid var(--border); margin:.5em 0; padding:.2em .8em; color:var(--muted); }
table { width:100%; max-width:100%; border-collapse:collapse; }
td,th { border:1px solid var(--border); padding:6px 8px; vertical-align:top; overflow-wrap:anywhere; }
img,svg { max-width:100%; height:auto; }
.capture-status { margin-top:2rem; padding-top:.5rem; border-top:1px solid var(--border); color:var(--muted); font-size:9pt; }
@media print { body { padding:0; } html,body { -webkit-print-color-adjust:exact; print-color-adjust:exact; } }
</style>
</head>
<body>
<main class="${EXPORT_ROOT_CLASS}">${snapshot?.cleanSemanticHtml || '<p>No chat content found.</p>'}</main>
${footer}
</body>
</html>`;
  }


  function buildPrintableChatPaneHtml({ title = appLabel + ' Chat', html = '' } = {}) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; object-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'">
    <title>${escapeHtmlForExport(title)}</title>
    <style>
    @page {
      margin: 0.5in;
    }

    html,
    body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      color: #111827;
      font-family: Arial, sans-serif;
      font-size: 12pt;
      line-height: 1.45;
    }

    *,
    *::before,
    *::after {
      box-sizing: border-box;
    }

    .${EXPORT_ROOT_CLASS} {
      width: 100%;
      max-width: 100%;
    }

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      break-after: avoid;
      page-break-after: avoid;
      margin: 0.85em 0 0.35em;
    }

    p {
      margin: 0.45em 0;
    }

    a {
      color: #0645ad;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    pre,
    code,
    kbd,
    samp {
      font-family: Consolas, Menlo, Monaco, monospace;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    pre {
      background: #f5f7fa;
      border: 1px solid #e3e7ee;
      border-radius: 6px;
      padding: 10px;
      max-width: 100%;
      overflow: visible;
      break-inside: auto;
      page-break-inside: auto;
    }

    blockquote {
      border-left: 3px solid #cbd5e1;
      margin: 0.5em 0;
      padding: 0.2em 0.8em;
      color: #374151;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    table {
      width: 100%;
      max-width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      break-inside: auto;
      page-break-inside: auto;
    }

    td,
    th {
      border: 1px solid #e5e7eb;
      padding: 6px 8px;
      vertical-align: top;
      overflow-wrap: anywhere;
      word-break: break-word;
    }

    img,
    svg,
    canvas,
    video {
      max-width: 100%;
      height: auto;
    }
    </style>
    </head>
    <body>
    <div class="${EXPORT_ROOT_CLASS}">${html || '<p>No chat content found.</p>'}</div>
    </body>
    </html>`;
  }

  async function waitForPrintableAssets(printWindow, { timeoutMs = 5000 } = {}) {
    if (!printWindow?.webContents) return null;
    try {
      const result = await callRA(
        { webContents: printWindow.webContents },
        'waitForPrintableAssets',
        { timeoutMs }
      );
      if (!result) return null;
      if (result.missing) {
        try {
          console.warn(
            '[export-print] waitForPrintableAssets MISSING on renderer agent:',
            result
          );
        } catch {}
        return null;
      }
      if (!result.ok) {
        try {
          console.warn('[export-print] waitForPrintableAssets failed:', result);
        } catch {}
      }
      return result;
    } catch (err) {
      try {
        console.warn('[export-print] waitForPrintableAssets threw:', err);
      } catch {}
      return null;
    }
  }

  async function logPrinterDiagnostics(printWindow, logPrefix) {
    const prefix = '[' + (logPrefix || 'print') + ']';
    if (!printWindow?.webContents) {
      console.warn(prefix + ' printer diagnostic skipped: no webContents');
      return;
    }

    let printWindowDestroyed = null;
    let webContentsDestroyed = null;
    let webContentsCrashed = null;
    let printUrl = '';

    try { printWindowDestroyed = !!printWindow.isDestroyed(); } catch {}
    try { webContentsDestroyed = !!printWindow.webContents.isDestroyed(); } catch {}
    try {
      webContentsCrashed =
        typeof printWindow.webContents.isCrashed === 'function'
          ? !!printWindow.webContents.isCrashed()
          : null;
    } catch {}
    try { printUrl = String(printWindow.webContents.getURL?.() || ''); } catch {}

    try {
      const printers = await printWindow.webContents.getPrintersAsync();
      const printerList = Array.isArray(printers) ? printers : [];
      const defaultPrinters = printerList.filter(printer => printer?.isDefault);

      console.log(
        prefix + ' printer diagnostic:\n' +
        JSON.stringify(
          {
            printUrl,
            printWindowDestroyed,
            webContentsDestroyed,
            webContentsCrashed,
            printerCount: printerList.length,
            defaultPrinterCount: defaultPrinters.length,
            defaultPrinters: defaultPrinters.map(printer => ({
              name: printer?.name || '',
              displayName: printer?.displayName || '',
              description: printer?.description || '',
              status: printer?.status ?? null,
            })),
            printers: printerList,
          },
          null,
          2
        )
      );
    } catch (printerError) {
      console.error(prefix + ' getPrintersAsync failed:', printerError);
    }
  }

  // ------------------------------------------------------------------
  // Chunked native PDF generation.
  //
  // A single printToPDF() call over a very large pane forces Chromium to
  // lay out, paginate and serialize the whole document in one pass. For long
  // conversations that peak allocation (renderer heap plus the one giant PDF
  // buffer held in the main process) is what triggered the historical
  // "Failed to generate PDF: Printing failed" / render-process-gone crashes.
  //
  // Instead we render the document in bounded page-range slices, each of
  // which yields a small PDF buffer, then stitch the slices back into a
  // single file with pdf-lib (pure JS, no native deps -> identical on Linux
  // and Windows). Peak memory is bounded by one slice rather than the whole
  // document.
  //
  // Chunking only engages once the estimated page count exceeds
  // pdfChunkPageThreshold; smaller exports keep the original single-pass
  // behaviour untouched, and any failure falls back to the single pass.
  // ------------------------------------------------------------------

  function resolvePdfChunkSettings() {
    const cfg = APP_CONFIG || {};
    const enabled = cfg.enablePdfChunking !== false; // default on
    const threshold = Number(cfg.pdfChunkPageThreshold);
    const size = Number(cfg.pdfChunkSize);
    const pageHeightPx = Number(cfg.pdfChunkPageHeightPx);
    return {
      enabled,
      threshold:
        Number.isFinite(threshold) && threshold > 0 ? Math.floor(threshold) : 40,
      chunkSize:
        Number.isFinite(size) && size > 0 ? Math.floor(size) : 25,
      pageHeightPx:
        Number.isFinite(pageHeightPx) && pageHeightPx > 0 ? pageHeightPx : 1056,
    };
  }


  // Estimate the prepared document's page count.
  //
  // CRITICAL: on the live chat window we must NOT issue our own
  // scrollHeight/offsetHeight read here. That read forces a synchronous
  // layout, and performing it AFTER the carefully-timed pre-print settle
  // re-triggers exactly the virtualizer unmount that settle prevents -- which
  // dropped every off-viewport assistant answer bubble and left only the short
  // user-input rows (plus their spacer height, hence the huge blank-page
  // export). So the caller passes the height it already measured during
  // hydration (hydratedHeight); we only fall back to measuring for the
  // static, virtualizer-free offscreen document, where a layout read is safe.
  async function estimatePreparedPageCount(win, pageHeightPx, knownHeightPx) {
    let h = Number(knownHeightPx) || 0;
    if (h <= 0) {
      try {
        const contentHeightPx = await win.webContents.executeJavaScript(
          '(function(){' +
            'var de=document.documentElement,b=document.body;' +
            'return Math.max(' +
              'de?de.scrollHeight:0,de?de.offsetHeight:0,' +
              'b?b.scrollHeight:0,b?b.offsetHeight:0' +
            ');' +
          '})()',
          true
        );
        h = Number(contentHeightPx) || 0;
      } catch (e) {
        console.warn('[export-pdf-native] page-count estimate failed:', e);
        return 0;
      }
    }
    if (h <= 0) return 0;
    return Math.max(1, Math.ceil((h * 1.15) / pageHeightPx));
  }

  // Stitch an ordered list of single-slice PDF buffers into one Buffer.
  // pdf-lib is required lazily so a missing dependency degrades to the
  // single-pass fallback in printToPDFChunked() instead of breaking export.
  async function mergePdfChunkBuffers(buffers) {
    let PDFDocument = null;
    try {
      ({ PDFDocument } = require('pdf-lib'));
    } catch (e) {
      throw new Error(
        'pdf-lib is required to stitch chunked PDFs: ' + String(e?.message || e)
      );
    }
    const merged = await PDFDocument.create();
    for (const buf of buffers) {
      const src = await PDFDocument.load(buf, { ignoreEncryption: true });
      const copied = await merged.copyPages(src, src.getPageIndices());
      for (const page of copied) merged.addPage(page);
    }
    const out = await merged.save({ useObjectStreams: true });
    return Buffer.from(out);
  }

  // Distinguish "you asked for pages that do not exist" from a genuine print
  // failure so the tail clamp only fires for the former.
  function isPageRangeError(err) {
    const msg = String(err?.message || err || '').toLowerCase();
    return (
      msg.includes('page range') ||
      msg.includes('page-range') ||
      msg.includes('pageranges') ||
      msg.includes('exceeds page') ||
      msg.includes('out of range') ||
      msg.includes('invalid page')
    );
  }

  // Render `win` to a single PDF Buffer, transparently slicing very large
  // documents into stitched page-range chunks. `printOptions` is the exact
  // option bag that would otherwise be passed to webContents.printToPDF().
  async function printToPDFChunked(win, printOptions, options = {}) {
    const {
      logPrefix = 'export-pdf-native',
      // Height already measured by the caller, if any. When provided the
      // layout-forcing measurement is skipped.
      knownHeightPx = 0,
    } = options;
    const settings = resolvePdfChunkSettings();

    // Fast path: chunking disabled -> original single-pass behaviour.
    if (!settings.enabled) {
      return win.webContents.printToPDF(printOptions);
    }

    const estimatedPages = await estimatePreparedPageCount(
      win,
      settings.pageHeightPx,
      knownHeightPx
    );
    try {
      console.log('[' + logPrefix + '] chunking estimate:', {
        estimatedPages,
        threshold: settings.threshold,
        chunkSize: settings.chunkSize,
        pageHeightPx: settings.pageHeightPx,
      });
    } catch {}

    // Small/empty documents keep the single-pass path: no behaviour change
    // and pdf-lib is never exercised for ordinary exports.
    if (!estimatedPages || estimatedPages <= settings.threshold) {
      return win.webContents.printToPDF(printOptions);
    }

    // The estimate only decides WHETHER to chunk. The loop itself runs until
    // Chromium reports that the requested range starts past the last page,
    // so an under-estimate can never truncate the tail of the document. The
    // absolute cap only guards against a renderer that never reports the end.
    const hardCap = Math.max(estimatedPages * 4, estimatedPages + settings.chunkSize * 4, 20000);

    const chunkBuffers = [];
    let from = 1;
    let producedAny = false;

    while (from <= hardCap) {
      let to = from + settings.chunkSize - 1;
      let buf = null;

      // Attempt the slice, shrinking `to` when Chromium reports the range
      // runs past the real end of the document. When `from` itself is past
      // the end the innermost attempt fails with to === from and we stop.
      while (to >= from) {
        try {
          buf = await win.webContents.printToPDF(
            Object.assign({}, printOptions, { pageRanges: from + '-' + to })
          );
          break;
        } catch (err) {
          if (isPageRangeError(err) && to > from) {
            // Overshoot into non-existent pages: clamp the tail and retry.
            to = to - 1;
            continue;
          }
          if (isPageRangeError(err) && to === from) {
            // `from` is beyond the last page -> the document is exhausted.
            buf = null;
            break;
          }
          // A genuine (non-range) printToPDF failure: surface it.
          throw err;
        }
      }

      if (!buf) break; // reached the tail
      chunkBuffers.push(buf);
      producedAny = true;
      try {
        console.log('[' + logPrefix + '] chunk complete:', {
          range: from + '-' + to,
          bytes: buf.length,
          chunks: chunkBuffers.length,
          mainProcessMemory: captureMainProcessMemoryDiagnostic(),
        });
      } catch {}

      from = to + 1;
    }

    if (!producedAny) {
      // Estimation said "large" but we produced nothing (e.g. transient
      // clamp confusion). Fall back to a single pass rather than fail.
      return win.webContents.printToPDF(printOptions);
    }

    if (chunkBuffers.length === 1) {
      return chunkBuffers[0];
    }

    try {
      const stitched = await mergePdfChunkBuffers(chunkBuffers);
      try {
        console.log('[' + logPrefix + '] stitched chunked PDF:', {
          chunks: chunkBuffers.length,
          bytes: stitched.length,
        });
      } catch {}
      return stitched;
    } catch (mergeErr) {
      console.error(
        '[' + logPrefix + '] pdf-lib stitch failed, falling back to single pass:',
        mergeErr
      );
      return win.webContents.printToPDF(printOptions);
    }
  }


  async function renderHtmlFileToPDF(htmlPath, options = {}) {
    let printWindow = null;
    let renderTimer = null;
    const signal = options.signal;
    const onAbort = () => {
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); } catch {}
      }
    };
    const throwIfCancelled = () => {
      if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    };
    try {
      signal?.addEventListener('abort', onAbort, { once: true });
      throwIfCancelled();
      const staged = await fs.promises.stat(htmlPath);
      if (!staged.isFile() || staged.size <= 0) throw new Error('Staged PDF HTML is empty.');
      printWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false,
        },
      });
      await printWindow.loadFile(htmlPath);
      throwIfCancelled();
      if (Array.isArray(options.expectedFingerprints)) {
        const observed = await printWindow.webContents.executeJavaScript(
          '(function(){return Array.from(document.querySelectorAll(\'[data-export-logical-turn="1"]\')).map(function(node){return String(node.getAttribute(\'data-export-fingerprint\')||\'\');});})()',
          true
        );
        const expected = options.expectedFingerprints.map(value => String(value || ''));
        if (!Array.isArray(observed) || observed.length !== expected.length ||
            observed.some((value, index) => String(value || '') !== expected[index])) {
          throw new Error(`Offscreen PDF document contains ${Array.isArray(observed) ? observed.length : 0} of ${expected.length} ordered canonical turns.`);
        }
      }
      await waitForPrintableAssets(printWindow);
      throwIfCancelled();
      const renderTimeoutMs = Math.max(5000, Number(APP_CONFIG.pdfShardRenderTimeoutMs || 120000));
      return await Promise.race([
        printToPDFChunked(
          printWindow,
          {
            printBackground: true,
            marginsType: 1,
            pageSize: 'Letter',
            landscape: false,
            preferCSSPageSize: true,
          },
          { logPrefix: options.logPrefix || 'export-job-pdf-file' }
        ),
        new Promise((_, reject) => {
          renderTimer = setTimeout(() => {
            try { if (printWindow && !printWindow.isDestroyed()) printWindow.destroy(); } catch {}
            const error = new Error(`PDF section rendering timed out after ${Math.round(renderTimeoutMs / 1000)}s.`);
            error.code = 'EXPORT_PDF_TIMEOUT';
            reject(error);
          }, renderTimeoutMs);
        }),
      ]);
    } finally {
      if (renderTimer) clearTimeout(renderTimer);
      signal?.removeEventListener('abort', onAbort);
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); } catch {}
      }
    }
  }

  async function mergePdfFilesToPath(pdfPaths, outputPath, signal) {
    const { PDFDocument } = require('pdf-lib');
    if (!Array.isArray(pdfPaths) || !pdfPaths.length) throw new Error('No PDF shards were produced.');
    if (pdfPaths.length === 1) {
      await fs.promises.copyFile(pdfPaths[0], outputPath);
      const only = await fs.promises.stat(outputPath);
      return { pageCount: null, bytes: only.size };
    }
    const merged = await PDFDocument.create();
    let pageCount = 0;
    for (const pdfPath of pdfPaths) {
      if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
      const bytes = await fs.promises.readFile(pdfPath);
      const source = await PDFDocument.load(bytes, { ignoreEncryption: true });
      const indices = source.getPageIndices();
      if (!indices.length) throw new Error(`Rendered PDF shard has no pages: ${path.basename(pdfPath)}`);
      const copied = await merged.copyPages(source, indices);
      for (const page of copied) merged.addPage(page);
      pageCount += copied.length;
    }
    if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
    const output = await merged.save({ useObjectStreams: true });
    await fs.promises.writeFile(outputPath, output);
    return { pageCount, bytes: output.length };
  }

  async function renderHtmlShardsToPDF(shards, store, options = {}) {
    const signal = options.signal;
    const job = options.job;
    const list = Array.isArray(shards) ? shards : [];
    if (!list.length) throw new Error('PDF export has no HTML shards to render.');
    const outputDirectory = path.join(store.directory, 'rendered-pdf-shards');
    await fs.promises.mkdir(outputDirectory, { recursive: true });
    const pdfPaths = [];
    let pageCount = 0;
    for (let index = 0; index < list.length; index += 1) {
      if (signal?.aborted) throw new ExportCancelledError(String(signal.reason || 'Export cancelled'));
      const shard = list[index];
      const buffer = await renderHtmlFileToPDF(shard.path, {
        signal,
        logPrefix: `${options.logPrefix || 'export-job-pdf'}-shard-${index + 1}`,
        expectedFingerprints: shard.expectedFingerprints || [],
      });
      const validation = await validateRenderedPdfBuffer(buffer);
      pageCount += Number(validation.pageCount || 0);
      const pdfPath = path.join(outputDirectory, `shard-${String(index + 1).padStart(6, '0')}.pdf`);
      await fs.promises.writeFile(pdfPath, buffer);
      pdfPaths.push(pdfPath);
      if (job) {
        await job.updateProgress(`Rendering PDF: section ${index + 1} of ${list.length}`, {
          completedShards: index + 1,
          totalShards: list.length,
          renderedPages: pageCount,
        });
      }
    }
    const mergedPath = await store.createStageFile('rendered.pdf');
    const merged = await mergePdfFilesToPath(pdfPaths, mergedPath, signal);
    const finalStat = await fs.promises.stat(mergedPath);
    if (!finalStat.isFile() || finalStat.size < 100) throw new Error('Merged PDF is empty or truncated.');
    return {
      path: mergedPath,
      bytes: finalStat.size,
      pageCount: Number(merged.pageCount || pageCount),
      shardCount: list.length,
    };
  }

  async function validateRenderedPdfBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 100) {
      throw new Error('PDF renderer returned an empty or truncated buffer.');
    }
    const { PDFDocument } = require('pdf-lib');
    const document = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const pageCount = document.getPageCount();
    if (!pageCount) throw new Error('PDF renderer returned a document with no pages.');
    return { pageCount };
  }

  async function writeHtmlDocumentToPDF(filePath, htmlDoc) {
    let printWindow = null;
    let tempHtmlPath = null;

    try {
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tempHtmlPath = path.join(app.getPath('temp'), `${deps.appSlug || "app"}-export-print-${stamp}.html`);
      await fs.promises.writeFile(tempHtmlPath, htmlDoc, 'utf8');

      printWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false
        }
      });

      await printWindow.loadFile(tempHtmlPath);
      await waitForPrintableAssets(printWindow);
      // Static offscreen document: no virtualizer, so measuring its height
      // is safe and no per-chunk settle is required.
      const pdf = await printToPDFChunked(
        printWindow,
        {
          printBackground: true,
          marginsType: 1,
          pageSize: 'Letter',
          landscape: false,
          preferCSSPageSize: true
        },
        { logPrefix: 'export-print-html' }
      );

      await writeExportFileAtomically(filePath, pdf);
    } finally {
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); } catch {}
      }
      if (tempHtmlPath) {
        try { await fs.promises.unlink(tempHtmlPath); } catch {}
      }
    }
  }

  async function printChatPane(win) {
    if (!win?.webContents) return;

    let printWindow = null;
    let tempHtmlPath = null;

    try {
      const snapshot = await getChatPaneSnapshot(win);

      if (!snapshot?.ok || !snapshot.html) {
        safeShowError('Print Chat Pane', 'Chat pane not found.');
        return;
      }

      const title = win.webContents.getTitle?.() || appLabel + ' Chat';
      const htmlDoc = buildPrintableChatPaneHtml({
        title,
        html: String(snapshot.html || ''),
      });

      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tempHtmlPath = path.join(app.getPath('temp'), `${appSlug}-print-${stamp}.html`);
      await fs.promises.writeFile(tempHtmlPath, htmlDoc, 'utf8');

      printWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false
        }
      });

      await printWindow.loadFile(tempHtmlPath);
      await waitForPrintableAssets(printWindow);
      await logPrinterDiagnostics(printWindow, 'print-chat-pane');
      await new Promise((resolve, reject) => {
        printWindow.webContents.print(
          {
            printBackground: true
          },
          (success, failureReason) => {
            if (!success && failureReason !== 'cancelled') {
              reject(new Error(failureReason || 'Unknown print error'));
              return;
            }

            resolve();
          }
        );
      });
    } catch (err) {
      console.error('Print Chat Pane failed:', err);
      safeShowError('Print failed', String(err?.message ?? err));
    } finally {
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); } catch {}
      }

      if (tempHtmlPath) {
        try { await fs.promises.unlink(tempHtmlPath); } catch {}
      }
    }
  }

  async function printSelection(win) {
    if (!win?.webContents) return;

    let printWindow = null;
    let tempHtmlPath = null;

    try {
      const selection = normalizeSelectionForExport(await getSelectionFragment(win));

      if (!selection?.hasSelection) {
        safeShowError('Print Selection', 'No selection found.');
        return;
      }

      let selectionHtml = String(selection.html || '');

      if (!selectionHtml.trim()) {
        selectionHtml = `<pre>${escapeHtmlForExport(selection.text || '')}</pre>`;
      }

      const sanitizedSelection = await callRA(win, 'sanitizeExportHtml', selectionHtml, {
        baseUrl: getDocumentBaseHref(win),
        removeRemoteResources: false,
      });
      selectionHtml = sanitizedSelection?.ok ? sanitizedSelection.html : escapeHtmlForExport(selection.text || '');

      try {
        const materialized = await materializeInlineImageAssets(win, selectionHtml, 'print-selection');
        selectionHtml = materialized.html;
      } catch (imgErr) {
        console.error('[print-selection] image capture failed:', imgErr);
      }

      const title = (win.webContents.getTitle?.() || appLabel + ' Chat') + ' Selection';
      const htmlDoc = buildPrintableChatPaneHtml({
        title,
        html: selectionHtml,
      });

      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      tempHtmlPath = path.join(app.getPath('temp'), `${appSlug}-print-selection-${stamp}.html`);
      await fs.promises.writeFile(tempHtmlPath, htmlDoc, 'utf8');

      printWindow = new BrowserWindow({
        show: false,
        width: 1200,
        height: 1600,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          backgroundThrottling: false
        }
      });

      await printWindow.loadFile(tempHtmlPath);
      await waitForPrintableAssets(printWindow);
      await logPrinterDiagnostics(printWindow, 'print-chat-pane');
      await new Promise((resolve, reject) => {
        printWindow.webContents.print(
          {
            printBackground: true
          },
          (success, failureReason) => {
            if (!success && failureReason !== 'cancelled') {
              reject(new Error(failureReason || 'Unknown print error'));
              return;
            }

            resolve();
          }
        );
      });
    } catch (err) {
      console.error('Print Selection failed:', err);
      safeShowError('Print failed', String(err?.message ?? err));
    } finally {
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); } catch {}
      }

      if (tempHtmlPath) {
        try { await fs.promises.unlink(tempHtmlPath); } catch {}
      }
    }
  }

  async function saveSelectionAsPDF(win, filePath) {
    if (!win) return;
    try {
      const selection = normalizeSelectionForExport(await getSelectionFragment(win));
      if (!selection?.hasSelection) {
        safeShowError('Export Selection as PDF', 'No selection found.');
        return;
      }

      let selectionHtml = String(selection.html || '');
      if (!selectionHtml.trim()) {
        selectionHtml = `<pre>${escapeHtmlForExport(selection.text || '')}</pre>`;
      }
      const sanitizedSelection = await callRA(win, 'sanitizeExportHtml', selectionHtml, {
        baseUrl: getDocumentBaseHref(win),
        removeRemoteResources: false,
      });
      selectionHtml = sanitizedSelection?.ok ? sanitizedSelection.html : escapeHtmlForExport(selection.text || '');

      try {
        const materialized = await materializeInlineImageAssets(win, selectionHtml, 'selection-pdf');
        selectionHtml = materialized.html;
      } catch (imgErr) {
        console.error('[export-selection-pdf] image capture failed:', imgErr);
      }

      const title = (win.webContents.getTitle?.() || appLabel + ' Chat') + ' Selection';
      const htmlDoc = buildPrintableChatPaneHtml({
        title,
        html: selectionHtml,
      });

      await writeHtmlDocumentToPDF(filePath, htmlDoc)
    } catch (err) {
      console.error('Save Selection as PDF failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveChatPaneAsPDF(win, filePath) {
    if (!win || !filePath) return null;
    return runConversationExportJob(win, 'pdf', filePath);
  }





  async function saveAsDialog(win) {
    const { filePath, canceled } = await dialog.showSaveDialog(win, {
      title: 'Save Page As',
      defaultPath: (appSlug || 'chat') + '.html',
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


  return {
    htmlToMarkdown,
    stripTags,
    decodeEntities,
    stripExecutableBlocks,
    findBestChatRoot,
    getChatPaneSnapshot,
    getSelectionFragment,
    getSelectionFragmentRaw,
    saveSelectionAsMarkdown,
    saveSelectionAsCleanMarkdown,
    saveSelectionAsRawMarkdown,
    saveSelectionAsMarkdownWithMetadata,
    saveSelectionAsHTML,
    saveSelectionAsText,
    saveSelectionAsPDF,
    saveOnlyPaneWithSavePage,
    savePaneAsStandaloneHTML,
    savePaneAsCleanHTML,
    saveChatPaneByExtension,
    getDefaultExportExtension,
    getSaveDialogFilters,
    getExportProfile,
    getWriterForExportScope,
    getExportScopeLabel,
    getDefaultExportPathForProfile,
    ensureProfileFileExtension,
    runConversationExportJob,
    saveChatPaneByProfile,
    saveSelectionByProfile,
    promptExportWithProfile,
    buildExportProfileMenuTemplate,
    promptSaveChatPane,
    saveChatPaneAsMarkdown,
    saveChatPaneAsRawMarkdown,
    saveChatPaneAsMarkdownWithMetadata,
    saveChatPaneAsMarkdownExternalImages,
    saveSelectionAsCleanMarkdownExternalImages,
    materializeExternalImageAssets,
    getBestChatRootCleaned,
    saveChatPaneAsText,
    escapeHtmlForExport,
    escapeMarkdownImageText,
    escapeMarkdownImageUrl,
    escapeMarkdownImageTitle,
    normalizeImageUrlForMarkdown,
    normalizeMarkdownImageHtml,
    materializeInlineImageAssets,
    resolveExportPaperPalette,
    buildExportHtmlDocument,
    buildPrintableChatPaneHtml,
    waitForPrintableAssets,
    writeHtmlDocumentToPDF,
    printChatPane,
    printSelection,
    saveChatPaneAsPDF,
    selectChatPane,
    expandChatPane,
    buildSelectionMarkdownForExport,
    saveAsDialog,
  };
}

module.exports = {
  EXPORT_SCOPES,
  createExporters,
};

