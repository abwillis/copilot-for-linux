'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { createRendererAgentInstaller } = require('../lib/renderer-agent-installer');

class FakeExecutor extends EventEmitter {
  constructor() {
    super();
    this.sources = [];
    this.destroyed = false;
  }
  isDestroyed() { return this.destroyed; }
  async executeJavaScript(source) {
    this.sources.push(source);
    return null;
  }
}

test('boot source puts configured global and version before the agent source', () => {
  const installer = createRendererAgentInstaller({
    fs: { readFileSync: () => '(function(){ window.agentSaw = window.__APP_RENDERER_AGENT_CONFIG__; })();' },
    agentPath: '/fixture/agent.js',
    rendererApiGlobal: '__configuredRenderer',
    rendererAgentVersion: 17,
    agentConfig: { chatRootSelectors: ['#chat'] },
  });
  const source = installer.getBootSource();
  assert.ok(source.indexOf('__APP_RENDERER_AGENT_CONFIG__') < source.indexOf('window.agentSaw'));
  assert.match(source, /__configuredRenderer/);
  assert.match(source, /rendererAgentVersion[^\n]*17/);
  assert.match(source, /chatRootSelectors/);
});

test('installer executes for top-level and frame dom-ready events and detaches on destruction', async () => {
  const webContents = new FakeExecutor();
  webContents.mainFrame = {};
  const frame = new FakeExecutor();
  const installer = createRendererAgentInstaller({
    fs: { readFileSync: () => 'window.fixtureAgent = true;' },
    agentPath: '/fixture/agent.js',
  });
  installer.install(webContents);

  webContents.emit('dom-ready');
  webContents.emit('frame-created', {}, { frame });
  frame.emit('dom-ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(webContents.sources.length, 1);
  assert.equal(frame.sources.length, 1);

  webContents.destroyed = true;
  webContents.emit('destroyed');
  webContents.emit('dom-ready');
  frame.emit('dom-ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(webContents.sources.length, 1);
  assert.equal(frame.sources.length, 1);
});
