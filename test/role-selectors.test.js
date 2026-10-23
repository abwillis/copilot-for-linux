'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { chatDom, createHarness } = require('../test-support/dom-agent-harness');

// --- Contract: every app's chat-dom.js describes its own roles ---------------

test('chat-dom declares disjoint role selectors drawn from its collection selectors', () => {
  const roles = chatDom.DOM_ROLE_SELECTORS;
  assert.ok(roles && Array.isArray(roles.user) && Array.isArray(roles.assistant));
  assert.ok(roles.user.length > 0, 'user selectors');
  assert.ok(roles.assistant.length > 0, 'assistant selectors');
  for (const selector of [...roles.user, ...roles.assistant]) {
    assert.equal(typeof selector, 'string');
    assert.ok(chatDom.DOM_COLLECTION_SELECTORS.includes(selector), `${selector} is not a collection selector`);
  }
  const user = new Set(roles.user);
  assert.deepEqual(roles.assistant.filter(selector => user.has(selector)), []);
});

test('chat-dom answer label settings have the shape the agent expects', () => {
  assert.equal(typeof chatDom.ANSWER_MARKER, 'string');
  assert.ok(Array.isArray(chatDom.ANSWER_LEADING_LABELS));
  chatDom.ANSWER_LEADING_LABELS.forEach(label => assert.equal(typeof label, 'string'));
});

// --- Agent: role detection and the answer marker come from configuration ----

const COLLECTION = [
  '[data-testid*="human-message" i]',
  '[data-testid*="bot-message" i]',
  '[id^="copilot-message-"]',
];

function conversation() {
  const row = (id, testid, text) => ({ tag: 'div', attrs: { id, 'data-testid': testid }, text });
  return {
    body: {
      children: [{
        tag: 'div',
        attrs: { id: 'log', role: 'log' },
        children: [
          row('r1', 'human-message-1', 'A question'),
          row('r2', 'bot-message-1', 'Bot says:'),
          row('r3', 'bot-message-2', 'Bot says: A complete answer'),
          row('r4', 'bot-message-3', 'x'),
          { tag: 'div', attrs: { id: 'copilot-message-9' }, text: 'y' },
        ],
      }],
    },
  };
}

function config(extra) {
  return {
    chatRootSelectors: ['#log'],
    collectionSelectors: COLLECTION,
    collectionRowSelectors: ['#log > div'],
    ...extra,
  };
}

function emptyAssistantBodies(t, extra) {
  const harness = createHarness(conversation(), { config: config(extra) });
  t.after(() => harness.dispose());
  return harness.api.captureExportCompleteness({ fallbackSelector: '#log' }).emptyAssistantBodyCount;
}

test('configured role selectors decide which rows are assistant turns', t => {
  const count = emptyAssistantBodies(t, {
    roleSelectors: { user: ['[data-testid*="human-message" i]'], assistant: ['[data-testid*="bot-message" i]'] },
    answerMarker: 'Bot says:',
  });
  // r2 holds only the marker and r4 is a one-character body; r3 has a real
  // body. The copilot-named row is not an assistant row for this app.
  assert.equal(count, 2);
});

test('an app without an answer marker never has one searched for', t => {
  const count = emptyAssistantBodies(t, {
    roleSelectors: { user: ['[data-testid*="human-message" i]'], assistant: ['[data-testid*="bot-message" i]'] },
    answerMarker: '',
  });
  // "Bot says:" is ordinary text here, so only the one-character row counts.
  assert.equal(count, 1);
});

test('without role selectors the fallback keywords contain no app name', t => {
  const count = emptyAssistantBodies(t, {});
  // Neither "bot-message" nor "copilot-message-" contains a neutral keyword.
  assert.equal(count, 0);
});
