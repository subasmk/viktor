// Main process: overlay mascot window + full console window + Hermes API bridge.
const { app, BrowserWindow, ipcMain, globalShortcut, Menu, screen, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// VIKTOR_DATA_DIR override exists so the whole app can be tested headless on CI/sandbox.
const DATA_DIR = () => process.env.VIKTOR_DATA_DIR || app.getPath('userData');
const CONFIG_PATH = () => path.join(DATA_DIR(), 'config.json');
const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8642/v1',
  apiKey: '',
  sessionKey: 'desktop-console',
  modelName: 'hermes-agent',
  appName: 'VIKTOR',
  speakReplies: true,
  personality: 'off',      // persona + proactive scout are explicit opt-in (SETTINGS)
  proactive: false,
  mascotStyle: 'shiba',    // 'shiba' (sprite dog) or 'pixel' (classic cat) - SETTINGS
  ttsVoice: '',
  overlayAlwaysOnTop: true,
  overlayPos: null,
};

// One mascot per machine: a second launch focuses the running instance instead
// of spawning a rival overlay + voice watcher fighting over the same state files.
// Skipped under VIKTOR_DATA_DIR so headless test runs can coexist.
if (!process.env.VIKTOR_DATA_DIR && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let overlayWin = null;
let consoleWin = null;
let config = { ...DEFAULTS };

function loadConfig() {
  try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8')) }; }
  catch { config = { ...DEFAULTS }; }
}
function saveConfig(c) {
  config = { ...config, ...c };
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(config, null, 2));
}

function createOverlay() {
  overlayWin = new BrowserWindow({
    width: 380, height: 220,   // room for the comic speech bubble beside the cat
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: config.overlayAlwaysOnTop, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWin.setMenu(null);
  const d = screen.getPrimaryDisplay().workAreaSize;
  if (config.overlayPos) {
    // keep the (now wider) window fully on screen even with an old saved position
    const x = Math.max(0, Math.min(config.overlayPos.x, d.width - 380));
    const y = Math.max(0, Math.min(config.overlayPos.y, d.height - 220));
    overlayWin.setPosition(x, y);
  } else {
    overlayWin.setPosition(d.width - 400, d.height - 260);
  }
  overlayWin.loadFile('overlay.html');
  let moveSaveTimer = null;
  overlayWin.on('moved', () => {
    if (!overlayWin) return;
    clearTimeout(moveSaveTimer);   // dragging fires 'moved' constantly; persist once it settles
    moveSaveTimer = setTimeout(() => {
      if (!overlayWin) return;
      const [x, y] = overlayWin.getPosition();
      saveConfig({ overlayPos: { x, y } });
    }, 400);
  });
  overlayWin.on('closed', () => { overlayWin = null; });
}

function createConsole() {
  if (consoleWin) { consoleWin.show(); consoleWin.focus(); return; }
  const wa = screen.getPrimaryDisplay().workArea;   // clamp: 1600x1000 overflows a 1366x768 laptop
  consoleWin = new BrowserWindow({
    width: Math.min(1600, wa.width), height: Math.min(1000, wa.height),
    minWidth: Math.min(1200, wa.width), minHeight: Math.min(760, wa.height),
    backgroundColor: '#0b0b0d', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  consoleWin.setMenu(null);
  consoleWin.loadFile('console.html');
  consoleWin.once('ready-to-show', () => consoleWin.show());
  consoleWin.on('closed', () => { consoleWin = null; });
  consoleWin.webContents.setWindowOpenHandler(({ url }) => {
    try { if (new URL(url).protocol === 'https:') shell.openExternal(url); } catch {}
    return { action: 'deny' };
  });
}

function broadcastState(state, reply) {
  if (overlayWin) overlayWin.webContents.send('companion-state', state, reply || '');
  if (consoleWin) consoleWin.webContents.send('companion-state', state, reply || '');
}

// ---- Voice watcher bridge -------------------------------------------------
// Clicking the mascot toggles the mic. The watcher (voice/viktor_voice.py) runs
// headless as a child process; we talk to it through two tiny JSON files in the
// app data dir so no ports or permissions are involved.
const VOICE_STATE_PATH = () => path.join(DATA_DIR(), 'voice-state.json');
const VOICE_CMD_PATH = () => path.join(DATA_DIR(), 'voice-command.json');

let voiceProc = null;
let voiceProcStartedAt = 0;
let voiceState = 'off';        // off | wake | listen | think | speak
let voiceError = '';           // set when the watcher cannot start / crashed
const VOICE_OVERLAY_MAP = { wake: 'listening', listen: 'listening', think: 'working', speak: 'speaking', off: 'idle' };

function voiceMicOn() { return voiceState !== 'off'; }

function voiceScriptPath() {
  if (process.env.VIKTOR_VOICE_SCRIPT) return process.env.VIKTOR_VOICE_SCRIPT;
  // Packaged builds ship voice/ as extraResources: Python cannot read inside an asar.
  if (app.isPackaged) return path.join(process.resourcesPath, 'voice', 'viktor_voice.py');
  return path.join(__dirname, 'voice', 'viktor_voice.py');
}

function spawnVoice() {
  if (voiceProc && !voiceProc.killed) return true;
  const script = voiceScriptPath();
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  const tryNext = (i) => {
    if (i >= candidates.length) { voiceProc = null; voiceError = 'no-python'; return; }
    let settled = false;
    const proc = spawn(candidates[i], [script, '--headless'], {
      env: { ...process.env, VIKTOR_DATA_DIR: DATA_DIR(), PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.on('error', () => { if (!settled) { settled = true; tryNext(i + 1); } });
    let earlyExit = true;
    proc.on('spawn', () => {
      settled = true;
      voiceProc = proc;
      voiceProcStartedAt = Date.now();
      voiceError = '';
      setTimeout(() => { earlyExit = false; }, 3000);
    });
    let errBuf = '';
    proc.stderr.on('data', (d) => { errBuf = (errBuf + d.toString()).slice(-800); });
    proc.on('exit', () => {
      if (voiceProc === proc) voiceProc = null;
      if (earlyExit && errBuf) {
        voiceError = /ModuleNotFoundError|No module named/.test(errBuf) ? 'deps-missing' : 'crashed';
        broadcastState('sleepy');
      }
    });
  };
  tryNext(0);
  return true;
}

// seq is epoch-ms: monotonic across app sessions, so a fresh watcher never
// mistakes a leftover command file from a previous run for a new one.
function sendVoiceCommand(command, skipWake) {
  try {
    fs.writeFileSync(VOICE_CMD_PATH(), JSON.stringify({ command, seq: Date.now(), skipWake: !!skipWake }));
    return true;
  } catch { return false; }
}

// A just-spawned watcher may not have run its command-file init yet; wait until
// it proves it is alive (state file written after spawn) before sending.
function sendVoiceCommandWhenReady(command, skipWake) {
  const deadline = Date.now() + 10000;
  const tick = () => {
    if (voiceProc && voiceProc.killed) return;
    let updated = 0;
    try { updated = JSON.parse(fs.readFileSync(VOICE_STATE_PATH(), 'utf8')).updated * 1000 || 0; } catch {}
    if (updated >= voiceProcStartedAt - 1000 || Date.now() > deadline) {
      sendVoiceCommand(command, skipWake);
    } else {
      setTimeout(tick, 250);
    }
  };
  tick();
}

function toggleVoice() {
  if (voiceMicOn()) {
    sendVoiceCommand('disable');
    return { ok: true, enabled: false };
  }
  const alreadyRunning = !!voiceProc;
  spawnVoice();
  if (voiceError === 'no-python') return { ok: false, error: 'no-python' };
  if (alreadyRunning) sendVoiceCommand('enable', true);  // click = speak right away, no wake phrase needed first
  else sendVoiceCommandWhenReady('enable', true);
  return { ok: true, enabled: true };
}

function watchVoiceState() {
  let last = '';
  const read = () => {
    let s = 'off', j = {};
    try { j = JSON.parse(fs.readFileSync(VOICE_STATE_PATH(), 'utf8')); s = j.state || 'off'; } catch { return; }
    if (s === last) return;
    last = s; voiceState = s;
    const mapped = VOICE_OVERLAY_MAP[s];
    if (mapped) broadcastState(mapped, j.reply || '');
  };
  try {
    fs.watch(DATA_DIR(), (_e, f) => { if (f === 'voice-state.json') setTimeout(read, 50); });
  } catch { /* a restart still picks up state */ }
}

// ---- Hermes bridge (main process: no CORS, key never touches the page) ----
ipcMain.handle('hermes-models', async () => {
  const url = config.endpoint.replace(/\/$/, '') + '/models';
  const res = await net.fetch(url, { headers: { Authorization: 'Bearer ' + config.apiKey } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
});

const chatAborts = new Map();   // sender id -> AbortController for the in-flight stream
ipcMain.handle('hermes-cancel', (event) => {
  const c = chatAborts.get(event.sender.id);
  if (c) c.abort();
});

ipcMain.handle('hermes-chat', async (event, messages, sessionOverride) => {
  const url = config.endpoint.replace(/\/$/, '') + '/chat/completions';
  const abort = new AbortController();
  chatAborts.set(event.sender.id, abort);
  let res;
  try {
    res = await net.fetch(url, {
      method: 'POST',
      signal: abort.signal,
      headers: {
        Authorization: 'Bearer ' + config.apiKey,
        'Content-Type': 'application/json',
        'X-Hermes-Session-Key': sessionOverride || config.sessionKey,
      },
      body: JSON.stringify({ model: config.modelName || 'hermes-agent', messages, stream: true }),
    });
  } catch (e) {
    chatAborts.delete(event.sender.id);
    if (abort.signal.aborted) return;   // user pressed STOP: end quietly, no error bubble
    throw e;
  }
  if (!res.ok || !res.body) {
    chatAborts.delete(event.sender.id);
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (txt ? ' - ' + txt.slice(0, 200) : ''));
  }
  const wc = event.sender;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const payload = t.slice(5).trim();
        if (payload === '[DONE]') { wc.send('hermes-chunk', { done: true }); return; }
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
          if (delta) wc.send('hermes-chunk', { delta });
          const fr = j.choices && j.choices[0] && j.choices[0].finish_reason;
          if (fr === 'error' || fr === 'cancelled') wc.send('hermes-chunk', { failed: fr });
        } catch { /* partial json, ignore */ }
      }
    }
  } catch (e) {
    if (abort.signal.aborted) return;   // STOP pressed mid-stream: end quietly
    throw e;
  } finally {
    chatAborts.delete(event.sender.id);
  }
  wc.send('hermes-chunk', { done: true });
});


// Detect a local Nous Hermes Agent install without reading any secrets.
ipcMain.handle('detect-hermes', () => {
  const out = { hermesHome: false, envPresent: false, path: '' };
  try {
    const candidates = [];
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'hermes'));
    if (process.env.USERPROFILE) candidates.push(path.join(process.env.USERPROFILE, 'hermes'));
    candidates.push('D:\\hermes', 'C:\\hermes');
    const found = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    out.hermesHome = !!found;
    out.path = found || candidates[0] || '';
    out.envPresent = found ? fs.existsSync(path.join(found, '.env')) : false;
  } catch {}
  return out;
});

ipcMain.handle('get-config', () => config);
ipcMain.handle('set-config', (_e, c) => { saveConfig(c); if (overlayWin) overlayWin.webContents.send('config-changed', config); return config; });
ipcMain.handle('open-console', () => createConsole());
ipcMain.handle('set-state', (_e, s) => { broadcastState(s); });
ipcMain.handle('quit', () => app.quit());
// Scout offers: the ONLY thing a bubble click can execute is opening one
// verified https URL in the browser. No agent task runs from this path.
ipcMain.handle('open-external', async (_e, url) => {
  try {
    const raw = String(url);
    if (/[\x00-\x1f\x7f\s]/.test(raw)) return false;
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    await shell.openExternal(u.toString());
    return true;
  } catch { return false; }
});

// Proactive scout: bounded public-news fetch. No agent, no tools, no LLM -
// just two public Google News RSS queries; the overlay scores and words the offer.
ipcMain.handle('scout-news', async () => {
  const feeds = [
    'https://news.google.com/rss/search?q=GTA%206%20OR%20Rockstar%20Games&hl=en-US&gl=US&ceid=US:en',
    'https://news.google.com/rss/search?q=AI%20announcement%20OR%20big%20tech%20launch&hl=en-US&gl=US&ceid=US:en',
  ];
  const items = [];
  const de = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  for (const f of feeds) {
    try {
      const res = await net.fetch(f);
      const xml = await res.text();
      for (const it of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
        const t = (it[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
        const l = (it[1].match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
        const d = (it[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
        if (t && l) items.push({ title: de(t).slice(0, 200), url: l.trim(), when: Date.parse(d) || 0 });
      }
    } catch {}
  }
  return items.slice(0, 10);
});

// Mascot walk: glide the overlay window sideways (idle antics). The debounced
// 'moved' save persists wherever the walk ends - the new spot becomes home.
let walking = false;
ipcMain.handle('overlay-walk', async (_e, dx) => {
  if (!overlayWin || walking || !dx) return false;
  walking = true;
  try {
    const [x, y] = overlayWin.getPosition();
    const wa = screen.getDisplayMatching(overlayWin.getBounds()).workArea;
    const target = Math.max(wa.x, Math.min(wa.x + wa.width - 380, x + Math.round(dx)));
    const step = target > x ? 5 : -5;
    let cx = x;
    while (Math.abs(target - cx) > Math.abs(step)) {
      cx += step;
      if (!overlayWin) break;
      overlayWin.setPosition(cx, y);
      await new Promise((r) => setTimeout(r, 16));
    }
    if (overlayWin) overlayWin.setPosition(target, y);
    return true;
  } finally { walking = false; }
});

ipcMain.handle('toggle-voice', () => toggleVoice());
ipcMain.handle('voice-status', () => ({ state: voiceState, micOn: voiceMicOn(), error: voiceError, running: !!voiceProc }));

// External tools (e.g. setup-hermes-api.ps1) may write config.json while the app
// runs; reload it so the new key is used instead of being overwritten by a later save.
let configReloadTimer = null;
function watchConfigFile() {
  try {
    fs.watch(app.getPath('userData'), (_evt, filename) => {
      if (filename !== 'config.json') return;
      clearTimeout(configReloadTimer);
      configReloadTimer = setTimeout(() => { loadConfig(); }, 300);
    });
  } catch { /* watch unsupported: a restart still picks up external edits */ }
}

app.whenReady().then(() => {
  loadConfig();
  watchConfigFile();
  watchVoiceState();
  spawnVoice();                  // watcher starts mic-off; the mascot click opens the mic
  createOverlay();               // overlay mascot only, per design
  globalShortcut.register('Control+B', () => {
    if (consoleWin && consoleWin.isVisible()) consoleWin.hide();
    else createConsole();
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Voice on/off (or click the mascot)', click: () => toggleVoice() },
    { label: 'Open console (Ctrl+B)', click: () => createConsole() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  ipcMain.handle('overlay-menu', () => menu.popup());
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { if (voiceProc) voiceProc.kill(); } catch {}
});
app.on('window-all-closed', () => { /* overlay keeps app alive; quit via menu */ });
