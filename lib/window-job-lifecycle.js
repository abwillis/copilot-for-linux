'use strict';

const { ExportCancelledError } = require('./export-job');

function bindExportJobToWindow(job, win) {
  if (!job || typeof job.abort !== 'function' || !win) return () => {};

  const webContents = win.webContents;
  const abort = reason => {
    const message = reason || 'The source window closed during export.';
    job.abort(new ExportCancelledError(message));
  };
  const onClosed = () => abort('The source window closed during export.');
  const onDestroyed = () => abort('The source renderer was destroyed during export.');
  const onRenderProcessGone = (_event, details = {}) => {
    const suffix = details.reason ? ` (${details.reason})` : '';
    abort(`The source renderer stopped during export${suffix}.`);
  };

  try { win.once('closed', onClosed); } catch {}
  try { webContents?.once('destroyed', onDestroyed); } catch {}
  try { webContents?.once('render-process-gone', onRenderProcessGone); } catch {}

  return () => {
    try { win.removeListener('closed', onClosed); } catch {}
    try { webContents?.removeListener('destroyed', onDestroyed); } catch {}
    try { webContents?.removeListener('render-process-gone', onRenderProcessGone); } catch {}
  };
}

module.exports = { bindExportJobToWindow };
