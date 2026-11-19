// Clippy overlay: a transparent always-on-top window that watches the screen
// and, when the clippy agent sees something to help with, asks a yes/no question.
//
//   No   Clippy goes away for a moment.
//   Yes  A terminal opens running GitHub Copilot CLI, seeded with a prompt
//        about what was on screen.
//
//   npm start       talk to the deployed agent (needs `azd up` first)
//   npm run mock    canned offers, no cloud calls
//   npm run smoke   mock mode, no screen capture, exits after a few seconds
//
// The paperclip in the menu bar (system tray) pauses, resumes, and quits.
// Cmd+Shift+Q also quits, as does Ctrl+C in the terminal.

const { app, BrowserWindow, Menu, Tray, screen, desktopCapturer, ipcMain, globalShortcut, systemPreferences } = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { RateLimitError } = require('openai');
const { askAgent, askMock } = require('./agent');
const { launchCopilot, detectTerminal } = require('./launch');

const args = process.argv.slice(2);
const MOCK = args.includes('--mock');
const SMOKE = args.includes('--smoke');
const SHOT = args.includes('--shot') ? args[args.indexOf('--shot') + 1] : null;

const INTERVAL_MS = Number(process.env.CLIPPY_INTERVAL_MS ?? 3000);
const NO_SNOOZE_MS = Number(process.env.CLIPPY_NO_SNOOZE_MS ?? 20_000); // away after "No"
const YES_SNOOZE_MS = Number(process.env.CLIPPY_YES_SNOOZE_MS ?? 45_000); // away after "Yes"
const OFFER_TIMEOUT_MS = 25_000; // an unanswered question goes away on its own
const LEAVE_DELAY_MS = 900; // let the reaction animation play before he leaves
const CHANGE_THRESHOLD = 0.015; // share of the downscaled screen that must differ
const THUMB = { width: 64, height: 40 };
const WIN = { width: 380, height: 430, margin: 16 };

let win;
let tray;
let state = 'watching'; // watching | asking | away
let paused = false; // set from the tray: no screenshots, Clippy hidden
let awayTimers = [];
let busy = false;
let captureFailed = false;
let lastThumb = null;
let currentOffer = null;
let offerTimer;
const recentOffers = []; // { message, outcome }
const ask = MOCK ? askMock : askAgent;

const log = (...a) => console.log('[overlay]', ...a);
const send = (channel, payload) => win && !win.isDestroyed() && win.webContents.send(channel, payload);

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    width: WIN.width,
    height: WIN.height,
    x: area.x + area.width - WIN.width - WIN.margin,
    y: area.y + area.height - WIN.height - WIN.margin,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: false, // never take focus away from what the user is doing
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true }); // click-through until the pointer is on Clippy
  win.webContents.on('console-message', (e) => log('renderer:', e.message));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

// ---------- what is on screen ----------

// Returns null when the screen cannot be captured, which on macOS means the
// app has not been given Screen Recording permission.
async function captureScreen() {
  let sources;
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1280, height: 800 } });
  } catch (err) {
    if (!captureFailed) log('screen capture failed:', err?.message ?? String(err));
    return null;
  }
  const primaryId = String(screen.getPrimaryDisplay().id);
  const source = sources.find((s) => s.display_id === primaryId) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  return source.thumbnail;
}

// Has the screen changed since the last look? Clippy's own corner is left out,
// so his bubble appearing and disappearing does not count as a change.
function hasChanged(image) {
  const small = image.resize({ ...THUMB, quality: 'good' }).toBitmap();
  const prev = lastThumb;
  lastThumb = small;
  if (!prev || prev.length !== small.length) return true;

  const display = screen.getPrimaryDisplay().bounds;
  const b = win.getBounds();
  const x0 = Math.floor(((b.x - display.x) / display.width) * THUMB.width);
  const y0 = Math.floor(((b.y - display.y) / display.height) * THUMB.height);

  let different = 0;
  let counted = 0;
  for (let y = 0; y < THUMB.height; y++) {
    for (let x = 0; x < THUMB.width; x++) {
      if (x >= x0 && y >= y0) continue; // the overlay sits in the bottom-right corner
      const i = (y * THUMB.width + x) * 4;
      const d = Math.abs(small[i] - prev[i]) + Math.abs(small[i + 1] - prev[i + 1]) + Math.abs(small[i + 2] - prev[i + 2]);
      if (d > 48) different++;
      counted++;
    }
  }
  return different / counted > CHANGE_THRESHOLD;
}

// Front app name without needing Accessibility permission (macOS only).
function activeApp() {
  if (process.platform !== 'darwin') return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('/bin/sh', ['-c', 'lsappinfo info -only name "$(lsappinfo front)"'], { timeout: 2000 }, (err, out) => {
      const m = !err && out.match(/="(.*)"/);
      resolve(m ? m[1] : '');
    });
  });
}

function buildText(appName) {
  const offers = recentOffers.length ? recentOffers.map((o) => `- ${o.message} (${o.outcome})`) : ['- (none)'];
  return [`active_app: ${appName || 'unknown'}`, 'your_recent_offers:', ...offers].join('\n');
}

// ---------- watch, ask, go away ----------

async function tick() {
  if (busy || paused || state !== 'watching' ||!win || win.isDestroyed()) return;
  busy = true;
  try {
    let jpegBase64 = null;
    if (!SMOKE) {
      const image = await captureScreen();
      if (!image) {
        // Say so once. macOS needs the app restarted after permission is granted anyway.
        if (!captureFailed) send('notice', 'I need Screen Recording permission to see your screen. Grant it in System Settings > Privacy & Security, then restart me.');
        captureFailed = true;
        return;
      }
      captureFailed = false;
      if (!hasChanged(image)) return;
      jpegBase64 = image.toJPEG(60).toString('base64');
    }
    const offer = await ask({ text: buildText(await activeApp()), jpegBase64 });
    log(JSON.stringify(offer));
    if (offer.offer && state === 'watching' && !paused) present(offer);
  } catch (thrown) {
    const err = thrown instanceof Error ? thrown : new Error(String(thrown));
    log('error:', err.message);
    if (err instanceof RateLimitError) {
      // Still throttled after the SDK's own retries. Say nothing on screen, and
      // look at the same screen again next tick since this one went unseen.
      lastThumb = null;
    } else {
      send('notice', `Something went wrong: ${err.message.slice(0, 160)}`);
    }
  } finally {
    busy = false;
  }
}

function present(offer) {
  state = 'asking';
  currentOffer = offer;
  send('offer', { message: offer.message, animation: offer.animation });
  offerTimer = setTimeout(() => settle('ignored'), OFFER_TIMEOUT_MS);
}

function settle(outcome) {
  clearTimeout(offerTimer);
  const offer = currentOffer;
  currentOffer = null;
  if (!offer) return null;
  recentOffers.push({ message: offer.message, outcome });
  if (recentOffers.length > 5) recentOffers.shift();
  if (outcome === 'ignored') {
    send('expire');
    state = 'watching';
  }
  return offer;
}

function goAway(ms) {
  state = 'away';
  cancelAway();
  awayTimers = [
    setTimeout(() => send('leave'), LEAVE_DELAY_MS),
    setTimeout(() => {
      lastThumb = null; // look at the screen afresh when he comes back
      state = 'watching';
      if (!paused) send('return');
    }, LEAVE_DELAY_MS + ms),
  ];
}

function cancelAway() {
  awayTimers.forEach(clearTimeout);
  awayTimers = [];
}

// ---------- tray: pause, resume, look now, quit ----------

function setPaused(value) {
  paused = value;
  if (paused) {
    if (state === 'asking') settle('ignored');
    send('leave');
  } else {
    lookNow();
  }
  refreshTray();
}

// Bring Clippy back and have him look at the screen on the next tick,
// whether or not anything changed and even if he had been sent away.
function lookNow() {
  cancelAway();
  if (state === 'away') state = 'watching';
  lastThumb = null;
  send('return');
  tick();
}

function refreshTray() {
  if (!tray) return;
  const status = paused ? 'Clippy is paused' : `Clippy is watching${MOCK ? ' (mock)' : ''}`;
  tray.setToolTip(status);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: paused ? 'Resume' : 'Pause', click: () => setPaused(!paused) },
      { label: 'Look now', enabled: !paused, click: lookNow },
      { type: 'separator' },
      { label: 'Quit Clippy', accelerator: 'CommandOrControl+Shift+Q', click: () => app.quit() },
    ]),
  );
}

function createTray() {
  // macOS gets a black "template" image that adapts to light and dark menu bars.
  // Electron picks up the @2x file next to it on high-density screens.
  const icon = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  tray = new Tray(path.join(__dirname, 'assets', icon));
  refreshTray();
}

async function answer(choice) {
  if (state !== 'asking') return;
  if (choice !== 'yes') {
    settle('declined');
    goAway(NO_SNOOZE_MS);
    return;
  }
  const offer = settle('accepted');
  goAway(YES_SNOOZE_MS);
  try {
    const { terminal } = await launchCopilot(offer.prompt);
    log(`opened ${terminal} with prompt: ${offer.prompt}`);
  } catch (err) {
    log('error:', err.message);
    send('notice', err.message.slice(0, 160));
  }
}

// ---------- wiring ----------

ipcMain.on('hover', (_e, over) => win?.setIgnoreMouseEvents(!over, { forward: true }));
ipcMain.on('answer', (_e, choice) => answer(choice));

app.whenReady().then(() => {
  log(`mode: ${MOCK ? 'mock' : 'agent'}${SMOKE ? ' (smoke)' : ''}, interval ${INTERVAL_MS}ms`);
  if (process.platform === 'darwin' && !SMOKE) log('screen recording permission:', systemPreferences.getMediaAccessStatus('screen'));
  const terminal = detectTerminal();
  log(`"Yes" opens Copilot in: ${terminal.name ?? 'no terminal found'} (${terminal.source})`);
  createWindow();
  createTray();
  app.dock?.hide(); // the tray icon is the way in; no Dock icon on macOS
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
  win.webContents.once('did-finish-load', () => {
    tick();
    setInterval(tick, INTERVAL_MS);
    const quitAfter = Number(process.env.CLIPPY_QUIT_AFTER_MS ?? 0); // for unattended test runs
    if (quitAfter > 0) setTimeout(() => app.quit(), quitAfter);
    if (SMOKE) {
      setTimeout(async () => {
        if (SHOT) fs.writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG());
        log(`smoke ok (state: ${state})`);
        app.quit();
      }, 3500);
    }
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());
