'use strict';

const defaultAppConfig = Object.freeze({
  appUrl: 'https://m365.cloud.microsoft/chat',
  partition: String(process.env.COPILOT_PARTITION ?? 'persist:copilot-for-linux').trim(),
  enableLayoutCss: true,
  layoutWidthVw: 100,
  theme: 'system',
  enableDirectOpen: true,
  directOpenBehavior: 'shift-click',
  enableQuickChat: true,
  quickChatCloseBehavior: 'hide',
  spellcheckEnabled: false,
  spellcheckLanguages: ['en-US'],
  permissionNotifications: 'ask',
  permissionMedia: 'ask',
  permissionGeolocation: 'deny',
  permissionClipboardRead: 'ask',
  launchAtLogin: false,
  startMinimized: false,
  showTrayIcon: true,
  globalShortcutsEnabled: false,
  globalShortcutShowMain: 'Ctrl+Alt+1',
  globalShortcutNewQuickChat: 'Ctrl+Alt+N',
  globalShortcutShowQuickChat: 'Ctrl+Alt+2',
  // Drop decorative UI icons (file-type glyphs on attachment/reference chips,
  // favicons) from exports instead of inlining them as base64. A measured
  // markdown export was 34% icon data -- 104 images, all file-type glyphs, for
  // 291,180 of 853,955 chars. Real content images are unaffected. Set false to
  // restore the previous behaviour of embedding every image.
  stripDecorativeIcons: true,
  // cleanMarkdown export evaluates likely UI chrome with a cleanup predicate.
  // Selector matches only generate candidates; controls are removed or
  // unwrapped only after interactive and content-preservation checks. Anchors,
  // citations, attachments, code, tables, lists, and media are preserved. Set
  // false to make cleanMarkdown behave like rawMarkdown. rawMarkdown is never
  // affected by this.
  cleanMarkdownStripsJunk: true,
  // Conversation capture (export engine v2, lib/conversation-capture.js).
  // The main process walks the virtualized conversation top to bottom and
  // persists each logical turn to a temporary disk store. A step is accepted
  // only when it shares a turn with the previous step (otherwise the step is
  // halved and retried), so no turn can be skipped regardless of how the
  // virtualizer re-measures rows. A verification pass re-walks the
  // conversation unless the page exposes a complete ordinal sequence.
  exportCaptureSettleMs: 80,             // settle time after each scroll step
  exportCaptureStepFraction: 0.7,        // step size as a fraction of the viewport
  exportCaptureMinStepPx: 40,            // smallest step tried before accepting a break
  exportCaptureTerminalSamples: 3,       // stable samples required at top/bottom
  exportCaptureVerificationPasses: 2,    // maximum verification passes
  exportCaptureStuckLimit: 6,            // non-advancing steps before giving up
  exportCaptureMaxSteps: 50000,
  exportCaptureBudgetMs: 1800000,        // 30 minutes; raise for extremely long conversations
  // Large row HTML is streamed through bounded IPC chunks into the disk store.
  // No complete long-conversation snapshot crosses the renderer/main boundary.
  exportCaptureIpcChunkBytes: 524288,
  exportCaptureCallTimeoutMs: 30000,
  defaultExportFormat: 'pdf',
  defaultPaneExportProfile: 'pdf',
  defaultSelectionExportProfile: 'pdf',
  // Paper treatment for generated HTML/PDF. "match" captures the live
  // conversation's computed foreground/background colors when the export job
  // starts; the other modes deliberately override them.
  exportPaperMode: 'match',
  // Self-contained HTML drops any remote resource that could not be
  // materialized. Linked HTML keeps safe http(s) image references and carries
  // a CSP that still disables scripts, frames, forms, and plugins.
  exportHtmlRemoveRemoteResources: true,
  exportIncludeCaptureMetadata: true,
  quickPasteDelayMs: 3000,
  findContentVisibilityOverride: true,
  devToolsEnabled: true,
  enableExportDiagnostics: false,
  // Numeric-only export health metrics are safe to emit during normal use.
  // Per-row text previews, labels, attributes, and reasoning-control details are
  // available only while a temporary diagnostic session is active.
  enableExportHealthMetrics: true,
  enableConversationExportDiagnostic: false,
  diagnosticSessionDurationMinutes: 15,
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
  // Canonical PDF output is split into static HTML shards before Chromium
  // lays it out. pageRanges alone do not bound whole-document layout memory.
  pdfShardMaxTurns: 24,
  pdfShardMaxHtmlBytes: 6291456,
  pdfShardRenderTimeoutMs: 120000,
  // Bound remote image fetches and the cross-turn data-URI cache.
  exportAssetFetchTimeoutMs: 20000,
  exportAssetMaxBytes: 26214400,
  exportAssetCacheMaxBytes: 16777216,
  enableConsoleLogging: true,
  enableFileLogging: false,
  logFileName: 'copilot-for-linux.log',
  // File writes are buffered and asynchronous. The active file plus four
  // numbered archives are retained; rotation occurs at either limit.
  logFlushIntervalMs: 250,
  logBufferMaxBytes: 65536,
  logMaxBytes: 5242880,
  logMaxAgeDays: 7,
  logMaxFiles: 5,
  // Capture renderer-side console output (renderer/agent.js, preload, and the
  // hosted web app) via Electron's webContents 'console-message' event. Without
  // this, renderer console.log never reaches any file -- which is why the
  // renderer heartbeats added during the PDF export investigation never showed
  // up in the log. Written to rendererLogFileName so the noisy hosted web app
  // cannot drown out the app's own main-process log.
  enableRendererConsoleCapture: false,
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
  rendererAgentVersion: 6,

  dynamicWidth: Object.freeze({
    cssVar: '--copilot-vw',
    minVw: 83,
    maxVw: 100,
    defaultVw: 100,
    screenPercent: 100,
  }),

  defaultAppConfig,
});

