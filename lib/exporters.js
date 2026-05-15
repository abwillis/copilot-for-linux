'use strict';

const fs = require('fs');
const path = require('path');
const TurndownService = require('turndown');
const turndownPluginGfm = require('turndown-plugin-gfm');

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
    buildLocateChatRootScript,
    buildChatPaneDetectionScript,
    cleanupDOMFragmentScript,
    CHAT_SCOPE_PSEUDO,
    EXPORT_ROOT_CLASS,
    EXPORT_ROOT_SELECTOR,
    getAppConfig,
    DEFAULT_APP_CONFIG,
    normalizeExportFormat,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });

  async function executeInAllFrames(win, source) {
    if (!win?.webContents) return [];
    const results = [];

    try {
      const value = await win.webContents.executeJavaScript(source, true).catch(() => null);
      if (value) results.push({ frameId: 0, where: 'top', value });
    } catch {}

    const frames = win.webContents.mainFrame?.framesInSubtree ?? win.webContents.mainFrame?.frames ?? [];
    for (const frame of frames) {
      try {
        if (frame === win.webContents.mainFrame) continue;
        const value = await frame.executeJavaScript(source, true).catch(() => null);
        if (value) results.push({ frameId: frame.routingId ?? -1, where: `frame:${frame.routingId}`, value });
      } catch {}
    }

    return results;
  }

  async function findBestChatRoot(win, { includeHtml = true } = {}) {
    const results = await executeInAllFrames(
      win,
      buildLocateChatRootScript({ includeHtml })
    );

    if (!results.length) return null;
    results.sort((a, b) => {
      const aScore = Number(a?.value?.score || 0);
      const bScore = Number(b?.value?.score || 0);
      if (bScore !== aScore) return bScore - aScore;
      const aLen = Number(a?.value?.textLength || 0);
      const bLen = Number(b?.value?.textLength || 0);
      return bLen - aLen;
    });

    return results[0];
  }

  async function getChatPaneSnapshot(win) {
    const best = await findBestChatRoot(win, { includeHtml: true });

    if (!best?.value) {
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
    const { hasSelection, html, text } = await getSelectionFragment(win);
    if (!hasSelection) return '';
    return htmlToMarkdown(html || text);
  }

  // --- Select Chat Pane (highlight chat content in renderer) ---
  async function selectChatPane(win) {
    if (!win) return { ok: false, selectedTextLength: 0 };
    try {
      const locateScript = typeof buildLocateChatRootScript === 'function'
        ? buildLocateChatRootScript({ includeHtml: false })
        : null;
      if (!locateScript) return { ok: false, selectedTextLength: 0 };

      const found = await win.webContents.executeJavaScript(locateScript);
      if (!found?.selector) return { ok: false, selectedTextLength: 0 };

      const selectScript = `
        (function() {
          try {
            const el = document.querySelector(${JSON.stringify(found.selector)});
            if (!el) return { ok: false, selectedTextLength: 0 };
            const sel = window.getSelection();
            if (!sel) return { ok: false, selectedTextLength: 0 };
            sel.removeAllRanges();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.addRange(range);
            const txt = String(sel.toString() || '');
            return { ok: !!txt.length, selectedTextLength: txt.length };
          } catch (e) {
            return { ok: false, selectedTextLength: 0, error: String(e) };
          }
        })();
      `;
      const result = await win.webContents.executeJavaScript(selectScript);
      return result || { ok: false, selectedTextLength: 0 };
    } catch (err) {
      console.error('selectChatPane failed:', err);
      return { ok: false, selectedTextLength: 0 };
    }
  }

  // ---------- Selection  Markdown helpers ----------
  // Extract the current selection from the renderer as HTML fragment and text.
  async function getSelectionFragment(win) {

    const result = await win.webContents.executeJavaScript(`
    (function() {
      const sel = window.getSelection && window.getSelection();
      if (!sel || sel.rangeCount === 0) {
        return { hasSelection: false, html: "", text: "" };
      }

      // Clone selected contents so we never mutate the live DOM
      const range = sel.getRangeAt(0);
      const container = document.createElement('div');
      container.appendChild(range.cloneContents());
      ${cleanupDOMFragmentScript('container')}
      const html = container.innerHTML;
      const text = String(sel.toString() || '');
      return { hasSelection: true, html, text };
    })();
    `).catch(() => ({ hasSelection: false, html: "", text: "" }));
    return result;
  }

  async function getSelectionFragmentRaw(win) {
    if (!win) return { hasSelection: false, html: '', text: '' };

    const result = await win.webContents.executeJavaScript(`
      (function() {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.rangeCount === 0) {
          return { hasSelection: false, html: "", text: "" };
        }

        const range = sel.getRangeAt(0);
        const container = document.createElement('div');
        container.appendChild(range.cloneContents());

        return {
          hasSelection: true,
          html: container.innerHTML,
          text: String(sel.toString() || '')
        };
      })();
    `).catch(() => ({ hasSelection: false, html: '', text: '' }));

    return result;
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
        'button', 'input', 'select', 'textarea',
        'svg', 'canvas', 'iframe'
      ]);
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

  function htmlToMarkdown(html) {
    const preparedHtml = preprocessHtmlForMarkdown(html);
    if (!preparedHtml) return '';

    try {
      return postProcessMarkdown(turndownService.turndown(preparedHtml));
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

  async function saveSelectionAsCleanMarkdown(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = await getSelectionFragment(win);
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      const md = htmlToMarkdown(html || text);
      await fs.promises.writeFile(filePath, md, 'utf8');
    } catch (err) {
      console.error('Save Selection as Clean Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveSelectionAsRawMarkdown(win, filePath) {
    try {
      if (!win) return;
      const { hasSelection, html, text } = await getSelectionFragmentRaw(win);
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      const safeHtml = stripExecutableBlocks(String(html || text || ''));
      const md = htmlToMarkdown(safeHtml);
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
      const { hasSelection, html, text } = await getSelectionFragment(win);
      if (!hasSelection) {
        safeShowError('Export Selection', 'No selection found.');
        return;
      }

      const md = htmlToMarkdown(html || text);
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
      const { hasSelection, html, text } = await getSelectionFragment(win);
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
      const { hasSelection, html, text } = await getSelectionFragment(win);
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
    const result = await win.webContents.executeJavaScript(`
    (function() {
      const root = document.createElement('div');
      root.innerHTML = ${JSON.stringify(String(snapshot.html || ''))};
      const clone = root.firstElementChild || root;
      clone.querySelectorAll('[class]').forEach(n => n.removeAttribute('class'));
      clone.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
      clone.querySelectorAll('*').forEach(n => {
        [...n.attributes].forEach(a => {
          const name = a.name.toLowerCase();
          if (name.startsWith('data-') || name.startsWith('aria-') || name === 'role' || name === 'tabindex') {
            n.removeAttribute(a.name);
          }
          if (name === 'id' && n !== clone) n.removeAttribute('id');
        });
      });
      clone.querySelectorAll('div').forEach(n => { if (!n.textContent.trim()) n.remove(); });
      return { ok:true, title: document.title, html: clone.innerHTML };
    })();
    `);
    const htmlDoc = `<!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${result.title || appLabel + ' Chat'}</title>
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
    <div class="${EXPORT_ROOT_CLASS}">${result.html || '<p>No chat content found.</p>'}</div>
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
          await promptExportWithProfile(win, scope, profileKey);
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
    try {
      const snapshot = await getBestChatRootCleaned(win);
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Markdown', 'Chat pane not found.');
        return;
      }

      // Convert cleaned semantic HTML  Markdown
      // (No entity decoding; structure already preserved)
      const paneHtml = String(snapshot.html ?? '');

      // IMPORTANT:
      // The app renders diff lines as separate block elements (div/span)
      // with NO newline text nodes. Inject newlines between blocks so
      // diffs and code retain line structure.
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      const safeHtml = stripExecutableBlocks(withLineBreaks);
      const md = htmlToMarkdown(safeHtml);
      await fs.promises.writeFile(filePath, md, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveChatPaneAsRawMarkdown(win, filePath) {
    if (!win) return;
    try {
      const snapshot = await getChatPaneSnapshot(win);
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Raw Markdown', 'Chat pane not found.');
        return;
      }

      const paneHtml = String(snapshot.html ?? '');
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      const safeHtml = stripExecutableBlocks(withLineBreaks);
      const md = htmlToMarkdown(safeHtml);
      await fs.promises.writeFile(filePath, md, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Raw Markdown failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveChatPaneAsMarkdownWithMetadata(win, filePath) {
    if (!win) return;
    try {
      const snapshot = await getBestChatRootCleaned(win);
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as Markdown with metadata', 'Chat pane not found.');
        return;
      }

      const paneHtml = String(snapshot.html ?? '');
      const withLineBreaks = paneHtml.replace(/></g, '>\n<');
      const safeHtml = stripExecutableBlocks(withLineBreaks);
      const md = htmlToMarkdown(safeHtml);
      const header = buildExportMetadataHeader(win, {
        scope: EXPORT_SCOPES.PANE,
        profileKey: 'markdownWithMetadata',
        format: 'markdown'
      });

      await fs.promises.writeFile(filePath, `${header}\n${md}\n`, 'utf8');
    } catch (err) {
      console.error('Save Chat Pane as Markdown with metadata failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function getBestChatRootCleaned(win) {
    const results = await executeInAllFrames(
      win,
      buildLocateChatRootScript({
        includeHtml: true,
        cleanupJunk: true
      })
    );
    const best = results
    .map(r => r.value)
    .filter(v => v?.selector)
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

  async function saveSelectionAsPDF(win, filePath) {
    if (!win) return;
    try {
      const { hasSelection, html, text } = await getSelectionFragment(win);
      if (!hasSelection) {
        safeShowError('Export Selection as PDF', 'No selection found.');
        return;
      }

      const title = win.webContents.getTitle?.() || appLabel + ' Selection';
      const body = html || `<pre>${escapeHtmlForExport(text)}</pre>`;
      const htmlDoc = buildPrintableChatPaneHtml({ title, html: body });
      await writeHtmlDocumentToPDF(filePath, htmlDoc);
    } catch (err) {
      console.error('Save Selection as PDF failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    }
  }

  async function saveChatPaneAsPDF(win, filePath) {
    if (!win) return;
    let printWindow = null;
    let tempHtmlPath = null;

    try {
      const snapshot = await getBestChatRootCleaned(win);
      if (!snapshot?.ok) {
        safeShowError('Save Chat Pane as PDF', 'Chat pane not found.');
        return;
      }

      const title = win.webContents.getTitle?.() || appLabel + ' Chat';
      const htmlDoc = buildPrintableChatPaneHtml({
        title,
        html: String(snapshot.html ?? '')
      });
      await writeHtmlDocumentToPDF(filePath, htmlDoc);
    } catch (err) {
      console.error('Save Chat Pane as PDF failed:', err);
      safeShowError('Save failed', String(err?.message ?? err));
    } finally {
      if (printWindow && !printWindow.isDestroyed()) {
        try { printWindow.destroy(); } catch {}
      }
      if (tempHtmlPath) {
        try { await fs.promises.unlink(tempHtmlPath); } catch {}
      }
      tempHtmlPath = null;
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
    getBestChatRootCleaned,
    saveChatPaneAsText,
    escapeHtmlForExport,
    buildPrintableChatPaneHtml,
    writeHtmlDocumentToPDF,
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
