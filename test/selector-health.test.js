'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatScrollerDiscoveryLines } = require('../lib/selector-health');

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
