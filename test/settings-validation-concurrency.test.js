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
