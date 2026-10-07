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

    ipcMain.handle(IPC.SETTINGS_SAVE, async (event, patch) => {
      if (!isTrustedSender(event)) throw new Error('Settings access denied.');
      const before = getAppConfig();
      const validation = validateSettingsPatch(before, patch);
      if (!validation.valid) return validation;

      if (typeof validateRuntimeSettings === 'function') {
        const runtimeValidation = await validateRuntimeSettings(
          { ...before, ...validation.normalizedPatch },
          before,
          validation
        );
        if (runtimeValidation && runtimeValidation.ok === false) {
          return {
            ...validation,
            valid: false,
            errors: Object.fromEntries((runtimeValidation.errors || []).map(item => [item.key || '_form', item.message])),
          };
        }
      }

      const next = updateAppConfig(validation.normalizedPatch);
      let applyResult = { ok: true, errors: [] };
      if (typeof applyRuntimeSettings === 'function') {
        applyResult = await applyRuntimeSettings(next, before, validation) || applyResult;
      }

      return {
        ...validation,
        values: selectManagedSettings(next),
        applyResult,
      };
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
        preload: path.join(dirname, 'renderer', 'settings-preload.js'),
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
