'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function executablePath(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const productName = String(packageJson.build?.productName || packageJson.name);
  const executableName = String(packageJson.build?.linux?.executableName || packageJson.name);
  if (process.platform === 'win32') {
    return path.join(root, 'dist', 'win-unpacked', `${productName}.exe`);
  }
  return path.join(root, 'dist', 'linux-unpacked', executableName);
}

async function main() {
  const root = path.join(__dirname, '..', '..');
  const executable = executablePath(root);
  assert.equal(fs.existsSync(executable), true, `Packaged executable not found: ${executable}`);

  const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'copilot-packaged-smoke-'));
  const reportPath = path.join(tempDirectory, 'report.json');
  const args = ['--packaged-smoke', `--smoke-report=${reportPath}`];
  if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
    args.unshift('--no-sandbox');
  }

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: 'true',
      },
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Packaged smoke process timed out.'));
    }, 30000);
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });

  assert.equal(exitCode, 0, 'Packaged application exited with a failure code.');
  const report = JSON.parse(await fs.promises.readFile(reportPath, 'utf8'));
  assert.equal(report.packaged, true);
  assert.equal(report.startup, true);
  assert.equal(report.export, true);
  assert.equal(report.replacement, true);
  console.log(`Packaged ${process.platform} startup/export smoke passed.`);
  await fs.promises.rm(tempDirectory, { recursive: true, force: true });
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
