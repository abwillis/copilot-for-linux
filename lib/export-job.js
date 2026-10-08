'use strict';

const { EventEmitter } = require('events');

const EXPORT_JOB_PHASES = Object.freeze([
  'locate',
  'hydrate',
  'expand',
  'capture',
  'validate',
  'transform',
  'render',
  'write',
]);

class ExportCancelledError extends Error {
  constructor(message = 'Export cancelled') {
    super(message);
    this.name = 'ExportCancelledError';
    this.code = 'EXPORT_CANCELLED';
  }
}

function stableOptionsKey(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableOptionsKey).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableOptionsKey(value[key])}`).join(',')}}`;
}

class ConversationSnapshot {
  constructor(value = {}) {
    this.cleanSemanticHtml = String(value.cleanSemanticHtml || '');
    this.rawHtml = value.rawHtml === undefined || value.rawHtml === null
      ? null
      : String(value.rawHtml);
    this.plainText = String(value.plainText || '');
    this.messageFingerprints = Object.freeze([...(value.messageFingerprints || [])]);
    this.orderFingerprints = Object.freeze([...(value.orderFingerprints || value.messageFingerprints || [])]);
    this.title = String(value.title || 'Conversation');
    this.url = String(value.url || '');
    this.capturedAt = String(value.capturedAt || new Date().toISOString());
    this.theme = Object.freeze({ ...(value.theme || {}) });
    this.sourceMetadata = Object.freeze({ ...(value.sourceMetadata || {}) });
    this.materializedImageMap = Object.freeze({ ...(value.materializedImageMap || {}) });
    this.completeness = Object.freeze({ ...(value.completeness || {}) });
    this.captureStatus = String(value.captureStatus || 'complete');
    this.warnings = Object.freeze([...(value.warnings || [])]);
    this.cacheIdentity = Object.freeze({ ...(value.cacheIdentity || {}) });
    Object.freeze(this);
  }
}

class ConversationSnapshotCache {
  constructor() {
    this.byOwner = new WeakMap();
  }

  buildKey(identity = {}) {
    return stableOptionsKey({
      conversationIdentity: identity.conversationIdentity || identity.url || '',
      url: identity.url || '',
      expansionOptions: identity.expansionOptions || {},
      includeRaw: identity.includeRaw === true,
    });
  }

  get(owner, identity = {}) {
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) return null;
    const bucket = this.byOwner.get(owner);
    if (!bucket) return null;
    const entry = bucket.get(this.buildKey(identity));
    if (!entry) return null;
    if (Number(entry.mutationRevision) !== Number(identity.mutationRevision)) return null;
    return entry.snapshot || null;
  }

  set(owner, identity = {}, snapshot) {
    if (!owner || (typeof owner !== 'object' && typeof owner !== 'function')) return snapshot;
    let bucket = this.byOwner.get(owner);
    if (!bucket) {
      bucket = new Map();
      this.byOwner.set(owner, bucket);
    }
    bucket.set(this.buildKey(identity), {
      mutationRevision: Number(identity.mutationRevision || 0),
      snapshot,
      storedAt: Date.now(),
    });
    return snapshot;
  }

  invalidate(owner) {
    if (owner) this.byOwner.delete(owner);
  }
}

class ExportJob extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = String(options.id || `export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.controller = options.controller || new AbortController();
    this.signal = this.controller.signal;
    this.handlers = { ...(options.handlers || {}) };
    this.messages = { ...(options.messages || {}) };
    this.context = { ...(options.context || {}) };
    this.startedAt = 0;
    this.phase = 'idle';
    this.phaseStartedAt = 0;
    this.progress = null;
    this.warnings = [];
    this.results = {};
    this.cleanupStack = [];
    this.reportProgress = typeof options.reportProgress === 'function'
      ? options.reportProgress
      : async () => {};
  }

  abort(reason = 'Export cancelled') {
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  throwIfCancelled() {
    if (!this.signal.aborted) return;
    const reason = this.signal.reason;
    throw reason instanceof Error ? reason : new ExportCancelledError(String(reason || 'Export cancelled'));
  }

  addWarning(warning) {
    const message = String(warning || '').trim();
    if (message && !this.warnings.includes(message)) this.warnings.push(message);
  }

  addCleanup(cleanup) {
    if (typeof cleanup === 'function') this.cleanupStack.push(cleanup);
  }

  elapsedMs() {
    return this.startedAt ? Date.now() - this.startedAt : 0;
  }

  async updateProgress(message, data = {}) {
    const payload = {
      jobId: this.id,
      phase: this.phase,
      message: String(message || this.messages[this.phase] || this.phase),
      elapsedMs: this.elapsedMs(),
      phaseElapsedMs: this.phaseStartedAt ? Date.now() - this.phaseStartedAt : 0,
      cancellable: true,
      warnings: [...this.warnings],
      data: data && typeof data === 'object' ? data : {},
    };
    this.progress = payload;
    this.emit('progress', payload);
    await this.reportProgress(payload);
    return payload;
  }

  async runPhase(phase) {
    this.throwIfCancelled();
    this.phase = phase;
    this.phaseStartedAt = Date.now();
    await this.updateProgress(this.messages[phase] || phase);
    const handler = this.handlers[phase];
    if (typeof handler !== 'function') {
      const skipped = { skipped: true };
      this.results[phase] = skipped;
      return skipped;
    }
    let heartbeatBusy = false;
    const heartbeat = setInterval(async () => {
      if (heartbeatBusy || this.phase !== phase) return;
      heartbeatBusy = true;
      try { await this.updateProgress(this.messages[phase] || phase); } catch {}
      heartbeatBusy = false;
    }, 1000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    let result;
    try {
      result = await handler(this);
    } finally {
      clearInterval(heartbeat);
    }
    this.throwIfCancelled();
    this.results[phase] = result === undefined ? null : result;
    if (result && Array.isArray(result.warnings)) {
      result.warnings.forEach(warning => this.addWarning(warning));
    }
    await this.updateProgress(this.messages[phase] || phase, { complete: true });
    return result;
  }

  async cleanup() {
    const failures = [];
    while (this.cleanupStack.length) {
      const cleanup = this.cleanupStack.pop();
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      failures.forEach(error => this.addWarning(`Cleanup failed: ${String(error?.message || error)}`));
    }
    return failures;
  }

  async run() {
    if (this.startedAt) throw new Error('ExportJob instances can only run once');
    this.startedAt = Date.now();
    this.emit('start', { jobId: this.id, startedAt: this.startedAt });
    try {
      for (const phase of EXPORT_JOB_PHASES) await this.runPhase(phase);
      this.phase = 'complete';
      const result = {
        ok: true,
        jobId: this.id,
        elapsedMs: this.elapsedMs(),
        warnings: [...this.warnings],
        results: { ...this.results },
        context: this.context,
      };
      this.emit('complete', result);
      return result;
    } catch (error) {
      const cancelled = error instanceof ExportCancelledError || error?.code === 'EXPORT_CANCELLED' || this.signal.aborted;
      const finalError = cancelled && !(error instanceof ExportCancelledError)
        ? new ExportCancelledError(String(error?.message || this.signal.reason || 'Export cancelled'))
        : error;
      this.phase = cancelled ? 'cancelled' : 'failed';
      this.emit(this.phase, finalError);
      throw finalError;
    } finally {
      await this.cleanup();
      this.emit('cleanup', { jobId: this.id, elapsedMs: this.elapsedMs(), warnings: [...this.warnings] });
    }
  }
}

module.exports = {
  EXPORT_JOB_PHASES,
  ExportCancelledError,
  ConversationSnapshot,
  ConversationSnapshotCache,
  ExportJob,
  stableOptionsKey,
};
