// Starts the overlay. Used by `npm start` and `npm run mock`.
//
// On macOS the overlay is started through `open`, so it runs as its own app.
// Started as a child of a terminal instead, macOS would hold the terminal
// responsible for it, and Screen Recording permission would have to be given
// to the terminal (and the terminal restarted). This way the permission
// belongs to "Electron".
//
// An app started through `open` does not inherit the shell's environment, so
// the things the overlay needs are passed along explicitly.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectTerminal } = require('./launch');

const electronBinary = require('electron'); // path to the Electron executable
const overlayDir = __dirname;
const args = process.argv.slice(2);

if (process.platform !== 'darwin') {
  const child = spawn(electronBinary, [overlayDir, ...args], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const appBundle = path.resolve(electronBinary, '../../..'); // .../Electron.app
  const logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-log-')), 'overlay.log');
  fs.writeFileSync(logFile, '');

  // What the overlay needs from this shell: PATH for azd, az and copilot,
  // any CLIPPY_* settings, and the terminal this shell is running in.
  const env = { PATH: process.env.PATH ?? '' };
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(CLIPPY_|AZURE_CONFIG_DIR$|AZD_CONFIG_DIR$)/.test(key)) env[key] = value;
  }
  env.CLIPPY_TERMINAL ??= detectTerminal().name;

  const openArgs = ['-n', '-W', '-a', appBundle, '--stdout', logFile, '--stderr', logFile];
  for (const [key, value] of Object.entries(env)) openArgs.push('--env', `${key}=${value}`);
  openArgs.push('--args', overlayDir, ...args);

  // Show the app's log here, since its output no longer comes to this terminal.
  let shown = 0;
  const showNewLog = () => {
    const size = fs.statSync(logFile).size;
    if (size <= shown) return;
    const fd = fs.openSync(logFile, 'r');
    const chunk = Buffer.alloc(size - shown);
    fs.readSync(fd, chunk, 0, chunk.length, shown);
    fs.closeSync(fd);
    shown = size;
    process.stdout.write(chunk);
  };
  const timer = setInterval(showNewLog, 300);

  const opener = spawn('open', openArgs, { stdio: 'inherit' });
  opener.on('exit', (code) => {
    clearInterval(timer);
    showNewLog();
    process.exit(code ?? 0);
  });

  // Ctrl+C here should close the overlay, which is no longer a child of this process.
  const quit = () => spawnSync('pkill', ['-f', `${electronBinary} ${overlayDir}`]);
  process.on('SIGINT', quit);
  process.on('SIGTERM', quit);
}
