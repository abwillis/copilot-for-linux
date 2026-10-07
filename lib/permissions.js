'use strict';

function createPermissionManager(deps = {}) {
  const { dialog, getAppConfig, getAppUrl } = deps;
  const configuredSessions = new WeakSet();

  const PERMISSION_SETTING = Object.freeze({
    notifications: 'permissionNotifications',
    media: 'permissionMedia',
    geolocation: 'permissionGeolocation',
    clipboardReadWrite: 'permissionClipboardRead',
    clipboardSanitizedWrite: 'permissionClipboardRead',
    'clipboard-read': 'permissionClipboardRead',
  });

  function isTrustedOrigin(url) {
    try {
      return new URL(String(url || '')).origin === new URL(String(getAppUrl?.() || '')).origin;
    } catch {
      return false;
    }
  }

  function getChoice(permission) {
    const key = PERMISSION_SETTING[permission];
    if (!key) return 'deny';
    const value = getAppConfig?.()[key];
    return ['ask', 'allow', 'deny'].includes(value) ? value : 'deny';
  }

  function configure(sessionInstance) {
    if (!sessionInstance || configuredSessions.has(sessionInstance)) return;
    configuredSessions.add(sessionInstance);

    sessionInstance.setPermissionRequestHandler(async (webContents, permission, callback, details) => {
      let finished = false;
      const done = value => {
        if (finished) return;
        finished = true;
        try { callback(!!value); } catch {}
      };

      try {
        const requestingUrl = details?.requestingUrl || webContents?.getURL?.() || '';
        if (!isTrustedOrigin(requestingUrl)) return done(false);
        const choice = getChoice(permission);
        if (choice === 'allow') return done(true);
        if (choice === 'deny') return done(false);

        const parent = webContents?.getOwnerBrowserWindow?.();
        const label = permission === 'media'
          ? 'camera or microphone'
          : permission === 'clipboardReadWrite' || permission === 'clipboardSanitizedWrite'
            ? 'clipboard'
            : permission;
        const options = {
          type: 'question',
          buttons: ['Allow once', 'Block'],
          defaultId: 1,
          cancelId: 1,
          title: 'Permission request',
          message: `Allow access to ${label}?`,
          detail: 'This choice applies to this request only. Change the default in Settings.',
          noLink: true,
        };
        const result = parent && !parent.isDestroyed?.()
          ? await dialog.showMessageBox(parent, options)
          : await dialog.showMessageBox(options);
        done(result.response === 0);
      } catch (error) {
        console.error('Permission request failed:', error);
        done(false);
      }
    });
  }

  return { configure };
}

module.exports = { createPermissionManager };
