(function () {
  const api = window.companion; // preload bridge (absent if opened as a plain file)
  const $ = (id) => document.getElementById(id);

  let config = { endpoint: 'http://127.0.0.1:8642/v1', apiKey: '', sessionKey: 'desktop-console', appName: 'VIKTOR', speakReplies: true, ttsVoice: '' };
  let live = false;
  let busy = false;
  let generation = 0;
  const bootTime = Date.now();

  const orb = new CompanionOrb.Orb($('orb'));
  const mascotMain = new CompanionMascot.Mascot($('spriteMain'));
  const mascotMini = new CompanionMascot.Mascot($('spriteMini'));

  // EQ bars in command bar
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('i');
    b.style.height = (4 + Math.random() * 20) + 'px';
    b.style.animationDelay = (Math.random() * -1) + 's';
    $('eqLive').appendChild(b);
  }

  function toast(text, ms = 2600) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = text;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  function setState(s) {
    mascotMain.setState(s);
    $('mascotState').textContent = { idle: 'idle', listening: 'listening', speaking: 'speaking', working: 'working', happy: 'done', sleepy: 'offline' }[s] || s;
    orb.setMode(s === 'sleepy' ? 'offline' : s);
    if (api) api.setState(s);
    const map = { idle: ['READY', 'say a command, or hold the mascot'], listening: ['LISTENING', 'speak now…'], speaking: ['SPEAKING', 'say "stop" to cut it off'], working: ['WORKING', 'hermes is on it…'], sleepy: ['OFFLINE', 'cannot reach your Hermes - see SETTINGS'], happy: ['DONE', ''] }[s];
    if (map) { $('orbState').textContent = map[0]; $('orbSub').textContent = map[1]; $('orbState').classList.toggle('off', s === 'sleepy'); }
  }

  function setBadge(ok, detail) {
    live = ok;
    $('connBadge').className = 'status-pill ' + (ok ? 'live' : 'off');
    $('connText').textContent = ok ? 'HERMES LIVE' : 'HERMES OFFLINE';
    $('sysBackend').textContent = ok ? 'hermes-agent' : '--';
    $('sysBackend').className = ok ? 'tag-ok' : 'tag-bad';
    if (detail) $('sysRoute').textContent = detail;
  }

  async function health() {
    if (!api) { setBadge(false, 'no bridge'); setState('sleepy'); $('orbSub').textContent = 'opened outside the desktop app - run: npm start'; return; }
    try {
      const t0 = performance.now();
      const m = await api.models();
      const ms = Math.round(performance.now() - t0);
      $('sysLatency').textContent = ms + ' ms';
      const host = (config.endpoint || '').replace(/^https?:\/\//, '').split('/')[0];
      setBadge(true, host);
      $('sysRoute').className = 'tag-ok';
      if (m && m.data && m.data[0]) {
        $('sysBackend').textContent = m.data[0].id || 'hermes-agent';
        if (m.data[0].id && m.data[0].id !== config.modelName) { config.modelName = m.data[0].id; saveConfig(); }
      }
      if (!busy) setState('idle');
    } catch (e) {
      setBadge(false, (config.endpoint || '').replace(/^https?:\/\//, '').split('/')[0]);
      $('sysRoute').className = 'tag-bad';
      $('sysLatency').textContent = '--';
      setState('sleepy');
      lastError = String(e && e.message || e);
    }
  }

  // ---------- chat ----------
  function addMsg(role, text, meta) {
    const d = document.createElement('div');
    d.className = 'msg ' + role;
    d.textContent = text;
    if (meta) { const m = document.createElement('div'); m.className = 'meta'; m.textContent = meta; d.appendChild(m); }
    $('chatScroll').appendChild(d);
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
    return d;
  }
  function addTyping() {
    const d = document.createElement('div');
    d.className = 'msg ai';
    d.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
    $('chatScroll').appendChild(d);
    $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
    return d;
  }

  function speak(text) {
    if (!config.speakReplies || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const v = voices.find(v => v.name === config.ttsVoice) || voices.find(v => /david|mark|guy|male/i.test(v.name)) || voices[0];
    if (v) u.voice = v;
    u.onstart = () => setState('speaking');
    u.onend = () => setState(live ? 'idle' : 'sleepy');
    const lvl = setInterval(() => orb.setLevel(0.3 + Math.random() * 0.7), 120);
    u.onend = () => { clearInterval(lvl); orb.setLevel(0); setState(live ? 'idle' : 'sleepy'); };
    speechSynthesis.speak(u);
  }

  async function sendCommand(text) {
    text = (text || '').trim();
    if (!text || busy) return;
    if (!api) { toast('Desktop bridge missing - run with: npm start'); return; }
    if (!live) { addMsg('err', 'Hermes is offline. Fix the connection in SETTINGS, then retry. Last error: ' + (lastError || 'unknown')); return; }
    busy = true;
    generation++;
    const gen = generation;
    addMsg('user', text, new Date().toLocaleTimeString());
    const typing = addTyping();
    setState('working');
    const notes = getNotes();
    const messages = [];
    if (notes.length) messages.push({ role: 'system', content: 'Persistent user notes (device console):\n' + notes.map(n => '- ' + n).join('\n') });
    messages.push({ role: 'user', content: text });

    const t0 = performance.now();
    let acc = '';
    let bubble = null;
    const off = api.onChunk((c) => {
      if (gen !== generation) return;
      if (c.delta) {
        acc += c.delta;
        if (!bubble) { typing.remove(); bubble = addMsg('ai', ''); }
        bubble.textContent = acc;
        $('chatScroll').scrollTop = $('chatScroll').scrollHeight;
      }
      if (c.failed) {
        if (!bubble) { typing.remove(); bubble = addMsg('err', 'Turn ' + c.failed + ' by Hermes.'); }
      }
    });
    try {
      await api.chat(messages);
      typing.remove();
      if (!bubble && acc) bubble = addMsg('ai', acc);
      if (bubble) {
        const ms = Math.round(performance.now() - t0);
        $('sysLatency').textContent = ms + ' ms';
        const meta = document.createElement('div'); meta.className = 'meta';
        meta.textContent = (config.appName || 'VIKTOR') + ' · ' + (ms / 1000).toFixed(1) + 's';
        bubble.appendChild(meta);
      }
      setState('happy');
      setTimeout(() => { if (!busy) setState(live ? 'idle' : 'sleepy'); }, 1200);
      if (acc) speak(acc);
    } catch (e) {
      typing.remove();
      addMsg('err', 'Request failed: ' + String(e && e.message || e));
      setBadge(false, (config.endpoint || '').replace(/^https?:\/\//, '').split('/')[0]);
      setState('sleepy');
    } finally {
      off(); busy = false;
    }
  }

  // ---------- notes ----------
  const NOTES_KEY = 'companion.notes';
  function getNotes() { try { return JSON.parse(localStorage.getItem(NOTES_KEY)) || []; } catch { return []; } }
  function setNotes(n) { localStorage.setItem(NOTES_KEY, JSON.stringify(n)); renderNotes(); }
  function renderNotes() {
    const ul = $('memList'); ul.innerHTML = '';
    getNotes().forEach((n, i) => {
      const li = document.createElement('li');
      const s = document.createElement('span'); s.textContent = n;
      const b = document.createElement('button'); b.textContent = 'remove';
      b.onclick = () => setNotes(getNotes().filter((_, j) => j !== i));
      li.appendChild(s); li.appendChild(b); ul.appendChild(li);
    });
  }
  $('memAdd').onclick = () => { const v = $('memInput').value.trim(); if (v) { setNotes([...getNotes(), v]); $('memInput').value = ''; } };
  $('memInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('memAdd').click(); });

  // ---------- skills ----------
  const SKILLS = [
    { id: 'speakReplies', nm: 'Speak replies', ds: 'Windows voices, offline' },
    { id: 'voiceInput', nm: 'Voice input via OpenWhispr', ds: 'hotkey types into the command bar' },
    { id: 'overlayStates', nm: 'Overlay mascot reactions', ds: 'idle / listening / speaking / working / offline' },
  ];
  const SKILLS_KEY = 'companion.skills';
  function getSkills() { try { return { speakReplies: true, voiceInput: true, overlayStates: true, ...JSON.parse(localStorage.getItem(SKILLS_KEY)) }; } catch { return {}; } }
  function renderSkills() {
    const cur = getSkills();
    const wrap = $('skillToggles'); wrap.innerHTML = '';
    const listEl = $('skillList'); listEl.innerHTML = '';
    SKILLS.forEach((s) => {
      const row = document.createElement('div'); row.className = 'skill-toggle';
      const left = document.createElement('div');
      left.innerHTML = '<div class="nm">' + s.nm + '</div><div class="ds">' + s.ds + '</div>';
      const sw = document.createElement('div'); sw.className = 'switch' + (cur[s.id] ? ' on' : '');
      sw.onclick = () => { const k = getSkills(); k[s.id] = !k[s.id]; localStorage.setItem(SKILLS_KEY, JSON.stringify(k)); if (s.id === 'speakReplies') { config.speakReplies = k[s.id]; saveConfig(); } renderSkills(); };
      row.appendChild(left); row.appendChild(sw); wrap.appendChild(row);
      const r2 = document.createElement('div'); r2.className = 'row';
      r2.innerHTML = '<span class="lab">⬢ ' + s.nm.toLowerCase() + '</span><b class="' + (cur[s.id] ? 'tag-ok' : 'tag-bad') + '">' + (cur[s.id] ? 'on' : 'off') + '</b>';
      listEl.appendChild(r2);
    });
  }

  // ---------- views ----------
  document.querySelectorAll('.nav .pill').forEach((p) => {
    p.onclick = () => {
      document.querySelectorAll('.nav .pill').forEach(x => x.classList.remove('on'));
      p.classList.add('on');
      ['console', 'notes', 'skills', 'settings'].forEach(v => $('view-' + v).classList.toggle('hidden', v !== p.dataset.view));
      if (p.dataset.view === 'settings') fillSettings();
    };
  });

  // ---------- settings ----------
  async function saveConfig() { if (api) config = await api.setConfig(config); }
  async function fillSettings() {
    $('setName').value = config.appName || '';
    $('setEndpoint').value = config.endpoint || '';
    $('setKey').value = config.apiKey || '';
    $('setSession').value = config.sessionKey || '';
    $('setSpeak').checked = !!config.speakReplies;
    const sel = $('setVoice'); sel.innerHTML = '';
    speechSynthesis.getVoices().forEach(v => { const o = document.createElement('option'); o.value = v.name; o.textContent = v.name; if (v.name === config.ttsVoice) o.selected = true; sel.appendChild(o); });
    if (api && api.detectHermes) {
      const d = await api.detectHermes();
      $('hermesDetect').textContent = d.hermesHome
        ? 'Detected a Hermes data folder at ' + d.path + (d.envPresent ? ' (.env present)' : ' (no .env yet - the API server needs API_SERVER_ENABLED=true and API_SERVER_KEY there). Docs: hermes-agent.nousresearch.com/docs/user-guide/features/api-server')
        : 'No Hermes data folder found at the usual location. If your assistant runs elsewhere, just point the endpoint above at it.';
    }
  }
  $('setSave').onclick = async () => {
    config.appName = $('setName').value.trim() || 'VIKTOR';
    config.endpoint = $('setEndpoint').value.trim() || 'http://127.0.0.1:8642/v1';
    config.apiKey = $('setKey').value.trim();
    config.sessionKey = $('setSession').value.trim() || 'desktop-console';
    config.ttsVoice = $('setVoice').value;
    config.speakReplies = $('setSpeak').checked;
    await saveConfig();
    $('appLogo').textContent = config.appName.toUpperCase();
    $('setStatus').textContent = 'Saved.';
    health();
  };
  $('setTest').onclick = async () => {
    $('setStatus').textContent = 'Testing…';
    try {
      const t0 = performance.now();
      await api.models();
      $('setStatus').textContent = 'Connected in ' + Math.round(performance.now() - t0) + ' ms.';
    } catch (e) {
      $('setStatus').textContent = 'Failed: ' + String(e && e.message || e) + ' — check that the gateway is running and the key matches.';
    }
  };

  // ---------- voice input ----------
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null, listening = false;
  function toggleListen(on) {
    if (!SR) { toast('No built-in speech recognition here - use your OpenWhispr hotkey to dictate into the command bar.'); return; }
    if (on === undefined) on = !listening;
    if (on && !listening) {
      rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true;
      rec.onresult = (e) => {
        let fin = '', inter = '';
        for (const r of e.results) (r.isFinal ? fin += r[0].transcript : inter += r[0].transcript);
        $('cmdInput').value = fin || inter;
        if (fin) { stopListen(); sendCommand(fin); }
      };
      rec.onerror = () => stopListen();
      rec.onend = () => stopListen();
      rec.start(); listening = true; setState('listening');
      const lvl = setInterval(() => { if (!listening) { clearInterval(lvl); orb.setLevel(0); } else orb.setLevel(Math.random()); }, 150);
    } else if (!on) stopListen();
  }
  function stopListen() { if (rec) try { rec.stop(); } catch {} listening = false; orb.setLevel(0); if (!busy) setState(live ? 'idle' : 'sleepy'); }

  // mascot hold-to-talk
  const m1 = $('mascotMain');
  m1.addEventListener('pointerdown', () => toggleListen(true));
  m1.addEventListener('pointerup', () => { if (listening) { /* let final result fire */ setTimeout(() => toggleListen(false), 400); } });
  $('mascotMini').addEventListener('click', () => {
    const spots = [[3, 60], [70, 12], [30, 70], [60, 65], [12, 20]];
    const [x, y] = spots[Math.floor(Math.random() * spots.length)];
    const el = $('mascotMini');
    el.style.right = 'auto'; el.style.bottom = 'auto';
    el.style.left = x + '%'; el.style.top = y + '%';
    mascotMini.setState('happy'); setTimeout(() => mascotMini.setState('idle'), 1500);
  });

  // ---------- command bar ----------
  $('micBtn').onclick = () => toggleListen();
  $('cmdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { sendCommand($('cmdInput').value); $('cmdInput').value = ''; } });
  $('stopBtn').onclick = () => { generation++; speechSynthesis.cancel(); stopListen(); busy = false; setState(live ? 'idle' : 'sleepy'); };
  const obs = new MutationObserver(() => $('stopBtn').classList.toggle('hidden', !(busy || speechSynthesis.speaking)));
  setInterval(() => $('stopBtn').classList.toggle('hidden', !(busy || speechSynthesis.speaking)), 300);

  document.querySelectorAll('.chip').forEach(ch => ch.onclick = () => sendCommand(ch.dataset.cmd));

  // uptime ticker
  setInterval(() => {
    const s = Math.floor((Date.now() - bootTime) / 1000);
    $('sysUptime').textContent = [s / 3600, s / 60 % 60, s % 60].map(n => String(Math.floor(n)).padStart(2, '0')).join(':');
  }, 1000);

  let lastError = '';

  // ---------- boot ----------
  (async function boot() {
    if (api) {
      config = { ...config, ...(await api.getConfig()) };
      $('appLogo').textContent = (config.appName || 'VIKTOR').toUpperCase();
      api.onState(() => {}); // console is the state source
    }
    renderNotes(); renderSkills();
    await health();
    setInterval(health, 20000);
    setState(live ? 'idle' : 'sleepy');
  })();
})();
