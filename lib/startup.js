'use strict';

function createStartupManager(deps = {}) {
  const { app, fs, path, process: processRef = process, appName = 'Application' } = deps;

  function linuxDesktopFilePath() {
    const configHome = processRef.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config');
    return path.join(configHome, 'autostart', `${appName}.desktop`);
  }

  function quoteDesktopExec(value) {
    return `"${String(value || '').replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')}"`;
  }

  function apply(config) {
    const enabled = !!config.launchAtLogin;
    if (processRef.platform !== 'linux') {
      app.setLoginItemSettings({
        openAtLogin: enabled,
        args: config.startMinimized ? ['--hidden'] : [],
      });
      return { ok: true };
    }

    const desktopPath = linuxDesktopFilePath();
    if (!enabled) {
      try { fs.unlinkSync(desktopPath); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      return { ok: true };
    }

    fs.mkdirSync(path.dirname(desktopPath), { recursive: true });
    const args = config.startMinimized ? ' --hidden' : '';
    const desktop = [
      '[Desktop Entry]',
      'Type=Application',
      'Version=1.0',
      `Name=${appName}`,
      `Exec=${quoteDesktopExec(processRef.execPath)}${args}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');
    const tempPath = `${desktopPath}.tmp`;
    fs.writeFileSync(tempPath, desktop, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, desktopPath);
    return { ok: true };
  }

  return { apply, linuxDesktopFilePath };
}

module.exports = { createStartupManager };
