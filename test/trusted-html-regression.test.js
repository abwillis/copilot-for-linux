'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const agentSource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'agent.js'),
  'utf8'
);

test('export parsing keeps Trusted-Types-compatible setHTML without its default custom-element loss', () => {
  const helperStart = agentSource.indexOf('function setExportTemplateHtml(');
  const sanitizerStart = agentSource.indexOf('function sanitizeExportHtml(');

  assert.notEqual(helperStart, -1, 'shared export HTML parser helper is present');
  assert.ok(sanitizerStart > helperStart, 'parser helper runs before the project sanitizer');

  const helperSource = agentSource.slice(helperStart, sanitizerStart);
  assert.match(helperSource, /typeof template\.setHTML === 'function'/);
  assert.match(helperSource, /new Sanitizer\(\{ allowCustomElements: true \}\)/);
  assert.doesNotMatch(
    helperSource,
    /template\.setHTML\(source\s*\)/,
    'default setHTML must never receive Gemini export markup'
  );
  assert.match(
    helperSource,
    /template\.innerHTML = source/,
    'older Chromium keeps the established raw-parse fallback'
  );
});

test('sanitizeExportHtml parses first, then applies the shared allowlist sanitizer', () => {
  const sanitizerStart = agentSource.indexOf('function sanitizeExportHtml(');
  const sanitizerEnd = agentSource.indexOf('\n  // -------------------------------------------------------------------------', sanitizerStart);
  const sanitizerSource = agentSource.slice(sanitizerStart, sanitizerEnd);

  const parseCall = sanitizerSource.indexOf('setExportTemplateHtml(template, source)');
  const allowlist = sanitizerSource.indexOf('var allowed = new Set([');
  const sanitizeElement = sanitizerSource.indexOf('function sanitizeElement(');

  assert.ok(parseCall >= 0, 'captured HTML is parsed through the shared helper');
  assert.ok(allowlist > parseCall, 'the project allowlist is constructed after parsing');
  assert.ok(sanitizeElement > allowlist, 'the existing project sanitizer remains authoritative');
});
