'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createExporters } = require('../lib/exporters');

function exporters() {
  return createExporters({
    getAppConfig: () => ({}),
    normalizeExportFormat: (value, fallback) => value || fallback,
    DEFAULT_APP_CONFIG: {},
  });
}

test('decodeEntities decodes &amp; last so escaped entities stay literal', () => {
  const { decodeEntities } = exporters();
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
  assert.equal(decodeEntities('a &lt; b &amp;&amp; c &gt; d'), 'a < b && c > d');
});

test('stripExecutableBlocks removes real script/style and handlers only', () => {
  const { stripExecutableBlocks } = exporters();
  assert.equal(stripExecutableBlocks('<p>x</p><script>alert(1)</script><style>p{}</style>'), '<p>x</p>');
  assert.equal(stripExecutableBlocks('<a href="#" onclick="go()" title="t">x</a>'), '<a href="#" title="t">x</a>');
  const sample = '<pre><code>&lt;script&gt;init()&lt;/script&gt;</code></pre>';
  assert.equal(stripExecutableBlocks(sample), sample);
  const handler = '<pre>&lt;button onclick="go()"&gt;Go&lt;/button&gt;</pre>';
  assert.equal(stripExecutableBlocks(handler), handler);
});

test('Save Selection as Plain Text keeps escaped angle brackets', async t => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-text-export-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const win = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async () => ({
        ok: true,
        hasSelection: true,
        html: '<p>if a &lt; b and c &gt; d then x</p>',
        text: 'if a < b and c > d then x',
      }),
    },
  };
  const target = path.join(dir, 'selection.txt');
  await exporters().saveSelectionAsText(win, target);
  assert.equal(fs.readFileSync(target, 'utf8'), 'if a < b and c > d then x');
});

test('postProcessMarkdown leaves fenced code blocks byte-for-byte intact', () => {
  const { postProcessMarkdown } = exporters();
  const code = '```python\ndef a():\n    pass\n\n\ndef b():\n    x = 1\n# comment\n- item\n```';
  assert.equal(postProcessMarkdown(code), code);
  assert.equal(postProcessMarkdown(`Intro\n\n${code}\n\n\n\nOutro`), `Intro\n\n${code}\n\nOutro`);
});

test('postProcessMarkdown still tidies prose outside code fences', () => {
  const { postProcessMarkdown } = exporters();
  // Trailing spaces are dropped, but a two-space <br> hard break before another line is kept.
  assert.equal(postProcessMarkdown('one\n# Heading\n\n\n\ntwo  \nthree\n- item'), 'one\n\n# Heading\n\ntwo  \nthree\n\n- item');
  assert.equal(postProcessMarkdown('one \n# Heading\n\ntwo \nthree'), 'one\n\n# Heading\n\ntwo\nthree');
});

test('markdown tables keep an escaped pipe inside one cell', () => {
  const { postProcessMarkdown } = exporters();
  const table = postProcessMarkdown('| A | B |\n| --- | --- |\n| x \\| y | z |');
  const rows = table.split('\n');
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length, 4, row);
});
