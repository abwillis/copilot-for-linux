'use strict';

// === Window state persistence ===
// Extracted from main.js (Tier 3 refactor).
// Factory: createWindowState(deps) -> API object.

function createWindowState(deps = {}) {
  const { app, path, fs, screen, getIsQuitting } = deps;

// === Window state persistence (size/position) ===
function getWindowStateFile(key) {
  const safe = String(key || 'main')
  .toLowerCase()
  .replace(/[^a-z0-9_-]+/g, '-')
  .replace(/^-+|-+$/g, '');
  return path.join(app.getPath('userData'), `window-state-${safe}.json`);
}

const windowStateCache = new Map(); // key -> {x,y,width,height}
const saveStateDebounceByKey = new Map(); // key -> timeoutId
const SAVE_STATE_DEBOUNCE_MS = 500;

function loadWindowState(key = 'main') {
  try {
    const file = getWindowStateFile(key);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    windowStateCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function isBoundsOnAnyDisplay(bounds) {
  try {
    const rect = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    const disp = screen.getDisplayMatching(rect);
    if (!disp) return false;
    const wa = disp.workArea;
    const intersects =
    rect.x < (wa.x + wa.width) &&
    (rect.x + rect.width) > wa.x &&
    rect.y < (wa.y + wa.height) &&
    (rect.y + rect.height) > wa.y;
    return intersects;
  } catch {
    return true;
  }
}

function getInitialWindowBounds(key = 'main') {
  const persisted = windowStateCache.get(key) || loadWindowState(key);
  if (persisted && persisted.width && persisted.height) {
    if (isBoundsOnAnyDisplay(persisted)) {
      return {
        width: Math.max(600, persisted.width),
        height: Math.max(400, persisted.height),
        x: typeof persisted.x === 'number' ? persisted.x : undefined,
        y: typeof persisted.y === 'number' ? persisted.y : undefined
      };
    }
    return {
      width: Math.max(600, persisted.width),
      height: Math.max(400, persisted.height)
    };
  }
  return { width: 1200, height: 800 };
}

function scheduleSaveWindowState(win, key = 'main') {
  const prev = saveStateDebounceByKey.get(key);
  if (prev) clearTimeout(prev);
  const t = setTimeout(async () => {
    try {
      if (!win || win.isDestroyed()) return;
      const bounds = win.getBounds();
      const state = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      const file = getWindowStateFile(key);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, JSON.stringify(state), 'utf8');
      windowStateCache.set(key, state);
    } catch (err) {
      console.error('Failed to persist window state:', err);
    }
  }, SAVE_STATE_DEBOUNCE_MS);
  saveStateDebounceByKey.set(key, t);
}

function attachWindowStatePersistence(win, boundsKey, { hideOnClose = true } = {}) {
  if (!win) return;
  win.on('resize', () => scheduleSaveWindowState(win, boundsKey));
  win.on('move', () => scheduleSaveWindowState(win, boundsKey));
  win.on('close', (e) => {
    try { scheduleSaveWindowState(win, boundsKey); } catch {}
    if (!(typeof getIsQuitting === 'function' ? getIsQuitting() : false) && hideOnClose) {
      e.preventDefault();
      win.hide();
    }
  });
}

  return {
    attachWindowStatePersistence,
    getWindowStateFile,
    loadWindowState,
    isBoundsOnAnyDisplay,
    getInitialWindowBounds,
    scheduleSaveWindowState,
  };
}

module.exports = { createWindowState };
