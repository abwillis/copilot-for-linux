'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  evaluateSnapshotCompleteness,
  resolveExportPaperPalette,
} = require('../lib/export-validation');

test('completeness gate requires every known live-turn fingerprint', () => {
  const result = evaluateSnapshotCompleteness(
    {
      logicalTurnCount: 2,
      firstRowFingerprint: 'a',
      lastRowFingerprint: 'b',
      messageFingerprints: ['a', 'b'],
    },
    {
      logicalTurnCount: 1,
      firstRowFingerprint: 'a',
      lastRowFingerprint: 'a',
      messageFingerprints: ['a'],
      monotonicRowOrdering: true,
    },
    {},
    { bottomCoverageGapPx: 1200 }
  );

  assert.equal(result.lowConfidence, true);
  assert.equal(result.logicalTurnsBefore, 2);
  assert.equal(result.logicalTurnsAfter, 1);
  assert.equal(result.missingFingerprintCount, 1);
  assert.equal(result.fingerprintCoveragePct, 50);
  assert.match(result.warnings.join('\n'), /Captured 1 of 2 logical turns/);
  assert.match(result.warnings.join('\n'), /fingerprint/);
});

test('completeness gate accepts an ordered exact static capture', () => {
  const result = evaluateSnapshotCompleteness(
    {
      logicalTurnCount: 2,
      firstRowFingerprint: 'a',
      lastRowFingerprint: 'b',
      messageFingerprints: ['a', 'b'],
      bottomCoverageGap: 0,
    },
    {
      logicalTurnCount: 2,
      firstRowFingerprint: 'a',
      lastRowFingerprint: 'b',
      messageFingerprints: ['a', 'b'],
      monotonicRowOrdering: true,
      bottomCoverageGap: 0,
      missingImageCount: 0,
    },
    {},
    { bottomCoverageGapPx: 1200 }
  );

  assert.equal(result.lowConfidence, false);
  assert.equal(result.missingFingerprintCount, 0);
  assert.equal(result.fingerprintCoveragePct, 100);
  assert.deepEqual(result.warnings, []);
});

test('completeness gate uses stable logical anchors when expanded content changes fingerprints', () => {
  const result = evaluateSnapshotCompleteness(
    {
      logicalTurnCount: 2,
      firstRowFingerprint: 'before-a',
      lastRowFingerprint: 'before-b',
      messageFingerprints: ['before-a', 'before-b'],
      firstRowLogicalAnchor: 'source:message:a',
      lastRowLogicalAnchor: 'source:message:b',
      logicalAnchors: ['source:message:a', 'source:message:b'],
    },
    {
      logicalTurnCount: 2,
      firstRowFingerprint: 'expanded-a',
      lastRowFingerprint: 'expanded-b',
      messageFingerprints: ['expanded-a', 'expanded-b'],
      firstRowLogicalAnchor: 'source:message:a',
      lastRowLogicalAnchor: 'source:message:b',
      logicalAnchors: ['source:message:a', 'source:message:b'],
      monotonicRowOrdering: true,
    }
  );

  assert.equal(result.lowConfidence, false);
  assert.equal(result.missingFingerprintCount, 0);
  assert.equal(result.missingLogicalAnchorCount, 0);
  assert.equal(result.logicalAnchorCoveragePct, 100);
  assert.deepEqual(result.warnings, []);
});

test('completeness gate rejects a missing logical anchor even when content fingerprints match', () => {
  const result = evaluateSnapshotCompleteness(
    {
      logicalTurnCount: 2,
      messageFingerprints: ['same', 'same'],
      logicalAnchors: ['source:message:a', 'source:message:b'],
    },
    {
      logicalTurnCount: 2,
      messageFingerprints: ['same', 'same'],
      logicalAnchors: ['source:message:a', 'source:message:c'],
      monotonicRowOrdering: true,
    }
  );

  assert.equal(result.lowConfidence, true);
  assert.equal(result.missingLogicalAnchorCount, 1);
  assert.equal(result.logicalAnchorCoveragePct, 50);
  assert.match(result.warnings.join('\n'), /logical turn anchor/);
});

test('completeness gate rejects an empty capture even without a live baseline', () => {
  const result = evaluateSnapshotCompleteness({}, {}, {}, { bottomCoverageGapPx: 1200 });
  assert.equal(result.lowConfidence, true);
  assert.match(result.warnings.join('\n'), /No logical conversation turns/);
});

test('match-paper palette repairs light-on-light transparent-root fallback', () => {
  const palette = resolveExportPaperPalette({
    foreground: 'rgb(243, 244, 246)',
    background: '#ffffff',
    prefersDark: true,
    colorScheme: 'dark',
  }, 'match');

  assert.equal(palette.foreground, '#f3f4f6');
  assert.equal(palette.background, '#1f1f1f');
  assert.equal(palette.colorScheme, 'dark');
});
