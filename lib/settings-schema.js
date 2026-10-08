'use strict';

const EXPORT_PROFILES = Object.freeze([
  ['cleanMarkdown', 'Clean Markdown'],
  ['rawMarkdown', 'Raw Markdown'],
  ['markdownWithMetadata', 'Markdown with metadata'],
  ['markdownExternalImages', 'Markdown with external images'],
  ['html', 'Linked HTML'],
  ['htmlArchive', 'Self-contained HTML archive'],
  ['plainText', 'Plain text'],
  ['pdf', 'PDF'],
]);

const SETTINGS_SCHEMA = Object.freeze([
  {
    id: 'appearance',
    title: 'Appearance and layout',
    description: 'Control the local window appearance and expanded conversation width.',
    fields: [
      { key: 'layoutWidthVw', type: 'number', label: 'Layout width', suffix: 'vw', min: 83, max: 100, step: 1, effect: 'immediate' },
      { key: 'theme', type: 'select', label: 'Theme', options: [['system', 'Use system setting'], ['light', 'Light'], ['dark', 'Dark']], effect: 'immediate' },
    ],
  },
  {
    id: 'exports',
    title: 'Export defaults',
    description: 'Choose the default format used by Save and each export scope.',
    fields: [
      { key: 'defaultExportFormat', type: 'select', label: 'Save format', options: [['pdf', 'PDF'], ['md', 'Markdown'], ['html', 'HTML'], ['mhtml', 'MHTML'], ['txt', 'Plain text']], effect: 'immediate' },
      { key: 'defaultPaneExportProfile', type: 'select', label: 'Chat pane profile', options: EXPORT_PROFILES, effect: 'immediate' },
      { key: 'defaultSelectionExportProfile', type: 'select', label: 'Selection profile', options: EXPORT_PROFILES.filter(([value]) => value !== 'htmlArchive'), effect: 'immediate' },
      { key: 'exportPaperMode', type: 'select', label: 'PDF and print paper mode', options: [['match', 'Match current theme'], ['light', 'Light paper'], ['dark', 'Dark paper'], ['monochrome', 'Printer-friendly monochrome']], effect: 'immediate' },
      { key: 'exportHtmlRemoveRemoteResources', type: 'checkbox', label: 'Remove unresolved remote resources from self-contained HTML', effect: 'immediate' },
      { key: 'exportIncludeCaptureMetadata', type: 'checkbox', label: 'Include capture status footer', effect: 'immediate' },
    ],
  },
  {
    id: 'quick-chat',
    title: 'Quick Chat',
    description: 'Configure window-close and selection-paste behavior.',
    fields: [
      { key: 'quickChatCloseBehavior', type: 'select', label: 'When a Quick Chat window closes', options: [['hide', 'Hide and keep running'], ['close', 'Close the window']], effect: 'immediate' },
      { key: 'quickPasteDelayMs', type: 'number', label: 'Paste delay', suffix: 'ms', min: 0, max: 30000, step: 100, effect: 'immediate' },
    ],
  },
  {
    id: 'language',
    title: 'Spellcheck and language',
    description: 'Language tags use BCP 47 syntax, such as en-US or fr.',
    fields: [
      { key: 'spellcheckEnabled', type: 'checkbox', label: 'Enable spellcheck', effect: 'reload' },
      { key: 'spellcheckLanguages', type: 'string-list', label: 'Spellcheck languages', placeholder: 'en-US, es', effect: 'reload' },
    ],
  },
  {
    id: 'diagnostics',
    title: 'Logging and diagnostics',
    description: 'Control normal logging and retention. Temporary diagnostic sessions can still override file capture.',
    fields: [
      { key: 'enableConsoleLogging', type: 'checkbox', label: 'Write logs to the console', effect: 'immediate' },
      { key: 'enableFileLogging', type: 'checkbox', label: 'Write logs to files', effect: 'immediate' },
      { key: 'enableRendererConsoleCapture', type: 'checkbox', label: 'Capture renderer console messages', effect: 'immediate' },
      { key: 'logMaxAgeDays', type: 'number', label: 'Log retention', suffix: 'days', min: 0, max: 365, step: 1, effect: 'immediate' },
      { key: 'logMaxFiles', type: 'number', label: 'Maximum retained log files', min: 1, max: 50, step: 1, effect: 'immediate' },
      { key: 'diagnosticSessionDurationMinutes', type: 'number', label: 'Diagnostic session duration', suffix: 'minutes', min: 1, max: 120, step: 1, effect: 'immediate' },
    ],
  },
  {
    id: 'direct-open',
    title: 'Direct open',
    description: 'Direct open downloads a linked file to a temporary location and opens it with the operating system.',
    fields: [
      { key: 'directOpenBehavior', type: 'select', label: 'Link behavior', options: [['disabled', 'Disabled'], ['shift-click', 'Shift+click to direct open']], effect: 'reload' },
    ],
  },
  {
    id: 'permissions',
    title: 'Permissions',
    description: 'Choose how the hosted application may use sensitive browser capabilities.',
    fields: [
      { key: 'permissionNotifications', type: 'select', label: 'Notifications', options: permissionOptions(), effect: 'immediate' },
      { key: 'permissionMedia', type: 'select', label: 'Camera and microphone', options: permissionOptions(), effect: 'immediate' },
      { key: 'permissionGeolocation', type: 'select', label: 'Location', options: permissionOptions(), effect: 'immediate' },
      { key: 'permissionClipboardRead', type: 'select', label: 'Read clipboard', options: permissionOptions(), effect: 'immediate' },
    ],
  },
  {
    id: 'startup',
    title: 'Startup and tray',
    description: 'Control launch behavior and whether the app remains available from the system tray.',
    fields: [
      { key: 'launchAtLogin', type: 'checkbox', label: 'Launch at login', effect: 'immediate' },
      { key: 'startMinimized', type: 'checkbox', label: 'Start hidden in the tray', effect: 'next-launch' },
      { key: 'showTrayIcon', type: 'checkbox', label: 'Show a tray icon', effect: 'immediate' },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Global shortcuts',
    description: 'Global shortcuts work while another application is focused. Leave an individual shortcut blank to disable it.',
    fields: [
      { key: 'globalShortcutsEnabled', type: 'checkbox', label: 'Enable global shortcuts', effect: 'immediate' },
      { key: 'globalShortcutShowMain', type: 'shortcut', label: 'Show main window', placeholder: 'Ctrl+Alt+1', effect: 'immediate' },
      { key: 'globalShortcutNewQuickChat', type: 'shortcut', label: 'New Quick Chat', placeholder: 'Ctrl+Alt+N', effect: 'immediate' },
      { key: 'globalShortcutShowQuickChat', type: 'shortcut', label: 'Show active Quick Chat', placeholder: 'Ctrl+Alt+2', effect: 'immediate' },
    ],
  },
]);

function permissionOptions() {
  return [['ask', 'Ask each time'], ['allow', 'Allow'], ['deny', 'Block']];
}

const FIELD_BY_KEY = new Map();
for (const section of SETTINGS_SCHEMA) {
  for (const field of section.fields) FIELD_BY_KEY.set(field.key, field);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function selectManagedSettings(config = {}) {
  const selected = {};
  for (const key of FIELD_BY_KEY.keys()) selected[key] = clone(config[key]);
  return selected;
}

function validateShortcut(value) {
  const shortcut = String(value ?? '').trim();
  if (!shortcut) return { value: '' };
  if (shortcut.length > 80) return { error: 'Shortcut is too long.' };

  const parts = shortcut.split('+').map(part => part.trim()).filter(Boolean);
  if (parts.length < 2) return { error: 'Use at least one modifier and one key.' };

  const modifiers = new Set(['Command', 'Cmd', 'Control', 'Ctrl', 'CommandOrControl', 'CmdOrCtrl', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta']);
  const key = parts.at(-1);
  const modifierParts = parts.slice(0, -1);
  if (modifierParts.some(part => !modifiers.has(part))) return { error: 'Use Electron accelerator names such as Ctrl, Alt, Shift, or Super.' };
  if (new Set(modifierParts.map(part => part.toLowerCase())).size !== modifierParts.length) return { error: 'A modifier is repeated.' };
  if (!/^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Plus|Space|Tab|Enter|Escape|Esc|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right|MediaNextTrack|MediaPreviousTrack|MediaStop|MediaPlayPause)$/.test(key)) {
    return { error: 'The final key is not a supported accelerator key.' };
  }
  return { value: shortcut };
}

function normalizeLanguageList(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(',');
  const result = [];
  for (const item of source) {
    const raw = String(item ?? '').trim();
    if (!raw) continue;
    if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(raw)) {
      return { error: `Invalid language tag: ${raw}` };
    }
    let canonical = raw;
    try { canonical = Intl.getCanonicalLocales(raw)[0] || raw; } catch {
      return { error: `Invalid language tag: ${raw}` };
    }
    if (!result.includes(canonical)) result.push(canonical);
  }
  return { value: result };
}

function normalizeFieldValue(field, value) {
  if (field.type === 'checkbox') {
    if (typeof value !== 'boolean') return { error: 'Expected true or false.' };
    return { value };
  }
  if (field.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number)) return { error: 'Enter a whole number.' };
    if (number < field.min || number > field.max) return { error: `Enter a value from ${field.min} to ${field.max}.` };
    return { value: number };
  }
  if (field.type === 'select') {
    const allowed = new Set(field.options.map(option => option[0]));
    if (!allowed.has(value)) return { error: 'Choose one of the available options.' };
    return { value };
  }
  if (field.type === 'string-list') return normalizeLanguageList(value);
  if (field.type === 'shortcut') return validateShortcut(value);
  return { error: 'Unsupported setting type.' };
}

function validateSettingsPatch(currentConfig, patch) {
  const errors = {};
  const normalizedPatch = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { valid: false, errors: { _form: 'Settings must be an object.' }, normalizedPatch: {} };
  }

  for (const [key, value] of Object.entries(patch)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) {
      errors[key] = 'This setting cannot be changed from the Settings window.';
      continue;
    }
    const result = normalizeFieldValue(field, value);
    if (result.error) errors[key] = result.error;
    else normalizedPatch[key] = result.value;
  }

  const candidate = { ...selectManagedSettings(currentConfig), ...normalizedPatch };
  if (candidate.startMinimized && !candidate.showTrayIcon) {
    errors.startMinimized = 'Starting hidden requires the tray icon to be enabled.';
    errors.showTrayIcon = 'Enable the tray icon or turn off Start hidden.';
  }

  if (candidate.spellcheckEnabled && !candidate.spellcheckLanguages.length) {
    errors.spellcheckLanguages = 'Add at least one language when spellcheck is enabled.';
  }

  if (candidate.globalShortcutsEnabled) {
    const shortcutKeys = ['globalShortcutShowMain', 'globalShortcutNewQuickChat', 'globalShortcutShowQuickChat'];
    const seen = new Map();
    for (const key of shortcutKeys) {
      const value = String(candidate[key] || '').toLowerCase();
      if (!value) continue;
      if (seen.has(value)) {
        errors[key] = 'Each enabled global shortcut must be unique.';
        errors[seen.get(value)] = 'Each enabled global shortcut must be unique.';
      } else {
        seen.set(value, key);
      }
    }
  }

  const changedKeys = Object.keys(normalizedPatch).filter(key => {
    return JSON.stringify(currentConfig[key]) !== JSON.stringify(normalizedPatch[key]);
  });
  const effects = changedKeys.map(key => ({
    key,
    effect: FIELD_BY_KEY.get(key)?.effect || 'immediate',
    label: FIELD_BY_KEY.get(key)?.label || key,
  }));

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    normalizedPatch,
    changedKeys,
    effects,
  };
}

function getPublicSettingsSchema() {
  return clone(SETTINGS_SCHEMA);
}

module.exports = {
  SETTINGS_SCHEMA,
  getPublicSettingsSchema,
  selectManagedSettings,
  validateSettingsPatch,
  validateShortcut,
  normalizeLanguageList,
};
