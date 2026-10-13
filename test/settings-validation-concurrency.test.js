'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function fixture() {
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', className: '', disabled: false, hidden: false,
      listeners: {},
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      getAttribute(name) { return this.attributes[name]; },
      querySelector() { return null; },
      focus() { this.focused = true; },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      querySelectorAll() { return []; },
      replaceChildren() {},
    });
    return nodes.get(id);
  }
  const requests = [], saves = [], timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document: { getElementById: node, querySelectorAll: () => [] },
    window: {
      addEventListener() {},
      appSettings: {
        get: async () => ({ values: { theme: 'system' }, schema: [] }),
        validate(patch) {
          const request = { ...deferred(), patch };
          requests.push(request);
          return request.promise;
        },
        save(patch) {
          const request = { ...deferred(), patch };
          saves.push(request);
          return request.promise;
        },
      },
    },
    setTimeout(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  const source = fs.readFileSync(path.join(__dirname, '../renderer/settings.js'), 'utf8');
  vm.runInContext(source + '\nglobalThis.harness = { state, validate, scheduleValidation, restoreBaseline };', context);
  await new Promise(resolve => setImmediate(resolve));
  requests[0].resolve({ errors: {}, effects: [] });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  requests.length = 0;
  return {
    context,
    ...context.harness, requests, saves, timers, node,
    submit: () => node('settings-form').listeners.submit({ preventDefault() {} }),
    fireTimer() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.callback();
    },
  };
}

const current = { errors: { theme: 'Current error' }, effects: [{ label: 'Theme', effect: 'reload' }] };
const stale = { errors: { _form: 'Stale error' }, effects: [{ label: 'Old', effect: 'next-launch' }] };
function snapshot(f) {
  return JSON.stringify({ errors: f.state.errors, effects: f.state.effects,
    message: f.node('form-message').textContent, saveDisabled: f.node('save').disabled,
    summary: f.node('effect-summary').textContent });
}

test('older successful validation cannot overwrite a newer result', async () => {
  const f = await fixture();
  const older = f.validate(), newer = f.validate();
  f.requests[1].resolve(current); await newer;
  const expected = snapshot(f);
  f.requests[0].resolve(stale); await older;
  assert.equal(snapshot(f), expected);
});

test('older rejected validation cannot overwrite a newer result', async () => {
  const f = await fixture();
  const older = f.validate(), newer = f.validate();
  f.requests[1].resolve(current); await newer;
  const expected = snapshot(f);
  f.requests[0].reject(new Error('Stale rejection')); await older;
  assert.equal(snapshot(f), expected);
});

test('editing invalidates a response before the next debounce fires', async () => {
  const f = await fixture();
  const pending = f.validate();
  f.state.values.theme = 'dark'; f.scheduleValidation();
  const expected = snapshot(f);
  f.requests[0].resolve(stale); await pending;
  assert.equal(snapshot(f), expected);
  assert.equal(f.timers.size, 1);
});

test('120 ms debounce coalesces edits and clears its timer reference', async () => {
  const f = await fixture();
  f.scheduleValidation(); f.scheduleValidation();
  assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].delay, 120);
  f.fireTimer();
  assert.equal(f.state.validationTimer, null);
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve(current); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.state.errors.theme, 'Current error');
});

for (const outcome of ['resolve', 'reject']) {
  test(`save invalidates pending validation ${outcome} after baseline replacement`, async () => {
    const f = await fixture();
    f.state.values.theme = 'dark';
    const pending = f.validate();
    f.scheduleValidation();
    const saving = f.submit();
    assert.equal(f.timers.size, 0);
    assert.equal(f.state.validationTimer, null);
    await f.validate();
    assert.equal(f.requests.length, 1);
    f.saves[0].resolve({ valid: true, values: { theme: 'dark' }, errors: {}, effects: [] });
    await saving;
    assert.equal(f.state.baseline.theme, 'dark');
    const expected = snapshot(f);
    f.requests[0][outcome](outcome === 'resolve' ? stale : new Error('Old failure'));
    await pending;
    assert.equal(snapshot(f), expected);
  });
}

test('pending validation cannot update UI while save is in flight', async () => {
  const f = await fixture();
  f.state.values.theme = 'dark';
  const pending = f.validate(), saving = f.submit();
  const expected = snapshot(f);
  f.requests[0].resolve(stale); await pending;
  assert.equal(snapshot(f), expected);
  f.saves[0].resolve({ valid: false, errors: { theme: 'Save error' } }); await saving;
  assert.equal(f.state.errors.theme, 'Save error');
});

test('reset invalidates pending responses and cancels queued validation', async () => {
  const f = await fixture();
  f.state.values.theme = 'dark';
  const pending = f.validate();
  f.scheduleValidation(); f.restoreBaseline();
  assert.equal(f.timers.size, 0);
  assert.equal(f.state.values.theme, 'system');
  const expected = snapshot(f);
  f.requests[0].resolve(stale); await pending;
  assert.equal(snapshot(f), expected);
});

test('latest validation rejection still reports its error', async () => {
  const f = await fixture();
  const pending = f.validate();
  f.requests[0].reject(new Error('Current failure')); await pending;
  assert.equal(f.state.errors._form, 'Current failure');
  assert.equal(f.node('form-message').textContent, 'Settings could not be validated.');
});



test('busy covers debounce and validation and clears on rejection', async () => {
  const f = await fixture();
  f.state.values.theme = 'dark';
  f.scheduleValidation();
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'true');
  assert.equal(f.node('save').disabled, true);
  const pending = f.validate();
  f.requests[0].reject(new Error('Validation failure'));
  await pending;
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'false');
});

test('stale validation cannot clear the newer busy state', async () => {
  const f = await fixture();
  const older = f.validate(), newer = f.validate();
  f.requests[0].resolve(stale); await older;
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'true');
  f.requests[1].resolve(current); await newer;
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'false');
});

test('save announces progress outside the busy fields and focuses after enabling controls', async () => {
  const f = await fixture();
  f.state.values.theme = 'dark';
  let focused = false, scrolled = false;
  const control = {
    focus() { assert.equal(f.state.saving, false); focused = true; },
    scrollIntoView(options) { assert.equal(options.behavior, 'instant'); scrolled = true; },
  };
  f.node('settings-form').querySelector = selector => {
    assert.equal(selector, '[aria-invalid="true"]:not(:disabled)');
    return control;
  };
  const pending = f.submit();
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'true');
  assert.match(f.node('form-message').textContent, /Validating and saving/);
  f.saves[0].resolve({ valid: false, errors: { theme: 'Invalid' } }); await pending;
  assert.equal(focused, true); assert.equal(scrolled, true);
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'false');
});

test('save rejection focuses the status when no field error is available', async () => {
  const f = await fixture();
  const pending = f.submit();
  f.saves[0].reject(new Error('Disk error')); await pending;
  assert.equal(f.node('form-message').focused, true);
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'false');
});

test('successful save clears busy without moving focus', async () => {
  const f = await fixture();
  const pending = f.submit();
  f.saves[0].resolve({ valid: true, values: { theme: 'dark' }, effects: [] }); await pending;
  assert.equal(f.node('settings-sections').getAttribute('aria-busy'), 'false');
  assert.equal(f.node('form-message').focused, undefined);
});

test('navigation marks exactly one current link and removes the old marker', async () => {
  const f = await fixture();
  const links = ['#section-general', '#section-export'].map(hash => ({
    hash, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
  }));
  f.node('settings-nav').querySelectorAll = () => links;
  f.context.window.location = { hash: '#section-export' };
  vm.runInContext('updateCurrentSection()', f.context);
  assert.equal(links[1].attributes['aria-current'], 'location');
  assert.equal(links[0].attributes['aria-current'], undefined);
  f.context.window.location.hash = '';
  vm.runInContext('updateCurrentSection()', f.context);
  assert.equal(links[0].attributes['aria-current'], 'location');
  assert.equal(links[1].attributes['aria-current'], undefined);
});

test('small dialogs load named controls and reduced-motion responsive styles', () => {
  const read = name => fs.readFileSync(path.join(__dirname, '../renderer', name), 'utf8');
  for (const name of ['find-modal.html', 'prompt.html']) {
    const html = read(name);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /name="viewport"/);
    assert.match(html, /href="\.\/find-modal.css"/);
    assert.doesNotMatch(html, /<style>/);
  }
  const find = read('find-modal.html');
  for (const id of ['prev', 'next', 'clear', 'close', 'cancel-indexing']) {
    assert.match(find, new RegExp('id="' + id + '" aria-label="[^"]+"'));
  }
  assert.match(read('prompt.html'), /id="lbl" for="term"/);
  for (const name of ['settings.css', 'find-modal.css']) {
    assert.match(read(name), /prefers-reduced-motion: reduce/);
    assert.match(read(name), /flex-wrap: wrap/);
  }
  const html = read('settings.html');
  assert.match(html, /aria-atomic="true" tabindex="-1"/);
  assert.match(html, /id="settings-sections" aria-busy="false"/);
});
