'use strict';

// Presentation layer for export progress.
//
// ExportJob accumulates numeric metrics from the capture driver, the
// canonical store, the per-turn transform loop, and the PDF shard renderer.
// This module turns those metrics into short, stable overlay lines. It is
// pure and has no Electron or DOM dependency, so the exact wording is unit
// tested in Node and the renderer agent only has to paint the lines.
//
// Metric keys (all optional; absent keys are simply not shown):
//   capturedTurns, expectedTurns          canonical store
//   pass ('capture' | 'verify' | 'stream'), passIndex,
//   verificationPass, maxVerificationPasses,
//   backtracks, continuityBreaks, scrollPercent, step
//                                         capture traversal
//   serializedTurns, totalTurns           transform loop
//   assetsProcessed, assetsEmbedded, assetsFailed
//                                         image materialization
//   pdfShard, pdfShards, renderedPages    PDF sharding and rendering

const PHASE_LABELS = Object.freeze({
  locate: 'Locating conversation',
  hydrate: 'Preparing rows',
  expand: 'Preparing content',
  capture: 'Capturing conversation',
  validate: 'Validating capture',
  transform: 'Converting turns',
  render: 'Rendering',
  write: 'Writing file',
  complete: 'Complete',
  cancelled: 'Cancelled',
  failed: 'Failed',
});

const CANCEL_HEADLINE = 'Cancelling \u2014 finishing current turn\u2026';
const CANCEL_FOOTER = 'Temporary files will be removed.';
const ACTIVE_FOOTER = 'Press Esc to cancel';
const BAR_WIDTH = 20;

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function has(value) {
  return count(value) !== null;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
  return `${minutes}:${ss}`;
}

function formatBar(fraction) {
  const value = Number(fraction);
  if (!Number.isFinite(value)) return '';
  const bounded = Math.max(0, Math.min(1, value));
  const filled = Math.round(bounded * BAR_WIDTH);
  return `${'\u2588'.repeat(filled)}${'\u2591'.repeat(BAR_WIDTH - filled)} ${Math.round(bounded * 100)}%`;
}

function plural(n, singular, pluralForm) {
  return `${n} ${n === 1 ? singular : (pluralForm || `${singular}s`)}`;
}

function captureLines(m) {
  const lines = [];
  if (has(m.capturedTurns)) {
    const captured = count(m.capturedTurns);
    const expected = count(m.expectedTurns);
    lines.push(expected
      ? `Turns: ${captured} captured of ${expected} expected`
      : `Turns: ${captured} captured (total not reported by page)`);
  }
  if (m.pass === 'verify') {
    const n = count(m.verificationPass) || 1;
    const max = count(m.maxVerificationPasses);
    lines.push(`Pass: verification ${n}${max ? ` of up to ${max}` : ''}`);
  } else if (m.pass === 'capture') {
    lines.push('Pass: initial capture');
  }
  const details = [];
  if (has(m.scrollPercent) && m.pass !== 'stream') details.push(`Position ${count(m.scrollPercent)}%`);
  if (has(m.backtracks)) details.push(plural(count(m.backtracks), 'backtrack'));
  if (count(m.continuityBreaks)) details.push(plural(count(m.continuityBreaks), 'continuity break'));
  if (details.length) lines.push(details.join(' \u00b7 '));
  return lines;
}

function transformLines(m) {
  const lines = [];
  if (has(m.serializedTurns) && has(m.totalTurns)) {
    lines.push(`Converted: ${count(m.serializedTurns)} of ${count(m.totalTurns)} turns`);
  }
  if (has(m.assetsProcessed)) {
    const parts = [];
    if (has(m.assetsEmbedded)) parts.push(`${count(m.assetsEmbedded)} saved`);
    if (count(m.assetsFailed)) parts.push(`${count(m.assetsFailed)} failed`);
    lines.push(`Images: ${count(m.assetsProcessed)} processed${parts.length ? ` (${parts.join(', ')})` : ''}`);
  }
  if (has(m.pdfShard)) lines.push(`PDF section: ${count(m.pdfShard)} being assembled`);
  return lines;
}

function renderLines(m) {
  const lines = [];
  if (has(m.pdfShard) && has(m.pdfShards)) {
    const pages = has(m.renderedPages) ? ` \u00b7 ${plural(count(m.renderedPages), 'page')}` : '';
    lines.push(`PDF section: ${count(m.pdfShard)} of ${count(m.pdfShards)}${pages}`);
  }
  return lines;
}

function progressFraction(phase, m) {
  if (phase === 'capture') {
    // Turn counts are authoritative when the page reports a total; scroll
    // position is only a proxy because the virtualizer re-measures rows.
    if (m.pass === 'capture' && count(m.expectedTurns) && has(m.capturedTurns)) {
      return count(m.capturedTurns) / count(m.expectedTurns);
    }
    if (has(m.scrollPercent)) return count(m.scrollPercent) / 100;
    return null;
  }
  if (phase === 'transform' && count(m.totalTurns)) return count(m.serializedTurns) / count(m.totalTurns);
  if (phase === 'render' && count(m.pdfShards)) return (count(m.pdfShard) || 0) / count(m.pdfShards);
  return null;
}

// Returns the complete overlay model. `lines` is what the renderer paints, in
// order. `cancelling` and the headline/footer are exposed separately so a
// renderer that learns about cancellation first (Escape pressed in the page)
// can switch to the cancelling presentation before the main process replies.
function buildExportProgressView(payload = {}) {
  const phase = String(payload.phase || 'export');
  const m = payload.metrics && typeof payload.metrics === 'object' ? payload.metrics : {};
  const cancelling = payload.cancelling === true;
  const phaseIndex = count(payload.phaseIndex);
  const phaseCount = count(payload.phaseCount);
  const label = PHASE_LABELS[phase] || phase;
  const message = String(payload.message || label);

  const details = [];
  const step = phaseIndex !== null && phaseCount ? `Step ${phaseIndex + 1} of ${phaseCount}: ${label}` : label;
  details.push(`${step} \u00b7 ${formatDuration(payload.elapsedMs)} elapsed`);

  if (phase === 'capture' || phase === 'locate' || phase === 'hydrate' || phase === 'expand') {
    details.push(...captureLines(m));
  } else if (phase === 'validate') {
    if (has(m.capturedTurns)) details.push(`Turns: ${count(m.capturedTurns)} captured`);
  } else if (phase === 'transform') {
    details.push(...transformLines(m));
  } else if (phase === 'render') {
    details.push(...renderLines(m));
    if (has(m.assetsProcessed)) details.push(...transformLines({ assetsProcessed: m.assetsProcessed, assetsEmbedded: m.assetsEmbedded, assetsFailed: m.assetsFailed }));
  } else if (phase === 'write') {
    if (has(m.totalTurns)) details.push(`Turns: ${count(m.totalTurns)}`);
  }

  const fraction = progressFraction(phase, m);
  if (fraction !== null && !cancelling) details.push(formatBar(fraction));

  const headline = cancelling ? CANCEL_HEADLINE : message;
  const footer = cancelling ? CANCEL_FOOTER : ACTIVE_FOOTER;
  const lines = cancelling ? [headline, message, ...details, footer] : [headline, ...details, footer];
  return {
    cancelling,
    headline,
    message,
    details,
    footer,
    lines,
    fraction,
    cancelHeadline: CANCEL_HEADLINE,
    cancelFooter: CANCEL_FOOTER,
  };
}

module.exports = {
  PHASE_LABELS,
  CANCEL_HEADLINE,
  CANCEL_FOOTER,
  ACTIVE_FOOTER,
  formatDuration,
  formatBar,
  buildExportProgressView,
};
