// Viktor Core - Viktor's own brain (Phase 2).
//
// A small local service that speaks the OpenAI chat API Viktor already uses,
// so Viktor can run WITHOUT Hermes: point Viktor's endpoint setting at
// http://127.0.0.1:8731/v1 and this service answers instead. Inside is a
// simple agent loop (ask the model -> run a tool -> feed the result back ->
// repeat, max 6 rounds) with a switchable provider:
//
//   provider "groq"   -> Groq cloud (fast, needs an API key + internet)
//   provider "ollama" -> local Ollama (offline, private, speed = your PC)
//
// Both providers speak the same OpenAI-compatible API, so the loop is shared.
// Switch providers on the built-in settings page at http://127.0.0.1:8731/
// (or edit core/config.json; changes apply to the next message, no restart).
//
// Safety: the service binds to 127.0.0.1 ONLY (it can run commands - it must
// never be reachable from the network), and run_command refuses a denylist
// of destructive patterns. Transcripts persist as JSONL under core/data/ so
// a crash never loses the conversation.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(DIR, 'config.json');
const DATA_DIR = path.join(DIR, 'data');
const NOTES_PATH = path.join(DATA_DIR, 'notes.txt');
const WIN = process.platform === 'win32';

const DEFAULTS = {
  port: 8731,
  provider: 'groq',
  groq: { base: 'https://api.groq.com/openai/v1', apiKey: '', model: 'llama-3.3-70b-versatile' },
  ollama: { base: 'http://127.0.0.1:11434/v1', apiKey: 'ollama', model: 'llama3.1:8b' },
};
function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return {
      ...DEFAULTS, ...raw,
      groq: { ...DEFAULTS.groq, ...(raw.groq || {}) },
      ollama: { ...DEFAULTS.ollama, ...(raw.ollama || {}) },
    };
  } catch { return structuredClone(DEFAULTS); }
}
function providerCfg(cfg) {
  const p = cfg.provider === 'ollama' ? cfg.ollama : cfg.groq;
  return {
    name: cfg.provider === 'ollama' ? 'ollama' : 'groq',
    base: String(p.base || '').replace(/\/$/, ''),
    key: (p.apiKey || (cfg.provider === 'groq' ? process.env.GROQ_API_KEY : '') || ''),
    model: p.model,
  };
}

// ---------------------------------------------------------------- tools
const DENY = [
  /\bformat\s+[a-z]:/i, /\bdel\s+\/[sfq]/i, /\brd\s+\/s/i, /\brmdir\s+\/s/i,
  /\bremove-item\b[^|]*(-recurse|--recurse)[^|]*[a-z]:\\/i, /\breg\s+delete/i,
  /\bshutdown\b/i, /\bmkfs\b/i, /\bdd\s+if=/i, /\bcipher\s+\/w/i,
  /\bnet\s+user\b[^|]*\//i, /:\(\)\s*\{/, /\brm\s+-rf\s+\/(?!\w)/,
];
const sh = (cmd, timeout = 25000) => new Promise((resolve) => {
  exec(cmd, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, shell: WIN ? undefined : '/bin/bash' },
    (err, stdout, stderr) => resolve({
      ok: !err, code: err ? (err.code ?? 1) : 0,
      out: String(stdout || '').slice(0, 6000), errOut: String(stderr || '').slice(0, 2000),
    }));
});
function openExternal(target) {
  const cmd = WIN ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open');
  const args = WIN ? ['/c', 'start', '', target] : [target];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch { return false; }
}
const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&quot;/g, '"').replace(/\s+/g, ' ').trim();

const TOOLS = [
  { name: 'get_datetime', desc: 'Current local date and time.', params: {} },
  { name: 'open_url', desc: 'Open a web page in the default browser.', params: { url: 'string - full http(s) URL' }, required: ['url'] },
  { name: 'open_app', desc: 'Launch an application by name, e.g. notepad, chrome, spotify, explorer.', params: { name: 'string' }, required: ['name'] },
  { name: 'run_command', desc: 'Run a shell command on this PC and get its output. Use for system info, listing processes, ipconfig, starting programs with arguments, etc. Destructive commands are refused.', params: { command: 'string' }, required: ['command'] },
  { name: 'read_file', desc: 'Read a text file (first 6000 chars).', params: { path: 'string - absolute path' }, required: ['path'] },
  { name: 'write_file', desc: 'Write text to a file, creating folders as needed. Overwrites.', params: { path: 'string - absolute path', content: 'string' }, required: ['path', 'content'] },
  { name: 'list_dir', desc: 'List the entries of a folder.', params: { path: 'string - absolute path' }, required: ['path'] },
  { name: 'web_search', desc: 'Search the web (DuckDuckGo). Returns titles, links and snippets.', params: { query: 'string' }, required: ['query'] },
  { name: 'web_fetch', desc: 'Fetch a web page as plain text (first 6000 chars).', params: { url: 'string' }, required: ['url'] },
  { name: 'media_key', desc: 'Send a media key: playpause, next, prev, volup, voldown, mute. Windows only.', params: { action: 'string' }, required: ['action'] },
  { name: 'remember', desc: 'Save a fact to long-term memory notes.', params: { text: 'string' }, required: ['text'] },
  { name: 'recall', desc: 'Read the saved long-term memory notes.', params: {} },
];
const toolSchemas = TOOLS.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.desc,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: 'string', description: v }])),
      required: t.required || [],
    },
  },
}));

async function runTool(name, args) {
  try {
    switch (name) {
      case 'get_datetime': {
        const d = new Date();
        return d.toLocaleString('en-IN', { dateStyle: 'full', timeStyle: 'medium' }) + ' (' + d.toISOString() + ')';
      }
      case 'open_url': {
        const u = new URL(String(args.url));
        if (!/^https?:$/.test(u.protocol)) return 'Refused: only http(s) URLs.';
        return openExternal(u.toString()) ? 'Opened ' + u.toString() : 'Could not open the browser.';
      }
      case 'open_app': {
        const app = String(args.name || '').replace(/["\n]/g, '');
        if (!app) return 'No app name given.';
        if (WIN) { const r = await sh('start "" "' + app + '"', 8000); return r.ok ? 'Launched ' + app : 'Launch failed: ' + (r.errOut || 'unknown app'); }
        return openExternal(app) ? 'Launched ' + app : 'Launch failed on this platform.';
      }
      case 'run_command': {
        const cmd = String(args.command || '');
        if (!cmd.trim()) return 'Empty command.';
        if (DENY.some((re) => re.test(cmd))) return 'Refused: that command matches the destructive-pattern denylist. Ask the user to run it manually if they really mean it.';
        const r = await sh(cmd);
        return (r.ok ? 'exit 0' : 'exit ' + r.code) + '\n' + (r.out || '') + (r.errOut ? '\nstderr: ' + r.errOut : '');
      }
      case 'read_file':
        return (await fs.promises.readFile(String(args.path), 'utf8')).slice(0, 6000);
      case 'write_file': {
        const p = String(args.path);
        await fs.promises.mkdir(path.dirname(p), { recursive: true });
        await fs.promises.writeFile(p, String(args.content ?? ''), 'utf8');
        return 'Wrote ' + p;
      }
      case 'list_dir': {
        const items = await fs.promises.readdir(String(args.path), { withFileTypes: true });
        return items.map((i) => (i.isDirectory() ? '[dir] ' : '') + i.name).join('\n').slice(0, 4000) || '(empty)';
      }
      case 'web_search': {
        const q = encodeURIComponent(String(args.query || ''));
        const res = await fetch('https://html.duckduckgo.com/html/?q=' + q, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const html = await res.text();
        const out = [];
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
        let m; while ((m = re.exec(html)) && out.length < 6) out.push(stripTags(m[2]) + '\n' + m[1] + '\n' + stripTags(m[3]));
        return out.length ? out.join('\n\n') : 'No results parsed. Try web_fetch on a likely site instead.';
      }
      case 'web_fetch': {
        const res = await fetch(String(args.url), { headers: { 'User-Agent': 'Mozilla/5.0' } });
        return stripTags(await res.text()).slice(0, 6000);
      }
      case 'media_key': {
        if (!WIN) return 'media_key is Windows-only for now.';
        const keys = { playpause: 179, next: 176, prev: 177, volup: 175, voldown: 174, mute: 173 };
        const code = keys[String(args.action || '').toLowerCase()];
        if (!code) return 'Unknown action. Use playpause, next, prev, volup, voldown, mute.';
        const ps = 'powershell -NoProfile -Command "$s=New-Object -ComObject WScript.Shell; $s.SendKeys([char]' + code + ')"';
        // SendKeys cannot send VK media codes directly; use keybd_event via .NET instead.
        const ps2 = 'powershell -NoProfile -Command "Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class K{[DllImport(\\"user32.dll\\")]public static extern void keybd_event(byte b,int s,int f,IntPtr e);}\'; [K]::keybd_event(' + code + ',0,0,[IntPtr]::Zero); [K]::keybd_event(' + code + ',0,2,[IntPtr]::Zero)"';
        void ps;
        const r = await sh(ps2, 10000);
        return r.ok ? 'Sent ' + args.action : 'media key failed: ' + (r.errOut || 'error');
      }
      case 'remember': {
        await fs.promises.mkdir(DATA_DIR, { recursive: true });
        await fs.promises.appendFile(NOTES_PATH, '- ' + String(args.text || '').replace(/\n/g, ' ') + '\n', 'utf8');
        return 'Saved to memory notes.';
      }
      case 'recall': {
        try { return (await fs.promises.readFile(NOTES_PATH, 'utf8')).slice(0, 4000) || '(no notes yet)'; }
        catch { return '(no notes yet)'; }
      }
      default: return 'Unknown tool: ' + name;
    }
  } catch (e) { return 'Tool error (' + name + '): ' + (e && e.message ? e.message : String(e)); }
}

// ---------------------------------------------------------------- agent loop
const CORE_PROMPT = [
  'You are Viktor Core, the built-in brain of the Viktor desktop companion on this PC (' + process.platform + ').',
  'You can act on the PC with your tools: open apps and pages, run commands, read and write files, search the web, control media playback, and remember facts.',
  'Rules: use tools when the user asks for an action or fresh information - do not invent results. Keep spoken replies short (the reply is read aloud): 1-3 sentences unless the user asks for detail. If a tool fails, say what happened plainly and offer the next step. Never claim you did something a tool did not confirm.',
].join(' ');

const sessions = new Map();   // sessionKey -> [{role, content}] (user/assistant only)
function logLine(session, obj) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(path.join(DATA_DIR, 'transcripts.jsonl'),
      JSON.stringify({ t: new Date().toISOString(), session, ...obj }) + '\n');
  } catch {}
}

async function callProvider(pcfg, messages) {
  const res = await fetch(pcfg.base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(pcfg.key ? { Authorization: 'Bearer ' + pcfg.key } : {}) },
    body: JSON.stringify({ model: pcfg.model, messages, tools: toolSchemas, tool_choice: 'auto', stream: false }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('provider HTTP ' + res.status + ' ' + body.slice(0, 240));
  }
  return res.json();
}

async function runAgent(pcfg, convo) {
  const messages = convo.map((m) => ({ ...m }));
  for (let round = 0; round < 6; round++) {
    const data = await callProvider(pcfg, messages);
    const msg = data && data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('empty provider response');
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const tc of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
        const result = await runTool(tc.function.name, args);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 7000) });
      }
      continue;
    }
    return String(msg.content || '').trim();
  }
  return 'I ran six tool rounds without finishing - the task may be too tangled for one go. Try splitting it up.';
}

// ---------------------------------------------------------------- http plumbing
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}
function streamAnswer(res, model, text) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const id = 'chatcmpl-viktor-' + Date.now();
  const chunk = (delta, finish) => res.write('data: ' + JSON.stringify({
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta, finish_reason: finish || null }],
  }) + '\n\n');
  const words = text.split(/(?<=\s)/);
  let i = 0;
  chunk({ role: 'assistant' });
  const tick = () => {
    if (i < words.length) { chunk({ content: words.slice(i, i + 3).join('') }); i += 3; setTimeout(tick, 24); }
    else { chunk({}, 'stop'); res.write('data: [DONE]\n\n'); res.end(); }
  };
  tick();
}

const SETTINGS_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Viktor Core</title>
<style>body{font-family:system-ui,sans-serif;background:#14101f;color:#efeaff;display:flex;justify-content:center;padding:32px}
main{max-width:520px;width:100%}h1{font-size:20px}label{display:block;margin:14px 0 4px;font-size:13px;color:#b9a5ff}
select,input{width:100%;padding:9px;border-radius:8px;border:1px solid #4b3678;background:#1e1830;color:#efeaff}
button{margin-top:20px;padding:10px 18px;border:0;border-radius:8px;background:#7c3aed;color:#fff;font-weight:600;cursor:pointer}
.note{font-size:12px;color:#9a8fb8;line-height:1.5}.ok{color:#7dffa8}</style></head><body><main>
<h1>🧠 Viktor Core — brain settings</h1>
<p class="note">Point Viktor's <b>Endpoint</b> setting at <b>http://127.0.0.1:__PORT__/v1</b> (API key can be anything). Changes apply to the next message — no restart.</p>
<form method="POST" action="/config">
<label>Provider</label>
<select name="provider"><option value="groq">Groq — cloud, fastest (needs API key + internet)</option><option value="ollama">Ollama — local, offline &amp; private</option></select>
<label>Groq API key (console.groq.com → API Keys; blank keeps the saved one)</label>
<input name="groqKey" type="password" placeholder="gsk_...">
<label>Groq model</label><input name="groqModel">
<label>Ollama model</label><input name="ollamaModel">
<label>Ollama base URL</label><input name="ollamaBase">
<button type="submit">Save</button> <span class="ok">__SAVED__</span>
</form>
<p class="note">Ollama: install from ollama.com, then run <b>ollama pull llama3.1:8b</b> once. Groq: a free key from console.groq.com is enough.</p>
<script>const c=__CFG__;document.querySelector('[name=provider]').value=c.provider;document.querySelector('[name=groqModel]').value=c.groq.model;document.querySelector('[name=ollamaModel]').value=c.ollama.model;document.querySelector('[name=ollamaBase]').value=c.ollama.base;</script>
</main></body></html>`;

const server = http.createServer(async (req, res) => {
  const cfg = loadConfig();
  const pcfg = providerCfg(cfg);
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const pub = { provider: cfg.provider, groq: { model: cfg.groq.model }, ollama: { model: cfg.ollama.model, base: cfg.ollama.base } };
      const html = SETTINGS_PAGE.replace('__PORT__', String(cfg.port)).replace('__CFG__', JSON.stringify(pub)).replace('__SAVED__', url.searchParams.get('saved') ? 'Saved ✓' : '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (req.method === 'POST' && url.pathname === '/config') {
      const form = new URLSearchParams(await readBody(req));
      const next = loadConfig();
      if (form.get('provider')) next.provider = form.get('provider') === 'ollama' ? 'ollama' : 'groq';
      if (form.get('groqKey')) next.groq.apiKey = form.get('groqKey').trim();
      if (form.get('groqModel')) next.groq.model = form.get('groqModel').trim();
      if (form.get('ollamaModel')) next.ollama.model = form.get('ollamaModel').trim();
      if (form.get('ollamaBase')) next.ollama.base = form.get('ollamaBase').trim();
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
      res.writeHead(303, { Location: '/?saved=1' });
      return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      return sendJson(res, 200, { object: 'list', data: [{ id: pcfg.model, object: 'model', created: 0, owned_by: 'viktor-core' }] });
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = JSON.parse(await readBody(req) || '{}');
      const incoming = Array.isArray(body.messages) ? body.messages : [];
      const sessionKey = String(req.headers['x-hermes-session-key'] || body.session || 'default');
      const systemMsgs = incoming.filter((m) => m.role === 'system');
      const plainIn = incoming.filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }));
      const stored = sessions.get(sessionKey) || [];
      // Viktor's console sends full history; the voice watcher sends one
      // message at a time. Adopt whichever view is longer, else append.
      let convoPlain;
      if (plainIn.length >= stored.length) convoPlain = plainIn;
      else if (plainIn.length === 1 && plainIn[0].role === 'user') convoPlain = [...stored, plainIn[0]];
      else convoPlain = stored.length ? stored : plainIn;
      const convo = [
        ...(systemMsgs.length ? systemMsgs : [{ role: 'system', content: 'You are Viktor, a desktop companion.' }]),
        { role: 'system', content: CORE_PROMPT },
        ...convoPlain.slice(-30),
      ];
      let answer;
      try {
        if (pcfg.name === 'groq' && !pcfg.key) throw new Error('No Groq API key set. Open http://127.0.0.1:' + cfg.port + '/ and paste one (free at console.groq.com), or switch the provider to Ollama.');
        answer = await runAgent(pcfg, convo);
      } catch (e) {
        answer = '⚠️ Viktor Core (' + pcfg.name + ') could not answer: ' + (e && e.message ? e.message : String(e));
      }
      const lastUser = [...convoPlain].reverse().find((m) => m.role === 'user');
      const newStored = [...convoPlain, { role: 'assistant', content: answer }].slice(-30);
      sessions.set(sessionKey, newStored);
      if (lastUser) logLine(sessionKey, { user: lastUser.content, assistant: answer, provider: pcfg.name, model: pcfg.model });
      if (body.stream) return streamAnswer(res, pcfg.model, answer);
      return sendJson(res, 200, {
        id: 'chatcmpl-viktor-' + Date.now(), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: pcfg.model,
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    }
    return sendJson(res, 404, { error: { message: 'not found: ' + url.pathname } });
  } catch (e) {
    return sendJson(res, 500, { error: { message: String(e && e.message ? e.message : e) } });
  }
});

const cfg0 = loadConfig();
server.listen(cfg0.port, '127.0.0.1', () => {
  const p = providerCfg(cfg0);
  console.log('Viktor Core listening on http://127.0.0.1:' + cfg0.port + '/v1  (provider: ' + p.name + ', model: ' + p.model + ')');
  console.log('Settings: http://127.0.0.1:' + cfg0.port + '/');
});
