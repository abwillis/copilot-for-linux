'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRuntimeConfig } = require('../lib/runtime-config');
const { createSettingsWindow } = require('../lib/settings-window');
const { createIPC } = require('../lib/ipc');
const defaults = require('../app-specific/app.config').defaultAppConfig;
function fixture(t, injected = fs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-recovery-'));
  const runtime = createRuntimeConfig({ app: { getPath: () => dir }, fs: injected, path,
    defaultAppConfig: { ...defaults, enableConsoleLogging: true } });
  t.after(async () => { await runtime.shutdownLogging(); fs.rmSync(dir, { recursive: true, force: true }); });
  runtime.loadAppConfig();
  return { runtime, dir, file: runtime.getConfigFilePath() };
}
test('previous valid config survives no-op save and startup', t => {
  const f = fixture(t); f.runtime.updateAppConfig({ theme: 'dark' });
  f.runtime.loadAppConfig(); f.runtime.updateAppConfig({ theme: 'dark' });
  assert.equal(f.runtime.getPreviousAppConfig().theme, 'system');
});
test('malformed JSON recovers backup and preserves exact malformed bytes', t => {
  const f = fixture(t); f.runtime.updateAppConfig({ theme: 'dark' });
  fs.writeFileSync(f.file, '{broken'); f.runtime.loadAppConfig();
  assert.equal(f.runtime.getStoredAppConfig().theme, 'system');
  assert.equal(fs.readFileSync(f.runtime.getConfigurationStatus().recovery.corruptPath, 'utf8'), '{broken');
  assert.equal(f.runtime.getConfigurationStatus().canRestore, true);
});
test('invalid primary and backup use defaults without destroying backup', t => {
  const f = fixture(t); fs.writeFileSync(f.file, 'null'); fs.writeFileSync(f.file + '.previous', '{bad');
  f.runtime.loadAppConfig(); assert.equal(f.runtime.getStoredAppConfig().theme, 'system');
  assert.equal(fs.readFileSync(f.file + '.previous', 'utf8'), '{bad');
  assert.equal(f.runtime.getConfigurationStatus().canRestore, false);
});
test('missing primary recovers backup; partial legacy config remains valid', t => {
  const f = fixture(t); f.runtime.updateAppConfig({ theme: 'dark' }); fs.unlinkSync(f.file);
  f.runtime.loadAppConfig(); assert.equal(f.runtime.getStoredAppConfig().theme, 'system');
  fs.writeFileSync(f.file, '{"theme":"light"}'); f.runtime.loadAppConfig();
  assert.equal(f.runtime.getStoredAppConfig().theme, 'light');
});
test('failed primary write leaves disk and memory intact and cleans temporary files', t => {
  let fail = false;
  const injected = { ...fs, renameSync(a, b) { if (fail && b.endsWith('config.json')) throw new Error('write failure'); return fs.renameSync(a, b); } };
  const f = fixture(t, injected); const before = fs.readFileSync(f.file, 'utf8'); fail = true;
  assert.throws(() => f.runtime.updateAppConfig({ theme: 'dark' }), /write failure/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(f.runtime.getStoredAppConfig().theme, 'system');
  assert.equal(fs.readdirSync(f.dir).some(name => name.endsWith('.tmp')), false);
});
test('failed backup write aborts primary replacement', t => {
  let fail = false;
  const injected = { ...fs, renameSync(a, b) { if (fail && b.endsWith('.previous')) throw new Error('backup failure'); return fs.renameSync(a, b); } };
  const f = fixture(t, injected); const before = fs.readFileSync(f.file, 'utf8'); fail = true;
  assert.throws(() => f.runtime.updateAppConfig({ theme: 'dark' }), /backup failure/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
function settingsFixture(t) {
  const f = fixture(t), handlers = new Map(), IPC = createIPC('test'); let win;
  class Window {
    constructor() { this.webContents = {}; win = this; }
    isDestroyed() { return false; } removeMenu() {} once() {} on() {} loadFile() { return Promise.resolve(); }
  }
  const dialog = {
    showMessageBox: async () => ({ response: 1 }),
    showSaveDialog: async () => ({ filePath: path.join(f.dir, 'export.json') }),
    showOpenDialog: async () => ({ filePaths: [path.join(f.dir, 'import.json')] }),
  };
  const settings = createSettingsWindow({ BrowserWindow: Window, ipcMain: { handle: (key, fn) => handlers.set(key, fn) },
    path, dirname: __dirname, IPC, fs, dialog, defaultAppConfig: defaults,
    getAppConfig: f.runtime.getStoredAppConfig, updateAppConfig: f.runtime.updateAppConfig,
    getConfigurationStatus: f.runtime.getConfigurationStatus, getPreviousAppConfig: f.runtime.getPreviousAppConfig });
  settings.showSettingsWindow();
  return { ...f, IPC, handlers, dialog, invoke: (channel, ...args) => handlers.get(channel)({ sender: win.webContents }, ...args) };
}
test('settings exposes exact path and defaults; untrusted senders denied', t => {
  const f = settingsFixture(t), snapshot = f.invoke(f.IPC.SETTINGS_GET);
  assert.equal(snapshot.configuration.configPath, f.file); assert.equal(snapshot.defaults.theme, 'system');
  for (const channel of [f.IPC.SETTINGS_RESTORE, f.IPC.SETTINGS_IMPORT, f.IPC.SETTINGS_EXPORT]) {
    assert.throws(() => f.handlers.get(channel)({ sender: {} }), /denied/);
  }
});
test('restore commits previous config and retains current as backup', async t => {
  const f = settingsFixture(t); f.runtime.updateAppConfig({ theme: 'dark' });
  assert.equal((await f.invoke(f.IPC.SETTINGS_RESTORE)).valid, true);
  assert.equal(f.runtime.getStoredAppConfig().theme, 'system'); assert.equal(f.runtime.getPreviousAppConfig().theme, 'dark');
});
test('export/import stages validated settings without committing', async t => {
  const f = settingsFixture(t); f.runtime.updateAppConfig({ theme: 'dark' }); await f.invoke(f.IPC.SETTINGS_EXPORT);
  const payload = JSON.parse(fs.readFileSync(path.join(f.dir, 'export.json')));
  assert.equal(payload.settings.partition, undefined); assert.equal(payload.settings.appUrl, undefined);
  f.runtime.updateAppConfig({ theme: 'light' }); fs.writeFileSync(path.join(f.dir, 'import.json'), JSON.stringify(payload));
  const result = await f.invoke(f.IPC.SETTINGS_IMPORT); assert.equal(result.valid, true); assert.equal(result.values.theme, 'dark');
  assert.equal(f.runtime.getStoredAppConfig().theme, 'light');
});
test('invalid and oversized imports rejected; export cannot overwrite config', async t => {
  const f = settingsFixture(t), file = path.join(f.dir, 'import.json');
  fs.writeFileSync(file, JSON.stringify({ format: 'wrapper-settings', version: 1, settings: { unknown: true } }));
  assert.equal((await f.invoke(f.IPC.SETTINGS_IMPORT)).valid, false);
  fs.writeFileSync(file, '{bad'); await assert.rejects(f.invoke(f.IPC.SETTINGS_IMPORT), SyntaxError);
  fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1)); await assert.rejects(f.invoke(f.IPC.SETTINGS_IMPORT), /1 MiB/);
  f.dialog.showSaveDialog = async () => ({ filePath: f.file }); await assert.rejects(f.invoke(f.IPC.SETTINGS_EXPORT), /cannot overwrite/);
});
test('section reset preserves other section edits and remains unsaved', () => {
  const vm = require('vm');
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} }; }
    replaceChildren(...items) { this.children = items; } append(...items) { this.children.push(...items); }
    addEventListener(name, fn) { this.listeners[name] = fn; } setAttribute() {} querySelectorAll() { return []; }
  }
  const elements = new Map(), fragments = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('section-template').content = { cloneNode() {
    const nodes = new Map(), fragment = { querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); } };
    fragments.push(fragment); return fragment;
  } };
  const context = vm.createContext({ document: { getElementById: get, createElement: () => new Element(), querySelectorAll: () => [] },
    window: { addEventListener() {} }, setTimeout: () => 1, clearTimeout() {} });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/settings.js'), 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('(async function init()')), context);
  vm.runInContext(`state.schema=[{id:'appearance',title:'Appearance',fields:[{key:'theme',type:'select',options:[['dark','Dark'],['system','System']]}]},
    {id:'quick',title:'Quick',fields:[{key:'quickPasteDelayMs',type:'number'}]}];
    state.values={theme:'dark',quickPasteDelayMs:1234};state.baseline={theme:'dark',quickPasteDelayMs:3000};
    state.defaults={theme:'system',quickPasteDelayMs:3000};render();`, context);
  fragments[0].querySelector('.section-heading').children[0].listeners.click();
  assert.equal(vm.runInContext('state.values.theme', context), 'system');
  assert.equal(vm.runInContext('state.values.quickPasteDelayMs', context), 1234);
  assert.equal(vm.runInContext('state.baseline.theme', context), 'dark'); assert.equal(vm.runInContext('isDirty()', context), true);
});
