// preload.js
const { contextBridge, ipcRenderer } = require('electron');

const IPC = Object.freeze({
  SEND_SELECTION: 'copilot:send-selection',
  QUICK_NEW: 'copilot:quick-new',
  DIRECT_OPEN_LINK: 'copilot:direct-open-link',
});

// ============================================================================
// Host API (Quick Chat interactions are clipboard-based in main)
// ============================================================================

// Optional host API for future in-page integrations (not required by menus)
contextBridge.exposeInMainWorld('copilotHost', {
  /**
   * Ask main process to send current selection to Quick Chat.
   * options = { mode: 'plain'|'quote', autoSubmit: boolean, targetQuickId?: number }
   */
  sendSelection(options = {}) {
    ipcRenderer.send('copilot:send-selection', {
      mode: options.mode || 'plain',
      autoSubmit: !!options.autoSubmit,
      targetQuickId: (typeof options.targetQuickId === 'number') ? options.targetQuickId : null
    });
  },
  /**
   * Create a new Quick Chat window.
   */
  newQuickChat() {
    ipcRenderer.send(IPC.QUICK_NEW);
  }
});

// ============================================================================
// Shift+click on file/download links => ask main process to auto-open the
// resulting download from a temp file using the OS default application.
//
// This does NOT prevent the page's normal behavior. It only tags the next
// matching download so main.js can redirect it to a temp path + shell.openPath().
// ============================================================================
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
    });
  } catch {
    // no-op
  }
}

window.addEventListener('click', onShiftClickDirectOpen, true);

