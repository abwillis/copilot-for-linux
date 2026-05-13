'use strict';

// === Shift+click direct-open download support ===
// Extracted from main.js (Tier 3 refactor).
// Factory: createDirectOpen(deps) → API object.

function createDirectOpen(deps = {}) {
  const {
    session,
    shell,
    fs,
    path,
    app,
    ipcMain,
    getAppConfig,
    getAppPartition,
    appSlug,
    safeShowError,
  } = deps;

  const APP_CONFIG = new Proxy({}, {
    get(_target, prop) {
      const cfg = (typeof getAppConfig === 'function') ? getAppConfig() : {};
      return cfg ? cfg[prop] : undefined;
    }
  });

  function getPartition() {
    return (typeof getAppPartition === 'function') ? getAppPartition() : (appSlug ? 'persist:' + appSlug + '-for-linux' : 'persist:app');
  }

  // --- Module state ---
  const DIRECT_OPEN_REQUEST_TTL_MS = 15000;
  const directOpenRequests = new Map(); // senderWC.id -> { url, expiresAt }
  const tempOpenedFiles = new Set();    // best-effort cleanup on quit
  let directOpenIpcHandlerRegistered = false;

  function debugDirectOpen(...args) {
    try {
      console.log('[direct-open]', ...args);
    } catch {}
  }

  function normalizeComparableUrl(input) {
    try {
      const u = new URL(String(input || '').trim());
      u.hash = '';
      return u.toString();
    } catch {
      return String(input || '').trim();
    }
  }

  function sanitizeDownloadFilename(name) {
    const raw = String(name || '').trim() || 'download';
    const cleaned = raw
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
    return cleaned || 'download';
  }

  function buildDirectOpenTempPath(filename) {
    const safeName = sanitizeDownloadFilename(filename);
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return path.join(app.getPath('temp'), `${appSlug}-open-${stamp}-${safeName}`);
  }

  function pruneExpiredDirectOpenRequests() {
    const now = Date.now();
    for (const [key, value] of directOpenRequests.entries()) {
      if (!value || value.expiresAt <= now) {
        directOpenRequests.delete(key);
      }
    }
  }

  function itemUrlMatchesDirectOpenRequest(item, request) {
    if (!request?.url) return false;

    const requested = normalizeComparableUrl(request.url);
    const candidates = new Set();

    try {
      const current = item?.getURL?.();
      if (current) candidates.add(normalizeComparableUrl(current));
    } catch {}

    try {
      const chain = item?.getURLChain?.();
      if (Array.isArray(chain)) {
        for (const u of chain) {
          if (u) candidates.add(normalizeComparableUrl(u));
        }
      }
    } catch {}

    if (candidates.has(requested)) return true;

    // Redirects sometimes preserve the requested URL as a prefix/query ancestor.
    for (const u of candidates) {
      if (u === requested) return true;
      if (u.startsWith(requested) || requested.startsWith(u)) return true;
    }

    return false;
  }

  function registerDirectOpenDownloadHandler() {
    if (!APP_CONFIG.enableDirectOpen) return;
    const ses = session.fromPartition(getPartition());
    if (!ses || ses.__directOpenHandlerAttached) return;
    ses.__directOpenHandlerAttached = true;

    // Prevent Chromium from prompting with the normal save dialog for a tagged
    // Shift+click download.  We decide the path in will-download.
    ses.on('download-created', (_event, item, webContents) => {
      try {
        pruneExpiredDirectOpenRequests();
        const senderId = webContents?.id;
        if (!senderId) return;
        const request = directOpenRequests.get(senderId);
        if (!request) return;
        debugDirectOpen('download-created', {
          senderId,
          requestUrl: request.url,
          itemUrl: item?.getURL?.(),
                        itemUrlChain: (typeof item?.getURLChain === 'function') ? item.getURLChain() : [],
                        itemFilename: (typeof item?.getFilename === 'function') ? item.getFilename() : null,
        });
        if (itemUrlMatchesDirectOpenRequest(item, request) && typeof item.setSaveDialogOptions === 'function') {
          // Suppress the "Save As" dialog — we will set the path ourselves
          // in will-download once Chromium resolves the final filename.
          try { item.setSaveDialogOptions({ defaultPath: '' }); } catch {}
          directOpenRequests.delete(senderId);
        }
      } catch (err) {
        console.error('download-created handler error:', err);
      }
    });

    ses.on('will-download', (_event, item, webContents) => {
      try {
        pruneExpiredDirectOpenRequests();
        const senderId = webContents?.id;
        if (!senderId) return;
        const request = directOpenRequests.get(senderId);
        const matches = itemUrlMatchesDirectOpenRequest(item, request);
        debugDirectOpen('will-download', {
          senderId,
          requestUrl: request?.url,
          itemUrl: item?.getURL?.(),
          itemFilename: item?.getFilename?.(),
          matches,
        });
        if (!request || !matches) return;

        directOpenRequests.delete(senderId);
        const filename =
          sanitizeDownloadFilename(
            item?.getFilename?.() ||
            path.basename(new URL(item?.getURL?.() || request.url).pathname) ||
            'download'
          );

        // Build temp path, save, then open with the OS default handler
        const tempPath = buildDirectOpenTempPath(filename);
        tempOpenedFiles.add(tempPath);

        debugDirectOpen('about to setSavePath', {
          tempPath,
          itemGetFilename: item?.getFilename?.(),
          itemGetURL: item?.getURL?.(),
        });

        item.on('updated', (_evt, state) => {
          debugDirectOpen('download updated', {
            state,
            tempPath,
            receivedBytes: item.getReceivedBytes?.(),
            totalBytes: item.getTotalBytes?.(),
          });
        });

        item.setSavePath(tempPath);
        debugDirectOpen('setSavePath', tempPath);

        // Best-effort cleanup after Chromium finishes downloading
        const cleanup = () => {
          try {
            setTimeout(() => {
              try {
                tempOpenedFiles.delete(tempPath);
                if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
              } catch {}
            }, 120_000);
          } catch {}
        };

        item.once('done', (_evt, state) => {
          debugDirectOpen('download done', { state, tempPath });
          if (state === 'completed') {
            try {
              tempOpenedFiles.delete(tempPath);
              shell.openPath(tempPath).then(() => cleanup()).catch(() => cleanup());
            } catch (err) {
              safeShowError('Direct-open failed', String(err?.message || err));
              cleanup();
            }
          } else {
            cleanup();
          }
        });

        // Clean up the request on abort/cancellation/navigation
        webContents?.on('destroyed', () => {
          directOpenRequests.delete(webContents?.id);
        });
      } catch (err) {
        console.error('will-download handler error:', err);
      }
    });
  }

  // === IPC handler for direct-open-link ===
  // Registers the ipcMain listener for IPC.DIRECT_OPEN_LINK.
  function registerDirectOpenIpcHandler(IPC) {
    if (directOpenIpcHandlerRegistered) return;
    directOpenIpcHandlerRegistered = true;

    ipcMain.on(IPC.DIRECT_OPEN_LINK, (event, payload) => {
      try {
        const url = String(payload?.href || '').trim();
        pruneExpiredDirectOpenRequests();
        if (!url) return;

        directOpenRequests.set(event.sender.id, {
          url,
          expiresAt: Date.now() + DIRECT_OPEN_REQUEST_TTL_MS,
        });

        debugDirectOpen('ipc request queued', {
          senderId: event.sender.id,
          url,
          pendingCount: directOpenRequests.size,
        });
      } catch (err) {
        console.error('IPC direct-open-link failed:', err);
      }
    });

    debugDirectOpen('preload ping', {
      channel: IPC.PRELOAD_PING,
      msg: 'direct-open IPC handler registered',
    });
  }

  // === Cleanup: called from app quit handler ===
  function cleanupTempFiles() {
    try {
      for (const p of tempOpenedFiles) {
        try { fs.unlinkSync(p); } catch {}
      }
      tempOpenedFiles.clear();
    } catch {}
  }

  return {
    registerDirectOpenDownloadHandler,
    registerDirectOpenIpcHandler,
    pruneExpiredDirectOpenRequests,
    cleanupTempFiles,
    debugDirectOpen,
    // Expose for external consumers if needed:
    normalizeComparableUrl,
    sanitizeDownloadFilename,
  };
}

module.exports = { createDirectOpen };
