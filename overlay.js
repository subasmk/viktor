(function () {
  const api = window.companion;
  const canvas = document.getElementById('sprite');
  const stateEl = document.getElementById('state');
  const catCol = document.getElementById('catCol');
  const mascot = new CompanionMascot.Mascot(canvas);

  const LABELS = {
    idle: 'online', listening: 'listening…', speaking: 'speaking…',
    working: 'working…', happy: 'done ✓', sleepy: 'hermes offline',
    smug: 'smug', annoyed: 'annoyed', sit: 'chilling…', walk: 'wandering…', sleep: 'sleeping…',
  };
  const bubble = document.getElementById('bubble');
  const bubbleWrap = document.getElementById('bubbleWrap');
  const bubbleDest = document.getElementById('bubbleDest');
  function hideBubble() { bubbleWrap.classList.remove('show'); bubbleDest.textContent = ''; }
  function apply(s, reply) {
    mascot.setState(s);
    canvas.className = s;
    stateEl.textContent = LABELS[s] || s;
    stateEl.style.color = s === 'sleepy' ? '#ff8b8b' : '#cfc3e8';
    if (s === 'speaking' && reply) { bubble.textContent = reply; bubbleWrap.classList.add('show'); }
    else if (s !== 'happy') hideBubble();  // keep the reply up through the happy beat
  }
  apply('idle');

  // health check → sleepy when Hermes unreachable
  let hermesOk = false;
  async function health() {
    try { if (!api) throw new Error('no bridge'); await api.models(); hermesOk = true; apply(current === 'sleepy' ? 'idle' : current); }
    catch { hermesOk = false; apply('sleepy'); }
  }
  let current = 'idle';
  let happyT = null, lastReply = '';
  let sleepySince = 0;
  if (api) { api.onState((s, reply) => {
    const prev = current; current = s;
    pose = null;   // a real state change always wins over idle antics
    if (s === 'sleepy' && prev !== 'sleepy') sleepySince = Date.now();
    if (prev === 'speaking' && s === 'idle') {
      apply('happy', lastReply);  // finished talking -> happy bounce, bubble stays, then settle
      clearTimeout(happyT);
      happyT = setTimeout(() => { if (current === 'idle') apply('idle'); }, 2600);
    } else apply(s, reply);
    if (s === 'speaking' && reply) lastReply = reply;
    lastInteract = Date.now();
  }); health(); setInterval(health, 30000); }

  // click vs drag
  let moved = false, downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', (e) => { moved = false; downX = e.screenX; downY = e.screenY; });
  canvas.addEventListener('pointermove', (e) => { if (Math.hypot(e.screenX - downX, e.screenY - downY) > 6) moved = true; });
  // click = talk to VIKTOR (mic on/off), never the dashboard - console is right-click / Ctrl+B
  canvas.addEventListener('pointerup', async () => {
    if (moved || !api) return;
    lastInteract = Date.now();
    const r = await api.toggleVoice().catch(() => null);
    if (r && r.ok === false) {
      stateEl.textContent = r.error === 'no-python' ? 'voice needs python - run voice setup' : 'voice unavailable';
      stateEl.style.color = '#ff8b8b';
      setTimeout(() => apply(current), 2600);
    } else if (r && r.enabled) {
      apply('listening');
    } else if (r && r.ok && r.enabled === false) {
      sulkOff();   // mic switched off -> Dexter-style exit, then he slinks back
    }
  });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (api) api.overlayMenu(); });

  // ---------- Dexter mode: sulk-off, idle antics, quips, proactive ----------
  let lastInteract = Date.now();
  let pose = null;             // 'sit' | 'walk' | 'sleep' while an antic owns the mascot
  let sulkTimer = null;

  function sulkOff() {
    if (!catCol) return;
    hideBubble();
    catCol.classList.add('gone');
    clearTimeout(sulkTimer);
    sulkTimer = setTimeout(() => {
      catCol.classList.remove('gone');
      if (current === 'idle') { mascot.setState('smug'); setTimeout(() => { if (current === 'idle' && !pose) apply('idle'); }, 1500); }
    }, 2400);
  }
  document.addEventListener('pointerdown', () => {
    lastInteract = Date.now();
    if (catCol && catCol.classList.contains('gone')) { clearTimeout(sulkTimer); catCol.classList.remove('gone'); }
  });

  async function getCfg() {
    try { return (api && await api.getConfig()) || {}; } catch { return {}; }
  }

  // Idle antics: sit a while, wander a few steps, or (offline long enough) sleep.
  async function anticsTick() {
    setTimeout(anticsTick, 20000 + Math.random() * 20000);
    if (!api || pose || catCol.classList.contains('gone')) return;
    if (current === 'sleepy') {
      if (sleepySince && Date.now() - sleepySince > 45000) { pose = 'sleep'; mascot.setState('sleep'); }
      return;
    }
    if (current !== 'idle') return;
    const roll = Math.random();
    if (roll < 0.45) {
      pose = 'sit'; mascot.setState('sit');
      setTimeout(() => { if (pose === 'sit') { pose = null; if (current === 'idle') apply('idle'); } }, 7000 + Math.random() * 5000);
    } else if (roll < 0.75 && api.walk) {
      pose = 'walk'; mascot.setState('walk');
      const dx = (140 + Math.random() * 160) * (Math.random() < 0.5 ? -1 : 1);
      try { await api.walk(dx); } catch {}
      pose = null;
      if (current === 'idle') apply('idle');
    }
  }
  setTimeout(anticsTick, 15000);

  // Proactive quips: the mascot talks first, now and then, while you idle.
  let lastQuip = 0;
  async function quipTick() {
    setTimeout(quipTick, 45000 + Math.random() * 45000);
    if (!api || current !== 'idle' || pose === 'walk') return;
    if (Date.now() - lastInteract < 40000 || Date.now() - lastQuip < 150000) return;
    if (pendingSuggestion) return;   // never cover an actionable offer with a quip - a click must approve what is visible
    const cfg = await getCfg();
    const level = cfg.personality || 'off';
    if (level === 'off') return;
    const list = (window.CompanionPersona && CompanionPersona.quipsFor(level)) || [];
    if (!list.length) return;
    lastQuip = Date.now();
    bubble.textContent = list[Math.floor(Math.random() * list.length)];
    bubbleWrap.classList.add('show');
    mascot.setState('smug');
    setTimeout(() => { if (current === 'idle' && !pendingSuggestion) { hideBubble(); if (!pose) apply('idle'); } }, 4200);
  }
  setTimeout(quipTick, 60000);

  // Proactive scout: Viktor checks the news itself and offers to act
  // ("GTA 6 trailer dropped - click me and I'll open it"). Clicking the
  // bubble is the yes; nothing opens on its own.
  let pendingSuggestion = '';
  let collecting = null;   // {buf} while one of OUR chat streams is running
  if (api && api.onChunk) api.onChunk((c) => {
    if (!collecting) return;
    if (c.delta) collecting.buf += c.delta;
    if (c.done || c.failed) { const done = collecting; collecting = null; done.finish && done.finish(done.buf); }
  });

  function chatOnce(messages, sessionKey) {
    return new Promise((resolve) => {
      collecting = { buf: '', finish: resolve };
      api.chat(messages, sessionKey).catch(() => { if (collecting) { collecting = null; } resolve(''); });
      setTimeout(() => { if (collecting) { const b = collecting.buf; collecting = null; resolve(b); } }, 90000);
    });
  }

  async function scoutTick() {
    setTimeout(scoutTick, 50 * 60 * 1000);
    if (!api || !hermesOk || current !== 'idle' || pendingSuggestion) return;
    const cfg = await getCfg();
    if (cfg.proactive === false) return;
    const level = cfg.personality || 'off';
    if (level === 'off') return;
    let notes = [];
    try { notes = JSON.parse(localStorage.getItem('companion.notes')) || []; } catch {}
    const persona = window.CompanionPersona && CompanionPersona.promptFor(level);
    const messages = [];
    if (persona) messages.push({ role: 'system', content: persona });
    messages.push({ role: 'system', content:
      "You are VIKTOR's proactive scout. Use your web tools to check today's news for: GTA / Rockstar games, major AI announcements, and big tech or product launches." +
      (notes.length ? ' The user also cares about: ' + notes.slice(0, 5).join('; ') + '.' : '') +
      " If you find ONE thing worth sharing, reply with EXACTLY one line in one of these two forms:" +
      " INFO: <one short in-character line, max 22 words, just sharing the news>" +
      " OFFER: <one short in-character line, max 22 words, offering to open the page> | <the exact https URL to open>" +
      " Never offer anything except opening that one link - no settings, installs, downloads, file changes or messages." +
      " If nothing is genuinely notable, reply with exactly: NOTHING. No preamble, no markdown, one line only." });
    messages.push({ role: 'user', content: 'Do your proactive check now.' });
    const raw = (await chatOnce(messages, 'viktor-proactive')).trim();
    if (!raw || /^NOTHING\b/i.test(raw)) return;
    if (raw.includes('\n') || raw.length > 260) return;   // one short visible offer only
    let parsed = null;
    let mm = raw.match(/^OFFER:\s*(.+?)\s*\|\s*(https:\/\/\S+)\s*$/i);
    if (mm) {
      let u = null;
      try { u = new URL(mm[2]); } catch {}
      if (u && u.protocol === 'https:' && !u.username && !u.password && !/[\x00-\x1f\x7f]/.test(mm[2])) {
        parsed = { text: mm[1].slice(0, 180), url: u.toString(), host: u.hostname };
      }
    } else { mm = raw.match(/^INFO:\s*(.+)$/i); if (mm) parsed = { text: mm[1].slice(0, 180), url: '', host: '' }; }
    if (!parsed) return;
    bubble.textContent = parsed.text;
    bubbleDest.textContent = parsed.host ? 'opens ' + parsed.host + ' - nothing else runs' : '';
    bubbleWrap.classList.add('show');
    mascot.setState('happy');
    setTimeout(() => { if (current === 'idle' && !pose) mascot.setState('idle'); }, 2000);
    setTimeout(() => { if (pendingSuggestion === parsed) { pendingSuggestion = null; hideBubble(); } }, 120000);
  }
  setTimeout(scoutTick, 180000);

  bubbleWrap.style.cursor = 'pointer';
  bubbleWrap.addEventListener('click', async () => {
    if (!pendingSuggestion || !api) return;
    const suggestion = pendingSuggestion;   // {text, url} - parsed and validated by the scout
    pendingSuggestion = null;
    if (suggestion.url && api.openExternal) {
      bubble.textContent = 'Opening it…';
      const ok = await api.openExternal(suggestion.url).catch(() => false);
      bubble.textContent = ok ? 'Opened!' : 'Could not open that link.';
    } else {
      hideBubble();   // info-only: a click just dismisses
      return;
    }
    mascot.setState('happy');
    setTimeout(() => { hideBubble(); if (current === 'idle' && !pose) apply('idle'); }, 6000);
  });
})();
