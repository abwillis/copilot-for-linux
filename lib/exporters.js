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

    // Leave reasoning controls for expandReasoningForPrint below -- but only
    // when that pass is actually going to run. If it is disabled, expandForPrint
    // must keep opening them or reasoning would not be expanded at all.
    const deferReasoning = APP_CONFIG.expandReasoningForSnapshot !== false;

    try {
      const expand1 = await callRAFrames(
        win, 'expandForPrint', { skipReasoning: deferReasoning }
      );
      await new Promise(r => setTimeout(r, 80));
      // restoreScrollTop:false matches what the (working) PDF path does. With
      // the default (true) the scroller snaps back after hydration and Fluent
      // promptly unmounts the off-viewport rows again -- renderer/agent.js says
      // exactly this in its own comment above collectVirtualizedChatHtml. That
      // silently undoes the hydration we just paid for.
      const hydrate = await callRAFrames(
        win,
        'hydrateVirtualizer',
        { stepDelayMs: 60, restoreScrollTop: false }
      );
      await new Promise(r => setTimeout(r, 80));

      const expand2 = await callRAFrames(
        win, 'expandForPrint', { skipReasoning: deferReasoning }
      );

      // Expand chain-of-thought reasoning panels, giving markdown/HTML/text
      // exports the same content the PDF path gets.
      //
      // POSITION MATTERS. This runs after hydrateVirtualizer() (so every row is
      // mounted) but before getFlattenedChatPaneHtml() calls pdfPrepare() (so
      // the virtualizer's scroll container is still intact). That combination is
      // the only one where the web app actually renders reasoning bodies:
      //   * post-flatten, the scroll container is destroyed and bodies never
      //     render -- measured 31/31 panels clicked, 0 bodies captured;
      //   * pre-hydrate, only ~10 rows are mounted so there is nothing to click.
      // It is the same position View > Expand uses, which is why that works.
      //
      // Without this the markdown snapshot captured 695,887 chars of DOM text
      // while a PDF export minutes later captured 1,140,885 -- a ~445K gap that
      // was entirely reasoning bodies, and which only closed because the user
      // happened to wait between exports.
      //
      // Gated separately from enableReasoningExpansion: that flag governs the
      // PDF export's own (post-flatten, non-working) attempt and defaults off.
      let reasoning = null;
      if (APP_CONFIG.expandReasoningForSnapshot !== false) {
        try {
          const reasoningBudgetMs = Number(APP_CONFIG.reasoningExpandBudgetMs) > 0
            ? Number(APP_CONFIG.reasoningExpandBudgetMs)
            : undefined;
          reasoning = await callRA(
            win,
            'expandReasoningForPrint',
            { reasoningBudgetMs }
          );
          console.log('[' + logPrefix + '] expandReasoningForPrint:', {
            found: reasoning?.found,
            clicked: reasoning?.clicked,
            capturedPanels: reasoning?.capturedPanels,
            materializeRounds: reasoning?.materializeRounds,
            materializeStillThin: reasoning?.materializeStillThin,
            reasoningGrew: reasoning?.reasoningGrew,
            budgetHit: reasoning?.budgetHit,
            cancelled: reasoning?.cancelled,
            elapsedMs: reasoning?.elapsedMs,
          });
        } catch (e) {
          console.warn('[' + logPrefix + '] expandReasoningForPrint failed:', e);
        }
      }

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

  // Capture the chat pane HTML the same way the PDF export captures it.
  //
  // WHY: the PDF path is complete because pdfPrepare() FLATTENS the Fluent
  // virtualizer -- it strips the scroll container's overflow/height/contain and
  // forces every row to lay out in document order. printToPDF then reads that
  // fully-materialized live DOM.
  //
  // The markdown path never did this. It relied on collectVirtualizedChatHtml(),
  // a bespoke scroll-and-accumulate collector, which was observed failing hard:
  // 642 scroll steps over a 709,233px range yet `collected: 1`, with
  // firstCollectedY === lastCollectedY === 0 and first/last previews identical --
  // i.e. it re-saw the top message and kept only that. The exported markdown was
  // the first message and nothing else.
  //
  // Reusing pdfPrepare here gives markdown (and clean-HTML/text, which share
  // this snapshot) the identical, proven DOM the PDF gets. pdfRestore() is
  // always called in the finally block so the live page is left untouched.
  async function getFlattenedChatPaneHtml(win, logPrefix = 'markdown-export', options = {}) {
    // cleanupJunk routes locateChatRoot through the agent's cleanedClone(),
    // which REMOVES elements matching DOM_CLEANUP_SELECTORS (buttons, copy /
    // feedback / toolbar / icon chrome) while protecting
    // DOM_PRESERVE_CONTENT_SELECTORS (pre, code, table, ul, ol, img...).
    // Defaults to false so the raw path keeps byte-for-byte current behaviour.
    const cleanupJunk = options.cleanupJunk === true;
    let prepApplied = false;
    try {
      const prepResult = await callRA(win, 'pdfPrepare', {});
      prepApplied = !!prepResult?.ok;
      try {
        console.log('[' + logPrefix + '] pdfPrepare:', prepResult);
      } catch {}
      if (!prepApplied) return null;

      // Let the flattened layout settle before reading it, mirroring the
      // reflow pause the PDF path takes after lifting the clamps.
      await new Promise(r => setTimeout(r, 150));

      // Read the marked pane from the now-flattened DOM.
      //
      // NOTE: includeHtml alone does NOT clean anything -- locateChatRoot only
      // calls cleanedClone() when cleanupJunk is also set; otherwise it returns
      // raw outerHTML. (An earlier comment here claimed cleaning was automatic;
      // it was not, which is why cleanMarkdown and rawMarkdown produced
      // byte-identical files.)
      const results = await callRAFrames(
        win,
        'locateChatRoot',
        { includeHtml: true, cleanupJunk }
      );
      const best = results
        .map(r => ({ where: r.where, value: r.value }))
        .filter(r => r.value?.ok && String(r.value?.html || '').trim())
        .sort((a, b) =>
          String(b.value?.html || '').length - String(a.value?.html || '').length
        )[0];

      if (!best?.value?.html) return null;

      const html = String(best.value.html || '');
      try {
        console.log('[' + logPrefix + '] flattened snapshot:', {
          where: best.where,
          selector: best.value.selector,
          htmlLength: html.length,
          textLength: Number(best.value.textLength || 0),
        });
      } catch {}

      return {
        ok: true,
        html,
        textLength: Number(best.value.textLength || 0),
        selector: best.value.selector || null,
      };
    } catch (e) {
      console.warn('[' + logPrefix + '] flattened snapshot failed:', e);
      return null;
    } finally {
      if (prepApplied) {
        try {
          const restore = await callRA(win, 'pdfRestore');
          try { console.log('[' + logPrefix + '] pdfRestore:', restore); } catch {}
        } catch (e) {
          console.warn('[' + logPrefix + '] pdfRestore failed:', e);
        }
      }
    }
  }

  async function getPreparedChatPaneSnapshot(win, logPrefix = 'markdown-export', options = {}) {
    const snapshotPrep = await prepareChatPaneForSnapshot(win, logPrefix);

    // Preferred path: flatten the virtualizer exactly as the PDF export does,
    // then read the fully-materialized DOM. Falls through to the legacy
    // scroll-collector below if this fails for any reason.
    if (snapshotPrep.markerApplied) {
      // Measure the DOM at the moment markdown captures it, using the same
      // diagnostic the PDF path uses. Without this the answer-body figures
      // exist only for PDF, so a markdown-only failure is invisible.
      await logConversationDiagnostic(win, '', 'markdown-capture', logPrefix);

      const flattened = await getFlattenedChatPaneHtml(win, logPrefix, options);
      if (flattened?.html) {
        return { prep: snapshotPrep, snapshot: flattened };
      }
      console.warn(
        '[' + logPrefix + '] flattened snapshot unavailable; ' +
        'falling back to collectVirtualizedChatHtml'
      );
    }

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
      // cleanMarkdown: strip UI chrome (buttons, copy/feedback widgets,
      // code-gutter line numbers, "Show more lines" expanders). rawMarkdown
      // deliberately does NOT pass this, so it preserves everything.
      const prepared = await getPreparedChatPaneSnapshot(
        win,
        'markdown-export',
        { cleanupJunk: APP_CONFIG.cleanMarkdownStripsJunk !== false }
      );
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

  // Estimate the prepared document's page count from its rendered height.
  // printToPDF() does not report a page count, so we derive one from the
  // flattened content height and an assumed printable page height (CSS px).
  // The estimate is deliberately inflated by a safety factor: over-estimation
  // is corrected cheaply by the out-of-range clamp in printToPDFChunked(),
  // whereas under-estimation would silently drop the tail of the export.
  // Cheap layout settle: two rAFs so the compositor commits any pending
  // reflow before the next capture. Deliberately does NOT read layout (no
  // scrollHeight/offsetHeight access) so it cannot force a synchronous
  // layout. That distinction is the whole point: a forced layout here
  // re-triggers the virtualizer unmount that saveChatPaneAsNativePDF()'s
  // pre-print settle is there to prevent.
  async function settlePrintLayout(win) {
    try {
      await win.webContents.executeJavaScript(
        '(function(){return new Promise(function(res){' +
          'requestAnimationFrame(function(){' +
            'requestAnimationFrame(function(){ res(); });' +
          '});' +
        '});})()',
        true
      );
    } catch {}
  }

  // Estimate the prepared document's page count.
  //
  // CRITICAL: on the live chat window we must NOT issue our own
  // scrollHeight/offsetHeight read here. That read forces a synchronous
  // layout, and performing it AFTER the carefully-timed pre-print settle
  // re-triggers exactly the virtualizer unmount that settle prevents -- which
  // dropped every off-viewport Copilot answer bubble and left only the short
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
      // Height already measured by the caller (hydratedHeight on the live
      // pane). When provided we skip the layout-forcing measurement.
      knownHeightPx = 0,
      // Re-commit layout with a rAF-only settle immediately before each
      // slice. Used for the live virtualized pane; unnecessary for the
      // static offscreen document.
      settleBeforeEachChunk = false,
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

    // Loop upper bound. estimatedPages is already inflated by the safety
    // factor; add one extra chunk of headroom plus a hard cap so a bad
    // estimate can never spin the slice loop forever.
    const hardCap = estimatedPages + settings.chunkSize;

    const chunkBuffers = [];
    let from = 1;
    let producedAny = false;

    while (from <= hardCap) {
      let to = from + settings.chunkSize - 1;
      let buf = null;

      // Re-commit any pending reflow with a layout-read-free settle so that
      // a settle -- not a forced layout -- is the last thing to touch the
      // page before each capture. This preserves the invariant documented at
      // the pre-print settle in saveChatPaneAsNativePDF(): off-viewport
      // message bubbles must stay mounted through printToPDF().
      if (settleBeforeEachChunk) {
        await settlePrintLayout(win);
      }

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

  // Run the renderer conversation diagnostic at a given export stage and log
  // it compactly. Gated by APP_CONFIG.enableConversationExportDiagnostic
  // (default true) so it is independent of enableExportDiagnostics and can be
  // switched off once the missing-answers / unexpanded-reasoning investigation
  // is complete. Never throws into the export path.
  async function logConversationDiagnostic(win, fallbackSelector, stage, logPrefix) {
    const tag = logPrefix || 'export-pdf-native';
    if (APP_CONFIG.enableConversationExportDiagnostic === false) return;
    try {
      const diag = await callRA(
        win,
        'capturePdfConversationDiagnostic',
        { fallbackSelector, stage }
      );
      // Log a compact summary line first for quick scanning, then the full
      // per-row JSON (bounded by the agent's maxRows/preview limits).
      try {
        console.log(
          '[' + tag + '][conv] ' + stage + ' summary:',
          diag && diag.assistantSummary
            ? {
                rowCount: diag.rowCount,
                assistant: diag.assistantSummary,
                // The decisive figures. `assistant` counts whole ROWS and reads
                // as healthy even when every answer body is empty, because each
                // row also holds the user's (often large) message. These count
                // the answer bodies themselves.
                answers: diag.answerStats,
                userHints: diag.userHints,
                assistantHints: diag.assistantHints
              }
            : diag
        );
      } catch {}
      logVerbose(
        '[' + tag + '][conv] ' + stage + ' detail:\n' +
        JSON.stringify(diag, null, 2)
      );
    } catch (e) {
      console.warn(
        '[' + tag + '][conv] ' + stage + ' failed:',
        e
      );
    }
  }


  // Optionally expand chain-of-thought / "Reasoning completed in N steps"
  // panels so the full reasoning is captured in the export. Gated by
  // APP_CONFIG.enableReasoningExpansion (default true). Must be called AFTER
  // pdfPrepare() has flattened the virtualizer (all rows mounted) and after the
  // clamp CSS has lifted, so every reasoning control is present and can lay out
  // once opened. Never throws into the export path.
  async function expandReasoningIfEnabled(win, fallbackSelector) {
    if (APP_CONFIG.enableReasoningExpansion === false) return;
    try {
      // Pass the configured wall-clock budget through. The renderer defaults to
      // a conservative value; long conversations need more, and the export
      // silently loses every panel past the cutoff when it is too small.
      const reasoningBudgetMs = Number(APP_CONFIG.reasoningExpandBudgetMs) > 0
        ? Number(APP_CONFIG.reasoningExpandBudgetMs)
        : undefined;
      const res = await callRA(
        win,
        'expandReasoningForPrint',
        { fallbackSelector, reasoningBudgetMs }
      );
      try { console.log('[export-pdf-native] expandReasoningForPrint:', res); } catch {}
      // Give any lazily-rendered reasoning bodies a moment to populate and the
      // virtualizer-flattened layout a chance to reflow before we print.
      await win.webContents.executeJavaScript(
        '(function(){return new Promise(function(res){' +
          'requestAnimationFrame(function(){' +
            'requestAnimationFrame(function(){ setTimeout(res, 150); });' +
          '});' +
        '});})()',
        true
      ).catch(() => {});
    } catch (e) {
      console.warn('[export-pdf-native] expandReasoningForPrint failed:', e);
    }
  }

  async function saveChatPaneAsNativePDF(win, filePath) {
    if (!win?.webContents) return;
    let cssKey = null;
    let prepApplied = false;
    let exportMarkerApplied = false;
    let rendererProcessGone = false;
    const exportDiagnosticsEnabled =
      APP_CONFIG.enableExportDiagnostics !== false;
    let hydratedHeight = 0;
    const layoutStages = [];
    const printBubbleDiagnosticSelectors = exportDiagnosticsEnabled
      ? getPrintBubbleDiagnosticSelectors(PRINT_BUBBLE_CSS)
      : [];
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
              logVerbose(
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
        // --- 0c. Expand reasoning panels, BEFORE pdfPrepare() ---------------
        // This must happen while the page is still in its normal, live state.
        //
        // pdfPrepare() flattens the chat pane for print: it walks every ancestor
        // and forces overflow:visible, height:auto and position:static, which
        // destroys the virtualizer's scroll container. The Copilot web app
        // renders a reasoning panel's body lazily, driven by that scrolling
        // viewport, so once it is flattened the bodies never render at all.
        //
        // Measured directly: with expansion after pdfPrepare, all 31 panels were
        // clicked open, then the materialization pass waited 12 rounds (~14s)
        // and captured NOTHING -- materializeCaptured: 0, materializeStillThin:
        // 31, reasoningGrew: 0. The bodies only appeared once pdfRestore() ran
        // after printToPDF, which is exactly what the user observed on screen:
        // "the rest of reasoning expand out after the pdf was already created".
        //
        // Running here -- alongside expandForPrint()/hydrateVirtualizer(), which
        // have always worked from this position -- keeps the live scroll
        // container intact so the app actually renders the bodies, and the
        // capture/materialization passes have something real to capture.
        await expandReasoningIfEnabled(win, fallbackSelector);

        // Conversation diagnostic: live, hydrated, pre-prepare state. This is
        // the reference point -- assistant rows present and non-zero here but
        // absent/collapsed at a later stage localizes the regression.
        await logConversationDiagnostic(win, fallbackSelector, 'live-baseline');

        // Capture the live, hydrated geometry before pdfPrepare() and the
        // per-app print CSS flatten the pane. diagnosePdfLayout() compares
        // these same element references with the post-prepare measurements.
        if (exportDiagnosticsEnabled) {
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

            layoutStages.push(await callRA(
              win,
              'capturePdfLayoutStage',
              { fallbackSelector, stage: 'baseline' }
            ));
          } catch (e) {
            console.warn(
              '[export-pdf-native] layout baseline failed:',
              e
            );
          }
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
      if (exportDiagnosticsEnabled) {
        try {
          layoutStages.push(await callRA(
            win,
            'capturePdfLayoutStage',
            { fallbackSelector, stage: 'after-pdfPrepare' }
          ));
        } catch (e) {
          console.warn('[export-pdf-native] after-pdfPrepare stage failed:', e);
        }
      }
      prepApplied = true;
      try { console.log('[export-pdf-native] prep result:', prepResult); } catch {}

      // Conversation diagnostic: after pdfPrepare() flattens the virtualizer.
      // If assistant rows are healthy at live-baseline but disconnected/zero
      // here, pdfPrepare (or the virtualizer's reaction to it) is the culprit.
      await logConversationDiagnostic(win, fallbackSelector, 'after-pdfPrepare');

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
          if (exportDiagnosticsEnabled) {
            layoutStages.push(await callRA(
              win,
              'capturePdfLayoutStage',
              { fallbackSelector, stage: 'after-PRINT_BUBBLE_CSS' }
            ));
          }
        } catch (e) {
          console.warn('[export-pdf-native] PRINT_BUBBLE_CSS insertCSS failed:', e);
        }
      }

      // NOTE: reasoning expansion used to run HERE, after pdfPrepare(). That is
      // too late -- see step 0c above for why it now runs before the flatten.

      // --- 3. Wait for images/fonts to finish loading ---
      const assetStatus = await waitForPrintableAssets(win);
      try { console.log('[export-pdf-native] asset status:', assetStatus); } catch {}
      if (exportDiagnosticsEnabled) {
        try {
          layoutStages.push(await callRA(
            win,
            'capturePdfLayoutStage',
            { fallbackSelector, stage: 'after-assets' }
          ));
        } catch (e) {
          console.warn('[export-pdf-native] after-assets stage failed:', e);
        }
      }

      // Measure the final post-prepare layout after per-app print CSS and
      // assets have settled. This is diagnostic-only and does not mutate DOM.
      if (exportDiagnosticsEnabled) {
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
          logVerbose(
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
      if (exportDiagnosticsEnabled) try {
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
      if (exportDiagnosticsEnabled) try {
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
      }

      // Capture coarse document-size and renderer-heap measurements after all
      // export preparation has settled and immediately before Chromium begins
      // pagination. This remains available in the log even if the renderer is
      // subsequently disposed during printToPDF().
      if (exportDiagnosticsEnabled) try {
        const resourceDiagnostic = await callRA(
          win,
          'capturePdfResourceDiagnostic',
          {
            fallbackSelector,
            stage: 'immediately-before-printToPDF'
          }
        );
        logVerbose(
          '[export-pdf-native] pre-print resource diagnostic:\n' +
          JSON.stringify(
            {
              renderer: resourceDiagnostic,
              mainProcessMemory: captureMainProcessMemoryDiagnostic()
            },
            null,
            2
          )
        );
      } catch (e) {
        console.warn(
          '[export-pdf-native] pre-print resource diagnostic failed:',
          e
        );
      }

      // Conversation diagnostic: the final DOM state Chromium will snapshot.
      // Assistant rows healthy here but missing from the PDF => the loss is in
      // pagination/rendering, not the DOM. Assistant rows already gone/collapsed
      // here => the loss is in the DOM, upstream of printToPDF.
      await logConversationDiagnostic(win, fallbackSelector, 'immediately-before-printToPDF');

      try { console.log('[export-pdf-native] printToPDF starting'); } catch {}

      let renderProcessGoneDetails = null;
      const onRenderProcessGone = (_event, details) => {
        rendererProcessGone = true;
        renderProcessGoneDetails = {
          reason: String(details?.reason || ''),
          exitCode: Number(details?.exitCode || 0),
        };
        try {
          console.error(
            '[export-pdf-native] render-process-gone during printToPDF:',
            renderProcessGoneDetails
          );
        } catch {}
      };

      try {
        win.webContents.once('render-process-gone', onRenderProcessGone);
      } catch {}

      // --- 4. Print to PDF ---
      // SINGLE PASS ONLY on the live pane.
      //
      // The live pane is a Fluent virtualizer. hydrateVirtualizer() mounts
      // every row and deliberately does NOT restore scrollTop so the rows
      // stay mounted, then we print ONCE, immediately, before Fluent's
      // debounced idle reconciler can run. Calling printToPDF() more than
      // once here (page-range chunking) reopens that race: between passes
      // the reconciler unmounts off-viewport rows and reverts reasoning
      // expansion, so the export loses whole answers and re-collapses
      // "reasoning completed in N steps" -- and which rows are lost varies
      // with timing, producing inconsistent output.
      //
      // Memory bounding for very large exports is handled WITHOUT fighting
      // the virtualizer, by the offscreen static-HTML path
      // (writeHtmlDocumentToPDF -> printToPDFChunked): that document has no
      // virtualizer, so multi-pass chunking there is stable. Routing large
      // live-pane exports through that static snapshot is the intended
      // follow-up; it is NOT wired here yet.
      let pdf = null;
      try {
        pdf = await win.webContents.printToPDF({
          printBackground: true,
          marginsType: 1,
          pageSize: 'Letter',
          landscape: false,
          preferCSSPageSize: true
        });
      } catch (printError) {
        let webContentsDestroyed = null;
        let browserWindowDestroyed = null;
        let webContentsCrashed = null;

        try {
          webContentsDestroyed = !!win.webContents.isDestroyed();
        } catch {}
        try {
          browserWindowDestroyed = !!win.isDestroyed();
        } catch {}
        try {
          webContentsCrashed = typeof win.webContents.isCrashed === 'function'
            ? !!win.webContents.isCrashed()
            : null;
        } catch {}

        try {
          console.error(
            '[export-pdf-native] printToPDF failure diagnostic:',
            {
              errorName: String(printError?.name || ''),
              errorMessage: String(printError?.message || printError),
              browserWindowDestroyed,
              webContentsDestroyed,
              webContentsCrashed,
              renderProcessGone: renderProcessGoneDetails,
              mainProcessMemory: captureMainProcessMemoryDiagnostic()
            }
          );
        } catch {}

        throw printError;
      } finally {
        try {
          win.webContents.removeListener(
            'render-process-gone',
            onRenderProcessGone
          );
        } catch {}
      }


      try {
        console.log('[export-pdf-native] printToPDF complete:', {
          bytes: pdf?.length || 0,
          mainProcessMemory: captureMainProcessMemoryDiagnostic()
        });
      } catch {}
      if (exportDiagnosticsEnabled) try {
        const beforePrintDiagnostic = await callRA(
          win,
          'getPdfBeforePrintDiagnostic'
        );
        logVerbose(
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
      let rendererUsable = !rendererProcessGone;
      try {
        rendererUsable =
          rendererUsable &&
          !win.isDestroyed() &&
          !win.webContents.isDestroyed() &&
          (
            typeof win.webContents.isCrashed !== 'function' ||
            !win.webContents.isCrashed()
          );
      } catch {
        rendererUsable = false;
      }

      if (rendererUsable) {
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
    expandChatPane,
    buildSelectionMarkdownForExport,
    saveAsDialog,
  };
}

module.exports = {
  EXPORT_SCOPES,
  createExporters,
};

