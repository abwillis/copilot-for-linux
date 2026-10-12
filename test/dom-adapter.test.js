'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  chatDom,
  createHarness,
  deepClone,
  defaultAgentConfig,
  loadFixture,
} = require('../test-support/dom-agent-harness');

const SHARED_CONTRACT = {
  version: 1,
  thresholds: { read: 55, interact: 70, destructive: 85 },
  negativeRegionSelectors: [
    'nav', 'header', 'aside', '[role="navigation"]', '[role="toolbar"]',
    '[role="dialog"]', '[role="search"]', '[role="menu"]',
  ],
  capabilities: {
    chatRoot: {
      selectors: ['[data-chat-root]'],
      semanticSelectors: ['[role="feed"]', '[role="log"]', 'main', '[role="main"]'],
      repeatedDescendants: ['article'],
      stableAttributeHints: [],
    },
    messageRow: {
      selectors: ['article'],
      semanticSelectors: ['article', '[role="article"]', '[aria-posinset]'],
      stableAttributeHints: ['message', 'turn', 'response', 'request'],
    },
    composer: {
      selectors: ['textarea', '[contenteditable="true"]', 'div[role="textbox"]'],
      semanticSelectors: ['textarea', '[contenteditable="true"]', '[role="textbox"]'],
      stableAttributeHints: ['composer'],
    },
    disclosureControl: {
      selectors: ['button[aria-expanded]', '[role="button"][aria-expanded]', 'summary'],
      semanticSelectors: ['button[aria-expanded]', '[role="button"][aria-expanded]', 'summary'],
      stableAttributeHints: ['expand', 'collapse', 'disclosure'],
    },
    virtualizer: { selectors: [], stableAttributeHints: [] },
  },
};

function sharedAgentConfig(contract = SHARED_CONTRACT) {
  const cloned = deepClone(contract);
  const capabilities = cloned.capabilities || {};
  return {
    chatRootSelectors: (capabilities.chatRoot && capabilities.chatRoot.selectors) || [],
    virtualizerSelectors: (capabilities.virtualizer && capabilities.virtualizer.selectors) || [],
    chatInputSelectors: (capabilities.composer && capabilities.composer.selectors) || [],
    scoreRules: [],
    collectionSelectors: ['article'],
    collectionKeyAttributes: ['data-message-id', 'data-testid', 'id', 'aria-label'],
    collectionRowSelectors: ['article'],
    collectionExcludeSelectors: [],
    domAdapterContract: cloned,
  };
}

function useHarness(t, fixture, options = {}) {
  const harness = createHarness(fixture, options);
  t.after(() => harness.dispose());
  return harness;
}

function negativeRegionFixture(region) {
  const candidateRegion = deepClone(region);
  candidateRegion.children = [
    {
      tag: 'textarea',
      attrs: { id: 'composer-decoy', 'aria-label': 'Not the chat composer' },
    },
  ];
  return {
    body: {
      children: [
        {
          tag: 'div',
          attrs: { id: 'app-shell' },
          children: [
            {
              tag: 'div',
              attrs: { id: 'conversation', role: 'feed', 'data-chat-root': 'candidate' },
              children: [
                { tag: 'article', attrs: { 'aria-posinset': '1', 'data-message-id': 'm1' }, text: 'One' },
                { tag: 'article', attrs: { 'aria-posinset': '2', 'data-message-id': 'm2' }, text: 'Two' },
              ],
            },
            candidateRegion,
          ],
        },
      ],
    },
  };
}

test('shared contract scores two plausible roots and chooses the stronger conversation', t => {
  const { api } = useHarness(t, 'two-roots.json', { config: sharedAgentConfig() });

  const hit = api.findCapability('chatRoot');

  assert.equal(hit.ok, true);
  assert.equal(hit.element.id, 'conversation-feed');
  assert.ok(hit.confidence >= SHARED_CONTRACT.thresholds.read);
  assert.match(hit.evidence.join('\n'), /5 repeated message descendants/);

  const located = api.locateChatRoot({ includeHtml: false });
  assert.equal(located.ok, true);
  assert.equal(located.confidence, hit.confidence);
});

test('all root consumers report the capability scorer winner', async t => {
  const contract = deepClone(SHARED_CONTRACT);
  contract.thresholds.destructive = 70;
  const { api, document } = useHarness(t, 'two-roots.json', {
    config: sharedAgentConfig(contract),
  });

  const authoritative = api.findCapability('chatRoot');
  const compatibility = api.pickBest();
  const located = api.locateChatRoot({ includeHtml: false });
  const selected = api.locateChatRoot({ includeHtml: false, selectContent: true });
  const exported = api.locateChatRoot({ includeHtml: false, markForExport: true });
  const find = api.enableFindContentVisibility();
  const health = api.getDomAdapterHealth();
  const composer = await api.waitForChatInputReady({ timeoutMs: 5 });

  assert.equal(authoritative.element.id, 'conversation-feed');
  assert.equal(compatibility.el, authoritative.element);
  assert.equal(compatibility.score, authoritative.confidence);
  assert.equal(document.querySelector('[data-pdf-export-target="1"]').id, 'conversation-feed');
  assert.equal(document.querySelector('[data-app-find-root="1"]').id, 'conversation-feed');
  assert.equal(composer.ready, true);
  assert.deepEqual(
    new Set([
      compatibility.rootIdentity,
      located.rootIdentity,
      selected.rootIdentity,
      exported.rootIdentity,
      find.rootIdentity,
      health.rootIdentity,
      health.selectedRoot,
      composer.rootIdentity,
    ]),
    new Set(['div#conversation-feed'])
  );
});

test('provider adapter selects its expected root from a realistic provider fixture', t => {
  const fixture = loadFixture('provider-root.json');
  const { api } = useHarness(t, fixture, { config: defaultAgentConfig() });

  const hit = api.findCapability('chatRoot');

  assert.equal(hit.ok, true);
  assert.equal(hit.element.id, fixture.expectedRootId);
  assert.ok(hit.confidence >= chatDom.DOM_ADAPTER_CONTRACT.thresholds.read);
  assert.match(hit.evidence.join('\n'), /repeated message descendants/);
});

test('a search textbox and chat composer can coexist without selecting search', t => {
  const { api } = useHarness(t, 'composer-and-search.json', { config: sharedAgentConfig() });
  const root = api.findCapability('chatRoot');

  const composer = api.findCapability('composer', { root: root.element, verifyBehavior: true });

  assert.equal(composer.ok, true);
  assert.equal(composer.element.id, 'composer-editor');
  assert.ok(composer.confidence >= SHARED_CONTRACT.thresholds.interact);
  assert.doesNotMatch(composer.warnings.join('\n'), /negative region/);
});

test('composer tracking moves markers when SPA navigation replaces the composer', async t => {
  const harness = useHarness(t, 'composer-tracking.json', { config: sharedAgentConfig() });
  const { api, document, fixture } = harness;

  const started = api.startComposerTracking({ throttleMs: 1 });
  assert.equal(started.ok, true);
  assert.equal(document.getElementById('route-a-form').getAttribute('data-expanded-composer'), '1');
  assert.equal(document.getElementById('route-a-composer').getAttribute('data-expanded-composer'), '1');

  const oldRoute = document.getElementById('route-a-composer');
  const appShell = document.getElementById('app-shell');
  oldRoute.remove();
  appShell.appendChild(harness.createElement(fixture.replacement));
  await harness.settle(10);

  assert.equal(document.getElementById('composer-b').isConnected, true);
  assert.equal(document.getElementById('route-b-form').getAttribute('data-expanded-composer'), '1');
  assert.equal(document.getElementById('route-b-composer').getAttribute('data-expanded-composer'), '1');
  assert.equal(oldRoute.getAttribute('data-expanded-composer'), null);
});

test('typing mutations keep the composer fast path and avoid repeated document rescans', async t => {
  const harness = useHarness(t, 'composer-tracking.json', { config: sharedAgentConfig() });
  const { api, document } = harness;

  const started = api.startComposerTracking({ throttleMs: 1 });
  assert.equal(started.ok, true);
  document.resetQuerySelectorAllCalls();

  const editor = document.getElementById('composer-a');
  editor.textContent = 'Typing should not rediscover the entire document';
  await harness.settle(10);

  assert.equal(editor.isConnected, true);
  assert.equal(document.querySelectorAllCalls, 0, 'connected-editor mutations must not trigger capability rescans');
  assert.equal(document.getElementById('route-a-form').getAttribute('data-expanded-composer'), '1');
});

test('low-confidence root candidates are rejected before read or export operations', t => {
  const { api, document } = useHarness(t, 'low-confidence.json', { config: sharedAgentConfig() });

  const candidate = api.findCapability('chatRoot');
  assert.equal(candidate.ok, true);
  assert.ok(candidate.confidence < SHARED_CONTRACT.thresholds.read);

  const readAttempt = api.locateChatRoot({ includeHtml: false });
  assert.deepEqual(
    {
      ok: readAttempt.ok,
      reason: readAttempt.reason,
      operationLevel: readAttempt.operationLevel,
      requiredConfidence: readAttempt.requiredConfidence,
    },
    {
      ok: false,
      reason: 'low-confidence-chat-root',
      operationLevel: 'read',
      requiredConfidence: SHARED_CONTRACT.thresholds.read,
    }
  );

  const exportAttempt = api.locateChatRoot({ includeHtml: false, markForExport: true });
  assert.equal(exportAttempt.ok, false);
  assert.equal(exportAttempt.operationLevel, 'destructive');
  assert.equal(exportAttempt.requiredConfidence, SHARED_CONTRACT.thresholds.destructive);
  assert.equal(document.querySelector('[data-pdf-export-target="1"]'), null);
});

test('navigation, dialogs, menus, and toolbars suppress composer candidates', async t => {
  const fixture = loadFixture('negative-regions.json');

  for (const fixtureCase of fixture.cases) {
    await t.test(fixtureCase.name, async t => {
      const { api } = useHarness(t, negativeRegionFixture(fixtureCase.region), { config: sharedAgentConfig() });
      const root = api.findCapability('chatRoot');
      const composer = api.findCapability('composer', { root: root.element, verifyBehavior: true });

      assert.equal(composer.ok, true);
      assert.ok(
        composer.confidence < SHARED_CONTRACT.thresholds.read,
        `${fixtureCase.name} candidate unexpectedly scored ${composer.confidence}`
      );
      assert.match(composer.warnings.join('\n'), /inside negative region/);

      const ready = await api.waitForChatInputReady({ timeoutMs: 2 });
      assert.deepEqual(
        { ok: ready.ok, ready: ready.ready, timeout: ready.timeout },
        { ok: true, ready: false, timeout: true }
      );
    });
  }
});

test('semantic-only chat root and composer fallbacks survive app fingerprint loss', t => {
  const semanticContract = deepClone(SHARED_CONTRACT);
  semanticContract.capabilities.chatRoot.selectors = [];
  semanticContract.capabilities.composer.selectors = [];
  const config = sharedAgentConfig(semanticContract);
  config.chatInputSelectors = ['textarea', '[contenteditable="true"]', '[role="textbox"]'];
  const { api } = useHarness(t, 'semantic-fallback.json', { config });

  const root = api.findCapability('chatRoot');
  assert.equal(root.ok, true);
  assert.equal(root.element.getAttribute('role'), 'log');
  assert.ok(root.confidence >= semanticContract.thresholds.read);
  assert.equal(root.tier, 'semantic-structural');
  assert.doesNotMatch(root.evidence.join('\n'), /configured selector evidence/);

  const composer = api.findCapability('composer', { root: root.element, verifyBehavior: true });
  assert.equal(composer.ok, true);
  assert.equal(composer.element.getAttribute('aria-label'), 'Send a message');
  assert.ok(composer.confidence >= semanticContract.thresholds.interact);
  assert.doesNotMatch(composer.evidence.join('\n'), /configured selector evidence/);
});

test('one element discovered through duplicate selector tiers is scored once', t => {
  const duplicateContract = deepClone(SHARED_CONTRACT);
  duplicateContract.negativeRegionSelectors = [];
  duplicateContract.capabilities.chatRoot = {
    selectors: ['main', '#chat-root', '[role="main"]', 'main'],
    semanticSelectors: ['main', '[role="main"]', 'main'],
    repeatedDescendants: ['article', '[aria-posinset]'],
    stableAttributeHints: ['chat-root'],
  };
  const harness = useHarness(t, 'duplicate-tiers.json', { config: sharedAgentConfig(duplicateContract) });
  const duplicateHit = harness.api.findCapability('chatRoot');

  const simpleContract = deepClone(duplicateContract);
  simpleContract.capabilities.chatRoot.selectors = ['main'];
  simpleContract.capabilities.chatRoot.semanticSelectors = ['main'];
  simpleContract.capabilities.chatRoot.repeatedDescendants = ['article'];
  harness.api.init(sharedAgentConfig(simpleContract));
  const simpleHit = harness.api.findCapability('chatRoot');

  assert.equal(duplicateHit.element, simpleHit.element);
  assert.equal(duplicateHit.confidence, simpleHit.confidence);
  assert.equal(duplicateHit.evidence.filter(item => item === 'configured selector evidence').length, 1);
  assert.equal(new Set(duplicateHit.evidence).size, duplicateHit.evidence.length);
});

test('selector health remains structured when no root or composer is found', t => {
  const { api } = useHarness(t, 'empty-shell.json', { config: sharedAgentConfig() });

  const health = api.getDomAdapterHealth();

  assert.equal(health.ok, true);
  assert.equal(health.selectedRoot, null);
  assert.equal(health.selectedRootConfidence, 0);
  assert.equal(health.activeFallbackTier, 'none');
  assert.deepEqual(
    {
      rootFound: health.capabilities.chatRoot.found,
      rootConfidence: health.capabilities.chatRoot.confidence,
      rootWarnings: Array.from(health.capabilities.chatRoot.warnings),
      composerFound: health.capabilities.composer.found,
      composerConfidence: health.capabilities.composer.confidence,
      composerWarnings: Array.from(health.capabilities.composer.warnings),
    },
    {
      rootFound: false,
      rootConfidence: 0,
      rootWarnings: ['no candidates'],
      composerFound: false,
      composerConfidence: 0,
      composerWarnings: ['no candidates'],
    }
  );
  assert.equal(health.messageRowCount, 0);
  assert.equal(health.exportCompleteness.readReady, false);
  assert.equal(health.exportCompleteness.destructiveReady, false);
});
