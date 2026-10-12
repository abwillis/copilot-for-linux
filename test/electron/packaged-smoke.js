'use strict';

const fs = require('fs');
const path = require('path');

function parseReportPath(argv) {
  const prefix = '--smoke-report=';
  const arg = argv.find(value => String(value).startsWith(prefix));
  return arg ? path.resolve(String(arg).slice(prefix.length)) : path.join(process.cwd(), 'packaged-smoke-report.json');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(check, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check().catch(() => null);
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Packaged smoke condition was not met within ${timeoutMs}ms.`);
}

async function runPackagedSmoke(deps) {
  const electron = require('electron');
  const app = deps.app || electron.app;
  const BrowserWindow = deps.BrowserWindow || electron.BrowserWindow;
  const ipcMain = deps.ipcMain || electron.ipcMain;
  const createExporters = deps.createExporters || require('../../lib/exporters').createExporters;
  const appConfig = deps.appConfig || require('../../app-specific/app.config');
  const chatDom = deps.chatDom || require('../../app-specific/chat-dom');
  const reportPath = parseReportPath(process.argv);
  const report = {
    platform: process.platform,
    packaged: app.isPackaged,
    startup: false,
    export: false,
    replacement: false,
  };
  let win = null;
  const rendererSettingsChannel = `${appConfig.appSlug}:renderer-settings`;
  const onRendererSettings = event => {
    event.returnValue = { directOpenBehavior: appConfig.defaultAppConfig.directOpenBehavior };
  };

  try {
    await app.whenReady();
    ipcMain.on(rendererSettingsChannel, onRendererSettings);
    win = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false,
        preload: path.join(__dirname, '..', '..', 'app-specific', 'preload.js'),
      },
    });
    await win.loadFile(path.join(__dirname, 'fixture', 'selection.html'));

    const globalName = String(appConfig.rendererApiGlobal || '__appRenderer');
    const version = Number(appConfig.rendererAgentVersion || 1);
    await waitFor(async () => win.webContents.executeJavaScript(
      `window[${JSON.stringify(globalName)}] && window[${JSON.stringify(globalName)}].__version === ${version}`,
      true
    ));
    report.startup = true;

    const exporters = createExporters({
      app,
      BrowserWindow,
      dialog: require('electron').dialog,
      safeShowError: (title, message) => { throw new Error(`${title}: ${message}`); },
      PRINT_BUBBLE_CSS: chatDom.PRINT_BUBBLE_CSS,
      CHAT_SCOPE_PSEUDO: chatDom.CHAT_SCOPE_PSEUDO,
      EXPORT_ROOT_CLASS: chatDom.EXPORT_ROOT_CLASS,
      EXPORT_ROOT_SELECTOR: chatDom.EXPORT_ROOT_SELECTOR,
      DOM_PRESERVE_CONTENT_SELECTORS: chatDom.DOM_PRESERVE_CONTENT_SELECTORS,
      getAppConfig: () => appConfig.defaultAppConfig,
      DEFAULT_APP_CONFIG: appConfig.defaultAppConfig,
      normalizeExportFormat: value => String(value || '').toLowerCase(),
      appLabel: appConfig.appLabel,
      appSlug: appConfig.appSlug,
      rendererApiGlobal: globalName,
    });

    const outputPath = path.join(app.getPath('temp'), `${appConfig.appSlug}-packaged-smoke-export.txt`);
    const selectFixture = text => win.webContents.executeJavaScript(`(() => {
      const node = document.getElementById('export-source');
      node.textContent = ${JSON.stringify(text)};
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    })()`, true);

    await selectFixture('Packaged export smoke one');
    await exporters.saveSelectionByProfile(win, 'plainText', outputPath);
    const first = await fs.promises.readFile(outputPath, 'utf8');
    if (first !== 'Packaged export smoke one') throw new Error('The first packaged export did not match the fixture selection.');
    report.export = true;

    await selectFixture('Packaged export smoke replacement');
    await exporters.saveSelectionByProfile(win, 'plainText', outputPath);
    const second = await fs.promises.readFile(outputPath, 'utf8');
    if (second !== 'Packaged export smoke replacement') throw new Error('The packaged export did not replace the existing file.');
    const leftovers = (await fs.promises.readdir(path.dirname(outputPath)))
      .filter(name => name.startsWith(`.${path.basename(outputPath)}.`) && (name.endsWith('.tmp') || name.includes('replace-backup')));
    if (leftovers.length) throw new Error(`Packaged export cleanup left artifacts: ${leftovers.join(', ')}`);
    report.replacement = true;
    report.outputBytes = Buffer.byteLength(second);
    await fs.promises.unlink(outputPath).catch(() => {});
  } catch (error) {
    report.error = String(error?.stack || error);
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch {}
    try { ipcMain.removeListener(rendererSettingsChannel, onRendererSettings); } catch {}
    await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.promises.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }

  if (!report.startup || !report.export || !report.replacement) {
    console.error(report.error || 'Packaged smoke failed.');
    app.exit(1);
    return;
  }
  console.log(`PACKAGED_SMOKE_OK ${JSON.stringify(report)}`);
  app.exit(0);
}

module.exports = { runPackagedSmoke };
