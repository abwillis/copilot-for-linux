'use strict';

const fs = require('fs');
const path = require('path');
const TurndownService = require('turndown');
const turndownPluginGfm = require('turndown-plugin-gfm');
const {
  callRendererMethod,
  callRendererMethodInAllFrames,
} = require('./renderer-api');

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

  function getPrintBubbleDiagnosticSelectors(cssText) {
    const selectors = [];
    const source = String(cssText || '');
    const markerSelector = /\[data-pdf-export-target(?:=(?:"1"|'1'|1))?\]\s+([^,{]+?)(?=\s*,|\s*\{)/g;
    let match = null;
    while ((match = markerSelector.exec(source)) !== null) {
      let selector = String(match[1] || '').trim();
      // The diagnostic needs the owning element targeted by each rule, not
      // the trailing descendant wildcard used to lift nested clamps.
      selector = selector.replace(/\s+\*\s*$/, '').trim();
      if (!selector || selectors.includes(selector)) continue;
      selectors.push(selector);
    }
    return selectors;
  }

  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });

  async function prepareChatPaneForSnapshot(win, logPrefix = 'export-snapshot') {
    const state = {
      markerApplied: false,
      clear: async () => {},
    };

    if (!win?.webContents) return state;

    try {
      const markResults = await callRAFrames(
        win,
        'locateChatRoot',
        { includeHtml: false, markForExport: true }
      );

      state.markerApplied = markResults.some(r => r?.value?.markerApplied);
      try {
        console.log('[' + logPrefix + '] markForExport:', markResults);
      } catch {}
    } catch (e) {
      console.warn('[' + logPrefix + '] markForExport failed:', e);
    }

    if (!state.markerApplied) return state;

    state.clear = async () => {
      try {
        const clearResults = await callRAFrames(win, 'clearExportMarker');
        try {
          console.log('[' + logPrefix + '] clearExportMarker:', clearResults);
        } catch {}
      } catch {}
    };

    try {
      const expand1 = await callRAFrames(win, 'expandForPrint');
      await new Promise(r => setTimeout(r, 80));
      const hydrate = await callRAFrames(
        win,
        'hydrateVirtualizer',
        { stepDelayMs: 60 }
      );
      await new Promise(r => setTimeout(r, 80));

      const expand2 = await callRAFrames(win, 'expandForPrint');

      try {
        console.log('[' + logPrefix + '] expand/hydrate:', {
          expand1,
          hydrate,
          expand2,
        });
      } catch {}
    } catch (e) {
      console.warn('[' + logPrefix + '] expand/hydrate failed:', e);
    }

    return state;
  }

  async function getPreparedChatPaneSnapshot(win, logPrefix = 'markdown-export') {
    const snapshotPrep = await prepareChatPaneForSnapshot(win, logPrefix);

    try {
      const collectedResults = await callRAFrames(
        win,
        'collectVirtualizedChatHtml',
        { stepDelayMs: 60 }
      );

      const bestCollected = collectedResults
        .map(r => ({ frameId: r.frameId, where: r.where, value: r.value }))
        .filter(r => r.value?.ok && String(r.value?.html || '').trim())
        .sort((a, b) => {
          const aCollected = Number(a.value?.collected || 0);
          const bCollected = Number(b.value?.collected || 0);
          if (bCollected !== aCollected) return bCollected - aCollected;
          return String(b.value?.html || '').length - String(a.value?.html || '').length;
        })[0];

      if (bestCollected?.value?.html) {
        try {
          console.log('[' + logPrefix + '] collected snapshot:', {
            where: bestCollected.where,
            collected: bestCollected.value.collected,
            steps: bestCollected.value.steps,
            finalHeight: bestCollected.value.finalHeight,
            scrollerRange: bestCollected.value.scrollerRange,
            scrollerTag: bestCollected.value.scrollerTag,
            scrollerLabel: bestCollected.value.scrollerLabel,
            firstCollectedY: bestCollected.value.firstCollectedY,
            lastCollectedY: bestCollected.value.lastCollectedY,
            bottomCoverageGap: bestCollected.value.bottomCoverageGap,
            firstCollectedPreview: bestCollected.value.firstCollectedPreview,
            lastCollectedPreview: bestCollected.value.lastCollectedPreview,
            scrollerCandidates: bestCollected.value.scrollerCandidates,
            htmlLength: String(bestCollected.value.html || '').length,
          });
          const bottomCoverageGap = Number(bestCollected.value.bottomCoverageGap || 0);
          const scrollerRange = Number(bestCollected.value.scrollerRange || 0);
          if (bottomCoverageGap > 3000) {
            console.warn('[' + logPrefix + '] collected snapshot may be incomplete:', {
              bottomCoverageGap,
              scrollerRange,
              collected: bestCollected.value.collected,
            });
          }
        } catch {}

        return {
          prep: snapshotPrep,
          snapshot: {
            ok: true,
            html: String(bestCollected.value.html || ''),
            textLength: 0,
            selector: '[data-collected-chat-export="1"]',
          },
        };
      }
    } catch (e) {
      console.warn('[' + logPrefix + '] collectVirtualizedChatHtml failed:', e);
    }

    return {
      prep: snapshotPrep,
      snapshot: await getChatPaneSnapshot(win),
    };
  }

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
      if (!value?.ok || !value?.selector) return false;
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
    service.addRule('markdownImages', {
      filter: 'img',
      replacement: function (_content, node) {
        var rawSrc =
          (node.getAttribute && node.getAttribute('src')) ||
          (node.getAttribute && node.getAttribute('data-src')) ||
          (node.getAttribute && node.getAttribute('data-original')) ||
          (node.getAttribute && node.getAttribute('data-url')) ||
          (node.getAttribute && node.getAttribute('data-image-url')) ||
          (node.getAttribute && node.getAttribute('data-thumbnail-url')) ||
          '';
        console.log('[archival-image] Turndown img rule: src length=' + rawSrc.length + ' first100=' + rawSrc.substring(0, 100));
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
      await fs.promises.writeFile(filePath, md, 'utf8');
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
      await fs.promises.writeFile(filePath, md, 'utf8');
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
      await fs.promises.writeFile(filePath, md, 'utf8');
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

      await fs.promises.writeFile(filePath, `${header}\n${md}\n`, 'utf8');
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
      const body = html || `<pre>${escapeHtmlForExport(text)}</pre>`;
      const htmlDoc = `<!DOCTYPE html>
  <html lang="en">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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

      await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
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

      await fs.promises.writeFile(filePath, plain, 'utf8');
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
    const url = win.webContents.getURL();
    let origin = '';
    try { origin = new URL(url).origin; } catch {}
    const snapshot = await getChatPaneSnapshot(win);
    const result = {
      ok: !!snapshot?.ok,
      html: String(snapshot?.html || ''),
      title: win.webContents.getTitle?.() || appLabel + ' Chat'
    };
    const htmlDoc = `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${(result && result.title) ? result.title : appLabel + ' Chat'}</title>
    <style>
    html, body { margin: 0; padding: 0; }
    ${EXPORT_ROOT_SELECTOR} { width: 100%; max-width: 100%; }
    </style>
    </head>
    <body>
    <div class="${EXPORT_ROOT_CLASS}">${(result && result.html) ? result.html : '<p>Chat pane not found.</p>'}</div>
    </body>
    </html>`;
    await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
  }

  // B2) Clean HTML export: strip noisy classes/styles and add minimal readable CSS
  async function savePaneAsCleanHTML(win, filePath) {
    const snapshot = await getChatPaneSnapshot(win);
    if (!snapshot?.ok) {
      try { dialog.showErrorBox('Save Chat Pane', 'Chat pane not found.'); } catch {}
      return;
    }
    const preserveSelectorsForCleanHtml = DOM_PRESERVE_CONTENT_SELECTORS || [
      '[data-preserve]',
      'pre', 'code', 'table', 'ul', 'ol',
      'img', 'picture', 'svg', 'canvas', 'video', 'iframe'
    ];

      const result = await callRA(
        win,
        'cleanExportHtml',
        String(snapshot.html || ''),
        preserveSelectorsForCleanHtml
      );

      if (!result?.ok) {
        try { console.warn('[clean-html-export] cleanExportHtml failed:', result); } catch {}
      }

    const baseHref = getDocumentBaseHref(win);
    const htmlDoc = `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${buildBaseTagForExport(win)}
    <title>${result?.title || appLabel + ' Chat'}</title>
    <style>
    body { font-family: Arial, sans-serif; margin: 20px; line-height: 1.5; color: #222; }
    h1,h2,h3,h4,h5 { margin: 0.6em 0 0.3em; }
    p { margin: 0.4em 0; }
    .message { margin-bottom: 12px; }
    .user { font-weight: 600; color: #333; }
    .app-chat { color: #004b9a; }
    /* Generic content spacing */
    ul,ol { margin: 0.4em 0 0.4em 1.2em; }
    pre, code { font-family: Consolas, Menlo, monospace; }
    pre { background: #f5f7fa; border: 1px solid #e3e7ee; padding: 10px; border-radius: 6px; overflow: auto; }
    blockquote { border-left: 3px solid #cbd5e1; margin: 0.4em 0; padding: 0.2em 0.8em; color: #555; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #e5e7eb; padding: 6px 8px; }
    /* Make export wrapper stretch full width */
    ${EXPORT_ROOT_SELECTOR} { width: 100%; max-width: 100%; }
    </style>
    <!-- NOTE: This cleaned export removes hashed classes/inline styles for readability. -->
    </head>
    <body>
    <div class="${EXPORT_ROOT_CLASS}">${result?.html || '<p>No chat content found.</p>'}</div>
    </body>
    </html>`;
    await fs.promises.writeFile(filePath, htmlDoc, 'utf8');
  }

  // Unified chooser by extension
  async function saveChatPaneByExtension(win, filePath) {
    const lower = String(filePath).toLowerCase();
    if (lower.endsWith('.pdf')) {
      // New: export chat/page view to PDF
      await saveChatPaneAsPDF(win, filePath);
    } else if (lower.endsWith('.html')) {
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
      label: 'HTML',
      defaultExtension: 'html',
      extensions: ['html'],
      filters: [{ name: 'HTML', extensions: ['html'] }],
      paneWriter: savePaneAsCleanHTML,
      selectionWriter: saveSelectionAsHTML,
    },

    htmlArchive: {
      label: 'HTML archive',
      defaultExtension: 'mhtml',
      extensions: ['mhtml'],
      filters: [{ name: 'Web Archive (MHTML)', extensions: ['mhtml'] }],
      paneWriter: async (win, filePath) => {
        await saveOnlyPaneWithSavePage(win, filePath, 'MHTML');
      },
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
    return `${base}.${profile.defaultExtension}`;
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

  async function saveChatPaneByProfile(win, profileKey, filePath) {
    const profile = getExportProfile(profileKey, APP_CONFIG.defaultPaneExportProfile);
    const writer = getWriterForExportScope(profile, EXPORT_SCOPES.PANE);
    if (typeof writer !== 'function') {
      safeShowError('Export unavailable', `${profile.label} is not available for chat pane export.`);
      return filePath;
    }

    const finalPath = ensureProfileFileExtension(filePath, profile);
    await writer(win, finalPath);
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
    if (!win) return;
    let snapshotPrep = null;
    try {
      const prepared = await getPreparedChatPaneSnapshot(win, 'markdown-export');
      snapshotPrep = prepared.prep;
      const snapshot = prepared.snapshot;
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Markdown', 'Chat pane not found.');
        return;
      }
      try {
        console.log('[markdown-export] snapshot:', {
          selector: snapshot.selector,
          textLength: snapshot.textLength,
          htmlLength: String(snapshot.html || '').length,
        });
      } catch {}
      // Convert cleaned semantic HTML  Markdown
      // (No entity decoding; structure already preserved)
      const paneHtml = String(snapshot.html ?? '');

      // IMPORTANT:
      // The app renders diff lines as separate block elements (div/span)
      // with NO newline text nodes. Inject newlines between blocks so
      // diffs and code retain line structure.
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      let safeHtml = stripExecutableBlocks(withLineBreaks);
      try {
        const materialized = await materializeInlineImageAssets(win, safeHtml, 'pane-markdown');
        safeHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveChatPaneAsMarkdown image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(safeHtml, { baseHref: getDocumentBaseHref(win) });
      await fs.promises.writeFile(filePath, md, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    } finally {
      if (snapshotPrep?.clear) await snapshotPrep.clear();
    }
  }

  async function saveChatPaneAsRawMarkdown(win, filePath) {
    if (!win) return;
    let snapshotPrep = null;
    try {
      const prepared = await getPreparedChatPaneSnapshot(win, 'markdown-raw-export');
      snapshotPrep = prepared.prep;
      const snapshot = prepared.snapshot;
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Raw Markdown', 'Chat pane not found.');
        return;
      }
      try {
        console.log('[markdown-raw-export] snapshot:', {
          selector: snapshot.selector,
          textLength: snapshot.textLength,
          htmlLength: String(snapshot.html || '').length,
        });
      } catch {}
      const paneHtml = String(snapshot.html ?? '');
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      let safeHtml = stripExecutableBlocks(withLineBreaks);
      try {
        const materialized = await materializeInlineImageAssets(win, safeHtml, 'pane-raw-markdown');
        safeHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveChatPaneAsRawMarkdown image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(safeHtml, { baseHref: getDocumentBaseHref(win) });
      await fs.promises.writeFile(filePath, md, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Raw Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    } finally {
      if (snapshotPrep?.clear) await snapshotPrep.clear();
    }
  }

  async function saveChatPaneAsMarkdownWithMetadata(win, filePath) {
    if (!win) return;
    let snapshotPrep = null;
    try {
      const prepared = await getPreparedChatPaneSnapshot(win, 'markdown-metadata-export');
      snapshotPrep = prepared.prep;
      const snapshot = prepared.snapshot;
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Markdown with metadata', 'Chat pane not found.');
        return;
      }
      try {
        console.log('[markdown-metadata-export] snapshot:', {
          selector: snapshot.selector,
          textLength: snapshot.textLength,
          htmlLength: String(snapshot.html || '').length,
        });
      } catch {}
      const paneHtml = String(snapshot.html ?? '');
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      let safeHtml = stripExecutableBlocks(withLineBreaks);
      try {
        const materialized = await materializeInlineImageAssets(win, safeHtml, 'pane-markdown-metadata');
        safeHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image] saveChatPaneAsMarkdownWithMetadata image capture failed:', imgErr);
      }
      const md = htmlToMarkdown(safeHtml, { baseHref: getDocumentBaseHref(win) });
      const header = buildExportMetadataHeader(win, {
        scope: EXPORT_SCOPES.PANE,
        profileKey: 'markdownWithMetadata',
        format: 'markdown'
      });

      await fs.promises.writeFile(filePath, `${header}\n${md}\n`, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Markdown with metadata failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    } finally {
      if (snapshotPrep?.clear) await snapshotPrep.clear();
    }
  }

async function saveChatPaneAsMarkdownExternalImages(win, filePath) {
    if (!win) return;
    let snapshotPrep = null;
    try {
      const prepared = await getPreparedChatPaneSnapshot(win, 'markdown-external-images-export');
      snapshotPrep = prepared.prep;
      const snapshot = prepared.snapshot;
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Markdown', 'Chat pane not found.');
        return;
      }
      try {
        console.log('[markdown-external-images-export] snapshot:', {
          selector: snapshot.selector,
          textLength: snapshot.textLength,
          htmlLength: String(snapshot.html || '').length,
        });
      } catch {}
      const paneHtml = String(snapshot.html ?? '');
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      let safeHtml = stripExecutableBlocks(withLineBreaks);
      try {
        const materialized = await materializeExternalImageAssets(win, safeHtml, filePath);
        safeHtml = materialized.html;
      } catch (imgErr) {
        console.error('[archival-image-ext] saveChatPaneAsMarkdownExternalImages failed:', imgErr);
      }
      const md = htmlToMarkdown(safeHtml, { baseHref: getDocumentBaseHref(win) });
      await fs.promises.writeFile(filePath, md, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Markdown (external images) failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    } finally {
      if (snapshotPrep?.clear) await snapshotPrep.clear();
    }
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
      await fs.promises.writeFile(filePath, md, 'utf8');
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
        v?.selector &&
        (
          String(v?.html || '').trim() ||
          Number(v?.textLength || 0) > 0
        )
      ))
      .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))[0];

    if (!best) return { ok: false, html: '', textLength: 0, selector: null };
    return { ok: true, ...best };
  }

  async function saveChatPaneAsText(win, filePath) {
    if (!win) return;
    try {
      const snapshot = await getChatPaneSnapshot(win);
      const result = {
        ok: !!snapshot?.ok,
        html: String(snapshot?.html || ''),
        title: win.webContents.getTitle?.() || appLabel + ' Chat'
      };
      if (!result?.ok) {
        try { dialog.showErrorBox('Save Chat Pane as Text', 'Chat pane not found.'); } catch {}
        return;
      }
      // Convert pane HTML  Plain Text: decode  sanitize  strip tags  normalize
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

  // ===========================================================================
  // Inline base64 image extraction pipeline
  // ===========================================================================
  async function extractScopedImagesFromRenderer(win, html) {
    if (!win?.webContents) return [];
    // Parse image IDs from the exported HTML
    const idPattern = /data-export-image-id=(?:"(img-\d{4})"|'(img-\d{4})')/g;
    const ids = [];
    let m;
    while ((m = idPattern.exec(html)) !== null) {
      const id = m[1] || m[2];
      if (id && !ids.includes(id)) ids.push(id);
    }
    if (!ids.length) return [];
    try {
      const result = await callRA(win, 'extractScopedImages', ids);
      return (result?.ok && Array.isArray(result.images)) ? result.images : [];
    } catch {
      return [];
    }
  }

  async function inlineImageDataUrisViaRenderer(win, html, idToDataUri) {
    if (!win?.webContents || !idToDataUri.size) return html;
    const mapObj = {};
    for (const [k, v] of idToDataUri) { mapObj[k] = v; }
    try {
      const result = await callRA(
        win,
        'inlineImageDataUris',
        html,
        mapObj
      );
      return (result?.ok && result.html) ? result.html : html;
    } catch {
      return html;
    }
  }

async function fetchImageAsDataUriFromMainProcess(url, partition) {
    if (!url || url.startsWith('data:')) return url;
    try {
      const ses = partition
        ? require('electron').session.fromPartition(partition)
        : require('electron').session.defaultSession;
      const resp = await ses.fetch(url);
      if (!resp.ok) return '';
      const contentType = resp.headers.get('content-type') || 'image/png';
      const buffer = Buffer.from(await resp.arrayBuffer());
      return `data:${contentType};base64,${buffer.toString('base64')}`;
    } catch (err) {
      console.error('[archival-image] Main-process fetch failed for', url, err);
      return '';
    }
  }

async function materializeInlineImageAssets(win, html, label = 'archival-image') {
    if (!html || !win?.webContents) return { html, inlined: 0, failures: [] };
    if (!/<img\b/i.test(html)) {
      console.log('[' + label + '] No <img> tags found in HTML (' + html.length + ' chars)');
      return { html, inlined: 0, failures: [] };
    }

    try {
      // Diagnostic: show the first <img> tag in the HTML
      var firstImgMatch = html.match(/<img\b[^>]*>/i);
      console.log('[' + label + '] First <img> tag: ' + (firstImgMatch ? firstImgMatch[0].substring(0, 500) : '(none)'));

      // Step 1: Parse all unique img src URLs — support both quote styles.
      var srcPattern = /<img\b[^>]*\ssrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
      var uniqueSrcs = new Map();
      var m;
      while ((m = srcPattern.exec(html)) !== null) {
        var rawSrc = String(m[1] || m[2] || '').trim();
        if (rawSrc && !rawSrc.startsWith('data:') && !uniqueSrcs.has(rawSrc)) {
          uniqueSrcs.set(rawSrc, null);
        }
      }

      console.log('[archival-image] Found ' + uniqueSrcs.size + ' unique non-data img src URL(s) in ' + html.length + ' chars of HTML');
      for (var [debugUrl] of uniqueSrcs) {
        console.log('[archival-image]   src: ' + debugUrl.substring(0, 150));
      }

      if (!uniqueSrcs.size) return { html, inlined: 0, failures: [] };

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
        var decodedSrc = decodeHtmlEntitiesInUrl(encodedSrc);

        if (/^(blob:|file:|javascript:|#)/i.test(decodedSrc)) {
          console.log('[archival-image] Skipping unfetchable: ' + decodedSrc.substring(0, 80));
          failures.push({ src: decodedSrc, status: 'unfetchable-scheme' });
          continue;
        }

        try {
          console.log('[archival-image] Fetching: ' + decodedSrc.substring(0, 150));
          var resp = await ses.fetch(decodedSrc, {
            headers: { 'Referer': 'https://m365.cloud.microsoft/' }
          });
          console.log('[archival-image] Response: ' + resp.status + ' content-type=' + (resp.headers.get('content-type') || '(none)'));
          if (!resp.ok) {
            failures.push({ src: decodedSrc, status: 'http-' + resp.status });
            continue;
          }
          var contentType = resp.headers.get('content-type') || 'image/png';
          if (!contentType.startsWith('image/')) {
            console.log('[archival-image] Skipping non-image content-type: ' + contentType);
            failures.push({ src: decodedSrc, status: 'not-image', contentType: contentType });
            continue;
          }
          var buf = Buffer.from(await resp.arrayBuffer());
          console.log('[archival-image] Fetched ' + buf.length + ' bytes (' + contentType + ')');
          uniqueSrcs.set(encodedSrc, 'data:' + contentType + ';base64,' + buf.toString('base64'));
          fetchCount++;
        } catch (fetchErr) {
          console.error('[archival-image] Fetch failed:', fetchErr);
          failures.push({ src: decodedSrc, status: String(fetchErr?.message || fetchErr) });
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

      return { html: result, inlined: inlined, failures: failures };
    } catch (err) {
      console.error('[archival-image] materializeInlineImageAssets failed:', err);
      return { html, inlined: 0, failures: [{ error: String(err?.message ?? err) }] };
    }
  }

async function materializeExternalImageAssets(win, html, mdFilePath) {
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
      var imagesDir = path.join(parsed.dir, parsed.name + '_images');
      await fs.promises.mkdir(imagesDir, { recursive: true });

      var electronSession = require('electron').session;
      var partition = (typeof deps.getAppPartition === 'function')
        ? String(deps.getAppPartition() || '').trim() : '';
      var ses = partition ? electronSession.fromPartition(partition) : electronSession.defaultSession;

      var failures = [];
      var savedCount = 0;
      var imgIndex = 0;

      for (var [originalSrc] of uniqueSrcs) {
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
            var resp = await ses.fetch(decodedSrc, {
              headers: { 'Referer': 'https://m365.cloud.microsoft/' }
            });
            if (!resp.ok) {
              failures.push({ src: decodedSrc, status: 'http-' + resp.status });
              continue;
            }
            var contentType = resp.headers.get('content-type') || 'image/png';
            if (!contentType.startsWith('image/')) {
              failures.push({ src: decodedSrc, status: 'not-image' });
              continue;
            }
            ext = (contentType.split('/')[1] || 'png').split(';')[0];
            if (ext === 'jpeg') ext = 'jpg';
            if (ext === 'svg+xml') ext = 'svg';
            imageBytes = Buffer.from(await resp.arrayBuffer());
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
      return { html: result, saved: savedCount, failures: failures };
    } catch (err) {
      console.error('[archival-image-ext] materializeExternalImageAssets failed:', err);
      return { html, saved: 0, failures: [{ error: String(err?.message ?? err) }] };
    }
  }

  function buildPrintableChatPaneHtml({ title = appLabel + ' Chat', html = '' } = {}) {
    return `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
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
      const pdf = await printWindow.webContents.printToPDF({
        printBackground: true,
        marginsType: 1,
        pageSize: 'Letter',
        landscape: false,
        preferCSSPageSize: true
      });

      await fs.promises.writeFile(filePath, pdf);
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

      selectionHtml = stripExecutableBlocks(selectionHtml);

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
      selectionHtml = stripExecutableBlocks(selectionHtml);

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
    if (!win) return;
    try {
      await saveChatPaneAsNativePDF(win, filePath);
    } catch (err) {
      console.error('Save Chat Pane as PDF failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveChatPaneAsNativePDF(win, filePath) {
    if (!win?.webContents) return;
    let cssKey = null;
    let prepApplied = false;
    let exportMarkerApplied = false;
    let hydratedHeight = 0;
    const layoutStages = [];
    const printBubbleDiagnosticSelectors =
      getPrintBubbleDiagnosticSelectors(PRINT_BUBBLE_CSS);
    try {
        // --- 0. Tag the correct chat pane element with a unique marker ---
        // The renderer agent runs the full detection+scoring pipeline in
        // every frame and tags the winning paneRoot with a unique
        // data-pdf-export-target attribute. The prep script below queries
        // by that attribute, avoiding the selector-ambiguity that bit
        // Gemini's "main" selector.
        const markResults = await callRAFrames(
          win,
          'locateChatRoot',
          { includeHtml: false, markForExport: true }
        );
        exportMarkerApplied = markResults.some(r => r?.value?.markerApplied);
        // Fallback selector for the unlikely case where the agent did not
        // mark anything (e.g. agent failed to install in a frame that owns
        // the chat pane). The prep script tries the marker first.
        const snapshot = !exportMarkerApplied ? await getChatPaneSnapshot(win) : null;
        const fallbackSelector = snapshot?.selector
          ? `:is(${snapshot.selector})`
          : CHAT_SCOPE_PSEUDO;

        // --- 0a. Expand collapsibles inside the marked pane so the PDF
        // captures "more lines" twisties, citations, and <details> open.
        if (exportMarkerApplied) {
          try {
            await callRA(win, 'expandForPrint');
            await new Promise(r => setTimeout(r, 80));
          } catch (e) {
            console.warn('[export-pdf-native] expandForPrint failed:', e);
          }
        }

        // --- 0b. Hydrate while the host page still has its real nested
        // virtualizer and scroll owner.
        //
        // pdfPrepare() removes the virtualizer's overflow and height
        // constraints. Hydrating after that point either selects the HTML
        // document and creates a scroll-height feedback loop, or triggers the
        // expanded-print-layout guard and performs zero hydration. In the
        // latter case, messages not currently mounted in the live DOM are
        // missing from the PDF.
        if (exportMarkerApplied) {
          try {
            const hydrateRes = await callRA(
              win,
              'hydrateVirtualizer',
              {
                stepDelayMs: 60,
                restoreScrollTop: false
              }
            );
            hydratedHeight = Number(
              hydrateRes?.finalHeight || 0
            );
            try {
              console.log(
                '[export-pdf-native] pre-prepare hydrateVirtualizer:',
                hydrateRes
              );
            } catch {}

            // Hydration can mount additional disclosure controls. Expand
            // those before flattening the page for print.
            await new Promise(r => setTimeout(r, 80));
            await callRA(win, 'expandForPrint');
          } catch (e) {
            console.warn(
              '[export-pdf-native] pre-prepare hydrateVirtualizer failed:',
              e
            );
          }
        }
        // Capture the live, hydrated geometry before pdfPrepare() and the
        // per-app print CSS flatten the pane. diagnosePdfLayout() compares
        // these same element references with the post-prepare measurements.
        try {
          const baselineStatus = await callRA(
            win,
            'capturePdfLayoutBaseline',
            {
              fallbackSelector,
              targetSelectors: printBubbleDiagnosticSelectors
            }
          );
          console.log(
            '[export-pdf-native] layout baseline:',
            baselineStatus
          );
          try {
            layoutStages.push(await callRA(
              win,
              'capturePdfLayoutStage',
              { fallbackSelector, stage: 'baseline' }
            ));
          } catch (e) {
            console.warn(
              '[export-pdf-native] baseline layout stage failed:',
              e
            );
          }
        } catch (e) {
          console.warn(
            '[export-pdf-native] layout baseline failed:',
            e
          );
        }

      // --- 1. Inject lightweight print-only CSS (no position:absolute!) ---
      const css = `
        @media print {
          img, svg, canvas, video {
            max-width: 100% !important;
            height: auto !important;
            break-inside: avoid !important;
          }
          pre {
            white-space: pre-wrap !important;
            word-break: break-word !important;
            overflow: visible !important;
          }
          table { break-inside: auto !important; page-break-inside: auto !important; }
          h1,h2,h3,h4,h5,h6 { break-after: avoid !important; page-break-after: avoid !important; }
        }
      `;
      cssKey = await win.webContents.insertCSS(css);

      // --- 2. Prepare the marked pane for native PDF printing.
      // The page mutation and rollback lifecycle lives in renderer/agent.js.
      const prepResult = await callRA(
        win,
        'pdfPrepare',
        { fallbackSelector }
      );
      try {
        layoutStages.push(await callRA(
          win,
          'capturePdfLayoutStage',
          { fallbackSelector, stage: 'after-pdfPrepare' }
        ));
      } catch (e) {
        console.warn('[export-pdf-native] after-pdfPrepare stage failed:', e);
      }
      prepApplied = true;
      try { console.log('[export-pdf-native] prep result:', prepResult); } catch {}

      // Per-app print-time CSS (clamp neutralizers etc.), scoped to the
      // marked pane. Each app provides its own rules via lib/chat-dom.js;
      // empty string => no-op. Removed in finally alongside prepCSS.
      if (PRINT_BUBBLE_CSS && PRINT_BUBBLE_CSS.trim()) {
        try {
          const bubbleKey = await win.webContents.insertCSS(PRINT_BUBBLE_CSS);
          if (Array.isArray(cssKey)) cssKey.push(bubbleKey);
          else cssKey = [cssKey, bubbleKey].filter(Boolean);
          // Allow the virtualizer to react to the reflow caused by lifting
          // the bubble clamp. Without this, off-viewport messages can be
          // transiently unmounted during printToPDF, producing an export
          // showing only the user inputs near the viewport.
          await win.webContents.executeJavaScript(
            '(function(){return new Promise(function(res){' +
              'requestAnimationFrame(function(){' +
                'requestAnimationFrame(function(){ setTimeout(res, 150); });' +
              '});' +
            '});})()',
            true
          ).catch(() => {});
          layoutStages.push(await callRA(
            win,
            'capturePdfLayoutStage',
            { fallbackSelector, stage: 'after-PRINT_BUBBLE_CSS' }
          ));
        } catch (e) {
          console.warn('[export-pdf-native] PRINT_BUBBLE_CSS insertCSS failed:', e);
        }
      }

      // --- 3. Wait for images/fonts to finish loading ---
      const assetStatus = await waitForPrintableAssets(win);
      try { console.log('[export-pdf-native] asset status:', assetStatus); } catch {}

      try {
        layoutStages.push(await callRA(
          win,
          'capturePdfLayoutStage',
          { fallbackSelector, stage: 'after-assets' }
        ));
      } catch (e) {
        console.warn('[export-pdf-native] after-assets stage failed:', e);
      }
      // Measure the final post-prepare layout after per-app print CSS and
      // assets have settled. This is diagnostic-only and does not mutate DOM.
      try {
        const layoutDiagnostics = await callRA(
          win,
          'diagnosePdfLayout',
          {
            fallbackSelector,
            expectedHeight: hydratedHeight,
            limit: 20,
            minimumExcess: 500,
            topDescendantLimit: 12,
            topGrowthLimit: 15,
            targetSelectors: printBubbleDiagnosticSelectors
          }
        );

        console.log(
          '[export-pdf-native] final layout diagnostic summary:',
          {
            ok: layoutDiagnostics?.ok,
            root: layoutDiagnostics?.root || null,
            document: layoutDiagnostics?.document || null,
            baseline: layoutDiagnostics?.baseline || null,
            conversationSummary:
              layoutDiagnostics?.conversationSummary || null,
            suspiciousCount:
              Number(layoutDiagnostics?.suspiciousCount || 0)
          }
        );
        console.log(
          '[export-pdf-native] compact layout diagnostics:\n' +
          JSON.stringify(
            {
              diagnosticVersion: 2,
               stages: layoutStages,
               root: layoutDiagnostics?.root || null,
              document: layoutDiagnostics?.document || null,
              conversationSummary:
                layoutDiagnostics?.conversationSummary || null,
              conversationRows:
                layoutDiagnostics?.conversationRows || [],
              largestGrowthDescendants:
                (layoutDiagnostics?.largestGrowthDescendants || []).slice(0, 15),
              suspicious:
                (layoutDiagnostics?.suspicious || []).slice(0, 12)
            },
            null,
            2
          )
        );
      } catch (e) {
        console.warn(
          '[export-pdf-native] final layout diagnostics failed:',
          e
        );
      }
      // Capture the final row text signatures immediately before Chromium
      // snapshots the prepared document. Comparing these with the baseline
      // distinguishes DOM tail loss from PDF pagination/rendering loss.
      try {
        const prePrintStage = await callRA(
          win,
          'capturePdfLayoutStage',
          { fallbackSelector, stage: 'immediately-before-printToPDF' }
        );
        console.log(
          '[export-pdf-native] immediately-before-printToPDF layout stage:',
          prePrintStage
        );
      } catch (e) {
        console.warn(
          '[export-pdf-native] immediately-before-printToPDF stage failed:',
          e
        );
      }
      try {
        const armResult = await callRA(
          win,
          'armPdfBeforePrintDiagnostic',
          {
            fallbackSelector,
            targetSelectors: printBubbleDiagnosticSelectors
          }
        );
        console.log(
          '[export-pdf-native] beforeprint diagnostic armed:',
          armResult
        );
      } catch (e) {
        console.warn(
          '[export-pdf-native] beforeprint diagnostic arm failed:',
          e
        );
      }
      try { console.log('[export-pdf-native] printToPDF starting'); } catch {}

      // --- 4. Print to PDF ---
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        marginsType: 1,
        pageSize: 'Letter',
        landscape: false,
        preferCSSPageSize: true
      });

      try {
        console.log('[export-pdf-native] printToPDF complete:', {
          bytes: pdf?.length || 0
        });
      } catch {}
      try {
        const beforePrintDiagnostic = await callRA(
          win,
          'getPdfBeforePrintDiagnostic'
        );
        console.log(
          '[export-pdf-native] beforeprint diagnostics:\n' +
          JSON.stringify(beforePrintDiagnostic, null, 2)
        );
      } catch (e) {
        console.warn(
          '[export-pdf-native] beforeprint diagnostic retrieval failed:',
          e
        );
      }

      await fs.promises.writeFile(filePath, pdf);
      try { console.log('[export-pdf-native] writeFile complete:', filePath); } catch {}

    } catch (err) {
      console.error('Save Chat Pane as Native PDF failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    } finally {
      // --- 5. Restore the original DOM state ---
      // Remove the export marker attribute via the renderer agent so the
      // teardown contract is name-call instead of script-string.
      if (exportMarkerApplied) {
        try {
          await callRAFrames(win, 'clearExportMarker');
        } catch {}
      }
      if (prepApplied) {
        try {
          const restoreResult = await callRA(win, 'pdfRestore');
          try { console.log('[export-pdf-native] restore result:', restoreResult); } catch {}
        } catch {}
      }
      if (cssKey) {
        try {
          const keys = Array.isArray(cssKey) ? cssKey : [cssKey];
          for (const k of keys) {
            try { await win.webContents.removeInsertedCSS(k); } catch {}
          }
        } catch {}
      }
    }
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
    buildPrintableChatPaneHtml,
    waitForPrintableAssets,
    writeHtmlDocumentToPDF,
    printChatPane,
    printSelection,
    saveChatPaneAsNativePDF,
    saveChatPaneAsPDF,
    selectChatPane,
    buildSelectionMarkdownForExport,
    saveAsDialog,
  };
}

module.exports = {
  EXPORT_SCOPES,
  createExporters,
};

