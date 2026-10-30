// Main process: overlay mascot window + full console window + Hermes API bridge.
const { app, BrowserWindow, ipcMain, globalShortcut, Menu, screen, net, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = () => path.join(app.getPath('userData'), 'config.json');
const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8642/v1',
  apiKey: '',
  sessionKey: 'desktop-console',
  modelName: 'hermes-agent',
  appName: 'VIKTOR',
  speakReplies: true,
  ttsVoice: '',
  overlayAlwaysOnTop: true,
  overlayPos: null,
};

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
    width: 180, height: 220,
    transparent: true, frame: false, resizable: false, hasShadow: false,
    alwaysOnTop: config.overlayAlwaysOnTop, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  overlayWin.setMenu(null);
  if (config.overlayPos) overlayWin.setPosition(config.overlayPos.x, config.overlayPos.y);
  else {
    const d = screen.getPrimaryDisplay().workAreaSize;
    overlayWin.setPosition(d.width - 220, d.height - 260);
  }
  overlayWin.loadFile('overlay.html');
  overlayWin.on('moved', () => {
    if (!overlayWin) return;
    const [x, y] = overlayWin.getPosition();
    saveConfig({ overlayPos: { x, y } });
  });
  overlayWin.on('closed', () => { overlayWin = null; });
}

function createConsole() {
  if (consoleWin) { consoleWin.show(); consoleWin.focus(); return; }
  consoleWin = new BrowserWindow({
    width: 1600, height: 1000, minWidth: 1200, minHeight: 760,
    backgroundColor: '#0b0b0d', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  consoleWin.setMenu(null);
  consoleWin.loadFile('console.html');
  consoleWin.once('ready-to-show', () => consoleWin.show());
  consoleWin.on('closed', () => { consoleWin = null; });
  consoleWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function broadcastState(state) {
  if (overlayWin) overlayWin.webContents.send('companion-state', state);
  if (consoleWin) consoleWin.webContents.send('companion-state', state);
}

// ---- Hermes bridge (main process: no CORS, key never touches the page) ----
ipcMain.handle('hermes-models', async () => {
  const url = config.endpoint.replace(/\/$/, '') + '/models';
  const res = await net.fetch(url, { headers: { Authorization: 'Bearer ' + config.apiKey } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
});

ipcMain.handle('hermes-chat', async (event, messages) => {
  const url = config.endpoint.replace(/\/$/, '') + '/chat/completions';
  const res = await net.fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + config.apiKey,
      'Content-Type': 'application/json',
      'X-Hermes-Session-Key': config.sessionKey,
    },
    body: JSON.stringify({ model: config.modelName || 'hermes-agent', messages, stream: true }),
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => '');
    throw new Error('HTTP ' + res.status + (txt ? ' - ' + txt.slice(0, 200) : ''));
  }
  const wc = event.sender;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
ipcMain.handle('set-config', (_e, c) => { saveConfig(c); return config; });
ipcMain.handle('open-console', () => createConsole());
ipcMain.handle('set-state', (_e, s) => { broadcastState(s); });
ipcMain.handle('quit', () => app.quit());

app.whenReady().then(() => {
  loadConfig();
  createOverlay();               // overlay mascot only, per design
  globalShortcut.register('Control+B', () => {
    if (consoleWin && consoleWin.isVisible()) consoleWin.hide();
    else createConsole();
  });
  const menu = Menu.buildFromTemplate([
    { label: 'Open console (Ctrl+B)', click: () => createConsole() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  ipcMain.handle('overlay-menu', () => menu.popup());
});

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => { /* overlay keeps app alive; quit via menu */ });
