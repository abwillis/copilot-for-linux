'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { ExportCancelledError } = require('../lib/export-job');
const { bindExportJobToWindow } = require('../lib/window-job-lifecycle');

function fixtureWindow() {
  const win = new EventEmitter();
  win.webContents = new EventEmitter();
  return win;
}

test('closing the source window aborts the export with a cancellation error', () => {
  const win = fixtureWindow();
  let reason = null;
  const job = { abort(value) { reason = value; } };
  const unbind = bindExportJobToWindow(job, win);

  win.emit('closed');
  assert.ok(reason instanceof ExportCancelledError);
  assert.equal(reason.code, 'EXPORT_CANCELLED');
  assert.match(reason.message, /window closed/i);
  unbind();
});

test('renderer termination aborts once and lifecycle listeners can be removed', () => {
  const win = fixtureWindow();
  const reasons = [];
  const job = { abort(value) { reasons.push(value); } };
  const unbind = bindExportJobToWindow(job, win);

  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(reasons.length, 1);
  assert.match(reasons[0].message, /crashed/);
  unbind();
  win.emit('closed');
  assert.equal(reasons.length, 1);
});
