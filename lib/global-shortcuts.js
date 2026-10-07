'use strict';

function createGlobalShortcutManager(deps = {}) {
  const {
    globalShortcut,
    reveal,
    getMainWindow,
    createQuickChatWindow,
    getActiveQuickChatWindow,
  } = deps;

  const registered = new Set();

  function unregisterAll() {
    for (const accelerator of registered) {
      try { globalShortcut.unregister(accelerator); } catch {}
    }
    registered.clear();
  }

  function bindingsFor(config) {
    if (!config?.globalShortcutsEnabled) return [];
    return [
      {
        key: 'globalShortcutShowMain',
        accelerator: String(config.globalShortcutShowMain || '').trim(),
        action() {
          const win = getMainWindow?.();
          if (win) reveal(win);
        },
      },
      {
        key: 'globalShortcutNewQuickChat',
        accelerator: String(config.globalShortcutNewQuickChat || '').trim(),
        action() {
          const win = createQuickChatWindow?.();
          if (win) reveal(win);
        },
      },
      {
        key: 'globalShortcutShowQuickChat',
        accelerator: String(config.globalShortcutShowQuickChat || '').trim(),
        action() {
          const win = getActiveQuickChatWindow?.({ createIfMissing: true });
          if (win) reveal(win);
        },
      },
    ].filter(binding => binding.accelerator);
  }

  function apply(config) {
    unregisterAll();
    const errors = [];
    for (const binding of bindingsFor(config)) {
      let ok = false;
      try { ok = globalShortcut.register(binding.accelerator, binding.action); } catch {}
      if (ok) registered.add(binding.accelerator);
      else errors.push({ key: binding.key, message: `Could not register ${binding.accelerator}; it may already be in use.` });
    }
    return { ok: errors.length === 0, errors };
  }

  function validate(config, currentConfig) {
    const result = apply(config);
    unregisterAll();
    apply(currentConfig || {});
    return result;
  }

  return { apply, validate, unregisterAll };
}

module.exports = { createGlobalShortcutManager };
