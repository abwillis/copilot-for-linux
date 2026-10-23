'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const agentSource = fs.readFileSync(
  path.join(__dirname, '..', 'renderer', 'agent.js'),
  'utf8'
);
const chatDom = require('../app-specific/chat-dom');

function splitSelectorList(value) {
  const parts = [];
  let current = '';
  let bracketDepth = 0;
  let parenDepth = 0;
  let quote = '';
  for (const char of String(value || '')) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth--;
    if (char === '(') parenDepth++;
    if (char === ')') parenDepth--;
    if (char === ',' && bracketDepth === 0 && parenDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitDescendantSelector(value) {
  const parts = [];
  let current = '';
  let bracketDepth = 0;
  let quote = '';
  for (const char of String(value || '').trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === '[') bracketDepth++;
    if (char === ']') bracketDepth--;
    if (/\s/.test(char) && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function parseAttributeExpression(expression) {
  const match = String(expression).trim().match(
    /^([^\s~|^$*!=]+)\s*(?:(\^=|\$=|\*=|~=|=)\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*(i)?)?$/i
  );
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    operator: match[2] || '',
    value: match[3] ?? match[4] ?? match[5] ?? '',
    insensitive: !!match[6],
  };
}

function matchesAttribute(element, expression) {
  const parsed = parseAttributeExpression(expression);
  if (!parsed) return false;
  if (!element.hasAttribute(parsed.name)) return false;
  if (!parsed.operator) return true;
  let actual = String(element.getAttribute(parsed.name) ?? '');
  let expected = String(parsed.value);
  if (parsed.insensitive) {
    actual = actual.toLowerCase();
    expected = expected.toLowerCase();
  }
  if (parsed.operator === '=') return actual === expected;
  if (parsed.operator === '*=') return actual.includes(expected);
  if (parsed.operator === '^=') return actual.startsWith(expected);
  if (parsed.operator === '$=') return actual.endsWith(expected);
  if (parsed.operator === '~=') return actual.split(/\s+/).includes(expected);
  return false;
}

function matchesSimpleSelector(element, selector) {
  let source = String(selector || '').trim();
  if (!source) return false;
  if (source === '*') return true;
  if (source.includes(':')) return false;

  const attributes = [];
  source = source.replace(/\[([^\]]+)\]/g, (_, expression) => {
    attributes.push(expression);
    return '';
  });
  if (!attributes.every(expression => matchesAttribute(element, expression))) return false;

  const ids = [];
  source = source.replace(/#([A-Za-z0-9_-]+)/g, (_, id) => {
    ids.push(id);
    return '';
  });
  if (ids.some(id => element.id !== id)) return false;

  const classes = [];
  source = source.replace(/\.([A-Za-z0-9_-]+)/g, (_, className) => {
    classes.push(className);
    return '';
  });
  const actualClasses = String(element.className || '').split(/\s+/).filter(Boolean);
  if (classes.some(className => !actualClasses.includes(className))) return false;

  const tag = source.trim();
  return !tag || tag === '*' || element.tagName.toLowerCase() === tag.toLowerCase();
}

function matchesComplexSelector(element, selector) {
  const parts = splitDescendantSelector(selector);
  if (!parts.length || !matchesSimpleSelector(element, parts[parts.length - 1])) return false;
  let ancestor = element.parentElement;
  for (let index = parts.length - 2; index >= 0; index--) {
    while (ancestor && !matchesSimpleSelector(ancestor, parts[index])) {
      ancestor = ancestor.parentElement;
    }
    if (!ancestor) return false;
    ancestor = ancestor.parentElement;
  }
  return true;
}

class FixtureElement {
  constructor(tagName, attrs = {}, text = '') {
    this.nodeType = 1;
    this.tagName = String(tagName || 'div').toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentElement = null;
    this.parentNode = null;
    this.ownerDocument = null;
    this._text = String(text || '');
    // Inline style bag. Overlay code assigns style.cssText; computed styles
    // still come from window.getComputedStyle() and data-* attributes.
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.disabled = false;
    this.readOnly = false;
    Object.entries(attrs || {}).forEach(([name, value]) => this.attributes.set(name.toLowerCase(), String(value)));
  }

  get id() { return this.getAttribute('id') || ''; }
  set id(value) { this.setAttribute('id', value); }
  get className() { return this.getAttribute('class') || ''; }
  set className(value) { this.setAttribute('class', value); }
  get childNodes() { return this.children; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { return this.children[this.children.length - 1] || null; }
  get isContentEditable() { return this.getAttribute('contenteditable') === 'true'; }
  get tabIndex() {
    if (this.hasAttribute('tabindex')) return Number(this.getAttribute('tabindex'));
    if (this.tagName === 'TEXTAREA' || this.isContentEditable) return 0;
    return -1;
  }
  get isConnected() {
    let node = this;
    while (node && node.parentElement) node = node.parentElement;
    return !!(this.ownerDocument && node === this.ownerDocument.documentElement);
  }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this._text = String(value ?? '');
    this.ownerDocument?._notify(this, { type: 'childList', target: this });
  }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }

  getAttribute(name) {
    const key = String(name).toLowerCase();
    return this.attributes.has(key) ? this.attributes.get(key) : null;
  }
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    this.attributes.set(key, String(value));
    this.ownerDocument?._notify(this, { type: 'attributes', target: this, attributeName: key });
  }
  removeAttribute(name) {
    const key = String(name).toLowerCase();
    if (!this.attributes.delete(key)) return;
    this.ownerDocument?._notify(this, { type: 'attributes', target: this, attributeName: key });
  }
  hasAttribute(name) { return this.attributes.has(String(name).toLowerCase()); }

  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    if (this.ownerDocument) this.ownerDocument._adopt(child);
    this.ownerDocument?._notify(this, { type: 'childList', target: this, addedNodes: [child], removedNodes: [] });
    return child;
  }
  remove() {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentElement = null;
    this.parentNode = null;
    parent.ownerDocument?._notify(parent, { type: 'childList', target: parent, addedNodes: [], removedNodes: [this] });
  }
  removeChild(child) {
    if (!child || child.parentElement !== this) throw new Error('NotFoundError: node is not a child');
    child.remove();
    return child;
  }
  replaceWith(...nodes) {
    const parent = this.parentElement;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    this.parentElement = null;
    this.parentNode = null;
    const replacements = nodes.filter(node => node && node.nodeType === 1);
    replacements.forEach(node => {
      if (node.parentElement) node.remove();
      node.parentElement = parent;
      node.parentNode = parent;
      parent.ownerDocument?._adopt(node);
    });
    parent.children.splice(index, 1, ...replacements);
    parent.ownerDocument?._notify(parent, {
      type: 'childList', target: parent, addedNodes: replacements, removedNodes: [this]
    });
  }
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parentElement;
    }
    return false;
  }
  matches(selector) {
    return splitSelectorList(selector).some(part => matchesComplexSelector(this, part));
  }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => {
      for (const child of node.children) {
        if (child.matches(selector)) result.push(child);
        visit(child);
      }
    };
    visit(this);
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches && node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  compareDocumentPosition(other) {
    if (!this.ownerDocument || this.ownerDocument !== other.ownerDocument) return 1;
    const nodes = this.ownerDocument._allElements();
    return nodes.indexOf(this) < nodes.indexOf(other) ? 4 : 2;
  }
  getBoundingClientRect() {
    if (this.getAttribute('data-hidden') === 'true') {
      return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    }
    const nodes = this.ownerDocument ? this.ownerDocument._allElements() : [];
    const top = Math.max(0, nodes.indexOf(this)) * 20;
    return { width: 800, height: 40, top, left: 0, right: 800, bottom: top + 40 };
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  cloneNode(deep) {
    const clone = new FixtureElement(this.tagName, Object.fromEntries(this.attributes), this._text);
    clone.scrollHeight = this.scrollHeight;
    clone.clientHeight = this.clientHeight;
    if (deep) this.children.forEach(child => clone.appendChild(child.cloneNode(true)));
    return clone;
  }
}

class FixtureDocument {
  constructor(bodySpec) {
    this._observers = new Set();
    this.querySelectorAllCalls = 0;
    this.title = 'DOM adapter fixture';
    this.documentElement = new FixtureElement('html');
    this.body = new FixtureElement('body');
    this._adopt(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.scrollingElement = null;
    for (const child of (bodySpec && bodySpec.children) || []) {
      this.body.appendChild(this.createFromSpec(child));
    }
  }

  _adopt(node) {
    node.ownerDocument = this;
    for (const child of node.children) this._adopt(child);
  }
  _allElements() {
    const result = [];
    const visit = node => {
      result.push(node);
      node.children.forEach(visit);
    };
    visit(this.documentElement);
    return result;
  }
  _notify(target, record) {
    for (const observer of this._observers) observer._enqueue(target, record);
  }
  _register(observer) { this._observers.add(observer); }
  _unregister(observer) { this._observers.delete(observer); }
  createFromSpec(spec) {
    const element = new FixtureElement(spec.tag || 'div', spec.attrs || {}, spec.text || '');
    if (spec.scroll) {
      element.scrollHeight = Number(spec.scroll.scrollHeight || 0);
      element.clientHeight = Number(spec.scroll.clientHeight || 0);
      element.scrollTop = Number(spec.scroll.scrollTop || 0);
    }
    for (const child of spec.children || []) element.appendChild(this.createFromSpec(child));
    return element;
  }
  createElement(tagName) {
    const element = new FixtureElement(tagName);
    this._adopt(element);
    return element;
  }
  querySelectorAll(selector) {
    this.querySelectorAllCalls++;
    return this._allElements().filter(element => element.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  getElementById(id) { return this._allElements().find(element => element.id === id) || null; }
  resetQuerySelectorAllCalls() { this.querySelectorAllCalls = 0; }
  get images() { return []; }
}

function createMutationObserverClass(document) {
  return class FixtureMutationObserver {
    constructor(callback) {
      this.callback = callback;
      this.target = null;
      this.options = null;
      this.records = [];
      this.scheduled = false;
    }
    observe(target, options) {
      this.target = target;
      this.options = options || {};
      document._register(this);
    }
    disconnect() {
      document._unregister(this);
      this.target = null;
      this.records = [];
    }
    _enqueue(target, record) {
      if (!this.target || !this.options) return;
      const inScope = target === this.target || (this.options.subtree && this.target.contains(target));
      if (!inScope || !this.options[record.type]) return;
      if (
        record.type === 'attributes' &&
        Array.isArray(this.options.attributeFilter) &&
        !this.options.attributeFilter.includes(record.attributeName)
      ) return;
      this.records.push(record);
      if (this.scheduled) return;
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        if (!this.target || !this.records.length) return;
        const records = this.records.splice(0);
        this.callback(records, this);
      });
    }
  };
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'test', 'fixtures', 'dom-adapter', name),
    'utf8'
  ));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function defaultAgentConfig(contract) {
  return {
    chatRootSelectors: chatDom.CHAT_ROOT_SELECTORS.slice(),
    virtualizerSelectors: chatDom.VIRTUALIZER_SELECTORS.slice(),
    chatInputSelectors: chatDom.CHAT_INPUT_SELECTORS.slice(),
    scoreRules: deepClone(chatDom.DOM_SCORE_RULES),
    collectionSelectors: chatDom.DOM_COLLECTION_SELECTORS.slice(),
    roleSelectors: deepClone(chatDom.DOM_ROLE_SELECTORS),
    answerMarker: chatDom.ANSWER_MARKER,
    answerLeadingLabels: chatDom.ANSWER_LEADING_LABELS.slice(),
    collectionKeyAttributes: chatDom.DOM_COLLECTION_KEY_ATTRIBUTES.slice(),
    collectionRowSelectors: chatDom.DOM_COLLECTION_ROW_SELECTORS.slice(),
    collectionExcludeSelectors: chatDom.DOM_COLLECTION_EXCLUDE_SELECTORS.slice(),
    domAdapterContract: deepClone(contract || chatDom.DOM_ADAPTER_CONTRACT),
  };
}

function createHarness(fixtureOrName, options = {}) {
  const fixture = typeof fixtureOrName === 'string' ? loadFixture(fixtureOrName) : deepClone(fixtureOrName);
  const document = new FixtureDocument(fixture.body || { children: [] });
  const MutationObserver = createMutationObserverClass(document);
  const window = {
    document,
    MutationObserver,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    getComputedStyle(element) {
      return { overflowY: element.getAttribute('data-overflow-y') || 'visible' };
    },
  };
  window.window = window;
  window.self = window;
  window.Element = FixtureElement;
  document.defaultView = window;

  const context = vm.createContext({
    window,
    document,
    MutationObserver,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    console,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    Date,
    RegExp,
    JSON,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isFinite,
  });
  vm.runInContext(agentSource, context, { filename: 'renderer/agent.js' });
  const api = window.__appRenderer;
  const config = options.config || defaultAgentConfig(options.contract);
  api.init(config);

  return {
    api,
    document,
    window,
    fixture,
    createElement(spec) {
      const element = document.createFromSpec(spec);
      document._adopt(element);
      return element;
    },
    async settle(ms = 0) {
      await new Promise(resolve => setTimeout(resolve, ms));
    },
    dispose() {
      try { api.stopComposerTracking(); } catch {}
      for (const observer of Array.from(document._observers)) observer.disconnect();
    },
  };
}

module.exports = {
  chatDom,
  createHarness,
  deepClone,
  defaultAgentConfig,
  loadFixture,
};
