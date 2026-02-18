// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// ============================================================================
// Structured message passing (Main -> Renderer/Quick Chat) + optional host API
// ============================================================================

/**
 * Envelope schema (best-effort; validated defensively in preload):
 * {
 *   kind: 'inject',
 *   mode: 'plain' | 'quote',
 *   content: string,          // typically markdown
 *   autoSubmit: boolean,
 *   meta: {
 *     source: 'selection' | string,
 *     sourceRole?: 'main' | 'quick',
 *     sourceQuickId?: number,
 *     timestamp: number,
 *     format?: 'markdown' | 'text'
 *   }
 * }
 */

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function coerceEnvelope(raw) {
  if (!isObject(raw)) return null;
  if (raw.kind !== 'inject') return null;
  const mode = (raw.mode === 'quote') ? 'quote' : 'plain';
  const content = (typeof raw.content === 'string') ? raw.content : '';
  const autoSubmit = !!raw.autoSubmit;
  const meta = isObject(raw.meta) ? raw.meta : {};
  return {
    kind: 'inject',
    mode,
    content,
    autoSubmit,
    meta: {
      source: typeof meta.source === 'string' ? meta.source : 'unknown',
      sourceRole: typeof meta.sourceRole === 'string' ? meta.sourceRole : undefined,
      sourceQuickId: typeof meta.sourceQuickId === 'number' ? meta.sourceQuickId : undefined,
      timestamp: typeof meta.timestamp === 'number' ? meta.timestamp : Date.now(),
      format: typeof meta.format === 'string' ? meta.format : 'text'
    }
  };
}

function findChatInput() {
  // Prefer textarea if present, otherwise fall back to contenteditable / role textbox.
  return (
    document.querySelector('textarea')
    || document.querySelector('[contenteditable="true"]')
    || document.querySelector('[role="textbox"]')
  );
}

function setInputValue(el, text) {
  try { el.focus(); } catch {}

  // Textarea / input-like
  if (Object.prototype.hasOwnProperty.call(el, 'value')) {
    try {
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {}
  }

  // contenteditable / role textbox
  try {
    el.textContent = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  } catch {}

  return false;
}

function tryClickSubmitNearInput(inputEl) {
  try {
    const form = inputEl.closest('form');
    if (form) {
      const btn =
        form.querySelector('button[type="submit"]')
        || form.querySelector('button[aria-label*="Send" i]')
        || form.querySelector('[data-testid*="send" i]');
      if (btn) {
        btn.click();
        return true;
      }
    }
  } catch {}

  try {
    const btn =
      document.querySelector('button[type="submit"]')
      || document.querySelector('button[aria-label*="Send" i]')
      || document.querySelector('[data-testid*="send" i]');
    if (btn) {
      btn.click();
      return true;
    }
  } catch {}

  return false;
}

function dispatchEnter(inputEl) {
  try {
    const down = new KeyboardEvent('keydown', {
      bubbles: true, cancelable: true,
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13
    });
    const up = new KeyboardEvent('keyup', {
      bubbles: true, cancelable: true,
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13
    });
    inputEl.dispatchEvent(down);
    inputEl.dispatchEvent(up);
    return true;
  } catch {}
  return false;
}

function injectEnvelope(envelope) {
  const e = coerceEnvelope(envelope);
  if (!e) return;

  const input = findChatInput();
  if (!input) return;

  const ok = setInputValue(input, e.content);
  if (!ok) return;

  if (e.autoSubmit) {
    const clicked = tryClickSubmitNearInput(input);
    if (!clicked) {
      dispatchEnter(input);
    }
  }
}

ipcRenderer.on('copilot:inject-envelope', (_evt, envelope) => {
  try { injectEnvelope(envelope); } catch {}
});

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
    ipcRenderer.send('copilot:quick-new');
  }
});
