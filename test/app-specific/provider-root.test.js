'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  chatDom,
  createHarness,
  defaultAgentConfig,
} = require('../../test-support/dom-agent-harness');

// This app's provider-shaped DOM. It lives beside the test, not under the
// shared test/fixtures/ tree, because each app's fixture mirrors its own
// selectors and so differs between the apps.
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'provider-root.json'), 'utf8')
);

test('provider adapter selects its expected root from a realistic provider fixture', t => {
  const harness = createHarness(fixture, { config: defaultAgentConfig() });
  t.after(() => harness.dispose());

  const hit = harness.api.findCapability('chatRoot');

  assert.equal(hit.ok, true);
  assert.equal(hit.element.id, fixture.expectedRootId);
  assert.ok(hit.confidence >= chatDom.DOM_ADAPTER_CONTRACT.thresholds.read);
  assert.match(hit.evidence.join('\n'), /repeated message descendants/);
});
