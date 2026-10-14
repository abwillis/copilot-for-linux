'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const appConfig = require('../app-specific/app.config');
const { SETTINGS_SCHEMA } = require('../lib/settings-schema');
const { createExporters } = require('../lib/exporters');

function exporters(config = {}) {
  return createExporters({
    getAppConfig: () => config,
    normalizeExportFormat: (value, fallback) => value || fallback,
    DEFAULT_APP_CONFIG: {},
  });
}

function schemaKeys() {
  return SETTINGS_SCHEMA.flatMap(section => section.fields.map(field => field.key));
}

test('npm is not a runtime dependency', () => {
  assert.equal(Object.hasOwn(pkg.dependencies || {}, 'npm'), false);
});

test('packaged files exclude the test suite but keep what main.bootstrap.js requires', () => {
  const files = pkg.build.files;
  assert.equal(files.includes('test/**'), false);
  assert.equal(files.includes('test-support/**'), false);
  const bootstrap = fs.readFileSync(path.join(root, 'main.bootstrap.js'), 'utf8');
  const required = [...bootstrap.matchAll(/require\('\.\/(test\/[^']+)'\)/g)]
    .map(match => (match[1].endsWith('.js') ? match[1] : `${match[1]}.js`));
  assert.ok(required.length > 0, 'bootstrap still loads the packaged smoke harness');
  for (const file of required) {
    assert.equal(files.includes(file), true, `${file} is required at runtime but not packaged`);
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} does not exist`);
  }
});

test('appId and appUserModelId are real, identical, and not placeholders', () => {
  const appId = pkg.build.appId;
  assert.equal(appConfig.appUserModelId, appId);
  assert.doesNotMatch(appId, /company|your\.|example/i);
  assert.match(appId, /^[A-Za-z0-9][A-Za-z0-9.-]*$/);
});

test('global shortcuts are opt-in by default', () => {
  assert.equal(appConfig.defaultAppConfig.globalShortcutsEnabled, false);
});

test('dead settings are gone: defaultExportFormat and dynamicWidth.screenPercent', () => {
  assert.equal(Object.hasOwn(appConfig.defaultAppConfig, 'defaultExportFormat'), false);
  assert.equal(schemaKeys().includes('defaultExportFormat'), false);
  assert.equal(Object.hasOwn(appConfig.dynamicWidth, 'screenPercent'), false);
  const layoutSource = fs.readFileSync(path.join(root, 'app-specific', 'layout-css.js'), 'utf8');
  assert.equal(layoutSource.includes('dynamicWidth.screenPercent'), false);
});

test('exportHtmlRemoveRemoteResources remains a real, defaulted setting', () => {
  assert.equal(schemaKeys().includes('exportHtmlRemoveRemoteResources'), true);
  assert.equal(typeof appConfig.defaultAppConfig.exportHtmlRemoveRemoteResources, 'boolean');
});

test('self-contained HTML archive honours exportHtmlRemoveRemoteResources', () => {
  const html = '<img src="https://cdn.test/a.png" alt="a"><img src="data:image/png;base64,AAAA" alt="b">'
    + '<img srcset=\'https://cdn.test/a.png 1x\' alt="c">';
  const stripped = '<img alt="a"><img src="data:image/png;base64,AAAA" alt="b"><img alt="c">';

  const remove = exporters({ exportHtmlRemoveRemoteResources: true }).finalizeUnresolvedRemoteImageSources;
  assert.equal(remove(html, { profileKey: 'htmlArchive', hadFailures: false }), stripped);

  const keep = exporters({ exportHtmlRemoveRemoteResources: false }).finalizeUnresolvedRemoteImageSources;
  assert.equal(keep(html, { profileKey: 'htmlArchive', hadFailures: true }), html);
});

test('other profiles keep the previous failure-only behaviour regardless of the setting', () => {
  const html = '<img src="https://cdn.test/a.png" alt="a">';
  for (const setting of [true, false]) {
    const { finalizeUnresolvedRemoteImageSources: finalize } = exporters({ exportHtmlRemoveRemoteResources: setting });
    for (const profileKey of ['pdf', 'cleanMarkdown']) {
      assert.equal(finalize(html, { profileKey, hadFailures: false }), html);
      assert.equal(finalize(html, { profileKey, hadFailures: true }), '<img alt="a">');
    }
  }
});

test('<br> hard breaks survive Markdown cleanup', () => {
  const { postProcessMarkdown } = exporters();
  assert.equal(postProcessMarkdown('line one  \nline two'), 'line one  \nline two');
  assert.equal(postProcessMarkdown('a  \nb  \nc'), 'a  \nb  \nc');
});

test('trailing spaces that are not a hard break are still removed', () => {
  const { postProcessMarkdown } = exporters();
  assert.equal(postProcessMarkdown('tail \nnext'), 'tail\nnext');
  assert.equal(postProcessMarkdown('end of paragraph  \n\nnext'), 'end of paragraph\n\nnext');
  assert.equal(postProcessMarkdown('last line  '), 'last line');
  assert.equal(postProcessMarkdown('tab\t\nnext'), 'tab\nnext');
});

test('hard breaks outside fences do not alter fenced code', () => {
  const { postProcessMarkdown } = exporters();
  const code = '```\nkeep  \nthis\n```';
  assert.equal(postProcessMarkdown(`a  \nb\n\n${code}`), `a  \nb\n\n${code}`);
});
