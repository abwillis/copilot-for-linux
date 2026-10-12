'use strict';

function createRendererAgentInstaller(options = {}) {
  const {
    fs,
    agentPath,
    rendererApiGlobal = '__appRenderer',
    rendererAgentVersion = 1,
    agentConfig = {},
    logError = (...args) => console.error(...args),
  } = options;

  if (!fs || typeof fs.readFileSync !== 'function') {
    throw new TypeError('createRendererAgentInstaller requires an fs implementation.');
  }
  if (!agentPath) throw new TypeError('createRendererAgentInstaller requires agentPath.');

  const globalName = String(rendererApiGlobal || '__appRenderer');
  const version = Number(rendererAgentVersion || 1);
  let cachedBoot = null;

  function getBootSource() {
    if (cachedBoot !== null) return cachedBoot;
    try {
      const source = fs.readFileSync(agentPath, 'utf8');
      const bootConfig = {
        rendererApiGlobal: globalName,
        rendererAgentVersion: version,
      };
      const initConfig = {
        ...agentConfig,
        ...bootConfig,
      };
      cachedBoot =
        'try { window.__APP_RENDERER_AGENT_CONFIG__ = ' + JSON.stringify(bootConfig) + '; } catch (e) {}\n' +
        source +
        '\n;try {' +
          'var __rendererApiGlobal = ' + JSON.stringify(globalName) + ';' +
          'var __rendererApi = window[__rendererApiGlobal];' +
          'if (__rendererApi && typeof __rendererApi.init === "function") {' +
            '__rendererApi.init(' + JSON.stringify(initConfig) + ');' +
          '}' +
        '} catch (e) {}';
    } catch (error) {
      logError('[renderer-agent] failed to load renderer/agent.js:', error);
      cachedBoot = '';
    }
    return cachedBoot;
  }

  function executeInMainFrame(webContents) {
    const boot = getBootSource();
    if (!boot || !webContents || webContents.isDestroyed?.()) return;
    try { webContents.executeJavaScript(boot, true).catch(() => {}); } catch {}
  }

  function executeInFrame(frame) {
    const boot = getBootSource();
    if (!boot || !frame) return;
    try { frame.executeJavaScript(boot, true).catch(() => {}); } catch {}
  }

  function install(webContents) {
    if (!webContents) return () => {};

    const frameListeners = new Map();
    const onDomReady = () => executeInMainFrame(webContents);
    const onFrameCreated = (_event, details) => {
      const frame = details?.frame;
      if (!frame || frame === webContents.mainFrame) return;
      const onFrameDomReady = () => executeInFrame(frame);
      frameListeners.set(frame, onFrameDomReady);
      try { frame.on('dom-ready', onFrameDomReady); } catch {}
    };
    const cleanup = () => {
      try { webContents.removeListener('dom-ready', onDomReady); } catch {}
      try { webContents.removeListener('frame-created', onFrameCreated); } catch {}
      for (const [frame, listener] of frameListeners) {
        try { frame.removeListener('dom-ready', listener); } catch {}
      }
      frameListeners.clear();
    };

    webContents.on('dom-ready', onDomReady);
    webContents.on('frame-created', onFrameCreated);
    webContents.once('destroyed', cleanup);
    return cleanup;
  }

  return {
    getBootSource,
    install,
  };
}

module.exports = { createRendererAgentInstaller };
