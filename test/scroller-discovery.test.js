'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  deepClone,
} = require('../test-support/dom-agent-harness');

const SCROLLER_CONTRACT = {
  version: 1,
  thresholds: { read: 55, interact: 70, destructive: 85 },
  negativeRegionSelectors: [],
  capabilities: {
    chatRoot: {
      selectors: ['[data-chat-root]'],
      semanticSelectors: ['[role="feed"]'],
      repeatedDescendants: ['article'],
      stableAttributeHints: [],
    },
    messageRow: {
      selectors: ['article'],
      semanticSelectors: ['article'],
      stableAttributeHints: [],
    },
    composer: {
      selectors: [],
      semanticSelectors: [],
      stableAttributeHints: [],
    },
    disclosureControl: {
      selectors: [],
      semanticSelectors: [],
      stableAttributeHints: [],
    },
    virtualizer: {
      selectors: ['[data-virtualizer]'],
      stableAttributeHints: [],
    },
  },
};

function scrollerAgentConfig({ virtualizerSelectors = ['[data-virtualizer]'] } = {}) {
  const contract = deepClone(SCROLLER_CONTRACT);
  contract.capabilities.virtualizer.selectors = virtualizerSelectors.slice();
  return {
    chatRootSelectors: contract.capabilities.chatRoot.selectors.slice(),
    virtualizerSelectors: virtualizerSelectors.slice(),
    chatInputSelectors: [],
    scoreRules: [],
    collectionSelectors: ['article'],
    collectionKeyAttributes: ['id'],
    collectionRowSelectors: ['article'],
    collectionExcludeSelectors: [],
    domAdapterContract: contract,
  };
}

function useHarness(t, fixture, options = {}) {
  const harness = createHarness(fixture, options);
  t.after(() => harness.dispose());
  return harness;
}

function trackDocumentSelectors(document) {
  const originalQuerySelectorAll = document.querySelectorAll.bind(document);
  const selectors = [];
  document.querySelectorAll = selector => {
    selectors.push(String(selector));
    return originalQuerySelectorAll(selector);
  };
  return selectors;
}

function qualifiedScrollerFixture(rootId = 'conversation-a', scrollerId = 'virtualizer-a') {
  return {
    body: {
      children: [{
        tag: 'div',
        attrs: {
          id: scrollerId,
          'data-virtualizer': '1',
          'data-overflow-y': 'auto',
        },
        scroll: { scrollHeight: 2200, clientHeight: 500 },
        children: [{
          tag: 'div',
          attrs: { id: rootId, role: 'feed', 'data-chat-root': '1' },
          children: [
            { tag: 'article', attrs: { id: `${rootId}-m1` }, text: 'One' },
            { tag: 'article', attrs: { id: `${rootId}-m2` }, text: 'Two' },
          ],
        }],
      }],
    },
  };
}

test('qualified scroller candidates bypass the generic document scan and remain cached across mutations', async t => {
  const harness = useHarness(t, qualifiedScrollerFixture(), { config: scrollerAgentConfig() });
  const { api, document } = harness;
  const selectors = trackDocumentSelectors(document);

  const first = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.equal(first.ok, true);
  assert.equal(first.scrollerFound, true);
  assert.match(first.scrollerLabel, /#virtualizer-a/);
  assert.equal(selectors.includes('body *'), false);

  let health = api.getDomAdapterHealth();
  assert.equal(health.scrollerDiscovery.genericScanCount, 0);
  assert.ok(health.scrollerDiscovery.qualifiedCandidateHits >= 1);
  assert.equal(health.scrollerDiscovery.fullDocumentFallbackNeeded, false);
  assert.equal(health.scrollerDiscovery.selectionSource, 'qualified-rescan');
  assert.equal(health.scrollerDiscovery.cacheState, 'cached');

  document.body.appendChild(harness.createElement({
    tag: 'span',
    attrs: { id: 'unrelated-mutation' },
    text: 'Unrelated mutation',
  }));
  await harness.settle();
  selectors.length = 0;

  const second = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.match(second.scrollerLabel, /#virtualizer-a/);
  assert.equal(selectors.includes('body *'), false);
  health = api.getDomAdapterHealth();
  assert.ok(health.scrollerDiscovery.cacheHits >= 1);
  assert.equal(health.scrollerDiscovery.genericScanCount, 0);
});

test('cached scroller invalidates when the selected chat root changes', async t => {
  const harness = useHarness(t, qualifiedScrollerFixture(), { config: scrollerAgentConfig() });
  const { api, document } = harness;

  const first = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.match(first.scrollerLabel, /#virtualizer-a/);

  document.getElementById('virtualizer-a').remove();
  document.body.appendChild(harness.createElement(
    qualifiedScrollerFixture('conversation-b', 'virtualizer-b').body.children[0]
  ));
  await harness.settle();

  const second = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.equal(second.ok, true);
  assert.match(second.scrollerLabel, /#virtualizer-b/);
});

test('cached scroller invalidates when it disconnects while the chat root remains', async t => {
  const fixture = {
    body: {
      children: [{
        tag: 'div',
        attrs: { id: 'stable-root', role: 'feed', 'data-chat-root': '1' },
        children: [{
          tag: 'div',
          attrs: {
            id: 'inner-virtualizer-a',
            'data-virtualizer': '1',
            'data-overflow-y': 'auto',
          },
          scroll: { scrollHeight: 1800, clientHeight: 400 },
          children: [{ tag: 'article', attrs: { id: 'message-a' }, text: 'One' }],
        }],
      }],
    },
  };
  const harness = useHarness(t, fixture, { config: scrollerAgentConfig() });
  const { api, document } = harness;

  const first = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.match(first.scrollerLabel, /#inner-virtualizer-a/);

  document.getElementById('inner-virtualizer-a').remove();
  document.getElementById('stable-root').appendChild(harness.createElement({
    tag: 'div',
    attrs: {
      id: 'inner-virtualizer-b',
      'data-virtualizer': '1',
      'data-overflow-y': 'auto',
    },
    scroll: { scrollHeight: 1900, clientHeight: 400 },
    children: [{ tag: 'article', attrs: { id: 'message-b' }, text: 'Two' }],
  }));
  await harness.settle();

  const second = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.equal(second.ok, true);
  assert.match(second.scrollerLabel, /#inner-virtualizer-b/);
});

test('generic document scan remains an observable final fallback', t => {
  const fixture = {
    body: {
      children: [
        {
          tag: 'div',
          attrs: { id: 'fallback-root', role: 'feed', 'data-chat-root': '1' },
          children: [{ tag: 'article', attrs: { id: 'fallback-message' }, text: 'One' }],
        },
        {
          tag: 'div',
          attrs: { id: 'generic-only-scroller', 'data-overflow-y': 'auto' },
          scroll: { scrollHeight: 1600, clientHeight: 300 },
        },
      ],
    },
  };
  const harness = useHarness(t, fixture, {
    config: scrollerAgentConfig({ virtualizerSelectors: [] }),
  });
  const { api, document } = harness;
  const selectors = trackDocumentSelectors(document);

  const measurement = api.measureChatScroller({ fallbackSelector: '[data-chat-root]' });
  assert.equal(measurement.ok, true);
  assert.equal(measurement.scrollerFound, true);
  assert.match(measurement.scrollerLabel, /#generic-only-scroller/);
  assert.equal(selectors.includes('body *'), true);

  const health = api.getDomAdapterHealth();
  assert.equal(health.scrollerDiscovery.genericScanCount, 1);
  assert.equal(health.scrollerDiscovery.fullDocumentFallbackNeeded, true);
  assert.equal(health.scrollerDiscovery.selectionSource, 'full-document-rescan');
  assert.equal(health.scrollerDiscovery.cacheState, 'cached');
});
