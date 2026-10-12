'use strict';

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatScrollerDiscoveryLines(scrollerDiscovery = {}) {
  const discovery = scrollerDiscovery && typeof scrollerDiscovery === 'object'
    ? scrollerDiscovery
    : {};
  const cacheHits = nonNegativeInteger(discovery.cacheHits);
  const cacheMisses = nonNegativeInteger(discovery.cacheMisses);
  const qualifiedCandidateHits = nonNegativeInteger(discovery.qualifiedCandidateHits);
  const genericScanCount = nonNegativeInteger(discovery.genericScanCount);
  const cachedMutationGeneration = nonNegativeInteger(discovery.cachedMutationGeneration);

  return [
    `Scroller cache: ${countLabel(cacheHits, 'hit', 'hits')}, ` +
      countLabel(cacheMisses, 'miss', 'misses'),
    `Qualified scroller candidates: ${qualifiedCandidateHits}`,
    'Generic document scan fallback: ' + (genericScanCount > 0
      ? `required ${countLabel(genericScanCount, 'time', 'times')}`
      : 'not required'),
    `Cached mutation generation: ${cachedMutationGeneration}`,
  ];
}

module.exports = {
  formatScrollerDiscoveryLines,
};
