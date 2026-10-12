'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSelectorHealthReport,
  formatCapabilityLine,
  formatScrollerDiscoveryLines,
  statusForCapability,
} = require('../lib/selector-health');

test('Selector Health reports when the generic document scan was unnecessary', () => {
  assert.deepEqual(
    formatScrollerDiscoveryLines({
      cacheHits: 7,
      cacheMisses: 1,
      qualifiedCandidateHits: 1,
      genericScanCount: 0,
      cachedMutationGeneration: 12,
    }),
    [
      'Scroller cache: 7 hits, 1 miss',
      'Qualified scroller candidates: 1',
      'Generic document scan fallback: not required',
      'Cached mutation generation: 12',
    ]
  );
});

test('Selector Health reports each required generic document scan', () => {
  assert.deepEqual(
    formatScrollerDiscoveryLines({ genericScanCount: 3 }),
    [
      'Scroller cache: 0 hits, 0 misses',
      'Qualified scroller candidates: 0',
      'Generic document scan fallback: required 3 times',
      'Cached mutation generation: 0',
    ]
  );
});

test('Selector Health formats the four actionable capability states', () => {
  assert.equal(statusForCapability({ status: 'Healthy' }), 'Healthy');
  assert.equal(statusForCapability({ status: 'Fallback' }), 'Fallback');
  assert.equal(statusForCapability({ found: true, confidence: 40, confidenceThreshold: 55 }), 'Low confidence');
  assert.equal(statusForCapability({ found: false, confidence: 0, confidenceThreshold: 55 }), 'Missing');
  assert.equal(
    formatCapabilityLine('composer', {
      status: 'Fallback',
      confidence: 78,
      confidenceThreshold: 70,
      requiredLevel: 'interact',
      selectedTier: 'semantic-structural',
    }),
    'Composer: Fallback | tier semantic-structural | confidence 78/70 (interact)'
  );
});

test('diagnostic report is actionable and excludes conversation text', () => {
  const report = buildSelectorHealthReport({
    appLabel: 'Fixture App',
    appVersion: '1.2.3',
    rendererAgentVersion: 6,
    urlOrigin: 'https://example.test',
    frameCount: 3,
    respondingFrameCount: 2,
    selectedFrame: 'frame:42',
    diagnosticSession: { active: false },
    health: {
      selectedRoot: 'main#conversation',
      activeFallbackTier: 'semantic-structural',
      messageRowCount: 2,
      contractVersion: 1,
      capabilities: {
        chatRoot: { status: 'Healthy', confidence: 90, confidenceThreshold: 55, requiredLevel: 'read', selectedTier: 'structural-stable' },
        messageRow: { status: 'Healthy', confidence: 80, confidenceThreshold: 55, requiredLevel: 'read', selectedTier: 'structural-stable' },
        composer: { status: 'Fallback', confidence: 75, confidenceThreshold: 70, requiredLevel: 'interact', selectedTier: 'semantic-structural' },
        disclosureControl: { status: 'Low confidence', confidence: 60, confidenceThreshold: 70, requiredLevel: 'interact', selectedTier: 'structural' },
        virtualizer: { status: 'Missing', confidence: 0, confidenceThreshold: 70, requiredLevel: 'interact', selectedTier: 'none' },
      },
      scrollerDiscovery: {
        cacheState: 'cached',
        selectionSource: 'full-document-rescan',
        fullDocumentFallbackNeeded: true,
      },
      exportCompleteness: {
        readReady: true,
        destructiveReady: false,
        orderedRows: true,
        stableRowIdentifiers: 2,
        stableRowIdentifierCoveragePct: 100,
        scrollerFound: true,
        scrollerRange: 1200,
        warnings: [],
      },
    },
  });

  assert.match(report, /Application: Fixture App 1\.2\.3/);
  assert.match(report, /Renderer agent: 6/);
  assert.match(report, /URL origin: https:\/\/example\.test/);
  assert.match(report, /Frames: 3 total, 2 agent response\(s\)/);
  assert.match(report, /Composer: Fallback \| tier semantic-structural \| confidence 75\/70 \(interact\)/);
  assert.match(report, /Full-document fallback scan: needed/);
  assert.match(report, /Cached vs rescanned: cached/);
  assert.match(report, /Conversation text: excluded/);
  assert.doesNotMatch(report, /secret conversation payload/);
});
