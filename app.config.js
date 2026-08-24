'use strict';

const defaultAppConfig = Object.freeze({
  appUrl: 'https://m365.cloud.microsoft/chat',
  partition: String(process.env.COPILOT_PARTITION ?? 'persist:copilot-for-linux').trim(),
  enableLayoutCss: true,
  enableDirectOpen: true,
  enableQuickChat: true,
  // Drop decorative UI icons (file-type glyphs on attachment/reference chips,
  // favicons) from exports instead of inlining them as base64. A measured
  // markdown export was 34% icon data -- 104 images, all file-type glyphs, for
  // 291,180 of 853,955 chars. Real content images are unaffected. Set false to
  // restore the previous behaviour of embedding every image.
  stripDecorativeIcons: true,
  // cleanMarkdown export strips UI chrome via DOM_CLEANUP_SELECTORS: buttons,
  // copy/feedback widgets, toolbars, and the code-gutter line numbers and
  // "Show more lines" expanders that Turndown otherwise emits as standalone
  // paragraphs between every line of code. Content selectors (pre, code,
  // table, lists, images) are preserved. Set false to make cleanMarkdown
  // behave like rawMarkdown. rawMarkdown is never affected by this.
  cleanMarkdownStripsJunk: true,
  // Flatten-retry + scroller-stability. Exporting the same conversation could
  // yield a half-size file that only completed on a second export: pdfPrepare()
  // mounts rows and leaves them mounted, so the second run built on the first.
  // The markdown/HTML/text snapshot now retries the flatten/capture until the
  // captured content stops growing; both paths first wait for the live scroller
  // range to hold steady (the app finishing layout) so nothing is captured
  // mid-layout. All bounded so they can never hang.
  flattenRetryMaxPasses: 4,
  flattenRetryBudgetMs: 60000,
  scrollerStableSamples: 2,
  scrollerStablePollMs: 400,
  scrollerStableBudgetMs: 8000,
  scrollerStableBeforePdf: true,
  defaultExportFormat: 'pdf',
  defaultPaneExportProfile: 'pdf',
  defaultSelectionExportProfile: 'pdf',
  quickPasteDelayMs: 3000,
  findContentVisibilityOverride: true,
  devToolsEnabled: true,
  enableExportDiagnostics: false,
  // Conversation export diagnostic: logs per-row user/assistant classification,
  // geometry, connectivity and reasoning-control attributes at each export
  // stage. Independent of enableExportDiagnostics so it can be run on demand to
  // investigate missing assistant answers / unexpanded reasoning. Set false to
  // silence once the investigation is complete.
  enableConversationExportDiagnostic: true,
  // Expand chain-of-thought / "Reasoning completed in N steps" panels during
  // PDF export so the full reasoning is captured. Runs after the virtualizer is
  // flattened (all rows mounted). Set false to keep reasoning collapsed in the
  // export (the prior behaviour).
  // Reasoning expansion during EXPORT is now off by default: it cannot work
  // reliably from inside the export pipeline (see expandChatPane() in
  // lib/exporters.js for the measured reasons). Use View > Expand to expand the
  // conversation in the live app first, then export -- the export will print
  // whatever is already expanded on screen. Set true only to re-enable the old
  // in-export attempt.
  // Expand chain-of-thought reasoning before taking the markdown/HTML/text
  // snapshot, so those exports contain the same reasoning the PDF does. This
  // runs after hydration but before the pane is flattened -- the only point at
  // which the web app actually renders reasoning bodies. Adds roughly a second
  // per reasoning panel to those exports; set false to skip it (headlines only,
  // as before). Distinct from enableReasoningExpansion below, which governs the
  // PDF export's own post-flatten attempt.
  expandReasoningForSnapshot: true,
  enableReasoningExpansion: false,
  // Wall-clock ceiling for the whole reasoning-expansion pass, in ms.
  // Cost scales with the number of reasoning panels: a 30-panel conversation
  // exhausted the previous hard-coded 12s budget after only 10 panels, so the
  // remaining 20 were never expanded at all. Panels are processed top-to-bottom,
  // so a too-small budget silently truncates the tail of the export. Raise this
  // for very long conversations; lower it if you would rather cap export time.
  reasoningExpandBudgetMs: 60000,
  // Large-pane PDF export is rendered as stitched page-range slices so a
  // single giant printToPDF() pass cannot exhaust the renderer. Chunking
  // only engages once the estimated page count exceeds pdfChunkPageThreshold.
  enablePdfChunking: true,
  pdfChunkPageThreshold: 50,
  pdfChunkSize: 50,
  pdfChunkPageHeightPx: 1056,
  enableConsoleLogging: true,
  enableFileLogging: true,
  logFileName: 'copilot-for-linux.log',
  // Capture renderer-side console output (renderer/agent.js, preload, and the
  // hosted web app) via Electron's webContents 'console-message' event. Without
  // this, renderer console.log never reaches any file -- which is why the
  // renderer heartbeats added during the PDF export investigation never showed
  // up in the log. Written to rendererLogFileName so the noisy hosted web app
  // cannot drown out the app's own main-process log.
  enableRendererConsoleCapture: true,
  rendererLogFileName: 'copilot-for-linux-renderer.log',
  // Verbose diagnostic dumps (the multi-hundred-line [conv] detail: /
  // hydrateVirtualizer JSON blobs) are written to the log FILE but kept off the
  // console by default, because they scroll everything else off screen. Set
  // true to also print them to the terminal.
  verboseDiagnosticsToConsole: false,
});

module.exports = Object.freeze({
  appLabel: 'Copilot',
  appSlug: 'copilot',
  appName: 'copilot-for-linux',
  appUserModelId: 'your.company.copilot',
  iconFileName: 'copilot-for-linux.png',
  trayToolTip: 'Microsoft Copilot',
  partitionEnvVar: 'COPILOT_PARTITION',
  layoutObserverGlobal: '__copilot_layoutObserver',
  rendererApiGlobal: '__copilotRenderer',
  rendererAgentVersion: 1,

  dynamicWidth: Object.freeze({
    cssVar: '--copilot-vw',
    minVw: 83,
    maxVw: 100,
    defaultVw: 100,
    screenPercent: 100,
  }),

  defaultAppConfig,
});

