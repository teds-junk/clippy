// Opens a terminal window running GitHub Copilot CLI, seeded with a prompt.
//
// The prompt was written by a model looking at the screen, so it is never
// placed on a command line: it goes into a file, and a small launcher script
// reads it into a single argument. No auto-approve flags are passed, so
// Copilot still asks before it runs tools.
//
// Which terminal:
//   macOS    the terminal the overlay was started from, else the app registered
//            to open shell scripts, else Terminal.app
//   Linux    $TERMINAL, else xdg-terminal-exec / x-terminal-emulator, else the
//            first common terminal found on PATH
//   Windows  a new console window, which Windows gives to the user's default
//            terminal app
//
//   CLIPPY_TERMINAL     override the terminal (app name on macOS, command on Linux)
//   CLIPPY_COPILOT_BIN  command to run (default: copilot)
//   CLIPPY_CWD          folder Copilot starts in (default: your home folder)

const { execFile, execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ---------- terminals we know how to hand a script to ----------

// macOS: arguments for `open`.
const MAC = {
  Terminal: { bundle: 'com.apple.Terminal', open: (s) => ['-a', 'Terminal', s] },
  iTerm: { bundle: 'com.googlecode.iterm2', open: (s) => ['-a', 'iTerm', s] },
  Ghostty: { bundle: 'com.mitchellh.ghostty', open: (s) => ['-na', 'Ghostty', '--args', '-e', s] },
  WezTerm: { bundle: 'com.github.wez.wezterm', open: (s) => ['-na', 'WezTerm', '--args', 'start', '--', s] },
  kitty: { bundle: 'net.kovidgoyal.kitty', open: (s) => ['-na', 'kitty', '--args', s] },
  Alacritty: { bundle: 'org.alacritty', open: (s) => ['-na', 'Alacritty', '--args', '-e', s] },
};

// Linux: command name -> arguments that run a script. Order is the fallback order.
const LINUX = {
  'xdg-terminal-exec': (s) => [s],
  'x-terminal-emulator': (s) => ['-e', s],
  'gnome-terminal': (s) => ['--', s],
  ptyxis: (s) => ['--', s],
  kgx: (s) => ['-e', s],
  konsole: (s) => ['-e', s],
  'xfce4-terminal': (s) => ['-x', s],
  tilix: (s) => ['-e', s],
  ghostty: (s) => ['-e', s],
  kitty: (s) => [s],
  wezterm: (s) => ['start', '--', s],
  alacritty: (s) => ['-e', s],
  foot: (s) => [s],
  xterm: (s) => ['-e', s],
};

// The terminal this process was started from, judged by what it leaves in the environment.
function terminalFromEnv(env = process.env) {
  const byProgram = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', ghostty: 'Ghostty', WezTerm: 'WezTerm', kitty: 'kitty', alacritty: 'Alacritty' };
  if (byProgram[env.TERM_PROGRAM]) return byProgram[env.TERM_PROGRAM];
  if (env.GHOSTTY_RESOURCES_DIR || env.GHOSTTY_BIN_DIR) return 'Ghostty';
  if (env.ITERM_SESSION_ID) return 'iTerm';
  if (env.KITTY_WINDOW_ID) return 'kitty';
  if (env.WEZTERM_PANE || env.WEZTERM_EXECUTABLE) return 'WezTerm';
  if (env.ALACRITTY_WINDOW_ID || env.ALACRITTY_SOCKET) return 'Alacritty';
  return null;
}

function onPath(cmd) {
  if (!cmd) return false;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd);
  return (process.env.PATH ?? '').split(path.delimiter).some((dir) => {
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

// macOS: the app the user has set to open shell scripts, if they changed it from Terminal.
function macDefaultHandler() {
  try {
    const out = execFileSync('defaults', ['read', 'com.apple.LaunchServices/com.apple.launchservices.secure', 'LSHandlers'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const block of out.split('},')) {
      if (!/com\.apple\.terminal\.shell-script|public\.unix-executable|public\.shell-script/.test(block)) continue;
      const m = block.match(/LSHandlerRole(?:All|Shell)\s*=\s*"?([\w.-]+)"?/);
      const name = m && Object.keys(MAC).find((k) => MAC[k].bundle.toLowerCase() === m[1].toLowerCase());
      if (name) return name;
    }
  } catch {
    /* no custom handlers */
  }
  return null;
}

// Returns { name, source } describing the terminal that will be used.
function detectTerminal() {
  const override = process.env.CLIPPY_TERMINAL;

  if (process.platform === 'win32') return { name: 'default terminal', source: 'Windows' };

  if (process.platform === 'darwin') {
    if (override) return { name: override, source: 'CLIPPY_TERMINAL' };
    const fromEnv = terminalFromEnv();
    if (fromEnv) return { name: fromEnv, source: 'the terminal the overlay was started from' };
    const handler = macDefaultHandler();
    if (handler) return { name: handler, source: 'the default app for shell scripts' };
    return { name: 'Terminal', source: 'macOS default' };
  }

  // Linux and other Unix
  if (override) return { name: override, source: 'CLIPPY_TERMINAL' };
  if (onPath(process.env.TERMINAL)) return { name: process.env.TERMINAL, source: '$TERMINAL' };
  const fromEnv = terminalFromEnv()?.toLowerCase();
  if (fromEnv && LINUX[fromEnv] && onPath(fromEnv)) return { name: fromEnv, source: 'the terminal the overlay was started from' };
  const found = Object.keys(LINUX).find(onPath);
  if (found) return { name: found, source: 'found on PATH' };
  return { name: null, source: 'none found' };
}

// ---------- launcher scripts ----------

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

function writeLauncher({ prompt, bin, cwd }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clippy-'));
  const promptFile = path.join(dir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, { mode: 0o600 });

  if (process.platform === 'win32') {
    const script = path.join(dir, 'ask-copilot.ps1');
    fs.writeFileSync(
      script,
      [`Set-Location -LiteralPath ${psQuote(cwd)}`, `$prompt = Get-Content -Raw -LiteralPath ${psQuote(promptFile)}`, `& ${psQuote(bin)} -i $prompt`, ''].join('\r\n'),
    );
    return script;
  }

  const script = path.join(dir, 'ask-copilot.command');
  fs.writeFileSync(
    script,
    [
      '#!/bin/sh',
      `export PATH=${shQuote(process.env.PATH ?? '')}`, // the PATH the overlay was started with
      `cd ${shQuote(cwd)}`,
      'clear',
      `exec ${shQuote(bin)} -i "$(cat ${shQuote(promptFile)})"`,
      '',
    ].join('\n'),
    { mode: 0o700 },
  );
  return script;
}

function start(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', ...options });
    child.once('error', (err) => reject(new Error(`Could not start ${cmd}: ${err.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function launchCopilot(prompt) {
  const bin = process.env.CLIPPY_COPILOT_BIN || 'copilot';
  const cwd = process.env.CLIPPY_CWD || os.homedir();
  const terminal = detectTerminal();
  const script = writeLauncher({ prompt, bin, cwd });

  if (process.platform === 'win32') {
    // A detached console program gets its own console window, and Windows
    // opens that window in the user's default terminal app.
    const shell = onPath('pwsh.exe') ? 'pwsh.exe' : 'powershell.exe';
    await start(shell, ['-NoLogo', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: false });
  } else if (process.platform === 'darwin') {
    const openArgs = MAC[terminal.name]?.open(script) ?? ['-a', terminal.name, script];
    await new Promise((resolve, reject) => {
      execFile('open', openArgs, (err, _out, stderr) => {
        if (err) reject(new Error(`Could not open ${terminal.name}: ${(stderr || err.message).trim()}`));
        else resolve();
      });
    });
  } else {
    if (!terminal.name) throw new Error('No terminal found. Set CLIPPY_TERMINAL to your terminal command.');
    const toArgs = LINUX[path.basename(terminal.name)] ?? ((s) => ['-e', s]);
    await start(terminal.name, toArgs(script));
  }
  return { terminal: terminal.name, script };
}

module.exports = { launchCopilot, detectTerminal, terminalFromEnv };
