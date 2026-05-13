'use strict';

function createSessionHelpers(deps = {}) {
  const {
    app,
    BrowserWindow,
    dialog,
    shell,
    session,
    clipboard,
    nativeImage,
    fs,
    path,

    getAppConfig,
    getAppPartition,
    appLabel,
    getAppUrl,
    getConfigFilePath,
    getLogFilePath,
    getMainWindow,
    safeShowError,

    // Injected callbacks from main.js.
    ensureConfigFile,
    refreshQuickChatMenu,
    refreshTrayMenu,
    getAppIconImage,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });

  function _partition() {
    return (typeof getAppPartition === 'function') ? getAppPartition() : '';
  }

  function _appUrl() {
    return (typeof getAppUrl === 'function') ? getAppUrl() : '';
  }

  function _mainWindow() {
    return (typeof getMainWindow === 'function') ? getMainWindow() : null;
  }

  function _appIconImage() {
    try {
      return (typeof getAppIconImage === 'function') ? getAppIconImage() : null;
    } catch {
      return null;
    }
  }

  function _refreshQuickChatMenu() {
    try {
      if (typeof refreshQuickChatMenu === 'function') refreshQuickChatMenu();
    } catch (err) {
      console.error('refreshQuickChatMenu failed:', err);
    }
  }

  function _refreshTrayMenu() {
    try {
      if (typeof refreshTrayMenu === 'function') refreshTrayMenu();
    } catch (err) {
      console.error('refreshTrayMenu failed:', err);
    }
  }

  function _ensureConfigFilePath() {
    if (typeof ensureConfigFile === 'function') {
      try { ensureConfigFile(); } catch {}
    }

    if (typeof getConfigFilePath === 'function') {
      return getConfigFilePath();
    }

    return path.join(app.getPath('userData'), 'config.json');
  }

  // ============================================================================
  // Helper: runtime info for About dialog
  // ============================================================================

  function getRuntimeInfo() {
    const name = app.getName?.() || 'Application';
    const appVersion = app.getVersion?.() || '0.0.0';
    const nodeVersion = process.versions?.node || 'unknown';
    const electronVersion = process.versions?.electron || 'unknown';
    const chromeVersion = process.versions?.chrome || 'unknown';
    const v8Version = process.versions?.v8 || 'unknown';

    return {
      name,
      appVersion,
      nodeVersion,
      electronVersion,
      chromeVersion,
      v8Version,
      detail:
        `Version: ${appVersion}\n` +
        `Node: ${nodeVersion}\n` +
        `V8: ${v8Version}\n` +
        `Electron: ${electronVersion}\n` +
        `Chromium: ${chromeVersion}\n`
    };
  }

  // ============================================================================
  // Session / cache / troubleshooting menu helpers
  // ============================================================================

  function getAppSession() {
    return session.fromPartition(_partition());
  }

  function getActiveAppWindow() {
    const focused = BrowserWindow.getFocusedWindow();
    const parent = focused?.getParentWindow?.();
    return parent || focused || _mainWindow();
  }

  function getActiveAppWebContents() {
    const win = getActiveAppWindow();
    if (!win || win.isDestroyed?.()) return null;
    return win.webContents || null;
  }

  function reloadApp({ ignoreCache = false } = {}) {
    try {
      const wc = getActiveAppWebContents();
      if (!wc) return;

      if (ignoreCache) wc.reloadIgnoringCache();
      else wc.reload();
    } catch (err) {
      console.error('Reload Gemini failed:', err);
      safeShowError('Reload ' + appLabel + ' failed', String(err?.message ?? err));
    }
  }

  async function clearAppCache() {
    try {
      const ses = getAppSession();
      await ses.clearCache();
    } catch (err) {
      console.error('Clear Gemini Cache failed:', err);
      safeShowError('Clear ' + appLabel + ' Cache failed', String(err?.message ?? err));
    }
  }

  async function clearCookiesAndSignOut() {
    try {
      const ses = getAppSession();

      await ses.clearStorageData({
        storages: [
          'cookies',
          'localstorage',
          'sessionstorage',
          'indexeddb',
          'serviceworkers',
          'cachestorage'
        ]
      });

      reloadApp({ ignoreCache: true });
    } catch (err) {
      console.error('Clear Cookies / Sign Out failed:', err);
      safeShowError('Clear Cookies / Sign Out failed', String(err?.message ?? err));
    }
  }

  function copyCurrentUrl() {
    try {
      const wc = getActiveAppWebContents();
      if (!wc) return;

      clipboard.writeText(wc.getURL());
    } catch (err) {
      console.error('Copy Current URL failed:', err);
      safeShowError('Copy Current URL failed', String(err?.message ?? err));
    }
  }

  async function openCurrentUrlExternal() {
    try {
      const wc = getActiveAppWebContents();
      if (!wc) return;

      const url = wc.getURL();
      if (url) await shell.openExternal(url);
    } catch (err) {
      console.error('Open Current URL in External Browser failed:', err);
      safeShowError('Open Current URL failed', String(err?.message ?? err));
    }
  }

  // ============================================================================
  // Tray / maintenance helpers
  // ============================================================================

  function getLogsFolderPath() {
    try {
      const logsPath = app.getPath('logs');
      fs.mkdirSync(logsPath, { recursive: true });
      return logsPath;
    } catch {
      const fallback = path.join(app.getPath('userData'), 'logs');
      fs.mkdirSync(fallback, { recursive: true });
      return fallback;
    }
  }

  async function openPathWithError(title, targetPath) {
    try {
      const openError = await shell.openPath(targetPath);
      if (openError) safeShowError(title, String(openError));
    } catch (err) {
      console.error(`${title} failed:`, err);
      safeShowError(title, String(err?.message ?? err));
    }
  }

  async function openLogsFolder() {
    await openPathWithError('Open Logs Folder failed', getLogsFolderPath());
  }

  async function openConfigFile() {
    const configPath = _ensureConfigFilePath();
    await openPathWithError('Open Config File failed', configPath);
  }

  function toggleActiveWindowAlwaysOnTop() {
    try {
      const win = getActiveAppWindow();
      if (!win || win.isDestroyed?.()) return;

      win.setAlwaysOnTop(!win.isAlwaysOnTop());

      _refreshQuickChatMenu();
      _refreshTrayMenu();
    } catch (err) {
      console.error('Toggle Always on Top failed:', err);
      safeShowError('Toggle Always on Top failed', String(err?.message ?? err));
    }
  }

  function showAboutDialog() {
    try {
      const info = getRuntimeInfo();
      const parent = getActiveAppWindow();

      const options = {
        type: 'info',
        buttons: ['OK'],
        defaultId: 0,
        title: `About ${info.name}`,
        message: `${info.name}`,
        detail: info.detail,
        noLink: true,
        icon: _appIconImage()
      };

      const promise = parent && !parent.isDestroyed?.()
        ? dialog.showMessageBox(parent, options)
        : dialog.showMessageBox(options);

      promise.catch(err => {
        console.error('About dialog failed:', err);
      });
    } catch (err) {
      console.error('About dialog failed:', err);
    }
  }

  const helpWindows = new Set();

  function showApplicationHelp() {
    let helpWin = null;

    try {
      const helpPath = path.join(app.getAppPath(), 'assets', 'help.md');
      const markdown = fs.readFileSync(helpPath, 'utf8');

      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>${deps.appLabel || 'Application'} — Help</title>
<style>
body {
  font-family: system-ui, Segoe UI, Arial, sans-serif;
  margin: 18px;
  line-height: 1.5;
  color: #222;
  background: #fff;
}
h1, h2, h3 {
  margin-top: 1.2em;
}
table {
  border-collapse: collapse;
  margin: 0.8em 0;
  width: 100%;
}
th, td {
  border: 1px solid #ddd;
  padding: 6px 8px;
  vertical-align: top;
}
code, pre {
  font-family: Consolas, Menlo, monospace;
  background: #f5f7fa;
}
pre {
  padding: 10px;
  overflow: auto;
  border-radius: 6px;
}
</style>
</head>
<body>
<pre id="md" style="white-space: pre-wrap;"></pre>
<script>
document.getElementById('md').textContent = ${JSON.stringify(markdown)};
</script>
</body>
</html>`;

      helpWin = new BrowserWindow({
        width: 900,
        height: 700,
        title: appLabel + ' for Linux — Help',
        resizable: true,
        minimizable: true,
        maximizable: true,
        show: false,
        autoHideMenuBar: true,
        icon: _appIconImage(),
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      helpWindows.add(helpWin);

      helpWin.on('closed', () => {
        helpWindows.delete(helpWin);
      });

      helpWin.loadURL(
        'data:text/html;charset=UTF-8,' + encodeURIComponent(html)
      );

      helpWin.once('ready-to-show', () => {
        try {
          helpWin.show();
          helpWin.focus();
        } catch {}
      });
    } catch (err) {
      console.error('Failed to open Help window:', err);
      try {
        dialog.showErrorBox(
          'Help Error',
          String(err?.message ?? err)
        );
      } catch {}
    }
  }

  return {
    getRuntimeInfo,
    getAppSession,
    getActiveAppWindow,
    getActiveAppWebContents,
    reloadApp,
    clearAppCache,
    clearCookiesAndSignOut,
    copyCurrentUrl,
    openCurrentUrlExternal,
    getLogsFolderPath,
    openPathWithError,
    openLogsFolder,
    openConfigFile,
    toggleActiveWindowAlwaysOnTop,
    showAboutDialog,
    showApplicationHelp,
  };
}

module.exports = { createSessionHelpers };

