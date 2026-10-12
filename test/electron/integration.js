'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const { createRendererAgentInstaller } = require('../../lib/renderer-agent-installer');
const { injectCSSOnLoad } = require('../../app-specific/layout-css');
const { createIPC } = require('../../lib/ipc');
const { createSettingsWindow } = require('../../lib/settings-window');
const { ExportJob, ExportCancelledError } = require('../../lib/export-job');
const { bindExportJobToWindow } = require('../../lib/window-job-lifecycle');
const { createCanonicalConversationStore } = require('../../lib/canonical-conversation');
const { captureConversation } = require('../../lib/conversation-capture');
const { callRendererMethodInFrame } = require('../../lib/renderer-api');
const { replaceFileFromTemporary } = require('../../lib/atomic-file');
const appConfig = require('../../app-specific/app.config');
const appSlug = appConfig.appSlug;
const appLabel = appConfig.appLabel;
const hostApiName = `${appSlug}Host`;

const repoRoot = path.join(__dirname, '..', '..');
const windows = new Set();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 8000);
  const intervalMs = Number(options.intervalMs || 25);
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(options.message || `Condition was not met within ${timeoutMs}ms.`);
}

function trackWindow(win) {
  windows.add(win);
  win.once('closed', () => windows.delete(win));
  return win;
}

function fixtureDocument(url) {
  const route = url.pathname;
  const revision = url.searchParams.get('rev') || '1';
  if (route === '/frame') {
    return `<!doctype html><html><body data-frame-revision="${revision}">
      <div id="frame-value">frame-${revision}</div>
      <script>
        window.__rpcFixture = {
          echo(value) { return { ok: true, value, revision: ${JSON.stringify(revision)} }; },
          slow(delayMs) { return new Promise(resolve => setTimeout(() => resolve({ ok: true, revision: ${JSON.stringify(revision)} }), delayMs)); }
        };
      </script>
    </body></html>`;
  }

  return `<!doctype html><html><head><meta charset="utf-8"></head>
    <body data-page="${route}" data-revision="${revision}">
      <main id="fixture">fixture-${revision}</main>
      <section id="conversation"><article data-message-id="one">one</article></section>
      ${route === '/with-frame' ? `<iframe id="same-origin-frame" src="/frame?rev=${revision}"></iframe>` : ''}
      <script>
        window.captureCancelled = false;
        window.fixtureCaptureBatch = async function(payload) {
          await new Promise(resolve => setTimeout(resolve, 80));
          if (window.captureCancelled) return { ok: false, cancelled: true, reason: 'cancelled' };
          return {
            ok: true,
            refs: [{ key: 'one', fingerprint: 'one:fp', ordinal: 1, setSize: 1 }],
            records: payload && payload.observeOnly ? [] : [{
              key: 'one', fingerprint: 'one:fp', ordinal: 1, setSize: 1,
              html: '<article>one</article>', htmlLength: 22, textLength: 3
            }],
            atTop: true,
            atBottom: true,
            range: 0,
            scrollTop: 0,
            clientHeight: 600
          };
        };
      </script>
    </body></html>`;
}

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const body = fixtureDocument(url);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function createFixtureWindow(installer, url, webPreferences = {}) {
  const win = trackWindow(new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      ...webPreferences,
    },
  }));
  if (installer) installer.install(win.webContents);
  await win.loadURL(url);
  return win;
}

async function destroyAllWindows() {
  for (const win of [...windows]) {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {}
  }
  windows.clear();
  await delay(50);
}

async function runCase(name, testFunction) {
  const started = Date.now();
  try {
    await Promise.race([
      testFunction(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out: ${name}`)), 20000)),
    ]);
    console.log(`ok - ${name} (${Date.now() - started}ms)`);
    return { name, ok: true, elapsedMs: Date.now() - started };
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error?.stack || error);
    return { name, ok: false, elapsedMs: Date.now() - started, error };
  } finally {
    await destroyAllWindows();
  }
}

async function main() {
  const userData = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copilot-electron-integration-'));
  app.setPath('userData', userData);
  await app.whenReady();

  const fixture = await startFixtureServer();
  const configuredGlobal = '__fixtureRenderer';
  const configuredVersion = 73;
  const installer = createRendererAgentInstaller({
    fs,
    agentPath: path.join(repoRoot, 'renderer', 'agent.js'),
    rendererApiGlobal: configuredGlobal,
    rendererAgentVersion: configuredVersion,
    agentConfig: {
      chatRootSelectors: ['#conversation'],
      collectionSelectors: ['#conversation'],
      collectionRowSelectors: ['article'],
      collectionKeyAttributes: ['data-message-id'],
      collectionExcludeSelectors: [],
      junkSelectors: [],
      preserveSelectors: ['article'],
      virtualizerSelectors: [],
      scoreRules: {},
      chatInputSelectors: [],
      reasoningExpandSelectors: [],
    },
  });

  const cases = [];

  cases.push(await runCase('renderer agent survives full navigation with configured global and version', async () => {
    const win = await createFixtureWindow(installer, `${fixture.origin}/page?rev=1`);
    const first = await waitFor(() => win.webContents.executeJavaScript(
      `window[${JSON.stringify(configuredGlobal)}] && ({ version: window[${JSON.stringify(configuredGlobal)}].__version, page: document.body.dataset.revision })`,
      true
    ));
    assert.deepEqual(first, { version: configuredVersion, page: '1' });

    await win.loadURL(`${fixture.origin}/page?rev=2`);
    const second = await waitFor(() => win.webContents.executeJavaScript(
      `window[${JSON.stringify(configuredGlobal)}] && ({ version: window[${JSON.stringify(configuredGlobal)}].__version, page: document.body.dataset.revision })`,
      true
    ));
    assert.deepEqual(second, { version: configuredVersion, page: '2' });
  }));

  cases.push(await runCase('renderer agent is reinjected when a same-origin frame navigates', async () => {
    const win = await createFixtureWindow(installer, `${fixture.origin}/with-frame?rev=1`);
    const getFrame = async revision => waitFor(async () => {
      const frames = win.webContents.mainFrame.framesInSubtree || [];
      const frame = frames.find(candidate => candidate !== win.webContents.mainFrame && candidate.url.includes(`/frame?rev=${revision}`));
      if (!frame) return null;
      const value = await frame.executeJavaScript(
        `window[${JSON.stringify(configuredGlobal)}] && ({ version: window[${JSON.stringify(configuredGlobal)}].__version, revision: document.body.dataset.frameRevision })`,
        true
      );
      return value ? { frame, value } : null;
    });

    const first = await getFrame('1');
    assert.deepEqual(first.value, { version: configuredVersion, revision: '1' });
    await win.webContents.executeJavaScript("document.getElementById('same-origin-frame').src = '/frame?rev=2'", true);
    const second = await getFrame('2');
    assert.deepEqual(second.value, { version: configuredVersion, revision: '2' });
  }));

  cases.push(await runCase('preloads remain available with context isolation and sandboxing', async () => {
    const IPC = createIPC(appSlug);
    let ping = null;
    let selectionMessage = null;
    const onRendererSettings = event => { event.returnValue = { directOpenBehavior: 'shift-click' }; };
    const onPing = (_event, value) => { ping = value; };
    const onSelection = (_event, value) => { selectionMessage = value; };
    ipcMain.on(IPC.RENDERER_SETTINGS, onRendererSettings);
    ipcMain.on(IPC.PRELOAD_PING, onPing);
    ipcMain.on(IPC.SEND_SELECTION, onSelection);
    try {
      const win = await createFixtureWindow(null, `${fixture.origin}/preload`, {
        preload: path.join(repoRoot, 'app-specific', 'preload.js'),
        contextIsolation: true,
        sandbox: false,
      });
      const availability = await win.webContents.executeJavaScript(`({
        host: typeof window[${JSON.stringify(hostApiName)}],
        sendSelection: typeof window[${JSON.stringify(hostApiName)}]?.sendSelection,
        rendererRequire: typeof window.require,
        rendererProcess: typeof window.process
      })`, true);
      assert.deepEqual(availability, {
        host: 'object',
        sendSelection: 'function',
        rendererRequire: 'undefined',
        rendererProcess: 'undefined',
      });
      await win.webContents.executeJavaScript(`window[${JSON.stringify(hostApiName)}].sendSelection({ mode: 'quote', autoSubmit: true })`, true);
      await waitFor(() => ping && selectionMessage);
      assert.equal(selectionMessage.mode, 'quote');
      assert.equal(selectionMessage.autoSubmit, true);
    } finally {
      ipcMain.removeListener(IPC.RENDERER_SETTINGS, onRendererSettings);
      ipcMain.removeListener(IPC.PRELOAD_PING, onPing);
      ipcMain.removeListener(IPC.SEND_SELECTION, onSelection);
    }
  }));

  cases.push(await runCase('layout CSS is inserted, replaced, and restored after reload', async () => {
    const win = await createFixtureWindow(null, `${fixture.origin}/css`);
    const holder = { key: null, css: '', __wired: false };
    injectCSSOnLoad(win, '#fixture { color: rgb(255, 0, 0) !important; }', holder);
    await waitFor(async () => (await win.webContents.executeJavaScript("getComputedStyle(document.getElementById('fixture')).color", true)) === 'rgb(255, 0, 0)');
    const firstKey = holder.key;
    assert.ok(firstKey);

    injectCSSOnLoad(win, '#fixture { background-color: rgb(0, 0, 255) !important; }', holder);
    await waitFor(async () => {
      const styles = await win.webContents.executeJavaScript(`(() => {
        const value = getComputedStyle(document.getElementById('fixture'));
        return { color: value.color, background: value.backgroundColor };
      })()`, true);
      return styles.background === 'rgb(0, 0, 255)' && styles.color !== 'rgb(255, 0, 0)' && styles;
    });
    assert.notEqual(holder.key, firstKey);

    await win.reload();
    const afterReload = await waitFor(async () => {
      const styles = await win.webContents.executeJavaScript(`(() => {
        const value = getComputedStyle(document.getElementById('fixture'));
        return { color: value.color, background: value.backgroundColor };
      })()`, true);
      return styles.background === 'rgb(0, 0, 255)' && styles;
    });
    assert.notEqual(afterReload.color, 'rgb(255, 0, 0)');
  }));

  cases.push(await runCase('settings IPC works through the sandboxed settings preload', async () => {
    let config = { ...appConfig.defaultAppConfig };
    const IPC = createIPC(appSlug);
    const manager = createSettingsWindow({
      BrowserWindow,
      ipcMain,
      path,
      dirname: repoRoot,
      IPC,
      appLabel: `${appLabel} Fixture`,
      getAppConfig: () => config,
      updateAppConfig: patch => (config = { ...config, ...patch }),
      validateRuntimeSettings: async () => ({ ok: true }),
      applyRuntimeSettings: async () => ({ ok: true, applied: true }),
      getAppIconImage: () => null,
    });
    const win = trackWindow(manager.showSettingsWindow());
    await waitFor(() => win.webContents.executeJavaScript("typeof window.appSettings === 'object'", true));
    const snapshot = await win.webContents.executeJavaScript('window.appSettings.get()', true);
    assert.equal(snapshot.appLabel, `${appLabel} Fixture`);
    assert.equal(snapshot.values.theme, 'system');

    const invalid = await win.webContents.executeJavaScript("window.appSettings.validate({ theme: 'ultraviolet' })", true);
    assert.equal(invalid.valid, false);
    assert.ok(invalid.errors.theme);

    const saved = await win.webContents.executeJavaScript("window.appSettings.save({ theme: 'dark' })", true);
    assert.equal(saved.valid, true);
    assert.equal(saved.values.theme, 'dark');
    assert.equal(config.theme, 'dark');
  }));

  cases.push(await runCase('closing a BrowserWindow aborts an active export and runs cleanup', async () => {
    const win = await createFixtureWindow(null, `${fixture.origin}/export-close`);
    let cleanupRan = false;
    const job = new ExportJob({
      handlers: {
        locate: async currentJob => {
          currentJob.addCleanup(() => { cleanupRan = true; });
          await new Promise((resolve, reject) => {
            currentJob.signal.addEventListener('abort', () => reject(currentJob.signal.reason), { once: true });
          });
        },
      },
    });
    const unbind = bindExportJobToWindow(job, win);
    const running = job.run();
    await delay(50);
    win.destroy();
    await assert.rejects(running, error => error instanceof ExportCancelledError && error.code === 'EXPORT_CANCELLED');
    unbind();
    assert.equal(cleanupRan, true);
  }));

  cases.push(await runCase('capture cancellation crosses a real renderer RPC boundary', async () => {
    const win = await createFixtureWindow(null, `${fixture.origin}/capture-cancel`);
    const store = await createCanonicalConversationStore({ tempRoot: os.tmpdir(), prefix: `${appSlug}-electron-capture-cancel` });
    const controller = new AbortController();
    const onAbort = () => {
      if (!win.isDestroyed()) win.webContents.executeJavaScript('window.captureCancelled = true', true).catch(() => {});
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const capture = captureConversation({
        store,
        signal: controller.signal,
        config: {
          exportCaptureSettleMs: 1,
          exportCaptureTerminalSamples: 2,
          exportCaptureBudgetMs: 5000,
          exportCaptureMaxSteps: 100,
        },
        callBatch: payload => win.webContents.executeJavaScript(`window.fixtureCaptureBatch(${JSON.stringify(payload)})`, true),
      });
      setTimeout(() => controller.abort('fixture cancellation'), 25);
      await assert.rejects(capture, error => error instanceof ExportCancelledError && error.code === 'EXPORT_CANCELLED');
    } finally {
      controller.signal.removeEventListener('abort', onAbort);
      await store.dispose();
    }
  }));

  cases.push(await runCase('destroying a frame during an RPC returns a bounded structured failure', async () => {
    const win = await createFixtureWindow(null, `${fixture.origin}/with-frame?rev=rpc`);
    const frame = await waitFor(() => {
      const frames = win.webContents.mainFrame.framesInSubtree || [];
      return frames.find(candidate => candidate !== win.webContents.mainFrame && candidate.url.includes('/frame?rev=rpc'));
    });
    const rpc = callRendererMethodInFrame(
      win,
      frame.routingId,
      'slow',
      1000,
      { __rendererApiOptions: { rendererApiGlobal: '__rpcFixture' } }
    );
    await delay(50);
    await win.webContents.executeJavaScript("document.getElementById('same-origin-frame').remove()", true);
    const result = await Promise.race([
      rpc,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Frame RPC did not settle after destruction.')), 3000)),
    ]);
    assert.equal(result.ok, false);
    assert.match(String(result.error || ''), /frame|context|destroy|disposed|available/i);
  }));

  cases.push(await runCase('file replacement preserves content and removes Windows backup artifacts', async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'atomic-replace-'));
    try {
      const destination = path.join(directory, 'export.txt');
      const temporary = path.join(directory, '.export.txt.pending.tmp');
      await fs.promises.writeFile(destination, 'old', 'utf8');
      await fs.promises.writeFile(temporary, 'new', 'utf8');
      const result = await replaceFileFromTemporary(temporary, destination, { platform: process.platform });
      assert.equal(await fs.promises.readFile(destination, 'utf8'), 'new');
      assert.equal(fs.existsSync(temporary), false);
      assert.equal(result.cleanupError, null);
      const leftovers = (await fs.promises.readdir(directory)).filter(name => name.includes('replace-backup') || name.endsWith('.tmp'));
      assert.deepEqual(leftovers, []);
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true });
    }
  }));

  await fixture.close();
  await destroyAllWindows();
  await fs.promises.rm(userData, { recursive: true, force: true });

  const failed = cases.filter(result => !result.ok);
  console.log(`1..${cases.length}`);
  console.log(`# ${cases.length - failed.length} passed; ${failed.length} failed`);
  app.exit(failed.length ? 1 : 0);
}

main().catch(async error => {
  console.error(error?.stack || error);
  await destroyAllWindows();
  app.exit(1);
});
