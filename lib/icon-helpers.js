'use strict';

function createIconHelpers(deps = {}) {
  const {
    app,
    fs,
    path,
    process,
  } = deps;

  function getIconPath(filename) {
    const basePath = app.getAppPath();
    const iconPath = path.join(basePath, 'assets', filename);

    if (app.isPackaged) {
      const asarPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', filename);
      if (fs.existsSync(asarPath)) return asarPath;
    }

    return iconPath;
  }

  return {
    getIconPath,
  };
}

module.exports = { createIconHelpers };
