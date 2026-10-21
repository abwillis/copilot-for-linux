'use strict';
function getRendererApiGlobal(options = {}) {
  return String(options.rendererApiGlobal || options.globalName || '__appRenderer');
}

function buildRendererMethodCallSource(method, args = [], options = {}) {
  const methodName = String(method || '').trim();
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(methodName)) return null;

  const safeArgs = Array.isArray(args) ? args : [args];
  const methodJson = JSON.stringify(methodName);
  const argsJson = JSON.stringify(safeArgs);
  const globalJson = JSON.stringify(getRendererApiGlobal(options));

  return (
    '(async function(){' +
      'try {' +
        'const api = window[' + globalJson + '];' +
        'if (!api || typeof api[' + methodJson + '] !== "function") {' +
          'return { ok:false, missing:true, method:' + methodJson + ', global:' + globalJson + ' };' +
        '}' +
        'return await api[' + methodJson + '].apply(api, ' + argsJson + ');' +
      '} catch (e) {' +
        'return {' +
          'ok:false,' +
          'error:String((e && e.message) || e),' +
          'stack:String((e && e.stack) || "")' +
        '};' +
      '}' +
    '})()'
  );
}

// Electron's WebFrameMain.executeJavaScript() never settles when the target
// frame is removed or replaced while the script is still running: the reply
// channel is torn down with the frame. Callers such as the export job then
// wait forever on a renderer that no longer exists. Poll frame liveness while
// the call is in flight and reject as soon as the frame is gone.
const FRAME_LIVENESS_POLL_MS = 50;

function createFrameGoneError() {
  const error = new Error('Renderer frame is no longer available');
  error.code = 'RENDERER_FRAME_GONE';
  return error;
}

function isFrameAlive(win, frame, frameId) {
  try {
    if (!win || win.isDestroyed?.()) return false;
    const webContents = win.webContents;
    if (!webContents || webContents.isDestroyed?.()) return false;
    if (frame.detached === true) return false;
    const frames = webContents.mainFrame?.framesInSubtree ?? webContents.mainFrame?.frames ?? [];
    return frames.some(candidate => candidate === frame || Number(candidate?.routingId) === Number(frameId));
  } catch {
    // A disposed WebFrameMain throws on access; that is the "gone" case.
    return false;
  }
}

function executeInFrameUnlessGone(win, frame, frameId, source) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = action => value => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      action(value);
    };
    const succeed = finish(resolve);
    const fail = finish(reject);
    timer = setInterval(() => {
      if (!isFrameAlive(win, frame, frameId)) fail(createFrameGoneError());
    }, FRAME_LIVENESS_POLL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      Promise.resolve(frame.executeJavaScript(source, true)).then(succeed, fail);
    } catch (error) {
      fail(error);
    }
  });
}

async function executeInAllFrames(win, source) {
  if (!win?.webContents || win.isDestroyed?.()) return [];

  const results = [];

  try {
    const value = await win.webContents.executeJavaScript(source, true).catch(() => null);
    if (value) results.push({ frameId: 0, where: 'top', value });
  } catch {}

  const frames = win.webContents.mainFrame?.framesInSubtree ?? win.webContents.mainFrame?.frames ?? [];
  for (const frame of frames) {
    try {
      if (frame === win.webContents.mainFrame) continue;
      const value = await frame.executeJavaScript(source, true).catch(() => null);
      if (value) {
        results.push({
          frameId: frame.routingId ?? -1,
          where: `frame:${frame.routingId}`,
          value,
        });
      }
    } catch {}
  }

  return results;
}

async function callRendererMethod(win, method, ...args) {
  if (!win?.webContents || win.isDestroyed?.()) return null;

  const options = (args.length && args[args.length - 1]?.__rendererApiOptions)
    ? args.pop().__rendererApiOptions
    : {};
  const source = buildRendererMethodCallSource(method, args, options);
  if (!source) {
    return {
      ok: false,
      error: 'Invalid renderer method name',
      method: String(method || ''),
    };
  }

  try {
    return await win.webContents.executeJavaScript(source, true);
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      method: String(method || ''),
    };
  }
}

async function callRendererMethodInFrame(win, frameId, method, ...args) {
  if (!win?.webContents || win.isDestroyed?.()) return null;

  const options = (args.length && args[args.length - 1]?.__rendererApiOptions)
    ? args.pop().__rendererApiOptions
    : {};
  const source = buildRendererMethodCallSource(method, args, options);
  if (!source) {
    return {
      ok: false,
      error: 'Invalid renderer method name',
      method: String(method || ''),
    };
  }

  try {
    if (Number(frameId) === 0) {
      return await win.webContents.executeJavaScript(source, true);
    }
    const frames = win.webContents.mainFrame?.framesInSubtree ?? win.webContents.mainFrame?.frames ?? [];
    const frame = frames.find(candidate => Number(candidate?.routingId) === Number(frameId));
    if (!frame) return { ok: false, error: 'Renderer frame is no longer available', frameId: Number(frameId) };
    return await executeInFrameUnlessGone(win, frame, frameId, source);
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      code: err?.code,
      method: String(method || ''),
      frameId: Number(frameId),
    };
  }
}

async function callRendererMethodInAllFrames(win, method, ...args) {
  const options = (args.length && args[args.length - 1]?.__rendererApiOptions)
    ? args.pop().__rendererApiOptions
    : {};
  const source = buildRendererMethodCallSource(method, args, options);

  if (!source) {
    return [{
      frameId: -1,
      where: 'renderer-api',
      value: {
        ok: false,
        error: 'Invalid renderer method name',
        method: String(method || ''),
      },
    }];
  }

  return executeInAllFrames(win, source);
}

module.exports = {
  getRendererApiGlobal,
  buildRendererMethodCallSource,
  executeInAllFrames,
  callRendererMethod,
  callRendererMethodInFrame,
  callRendererMethodInAllFrames,
};

