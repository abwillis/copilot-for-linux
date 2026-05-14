// preload-core.js — Shared preload logic for all Electron chat apps.
// Each app's preload.js calls initPreload() with app-specific config.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * @param {object} opts
 * @param {string}  opts.appSlug         - e.g. 'gemini' or 'copilot'
 * @param {string}  opts.hostApiName     - e.g. 'geminiHost' or 'copilotHost'
 * @param {object}  opts.IPC             - frozen channel map from lib/ipc.js
 * @param {boolean} [opts.enableDirectOpen=true]     - Shift+click → open with OS handler
 * @param {boolean} [opts.enableHoverTooltips=true]  - Show full URL on link hover
 */
function initPreload({ appSlug, hostApiName, IPC, enableDirectOpen = true, enableHoverTooltips = true }) {

  // ========================================================================
  // Preload ping — prove the preload actually executed
  // ========================================================================
  try {
    ipcRenderer.send(IPC.PRELOAD_PING, {
      href: String(location.href || ''),
      ts: Date.now(),
    });
  } catch {}

  // ========================================================================
  // Host API (exposed to renderer via contextBridge)
  // ========================================================================
  contextBridge.exposeInMainWorld(hostApiName, {
    /**
     * Ask main process to send current selection to Quick Chat.
     * @param {object} [options]
     * @param {'plain'|'quote'} [options.mode='plain']
     * @param {boolean}         [options.autoSubmit=false]
     * @param {number|null}     [options.targetQuickId=null]
     */
    sendSelection(options = {}) {
      ipcRenderer.send(IPC.SEND_SELECTION, {
        mode: options.mode || 'plain',
        autoSubmit: !!options.autoSubmit,
        targetQuickId: (typeof options.targetQuickId === 'number') ? options.targetQuickId : null,
      });
    },

    /** Create a new Quick Chat window. */
    newQuickChat() {
      ipcRenderer.send(IPC.QUICK_NEW);
    },
  });

  // ========================================================================
  // Shift+click direct-open: download to temp → open with OS default app
  // ========================================================================
  if (enableDirectOpen) {
    const hoverAttr = `data-${appSlug}-hover-title`;

    function shouldIgnoreHref(href) {
      const s = String(href || '').trim();
      if (!s) return true;
      return (
        s.startsWith('#') ||
        /^javascript:/i.test(s) ||
        /^mailto:/i.test(s) ||
        /^tel:/i.test(s)
      );
    }

    function findAnchorFromEventTarget(target) {
      try {
        if (!target) return null;
        if (typeof target.closest === 'function') {
          return target.closest('a[href]');
        }
      } catch {}
      return null;
    }

    function onShiftClickDirectOpen(event) {
      try {
        if (event.defaultPrevented) return;
        if (!event.shiftKey) return;
        if (event.button !== 0) return; // left click only

        const anchor = findAnchorFromEventTarget(event.target);
        if (!anchor) return;

        const href = anchor.href || anchor.getAttribute('href') || '';
        if (shouldIgnoreHref(href)) return;

        ipcRenderer.send(IPC.DIRECT_OPEN_LINK, {
          href: String(href),
          ts: Date.now(),
        });
      } catch (err) {
        try { console.error(`[direct-open][preload] handler failed`, err); } catch {}
      }
    }

    window.addEventListener('click', onShiftClickDirectOpen, true);
  }

  // ========================================================================
  // Hover over links: show full URL in native tooltip
  // ========================================================================
  if (enableHoverTooltips) {
    const hoverAttr = `data-${appSlug}-hover-title`;

    function findAnchorForHover(target) {
      try {
        if (!target) return null;
        if (typeof target.closest === 'function') {
          return target.closest('a[href]');
        }
      } catch {}
      return null;
    }

    window.addEventListener(
      'mouseover',
      (event) => {
        try {
          const a = findAnchorForHover(event.target);
          if (!a) return;
          if (!a.hasAttribute('title') || !a.getAttribute('title')) {
            const href = a.getAttribute('href');
            if (href) {
              a.setAttribute(hoverAttr, '1');
              a.setAttribute('title', href);
            }
          }
        } catch {}
      },
      true
    );
  }
}

module.exports = { initPreload };
