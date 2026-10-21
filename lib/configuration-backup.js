'use strict';
const { selectManagedSettings, validateSettingsPatch } = require('./settings-schema');

function createConfigurationBackup({ fs, path, getConfigFilePath, defaults, normalize, forDisk = config => config }) {
  let recovery = null;
  function read(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SyntaxError('Configuration must be an object.');
    // Normalize first, so hand-edited "false"/"off" strings and out-of-range values
    // that normalize() can clamp are accepted, then reset only the settings that
    // still fail validation. One bad value must not move the whole file aside and
    // revert every other setting.
    const config = normalize(raw);
    const keys = selectManagedSettings(defaults);
    const patch = Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(keys, key)));
    const validation = validateSettingsPatch(defaults, patch);
    if (!validation.valid) {
      for (const key of Object.keys(validation.errors)) {
        if (Object.hasOwn(keys, key)) config[key] = structuredClone(defaults[key]);
      }
    }
    return normalize(config);
  }
  function atomicWrite(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temporary, file);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  function write(file, config, { preservePrevious = true } = {}) {
    const text = JSON.stringify(forDisk(config), null, 2) + '\n';
    if (preservePrevious && fs.existsSync(file)) {
      const previous = JSON.stringify(forDisk(read(file)), null, 2) + '\n';
      if (previous === text) return;
      atomicWrite(`${file}.previous`, previous);
    }
    atomicWrite(file, text);
  }
  function previous() { return read(`${getConfigFilePath()}.previous`); }
  function status() {
    const configPath = getConfigFilePath();
    let canRestore = false;
    try { previous(); canRestore = true; } catch {}
    return { configPath, backupPath: `${configPath}.previous`, canRestore, recovery };
  }
  function load() {
    const file = getConfigFilePath();
    let config = defaults, mayWrite = true, preservePrevious = true;
    try { config = read(file); }
    catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) {
        let source = 'defaults';
        try { config = previous(); source = 'previous'; } catch {}
        preservePrevious = false;
        let corruptPath;
        if (error instanceof SyntaxError) {
          corruptPath = `${file}.${Date.now()}.${Math.random().toString(36).slice(2)}.corrupt`;
          try { fs.renameSync(file, corruptPath); }
          catch { mayWrite = false; corruptPath = file; }
        }
        if (corruptPath || source === 'previous') recovery = {
          source, corruptPath, message: `Configuration recovered using ${source}. Original malformed bytes, if any, were preserved.`,
        };
      } else {
        mayWrite = false;
        recovery = { source: 'defaults', message: `Configuration could not be read: ${error.message}` };
      }
    }
    config = normalize(config);
    if (mayWrite) {
      try { write(file, config, { preservePrevious }); }
      catch (error) { console.error('Failed to write configuration:', error); }
    }
    return config;
  }
  return { read, write, previous, status, load, atomicWrite };
}
module.exports = { createConfigurationBackup };
