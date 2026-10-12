'use strict';

const CAPABILITY_LABELS = Object.freeze({
  chatRoot: 'Chat root',
  messageRow: 'Message row',
  composer: 'Composer',
  disclosureControl: 'Disclosure control',
  virtualizer: 'Virtualizer',
});

const VALID_STATUSES = new Set(['Healthy', 'Fallback', 'Low confidence', 'Missing']);

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

function safeText(value, fallback = 'unknown') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function statusForCapability(capability = {}) {
  if (VALID_STATUSES.has(capability.status)) return capability.status;
  const confidence = Number(capability.confidence || 0);
  const threshold = Number(capability.confidenceThreshold || 0);
  if (!capability.found && confidence <= 0) return 'Missing';
  if (confidence < threshold) return 'Low confidence';
  return capability.fallback ? 'Fallback' : 'Healthy';
}

function formatCapabilityLine(name, capability = {}) {
  const label = CAPABILITY_LABELS[name] || safeText(name, 'Capability');
  const confidence = Number(capability.confidence || 0);
  const threshold = Number(capability.confidenceThreshold || 0);
  const level = safeText(capability.requiredLevel, 'read');
  const tier = safeText(capability.selectedTier || capability.tier, 'none');
  return `${label}: ${statusForCapability(capability)} | tier ${tier} | ` +
    `confidence ${confidence}/${threshold} (${level})`;
}

function buildSelectorHealthReport(options = {}) {
  const health = options.health && typeof options.health === 'object' ? options.health : {};
  const capabilities = health.capabilities && typeof health.capabilities === 'object'
    ? health.capabilities
    : {};
  const completeness = health.exportCompleteness && typeof health.exportCompleteness === 'object'
    ? health.exportCompleteness
    : {};
  const discovery = health.scrollerDiscovery && typeof health.scrollerDiscovery === 'object'
    ? health.scrollerDiscovery
    : {};
  const diagnosticSession = options.diagnosticSession && typeof options.diagnosticSession === 'object'
    ? options.diagnosticSession
    : {};
  const capabilityLines = Object.keys(CAPABILITY_LABELS).map(name =>
    formatCapabilityLine(name, capabilities[name])
  );
  const fullDocumentFallbackNeeded = discovery.fullDocumentFallbackNeeded === true ||
    (discovery.fullDocumentFallbackNeeded === undefined && nonNegativeInteger(discovery.genericScanCount) > 0);
  const cacheState = safeText(discovery.cacheState, 'unknown');
  const selectionSource = safeText(discovery.selectionSource, 'unknown');
  const frameCount = Math.max(0, nonNegativeInteger(options.frameCount));
  const respondingFrameCount = Math.max(0, nonNegativeInteger(options.respondingFrameCount));
  const stableRows = nonNegativeInteger(completeness.stableRowIdentifiers);
  const rowCount = nonNegativeInteger(health.messageRowCount);
  const diagnosticState = diagnosticSession.active
    ? `active until ${safeText(diagnosticSession.endsAt)}`
    : 'inactive';

  return [
    'Selector Health diagnostic report',
    '',
    `Application: ${safeText(options.appLabel, 'Application')} ${safeText(options.appVersion)}`,
    `Renderer agent: ${safeText(options.rendererAgentVersion ?? health.adapterVersion)}`,
    `URL origin: ${safeText(options.urlOrigin || health.urlOrigin)}`,
    `Frames: ${frameCount} total, ${respondingFrameCount} agent response(s)`,
    `Selected frame: ${safeText(options.selectedFrame, 'none')}`,
    'Conversation text: excluded',
    `Temporary diagnostic session: ${diagnosticState}`,
    'Temporary diagnostics require explicit opt-in and may include conversation previews and renderer logs.',
    '',
    'Capabilities',
    ...capabilityLines,
    '',
    'Selection',
    `Selected root: ${safeText(health.selectedRoot, 'not found')}`,
    `Selected tier: ${safeText(health.activeFallbackTier, 'none')}`,
    `Message rows: ${rowCount}`,
    '',
    'Scroller discovery',
    `Full-document fallback scan: ${fullDocumentFallbackNeeded ? 'needed' : 'not needed'}`,
    `Cached vs rescanned: ${cacheState}`,
    `Selection source: ${selectionSource}`,
    ...formatScrollerDiscoveryLines(discovery),
    '',
    'Export readiness',
    `Read: ${completeness.readReady ? 'ready' : 'blocked'}`,
    `Destructive: ${completeness.destructiveReady ? 'ready' : 'blocked'}`,
    `Row order: ${completeness.orderedRows ? 'verified' : 'not verified'}`,
    `Stable row identifiers: ${stableRows}/${rowCount} ` +
      `(${nonNegativeInteger(completeness.stableRowIdentifierCoveragePct)}%)`,
    `Scroll owner: ${completeness.scrollerFound
      ? `found (range ${nonNegativeInteger(completeness.scrollerRange)})`
      : 'not found'}`,
    `Warnings: ${(Array.isArray(completeness.warnings) && completeness.warnings.length)
      ? completeness.warnings.join(', ')
      : 'none'}`,
    `Contract version: ${nonNegativeInteger(health.contractVersion)}`,
  ].join('\n');
}

module.exports = {
  buildSelectorHealthReport,
  formatCapabilityLine,
  formatScrollerDiscoveryLines,
  statusForCapability,
};
