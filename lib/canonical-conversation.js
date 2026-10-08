'use strict';

// Disk-backed canonical conversation store (export engine v2).
//
// Every logical turn is identified by a renderer-computed key (stable message
// id, ordinal, or a leading-text fingerprint for anonymous turns) and its
// richest observed HTML is persisted to a temp file, so the whole
// conversation is never held in memory or sent through one IPC message.
//
// Ordering is derived from overlapping, top-to-bottom ordered batches: a turn
// first seen in a batch is inserted directly after the nearest preceding turn
// of that batch that is already known. Because the traversal only advances
// when consecutive batches share at least one turn (see
// lib/conversation-capture.js), this merge reproduces the conversation order
// without relying on pixel geometry, which a dynamic virtualizer rewrites
// continuously.

const fs = require('fs');
const os = require('os');
const path = require('path');

function safeNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sanitizeFilePart(value) {
  return String(value || '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 120) || 'turn';
}

function roleKey(record) {
  return String(record?.role || 'unknown').toLowerCase();
}

function logicalAnchorKey(record) {
  const sourceKey = String(record?.sourceKey || '').trim();
  if (sourceKey) return `source:${sourceKey}`;
  const ordinal = safeNumber(record?.ordinal);
  return ordinal !== null && ordinal >= 0 ? `ordinal:${roleKey(record)}:${ordinal}` : '';
}

function candidateScore(record) {
  return Number(record?.textLength || 0) * 8 +
    Number(record?.htmlLength || String(record?.html || '').length || 0) +
    Number(record?.preservedContentCount || 0) * 2048;
}

function mergeIntervals(intervals) {
  const sorted = (intervals || [])
    .map(item => [Math.max(0, Number(item[0] || 0)), Math.max(0, Number(item[1] || 0))])
    .filter(item => item[1] >= item[0])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const current of sorted) {
    const previous = merged[merged.length - 1];
    if (!previous || current[0] > previous[1] + 2) merged.push(current.slice());
    else previous[1] = Math.max(previous[1], current[1]);
  }
  return merged;
}

// Diagnostic only. Pixel coverage is NOT a completeness criterion: a dynamic
// virtualizer re-measures rows while it is walked, so offsets recorded early
// in a pass do not describe the final scroll range.
function intervalCoverage(intervals, range, clientHeight) {
  const total = Math.max(0, Number(range || 0)) + Math.max(0, Number(clientHeight || 0));
  if (total <= 0) return { coveredPx: 0, totalPx: 0, gapPx: 0, coveragePct: 100 };
  const merged = mergeIntervals(intervals);
  let covered = 0;
  let cursor = 0;
  let largestGap = 0;
  for (const [start, end] of merged) {
    const boundedStart = Math.max(0, Math.min(total, start));
    const boundedEnd = Math.max(0, Math.min(total, end));
    largestGap = Math.max(largestGap, Math.max(0, boundedStart - cursor));
    if (boundedEnd > cursor) {
      covered += boundedEnd - Math.max(cursor, boundedStart);
      cursor = boundedEnd;
    }
  }
  largestGap = Math.max(largestGap, Math.max(0, total - cursor));
  return {
    coveredPx: Math.round(covered),
    totalPx: Math.round(total),
    gapPx: Math.round(largestGap),
    coveragePct: Math.min(100, Math.round((covered / total) * 10000) / 100),
  };
}

class CanonicalConversationStore {
  static async create(options = {}) {
    const tempRoot = String(options.tempRoot || os.tmpdir());
    const prefix = sanitizeFilePart(options.prefix || 'conversation-export');
    const directory = await fs.promises.mkdtemp(path.join(tempRoot, `${prefix}-`));
    return new CanonicalConversationStore(directory);
  }

  constructor(directory) {
    this.directory = directory;
    this.turnDirectory = path.join(directory, 'turns');
    this.incomingDirectory = path.join(directory, 'incoming');
    this.entries = new Map();
    this.order = [];
    this.sequence = 0;
    this.passes = [];
    this.activePass = null;
    this.previousKeys = null;
    this.expectedTotal = 0;
    this.expectedTotalObservations = new Map();
    this.continuityBreaks = 0;
    this.disposed = false;
  }

  async initialize() {
    await fs.promises.mkdir(this.turnDirectory, { recursive: true });
    await fs.promises.mkdir(this.incomingDirectory, { recursive: true });
    return this;
  }

  beginPass(kind = 'capture') {
    if (this.activePass) throw new Error('A capture pass is already active.');
    this.activePass = {
      index: this.passes.length,
      kind: kind === 'verify' ? 'verify' : 'capture',
      startedAt: Date.now(),
      batches: 0,
      newTurns: 0,
      updatedTurns: 0,
      seen: new Set(),
      intervals: [],
      clientHeight: 0,
      endRange: 0,
      reachedStart: false,
      reachedEnd: false,
      continuityBreaks: 0,
      backtracks: 0,
    };
    this.previousKeys = null;
    return this.activePass;
  }

  // True when the batch shares at least one turn with the previous batch of
  // the active pass (or is the first batch of the pass).
  hasContinuity(refs) {
    if (!this.previousKeys) return true;
    const list = Array.isArray(refs) ? refs : [];
    if (!list.length) return this.previousKeys.size === 0;
    return list.some(ref => this.previousKeys.has(String(ref?.key || '')));
  }

  noteBacktrack() {
    if (this.activePass) this.activePass.backtracks += 1;
  }

  async _replaceFileFromTemporary(tempPath, finalPath) {
    // Node's rename contract replaces an existing file. Keeping the temporary
    // file beside the destination makes that replacement atomic on supported
    // local filesystems and avoids a remove-then-rename gap on every platform.
    await fs.promises.rename(tempPath, finalPath);
  }

  async _writeRaw(entry, html) {
    const fileName = `${String(entry.sequence).padStart(8, '0')}-${sanitizeFilePart(entry.key)}.html`;
    const finalPath = path.join(this.turnDirectory, fileName);
    const tempPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, String(html || ''), {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await this._replaceFileFromTemporary(tempPath, finalPath);
      entry.rawPath = finalPath;
      entry.htmlLength = String(html || '').length;
    } finally {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
    }
  }

  _resolveIncomingPath(stagedPath) {
    const incomingRoot = path.resolve(this.incomingDirectory);
    const resolved = path.resolve(String(stagedPath || ''));
    const relative = path.relative(incomingRoot, resolved);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Conversation capture attempted to access a file outside its incoming directory.');
    }
    return resolved;
  }

  async _installStagedRaw(entry, stagedPath, htmlLength) {
    const resolved = this._resolveIncomingPath(stagedPath);
    const sourceStat = await fs.promises.lstat(resolved);
    if (!sourceStat.isFile() || sourceStat.size <= 0) {
      throw new Error('Conversation capture produced an empty staged turn.');
    }
    const fileName = `${String(entry.sequence).padStart(8, '0')}-${sanitizeFilePart(entry.key)}.html`;
    const finalPath = path.join(this.turnDirectory, fileName);
    const nextPath = `${finalPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.next`;
    try {
      await fs.promises.copyFile(resolved, nextPath, fs.constants.COPYFILE_EXCL);
      const nextStat = await fs.promises.stat(nextPath);
      if (nextStat.size !== sourceStat.size) throw new Error('Staged conversation turn copy was truncated.');
      await this._replaceFileFromTemporary(nextPath, finalPath);
      entry.rawPath = finalPath;
      entry.htmlLength = Number(htmlLength || sourceStat.size);
    } finally {
      await fs.promises.rm(nextPath, { force: true }).catch(() => {});
      await fs.promises.rm(resolved, { force: true }).catch(() => {});
    }
  }

  async _writeRecordRaw(entry, record) {
    if (record?.stagedPath) {
      await this._installStagedRaw(entry, record.stagedPath, record.htmlLength);
      return;
    }
    await this._writeRaw(entry, record?.html);
  }

  // Delete only files created in this store's incoming directory. Records are
  // untrusted metadata from the page, so a stagedPath outside that directory
  // is ignored rather than passed to rm().
  async discardStagedRecords(records) {
    for (const record of Array.isArray(records) ? records : []) {
      if (!record?.stagedPath) continue;
      let stagedPath = '';
      try {
        stagedPath = this._resolveIncomingPath(record.stagedPath);
      } catch {
        continue;
      }
      await fs.promises.rm(stagedPath, { force: true }).catch(() => {});
    }
  }

  _insertOrdered(key, batchKeys, indexInBatch) {
    if (this.order.includes(key)) return;
    for (let i = indexInBatch - 1; i >= 0; i -= 1) {
      const at = this.order.indexOf(batchKeys[i]);
      if (at >= 0) { this.order.splice(at + 1, 0, key); return; }
    }
    for (let i = indexInBatch + 1; i < batchKeys.length; i += 1) {
      const at = this.order.indexOf(batchKeys[i]);
      if (at >= 0) { this.order.splice(at, 0, key); return; }
    }
    this.order.push(key);
  }

  async ingestBatch(batch = {}, options = {}) {
    const pass = this.activePass;
    if (!pass) throw new Error('beginPass() must be called before ingestBatch().');
    const refs = Array.isArray(batch.refs) ? batch.refs.filter(ref => ref && ref.key) : [];
    const recordList = (Array.isArray(batch.records) ? batch.records : [])
      .filter(record => record && record.key);
    const records = new Map(recordList.map(record => [String(record.key), record]));
    const continuity = this.hasContinuity(refs);
    if (!continuity) {
      pass.continuityBreaks += 1;
      this.continuityBreaks += 1;
    }
    pass.batches += 1;
    const clientHeight = Number(batch.clientHeight || 0);
    const top = Math.max(0, Number(batch.scrollTop || 0));
    pass.clientHeight = Math.max(pass.clientHeight, clientHeight);
    pass.endRange = Math.max(0, Number(batch.range || 0));
    pass.intervals.push([top, top + clientHeight]);
    if (batch.atTop === true) pass.reachedStart = true;
    if (batch.atBottom === true) pass.reachedEnd = true;

    const batchKeys = refs.map(ref => String(ref.key));
    let newTurns = 0;
    try {
      for (let index = 0; index < refs.length; index += 1) {
        const ref = refs[index];
        const key = String(ref.key);
        const record = records.get(key);
        const setSize = safeNumber(ref.setSize, 0);
        if (setSize > 0) {
          if (setSize > this.expectedTotal) this.expectedTotal = setSize;
          this.expectedTotalObservations.set(
            setSize,
            Number(this.expectedTotalObservations.get(setSize) || 0) + 1
          );
        }
        let entry = this.entries.get(key);
        if (!entry) {
          const hasInline = !!String(record?.html || '').trim();
          const hasStaged = !!(record?.stagedPath && Number(record?.htmlLength || 0) > 0);
          if (!record || (!hasInline && !hasStaged)) continue; // renderer had nothing to send
          this.sequence += 1;
          entry = {
            key,
            sequence: this.sequence,
            sourceKey: String(record.sourceKey || ''),
            ordinal: safeNumber(record.ordinal),
            setSize: safeNumber(record.setSize),
            role: roleKey(record),
            fingerprint: String(record.fingerprint || ''),
            textLength: Number(record.textLength || 0),
            preservedContentCount: Number(record.preservedContentCount || 0),
            score: candidateScore(record),
            firstSeenPass: pass.index,
            seenPasses: new Set(),
            rawPath: '',
            htmlLength: 0,
          };
          entry.logicalAnchor = logicalAnchorKey(entry);
          await this._writeRecordRaw(entry, record);
          this.entries.set(key, entry);
          this._insertOrdered(key, batchKeys, index);
          pass.newTurns += 1;
          newTurns += 1;
        } else if (record && candidateScore(record) > entry.score) {
          // Do not publish richer metadata until its file replacement succeeds.
          // Otherwise a failed write leaves the manifest describing bytes that
          // were never committed (and, before the atomic replacement above,
          // could also leave the previous bytes deleted).
          const replacement = {
            ...entry,
            sourceKey: String(record.sourceKey || entry.sourceKey || ''),
            role: record.role ? roleKey(record) : entry.role,
            fingerprint: String(record.fingerprint || entry.fingerprint),
            textLength: Number(record.textLength || entry.textLength || 0),
            preservedContentCount: Number(record.preservedContentCount || entry.preservedContentCount || 0),
            ordinal: safeNumber(record.ordinal, entry.ordinal),
            setSize: safeNumber(record.setSize, entry.setSize),
            score: candidateScore(record),
          };
          replacement.logicalAnchor = logicalAnchorKey(replacement);
          await this._writeRecordRaw(replacement, record);
          Object.assign(entry, replacement);
          pass.updatedTurns += 1;
        }
        entry.seenPasses.add(pass.index);
        pass.seen.add(key);
      }
    } finally {
      // Adopted staged files have already been removed by _installStagedRaw().
      // This also cleans redundant, duplicate-key, and unreferenced records.
      await this.discardStagedRecords(recordList);
    }
    this.previousKeys = new Set(batchKeys.filter(key => this.entries.has(key)));
    return { continuity, newTurns, totalTurns: this.entries.size, batchTurnCount: refs.length };
  }

  endPass(extra = {}) {
    const pass = this.activePass;
    if (!pass) throw new Error('No capture pass is active.');
    pass.finishedAt = Date.now();
    pass.elapsedMs = pass.finishedAt - pass.startedAt;
    pass.terminalStableSamples = Number(extra.terminalStableSamples || 0);
    pass.stuck = extra.stuck === true;
    pass.coverage = intervalCoverage(pass.intervals, pass.endRange, pass.clientHeight);
    pass.seenCount = pass.seen.size;
    pass.unseenKnownTurns = this.entries.size - pass.seen.size;
    delete pass.seen;
    delete pass.intervals;
    this.passes.push(pass);
    this.activePass = null;
    this.previousKeys = null;
    return pass;
  }

  dominantExpectedTotal() {
    const best = Array.from(this.expectedTotalObservations.entries())
      .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
    return best ? best[0] : this.expectedTotal;
  }

  ordinalsComplete() {
    const list = Array.from(this.entries.values());
    if (!list.length || list.some(entry => entry.ordinal === null)) return false;
    const ordinals = Array.from(new Set(list.map(entry => entry.ordinal))).sort((a, b) => a - b);
    if (ordinals.length !== list.length) return false;
    for (let i = 1; i < ordinals.length; i += 1) {
      if (ordinals[i] !== ordinals[i - 1] + 1) return false;
    }
    const expectedTotal = this.dominantExpectedTotal();
    if (expectedTotal > 0 && ordinals.length !== expectedTotal) return false;
    return true;
  }

  _orderedEntries() {
    const list = this.order.map(key => this.entries.get(key)).filter(Boolean);
    const allOrdinal = list.length && list.every(entry => entry.ordinal !== null) &&
      new Set(list.map(entry => entry.ordinal)).size === list.length;
    if (allOrdinal) return list.slice().sort((a, b) => a.ordinal - b.ordinal);
    return list;
  }

  buildManifest() {
    if (this.activePass) throw new Error('Cannot build a manifest during an active pass.');
    const ordered = this._orderedEntries();
    return {
      version: 2,
      directory: this.directory,
      turnCount: ordered.length,
      expectedTotal: this.dominantExpectedTotal(),
      expectedTotalObservations: Object.fromEntries(this.expectedTotalObservations),
      continuityBreaks: this.continuityBreaks,
      ordinalsComplete: this.ordinalsComplete(),
      entries: ordered.map(entry => ({
        key: entry.key,
        sequence: entry.sequence,
        sourceKey: entry.sourceKey,
        ordinal: entry.ordinal,
        setSize: entry.setSize,
        role: entry.role,
        fingerprint: entry.fingerprint,
        logicalAnchor: entry.logicalAnchor,
        textLength: entry.textLength,
        preservedContentCount: entry.preservedContentCount,
        rawPath: entry.rawPath,
        htmlLength: entry.htmlLength,
        seenPasses: Array.from(entry.seenPasses).sort((a, b) => a - b),
      })),
      passes: this.passes.map(pass => ({ ...pass })),
    };
  }

  async readRaw(entry) {
    return fs.promises.readFile(entry.rawPath, 'utf8');
  }

  async createStageFile(name) {
    const target = path.join(this.directory, sanitizeFilePart(name));
    await fs.promises.writeFile(target, '');
    return target;
  }

  async createIncomingFile(name) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const target = path.join(
        this.incomingDirectory,
        `${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${sanitizeFilePart(name)}.html`
      );
      let handle = null;
      let created = false;
      try {
        handle = await fs.promises.open(target, 'wx', 0o600);
        created = true;
        await handle.close();
        handle = null;
        return target;
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (created) await fs.promises.rm(target, { force: true }).catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    throw new Error('Could not allocate a unique incoming conversation file.');
  }

  async dispose() {
    if (this.disposed) return;
    await fs.promises.rm(this.directory, { recursive: true, force: true });
    // Mark disposal complete only after removal succeeds so a transient Windows
    // file lock does not make the leaked temp tree permanently non-retryable.
    this.disposed = true;
  }
}

async function createCanonicalConversationStore(options = {}) {
  const store = await CanonicalConversationStore.create(options);
  return store.initialize();
}

// Completeness is judged on identity, not pixels.
//   failures - conditions under which turns may be missing or misordered.
//   warnings - informational; never block an export on their own.
function validateCanonicalCapture(manifest, options = {}) {
  const failures = [];
  const warnings = [];
  const turns = Array.isArray(manifest?.entries) ? manifest.entries : [];
  const passes = Array.isArray(manifest?.passes) ? manifest.passes : [];
  const capturePass = passes.find(pass => pass.kind === 'capture') || null;
  const finalPass = passes[passes.length - 1] || null;
  const requireVerification = options.requireVerification === true;

  if (!turns.length) failures.push('No conversation turns were captured.');
  if (!capturePass) failures.push('The capture pass did not run.');
  if (capturePass && !capturePass.reachedStart) failures.push('The capture never reached the start of the conversation.');
  if (capturePass && !capturePass.reachedEnd) failures.push('The capture never reached the end of the conversation.');
  if (capturePass?.stuck) failures.push('Scrolling stopped advancing before the end of the conversation.');

  const breaks = Number(manifest?.continuityBreaks || 0);
  if (breaks > 0) {
    failures.push(`${breaks} scroll step(s) could not be linked to the previous position; turns between them may be missing.`);
  }

  const ordinals = turns.map(turn => turn.ordinal).filter(value => value !== null && value !== undefined);
  if (ordinals.length === turns.length && ordinals.length > 1) {
    const sorted = Array.from(new Set(ordinals)).sort((a, b) => a - b);
    let missing = 0;
    for (let i = 1; i < sorted.length; i += 1) missing += Math.max(0, sorted[i] - sorted[i - 1] - 1);
    if (missing) failures.push(`${missing} turn position(s) are missing between the first and last captured turn.`);
  }

  const expectedTotal = Number(manifest?.expectedTotal || 0);
  if (expectedTotal > 0 && expectedTotal !== turns.length) {
    const message = `The page reports ${expectedTotal} turns; ${turns.length} were captured.`;
    if (ordinals.length === turns.length) failures.push(message);
    else warnings.push(message);
  }

  const verifyPasses = passes.filter(pass => pass.kind === 'verify');
  if (verifyPasses.length) {
    const last = verifyPasses[verifyPasses.length - 1];
    if (Number(last.newTurns || 0) > 0) {
      failures.push(`The final verification pass still discovered ${last.newTurns} new turn(s).`);
    }
  } else if (requireVerification && !manifest?.ordinalsComplete) {
    failures.push('The capture was not verified.');
  }

  const empty = turns.filter(turn => Number(turn.textLength || 0) <= 0 && Number(turn.preservedContentCount || 0) <= 0);
  if (empty.length) warnings.push(`${empty.length} turn(s) contain neither text nor media.`);

  const anchors = turns.map(turn => String(turn.logicalAnchor || logicalAnchorKey(turn) || ''));
  const counts = new Map();
  anchors.filter(Boolean).forEach(anchor => counts.set(anchor, (counts.get(anchor) || 0) + 1));
  const duplicateLogicalAnchorCount = Array.from(counts.values()).filter(count => count > 1).length;
  if (duplicateLogicalAnchorCount) warnings.push(`${duplicateLogicalAnchorCount} logical anchor(s) identify more than one turn.`);

  return {
    logicalTurnsBefore: expectedTotal || turns.length,
    logicalTurnsAfter: turns.length,
    expectedLogicalTurns: expectedTotal,
    firstRowFingerprint: turns[0]?.fingerprint || '',
    lastRowFingerprint: turns[turns.length - 1]?.fingerprint || '',
    messageFingerprints: turns.map(turn => turn.fingerprint),
    logicalAnchors: anchors,
    firstRowLogicalAnchor: anchors[0] || '',
    lastRowLogicalAnchor: anchors[anchors.length - 1] || '',
    duplicateLogicalAnchorCount,
    continuityBreaks: breaks,
    ordinalsComplete: manifest?.ordinalsComplete === true,
    capturePasses: passes.length,
    verificationNewTurns: Number(finalPass?.kind === 'verify' ? finalPass.newTurns || 0 : 0),
    verificationSeenTurns: Number(finalPass?.seenCount || 0),
    maxCoverageGapPx: passes.reduce((max, pass) => Math.max(max, Number(pass.coverage?.gapPx || 0)), 0),
    failures,
    warnings,
    lowConfidence: failures.length > 0,
  };
}

module.exports = {
  CanonicalConversationStore,
  createCanonicalConversationStore,
  validateCanonicalCapture,
  logicalAnchorKey,
  intervalCoverage,
  mergeIntervals,
};
