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
  callRendererMethodInAllFrames,
};

