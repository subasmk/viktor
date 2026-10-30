(function () {
  const api = window.companion;
  const canvas = document.getElementById('sprite');
  const img = document.getElementById('spriteImg');
  const stateEl = document.getElementById('state');
  const catCol = document.getElementById('catCol');
  const pixelMascot = new CompanionMascot.Mascot(canvas);
  const spriteMascot = new SpriteMascot(img);
  let style = 'shiba';   // default mascot; Settings can switch to the pixel cat
  const mascot = {
    setState(s) {
      if (style === 'shiba') spriteMascot.setState(s);
      else pixelMascot.setState(s === 'peek' ? 'happy' : s);   // the pixel cat has no peek pose
    },
    isShiba() { return style === 'shiba'; },
  };
  function applyStyle() {
    const shiba = style === 'shiba';
    img.style.display = shiba ? 'block' : 'none';
    canvas.style.display = shiba ? 'none' : 'block';
  }
  applyStyle();
  if (api && api.getConfig) api.getConfig().then((cfg) => {
    if (cfg && cfg.mascotStyle === 'pixel') { style = 'pixel'; applyStyle(); mascot.setState(current); }
  }).catch(() => {});
  if (api && api.onConfigChanged) api.onConfigChanged((cfg) => {   // Settings mascot switch applies live
    const s = cfg && cfg.mascotStyle === 'pixel' ? 'pixel' : 'shiba';
    if (s !== style) { style = s; applyStyle(); mascot.setState(current); }
  });

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
  for (const el of [canvas, img]) el.addEventListener('pointerdown', (e) => { moved = false; downX = e.screenX; downY = e.screenY; });
  for (const el of [canvas, img]) el.addEventListener('pointermove', (e) => { if (Math.hypot(e.screenX - downX, e.screenY - downY) > 6) moved = true; });
  // click = talk to VIKTOR (mic on/off), never the dashboard - console is right-click / Ctrl+B
  for (const el of [canvas, img]) el.addEventListener('pointerup', async () => {
    if (moved || !api) return;
    lastInteract = Date.now();
    const r = await api.toggleVoice().catch(() => null);
    if (r && r.ok === false) {
      stateEl.textContent = r.error === 'no-python' ? 'voice needs python - run voice setup' : 'voice unavailable';
      stateEl.style.color = '#ff8b8b';
      setTimeout(() => apply(current), 2600);
    } else if (r && r.enabled) {
      if (mascot.isShiba()) { spriteMascot.setState('wave'); setTimeout(() => { if (current === 'idle') apply('listening'); }, 900); }
      else apply('listening');
    } else if (r && r.ok && r.enabled === false) {
      sulkOff();   // mic switched off -> Dexter-style exit, then he slinks back
    }
  });
  for (const el of [canvas, img]) el.addEventListener('contextmenu', (e) => { e.preventDefault(); if (api) api.overlayMenu(); });

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
  let pendingSuggestion = null;   // {text, url, host} from the bounded news scout

  async function scoutTick() {
    setTimeout(scoutTick, 50 * 60 * 1000);
    if (!api || current !== 'idle' || pendingSuggestion) return;
    const cfg = await getCfg();
    if (cfg.proactive === false) return;
    const level = cfg.personality || 'off';
    if (level === 'off') return;
    const items = api.scoutNews ? await api.scoutNews().catch(() => []) : [];
    if (!items || !items.length) return;
    // Freshness gate: only offer news published in the last 36 hours; RSS
    // items with an unparseable date are skipped rather than offered stale.
    const fresh = items.filter((it) => it.when && Date.now() - it.when < 36 * 3600 * 1000);
    if (!fresh.length) return;
    let notes = [];
    try { notes = JSON.parse(localStorage.getItem('companion.notes')) || []; } catch {}
    const kws = notes.join(' ').toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const scored = fresh.map((it) => {
      const t = it.title.toLowerCase();
      let s = 0;
      kws.forEach((k) => { if (t.includes(k)) s += 2; });
      if (/gta|rockstar|openai|gemini|claude|anthropic|launch|release|trailer|announce/.test(t)) s += 1;
      return { it, s };
    }).sort((a, b) => b.s - a.s || b.it.when - a.it.when);
    const top = scored[0].it;
    let u = null;
    try { u = new URL(top.url); } catch {}
    if (!u || u.protocol !== 'https:' || u.username || u.password) return;
    if (localStorage.getItem('companion.lastScoutUrl') === u.toString()) return;
    localStorage.setItem('companion.lastScoutUrl', u.toString());
    const title = top.title.length > 110 ? top.title.slice(0, 107) + '…' : top.title;
    pendingSuggestion = { text: title + " - click me and I'll open it.", url: u.toString(), host: u.hostname };
    bubble.textContent = pendingSuggestion.text;
    bubbleDest.textContent = 'opens ' + u.hostname + ' - nothing else runs';
    bubbleWrap.classList.add('show');
    mascot.setState('peek');   // the dog peeks over the edge with the offer (pixel cat: happy bounce)
    setTimeout(() => { if (current === 'idle' && !pose) mascot.setState('idle'); }, 2000);
    setTimeout(() => { if (pendingSuggestion && pendingSuggestion.url === u.toString()) { pendingSuggestion = null; hideBubble(); } }, 120000);
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
