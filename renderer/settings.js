'use strict';

const state = {
  baseline: {},
  values: {},
  schema: [],
  errors: {},
  effects: [],
  validationTimer: null,
  saving: false,
};

const form = document.getElementById('settings-form');
const sectionsHost = document.getElementById('settings-sections');
const nav = document.getElementById('settings-nav');
const template = document.getElementById('section-template');
const saveButton = document.getElementById('save');
const resetButton = document.getElementById('reset');
const message = document.getElementById('form-message');
const dirtyBadge = document.getElementById('dirty-badge');
const effectSummary = document.getElementById('effect-summary');

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isDirty() {
  return !equal(state.values, state.baseline);
}

function collectPatch() {
  const patch = {};
  for (const [key, value] of Object.entries(state.values)) {
    if (!equal(value, state.baseline[key])) patch[key] = value;
  }
  return patch;
}

function fieldForKey(key) {
  for (const section of state.schema) {
    const field = section.fields.find(item => item.key === key);
    if (field) return field;
  }
  return null;
}

function readControl(field, control) {
  if (field.type === 'checkbox') return control.checked;
  if (field.type === 'number') return control.value === '' ? '' : Number(control.value);
  if (field.type === 'string-list') {
    return control.value.split(',').map(item => item.trim()).filter(Boolean);
  }
  return control.value;
}

function displayValue(field, value) {
  if (field.type === 'string-list') return Array.isArray(value) ? value.join(', ') : '';
  if (field.type === 'checkbox') return !!value;
  return value ?? '';
}

function effectLabel(effect) {
  if (effect === 'reload') return 'Reload required';
  if (effect === 'next-launch') return 'Next launch';
  return '';
}

function createControl(field) {
  let control;
  if (field.type === 'select') {
    control = document.createElement('select');
    for (const [value, label] of field.options) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      control.append(option);
    }
  } else {
    control = document.createElement('input');
    control.type = field.type === 'checkbox' ? 'checkbox' : field.type === 'number' ? 'number' : 'text';
    if (field.min !== undefined) control.min = String(field.min);
    if (field.max !== undefined) control.max = String(field.max);
    if (field.step !== undefined) control.step = String(field.step);
    if (field.placeholder) control.placeholder = field.placeholder;
    if (field.type === 'shortcut') control.autocomplete = 'off';
  }
  control.id = `setting-${field.key}`;
  control.dataset.key = field.key;
  control.value = displayValue(field, state.values[field.key]);
  if (field.type === 'checkbox') control.checked = !!state.values[field.key];
  control.addEventListener('input', () => {
    state.values[field.key] = readControl(field, control);
    setMessage('');
    scheduleValidation();
  });
  return control;
}

function render() {
  nav.replaceChildren();
  sectionsHost.replaceChildren();

  for (const section of state.schema) {
    const link = document.createElement('a');
    link.href = `#section-${section.id}`;
    link.textContent = section.title;
    nav.append(link);

    const fragment = template.content.cloneNode(true);
    const sectionElement = fragment.querySelector('section');
    sectionElement.id = `section-${section.id}`;
    fragment.querySelector('h2').textContent = section.title;
    fragment.querySelector('.section-heading p').textContent = section.description || '';
    const fieldsHost = fragment.querySelector('.fields');

    for (const field of section.fields) {
      const row = document.createElement('div');
      row.className = 'field';
      row.dataset.key = field.key;

      const label = document.createElement('label');
      label.className = 'field-label';
      label.htmlFor = `setting-${field.key}`;
      const text = document.createElement('span');
      text.textContent = field.label;
      label.append(text);
      const badgeText = effectLabel(field.effect);
      if (badgeText) {
        const badge = document.createElement('span');
        badge.className = 'effect-badge';
        badge.textContent = badgeText;
        label.append(badge);
      }

      const controlWrap = document.createElement('div');
      controlWrap.className = 'control-wrap';
      const control = createControl(field);
      controlWrap.append(control);
      if (field.suffix) {
        const suffix = document.createElement('span');
        suffix.className = 'suffix';
        suffix.textContent = field.suffix;
        controlWrap.append(suffix);
      }

      const error = document.createElement('div');
      error.className = 'field-error';
      error.id = `error-${field.key}`;
      error.setAttribute('aria-live', 'polite');
      control.setAttribute('aria-describedby', error.id);

      row.append(label, controlWrap, error);
      fieldsHost.append(row);
    }

    sectionsHost.append(fragment);
  }
  updateUiState();
}

function setMessage(text, kind = '') {
  message.textContent = text;
  message.className = `form-message ${kind}`.trim();
}

function renderErrors() {
  for (const row of document.querySelectorAll('.field')) {
    const key = row.dataset.key;
    const error = state.errors[key] || '';
    row.classList.toggle('invalid', !!error);
    const errorNode = row.querySelector('.field-error');
    if (errorNode) errorNode.textContent = error;
    const control = row.querySelector('[data-key]');
    if (control) control.setAttribute('aria-invalid', error ? 'true' : 'false');
  }
}

function updateUiState() {
  const dirty = isDirty();
  const invalid = Object.keys(state.errors).length > 0;
  dirtyBadge.hidden = !dirty;
  saveButton.disabled = !dirty || invalid || state.saving;
  resetButton.disabled = !dirty || state.saving;

  const reload = state.effects.filter(item => item.effect === 'reload').map(item => item.label);
  const nextLaunch = state.effects.filter(item => item.effect === 'next-launch').map(item => item.label);
  const parts = [];
  if (reload.length) parts.push(`Reload required: ${reload.join(', ')}`);
  if (nextLaunch.length) parts.push(`Applies next launch: ${nextLaunch.join(', ')}`);
  effectSummary.textContent = parts.join(' • ');
  renderErrors();
}

async function validate() {
  try {
    const result = await window.appSettings.validate(collectPatch());
    state.errors = result.errors || {};
    state.effects = result.effects || [];
    if (state.errors._form) setMessage(state.errors._form, 'error');
  } catch (error) {
    state.errors = { _form: String(error?.message || error) };
    setMessage('Settings could not be validated.', 'error');
  }
  updateUiState();
}

function scheduleValidation() {
  if (state.validationTimer) clearTimeout(state.validationTimer);
  state.validationTimer = setTimeout(() => { void validate(); }, 120);
  updateUiState();
}

function syncControlsFromState() {
  for (const [key, value] of Object.entries(state.values)) {
    const field = fieldForKey(key);
    const control = document.getElementById(`setting-${key}`);
    if (!field || !control) continue;
    if (field.type === 'checkbox') control.checked = !!value;
    else control.value = displayValue(field, value);
  }
}

function restoreBaseline() {
  state.values = JSON.parse(JSON.stringify(state.baseline));
  state.errors = {};
  state.effects = [];
  syncControlsFromState();
  setMessage('Changes reset.');
  updateUiState();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (state.saving) return;
  state.saving = true;
  updateUiState();
  setMessage('Validating and saving…');
  try {
    const result = await window.appSettings.save(collectPatch());
    state.errors = result.errors || {};
    state.effects = result.effects || [];
    if (!result.valid) {
      setMessage('Fix the highlighted settings before saving.', 'error');
      return;
    }

    state.values = JSON.parse(JSON.stringify(result.values));
    state.baseline = JSON.parse(JSON.stringify(result.values));
    syncControlsFromState();
    const applyErrors = result.applyResult?.errors || [];
    const reload = state.effects.filter(item => item.effect === 'reload').map(item => item.label);
    const details = [];
    if (reload.length) details.push(`Reload required for: ${reload.join(', ')}.`);
    if (applyErrors.length) details.push(applyErrors.map(item => item.message).join(' '));
    setMessage(details.length ? `Settings saved. ${details.join(' ')}` : 'Settings saved and applied.', applyErrors.length ? 'error' : 'success');
  } catch (error) {
    setMessage(`Settings could not be saved: ${String(error?.message || error)}`, 'error');
  } finally {
    state.saving = false;
    updateUiState();
  }
});

resetButton.addEventListener('click', restoreBaseline);

window.addEventListener('beforeunload', event => {
  if (!isDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

(async function init() {
  try {
    const payload = await window.appSettings.get();
    state.schema = payload.schema || [];
    state.values = JSON.parse(JSON.stringify(payload.values || {}));
    state.baseline = JSON.parse(JSON.stringify(payload.values || {}));
    document.title = `${payload.appLabel || 'Application'} Settings`;
    render();
    await validate();
  } catch (error) {
    setMessage(`Settings could not be loaded: ${String(error?.message || error)}`, 'error');
    saveButton.disabled = true;
    resetButton.disabled = true;
  }
})();
