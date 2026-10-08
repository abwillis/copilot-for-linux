'use strict';

function missingFingerprintCount(expected = [], actual = []) {
  const remaining = new Map();
  for (const value of actual || []) {
    const key = String(value || '');
    if (!key) continue;
    remaining.set(key, Number(remaining.get(key) || 0) + 1);
  }
  let missing = 0;
  for (const value of expected || []) {
    const key = String(value || '');
    if (!key) continue;
    const count = Number(remaining.get(key) || 0);
    if (count > 0) remaining.set(key, count - 1);
    else missing++;
  }
  return missing;
}

function logicalAnchors(metrics = {}) {
  return Array.isArray(metrics.logicalAnchors)
    ? metrics.logicalAnchors.map(value => String(value || ''))
    : [];
}

function evaluateSnapshotCompleteness(before = {}, after = {}, budget = {}, options = {}) {
  const warnings = [];
  const beforeCount = Number(before.logicalTurnCount || 0);
  const afterCount = Number(after.logicalTurnCount || 0);
  const bottomGap = Number(after.bottomCoverageGap || before.bottomCoverageGap || 0);
  const gapLimit = Number(options.bottomCoverageGapPx || 1200);
  if (afterCount <= 0) warnings.push('No logical conversation turns were captured.');
  if (beforeCount > 0 && afterCount < beforeCount) warnings.push(`Captured ${afterCount} of ${beforeCount} logical turns.`);
  const expectedFingerprints = Array.isArray(before.messageFingerprints) ? before.messageFingerprints : [];
  const actualFingerprints = Array.isArray(after.messageFingerprints) ? after.messageFingerprints : [];
  const expectedLogicalAnchors = logicalAnchors(before);
  const actualLogicalAnchors = logicalAnchors(after);
  const expectedLogicalAnchorCount = expectedLogicalAnchors.filter(Boolean).length;
  const actualLogicalAnchorCount = actualLogicalAnchors.filter(Boolean).length;
  const useLogicalAnchors = expectedLogicalAnchorCount > 0 &&
    expectedLogicalAnchorCount === expectedLogicalAnchors.length &&
    actualLogicalAnchorCount === actualLogicalAnchors.length;
  const missingLogicalAnchors = useLogicalAnchors
    ? missingFingerprintCount(expectedLogicalAnchors, actualLogicalAnchors)
    : 0;
  const missingFingerprints = useLogicalAnchors
    ? 0
    : missingFingerprintCount(expectedFingerprints, actualFingerprints);
  if (missingLogicalAnchors > 0) warnings.push(`${missingLogicalAnchors} live logical turn anchor(s) are missing from the static capture.`);
  if (missingFingerprints > 0) warnings.push(`${missingFingerprints} live logical turn fingerprint(s) are missing from the static capture.`);
  if (useLogicalAnchors) {
    if (before.firstRowLogicalAnchor && after.firstRowLogicalAnchor && before.firstRowLogicalAnchor !== after.firstRowLogicalAnchor) warnings.push('The first captured logical anchor does not match the live conversation.');
    if (before.lastRowLogicalAnchor && after.lastRowLogicalAnchor && before.lastRowLogicalAnchor !== after.lastRowLogicalAnchor) warnings.push('The last captured logical anchor does not match the live conversation.');
  } else {
    if (before.firstRowFingerprint && after.firstRowFingerprint && before.firstRowFingerprint !== after.firstRowFingerprint) warnings.push('The first captured row does not match the live conversation.');
    if (before.lastRowFingerprint && after.lastRowFingerprint && before.lastRowFingerprint !== after.lastRowFingerprint) warnings.push('The last captured row does not match the live conversation.');
  }
  if (after.monotonicRowOrdering === false) warnings.push('Captured rows are not in monotonic order.');
  if (bottomGap > gapLimit) warnings.push(`Bottom coverage gap is ${bottomGap}px.`);
  const emptyAssistantBodyCount = Math.max(Number(before.emptyAssistantBodyCount || 0), Number(after.emptyAssistantBodyCount || 0));
  if (emptyAssistantBodyCount > 0) warnings.push(`${emptyAssistantBodyCount} assistant message body/bodies are empty.`);
  const missingImageCount = Number(after.missingImageCount || 0);
  if (missingImageCount > 0) warnings.push(`${missingImageCount} image(s) could not be materialized.`);
  const budgetReached = budget.timeBudgetReached === true || budget.passBudgetReached === true || budget.reasoningBudgetReached === true;
  if (budgetReached) warnings.push('A capture time or pass budget was reached.');
  return {
    logicalTurnsBefore: beforeCount,
    logicalTurnsAfter: afterCount,
    firstRowFingerprint: after.firstRowFingerprint || '',
    lastRowFingerprint: after.lastRowFingerprint || '',
    firstRowLogicalAnchor: after.firstRowLogicalAnchor || actualLogicalAnchors[0] || '',
    lastRowLogicalAnchor: after.lastRowLogicalAnchor || actualLogicalAnchors[actualLogicalAnchors.length - 1] || '',
    logicalAnchors: actualLogicalAnchors,
    monotonicRowOrdering: after.monotonicRowOrdering !== false,
    bottomCoverageGap: bottomGap,
    emptyAssistantBodyCount,
    missingImageCount,
    missingFingerprintCount: missingFingerprints,
    missingLogicalAnchorCount: missingLogicalAnchors,
    fingerprintCoveragePct: expectedFingerprints.length
      ? Math.round(((expectedFingerprints.length - missingFingerprints) / expectedFingerprints.length) * 100)
      : (afterCount > 0 ? 100 : 0),
    logicalAnchorCoveragePct: expectedLogicalAnchorCount
      ? Math.round(((expectedLogicalAnchorCount - missingLogicalAnchors) / expectedLogicalAnchorCount) * 100)
      : 0,
    timeOrPassBudgetReached: budgetReached,
    lowConfidence: warnings.length > 0,
    warnings,
  };
}

function parseColor(value) {
  const raw = String(value || '').trim().toLowerCase();
  const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const body = hex[1].length === 3
      ? hex[1].split('').map(ch => ch + ch).join('')
      : hex[1];
    return [0, 2, 4].map(index => parseInt(body.slice(index, index + 2), 16));
  }
  const rgb = raw.match(/^rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/i);
  if (rgb) return rgb.slice(1, 4).map(component => Math.max(0, Math.min(255, Number(component))));
  return null;
}

function luminance(value) {
  const rgb = parseColor(value);
  if (!rgb) return null;
  const linear = rgb.map(component => {
    const channel = component / 255;
    return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function colorContrast(foreground, background) {
  const a = luminance(foreground);
  const b = luminance(background);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function resolveExportPaperPalette(theme = {}, mode = 'match') {
  const selected = ['match', 'light', 'dark', 'monochrome'].includes(String(mode))
    ? String(mode)
    : 'match';
  if (selected === 'light') {
    return { mode: selected, foreground: '#111827', background: '#ffffff', muted: '#4b5563', border: '#d1d5db', code: '#f3f4f6', link: '#0645ad', colorScheme: 'light' };
  }
  if (selected === 'dark') {
    return { mode: selected, foreground: '#f3f4f6', background: '#1f1f1f', muted: '#d1d5db', border: '#6b7280', code: '#292929', link: '#8ab4f8', colorScheme: 'dark' };
  }
  if (selected === 'monochrome') {
    return { mode: selected, foreground: '#000000', background: '#ffffff', muted: '#333333', border: '#777777', code: '#ffffff', link: '#000000', colorScheme: 'light' };
  }
  const dark = theme.prefersDark === true || /dark/i.test(String(theme.colorScheme || ''));
  let background = String(theme.background || (dark ? '#1f1f1f' : '#ffffff'));
  let foreground = String(theme.foreground || (dark ? '#f3f4f6' : '#111827'));
  const contrast = colorContrast(foreground, background);
  if (contrast !== null && contrast < 3) {
    background = dark ? '#1f1f1f' : '#ffffff';
    foreground = dark ? '#f3f4f6' : '#111827';
  }
  return {
    mode: selected,
    foreground,
    background,
    muted: dark ? '#d1d5db' : '#4b5563',
    border: dark ? '#6b7280' : '#d1d5db',
    code: dark ? '#292929' : '#f3f4f6',
    link: dark ? '#8ab4f8' : '#0645ad',
    colorScheme: dark ? 'dark' : 'light',
  };
}

module.exports = {
  missingFingerprintCount,
  evaluateSnapshotCompleteness,
  resolveExportPaperPalette,
};
