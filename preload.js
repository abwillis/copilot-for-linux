// preload.js
const { contextBridge, ipcRenderer } = require('electron');

const IPC = Object.freeze({
  SEND_SELECTION: 'copilot:send-selection',
  QUICK_NEW: 'copilot:quick-new',
  DIRECT_OPEN_LINK: 'copilot:direct-open-link',
  PRELOAD_PING: 'copilot:preload-ping',
});

// Prove that the preload actually executed in the running app.
try {
  ipcRenderer.send(IPC.PRELOAD_PING, {
    href: String(location.href || ''),
    ts: Date.now(),
  });
} catch {}

// ============================================================================
// Host API (Quick Chat interactions are clipboard-based in main)
// ============================================================================
contextBridge.exposeInMainWorld('copilotHost', {
  /**
   * Ask main process to send current selection to Quick Chat.
   * options = { mode: 'plain'|'quote', autoSubmit: boolean, targetQuickId?: number }
   */
  sendSelection(options = {}) {
    ipcRenderer.send(IPC.SEND_SELECTION, {
      mode: options.mode || 'plain',
      autoSubmit: !!options.autoSubmit,
      targetQuickId:
        (typeof options.targetQuickId === 'number') ? options.targetQuickId : null
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
      ts: Date.now(),
    });
  } catch (err) {
    try { console.error('[direct-open][preload] handler failed', err); } catch {}
  }
}

window.addEventListener('click', onShiftClickDirectOpen, true);

// ============================================================================
// Hover over links: show full URL in native tooltip
// ============================================================================
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

            // Only set title if not already present
            if (!a.hasAttribute('title') || !a.getAttribute('title')) {
                const href = a.getAttribute('href');
                if (href) {
                    a.setAttribute('data-copilot-hover-title', '1');
                    a.setAttribute('title', href);
                }
            }
        } catch {}
    },
    true
);


