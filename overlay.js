(function () {
  const api = window.companion;
  const canvas = document.getElementById('sprite');
  const stateEl = document.getElementById('state');
  const mascot = new CompanionMascot.Mascot(canvas);

  const LABELS = {
    idle: 'online', listening: 'listening…', speaking: 'speaking…',
    working: 'working…', happy: 'done ✓', sleepy: 'hermes offline',
  };
  const bubble = document.getElementById('bubble');
  const bubbleWrap = document.getElementById('bubbleWrap');
  function apply(s, reply) {
    mascot.setState(s);
    canvas.className = s;
    stateEl.textContent = LABELS[s] || s;
    stateEl.style.color = s === 'sleepy' ? '#ff8b8b' : '#cfc3e8';
    if (s === 'speaking' && reply) { bubble.textContent = reply; bubbleWrap.classList.add('show'); }
    else if (s !== 'happy') bubbleWrap.classList.remove('show');  // keep the reply up through the happy beat
  }
  apply('idle');

  // health check → sleepy when Hermes unreachable
  async function health() {
    try { if (!api) throw new Error('no bridge'); await api.models(); apply(current === 'sleepy' ? 'idle' : current); }
    catch { apply('sleepy'); }
  }
  let current = 'idle';
  let happyT = null, lastReply = '';
  if (api) { api.onState((s, reply) => {
    const prev = current; current = s;
    if (prev === 'speaking' && s === 'idle') {
      apply('happy', lastReply);  // finished talking -> happy bounce, bubble stays, then settle
      clearTimeout(happyT);
      happyT = setTimeout(() => { if (current === 'idle') apply('idle'); }, 2600);
    } else apply(s, reply);
    if (s === 'speaking' && reply) lastReply = reply;
  }); health(); setInterval(health, 30000); }

  // click vs drag
  let moved = false, downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', (e) => { moved = false; downX = e.screenX; downY = e.screenY; });
  canvas.addEventListener('pointermove', (e) => { if (Math.hypot(e.screenX - downX, e.screenY - downY) > 6) moved = true; });
  // click = talk to VIKTOR (mic on/off), never the dashboard - console is right-click / Ctrl+B
  canvas.addEventListener('pointerup', async () => {
    if (moved || !api) return;
    const r = await api.toggleVoice().catch(() => null);
    if (r && r.ok === false) {
      stateEl.textContent = r.error === 'no-python' ? 'voice needs python - run voice setup' : 'voice unavailable';
      stateEl.style.color = '#ff8b8b';
      setTimeout(() => apply(current), 2600);
    } else if (r && r.enabled) {
      apply('listening');
    }
  });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (api) api.overlayMenu(); });
})();
