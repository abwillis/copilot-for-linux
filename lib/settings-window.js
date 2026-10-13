'use strict';

const {
  getPublicSettingsSchema,
  selectManagedSettings,
  validateSettingsPatch,
} = require('./settings-schema');

function createSettingsWindow(deps = {}) {
  const {
    BrowserWindow,
    ipcMain,
    path,
    dirname,
    IPC,
    appLabel,
    getAppConfig,
    updateAppConfig,
    validateRuntimeSettings,
    applyRuntimeSettings,
    getAppIconImage,
    fs,
    dialog,
    defaultAppConfig,
    getConfigurationStatus,
    getPreviousAppConfig,
  } = deps;

  let settingsWindow = null;
  let handlersRegistered = false;

  function isTrustedSender(event) {
    return !!settingsWindow && !settingsWindow.isDestroyed() && event.sender === settingsWindow.webContents;
  }

  function snapshot() {
    return {
      appLabel: appLabel || 'Application',
      schema: getPublicSettingsSchema(),
      values: selectManagedSettings(getAppConfig()),
      defaults: selectManagedSettings(defaultAppConfig || {}),
      configuration: getConfigurationStatus?.() || {},
    };
  }

  function registerIpcHandlers() {
    if (handlersRegistered) return;
    handlersRegistered = true;

    ipcMain.handle(IPC.SETTINGS_GET, event => {
      if (!isTrustedSender(event)) throw new Error('Settings access denied.');
      return snapshot();
    });

    ipcMain.handle(IPC.SETTINGS_VALIDATE, (event, patch) => {
      if (!isTrustedSender(event)) throw new Error('Settings access denied.');
      return validateSettingsPatch(getAppConfig(), patch);
    });

    let operation = Promise.resolve();
    function handle(channel, action) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrustedSender(event)) throw new Error('Settings access denied.');
        const pending = operation.then(() => {
          if (!isTrustedSender(event)) throw new Error('Settings access denied.');
          return action(...args);
        });
        operation = pending.catch(() => {});
        return pending;
      });
    }
    async function commit(patch, replacement) {
      const before = getAppConfig();
      const validation = validateSettingsPatch(before, patch);
      if (!validation.valid) return validation;
      if (typeof validateRuntimeSettings === 'function') {
        const result = await validateRuntimeSettings({ ...before, ...validation.normalizedPatch }, before, validation);
        if (result?.ok === false) return { ...validation, valid: false,
          errors: Object.fromEntries((result.errors || []).map(item => [item.key || '_form', item.message])) };
      }
      const next = replacement ? updateAppConfig(replacement, { replace: true }) : updateAppConfig(validation.normalizedPatch);
      let applyResult = { ok: true, errors: [] };
      try {
        if (typeof applyRuntimeSettings === 'function') applyResult = await applyRuntimeSettings(next, before, validation) || applyResult;
      } catch (error) { applyResult = { ok: false, errors: [{ message: `Saved, but runtime application failed: ${error.message}` }] }; }
      return { ...validation, values: selectManagedSettings(next), applyResult, configuration: getConfigurationStatus?.() || {} };
    }
    handle(IPC.SETTINGS_SAVE, patch => commit(patch));
    handle(IPC.SETTINGS_RESTORE, async () => {
      const previous = getPreviousAppConfig();
      const answer = await dialog.showMessageBox(settingsWindow, {
        type: 'question', buttons: ['Cancel', 'Restore'], defaultId: 0, cancelId: 0,
        message: 'Restore the previous saved configuration?',
        detail: 'The current valid configuration becomes the previous configuration. Unsaved edits will be discarded.',
      });
      if (answer.response !== 1) return { cancelled: true };
      return commit(selectManagedSettings(previous), previous);
    });
    handle(IPC.SETTINGS_EXPORT, async () => {
      const answer = await dialog.showSaveDialog(settingsWindow, {
        title: 'Export saved settings', defaultPath: 'settings-backup.json', filters: [{ name: 'JSON settings', extensions: ['json'] }],
      });
      if (answer.canceled || !answer.filePath) return { cancelled: true };
      const status = getConfigurationStatus();
      if ([status.configPath, status.backupPath].some(file => path.resolve(file) === path.resolve(answer.filePath))) {
        throw new Error('Export cannot overwrite the active configuration or its backup.');
      }
      const payload = { format: 'wrapper-settings', version: 1, settings: selectManagedSettings(getAppConfig()) };
      const temporary = `${answer.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      let output;
      try {
        output = await fs.promises.open(temporary, 'wx', 0o600);
        await output.writeFile(JSON.stringify(payload, null, 2) + '\n', 'utf8');
        await output.sync(); await output.close(); output = null;
        await fs.promises.rename(temporary, answer.filePath);
      } finally {
        if (output) await output.close();
        await fs.promises.rm(temporary, { force: true });
      }
      return { ok: true };
    });
    handle(IPC.SETTINGS_IMPORT, async () => {
      const answer = await dialog.showOpenDialog(settingsWindow, {
        title: 'Import settings', properties: ['openFile'], filters: [{ name: 'JSON settings', extensions: ['json'] }],
      });
      if (answer.canceled || !answer.filePaths?.[0]) return { cancelled: true };
      const file = await fs.promises.open(answer.filePaths[0], 'r');
      let text;
      try {
        const buffer = Buffer.alloc(1024 * 1024 + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
          const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
          if (!chunk.bytesRead) break;
          bytesRead += chunk.bytesRead;
        }
        if (bytesRead > 1024 * 1024) throw new Error('Settings import exceeds 1 MiB.');
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
      const payload = JSON.parse(text);
      if (payload?.format !== 'wrapper-settings' || payload.version !== 1) throw new Error('Unsupported settings backup format or version.');
      const validation = validateSettingsPatch(getAppConfig(), payload.settings);
      if (!validation.valid) return validation;
      // Stage for review; import does not commit until Save.
      return { ...validation, values: selectManagedSettings({ ...getAppConfig(), ...validation.normalizedPatch }) };
    });
  }

  function showSettingsWindow(parent) {
    registerIpcHandlers();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      return settingsWindow;
    }

    settingsWindow = new BrowserWindow({
      parent: parent && !parent.isDestroyed?.() ? parent : undefined,
      width: 760,
      height: 820,
      minWidth: 640,
      minHeight: 560,
      show: false,
      title: `${appLabel || 'Application'} Settings`,
      icon: typeof getAppIconImage === 'function' ? getAppIconImage() || undefined : undefined,
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
        preload: path.join(dirname, 'app-specific', 'settings-preload.js'),
      },
    });

    settingsWindow.removeMenu();
    settingsWindow.once('ready-to-show', () => {
      try { settingsWindow.show(); settingsWindow.focus(); } catch {}
    });
    settingsWindow.on('closed', () => { settingsWindow = null; });
    settingsWindow.loadFile(path.join(dirname, 'renderer', 'settings.html')).catch(error => {
      console.error('Settings window failed to load:', error);
      try { settingsWindow?.destroy(); } catch {}
    });
    return settingsWindow;
  }

  function closeSettingsWindow() {
    try { settingsWindow?.close(); } catch {}
  }

  return {
    registerIpcHandlers,
    showSettingsWindow,
    closeSettingsWindow,
  };
}

module.exports = { createSettingsWindow };
