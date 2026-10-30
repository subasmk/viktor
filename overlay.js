(function () {
  const api = window.companion;
  const canvas = document.getElementById('sprite');
  const stateEl = document.getElementById('state');
  const mascot = new CompanionMascot.Mascot(canvas);

  const LABELS = {
    idle: 'online', listening: 'listening…', speaking: 'speaking…',
    working: 'working…', happy: 'done ✓', sleepy: 'hermes offline',
  };
  function apply(s) {
    mascot.setState(s);
    canvas.className = s;
    stateEl.textContent = LABELS[s] || s;
    stateEl.style.color = s === 'sleepy' ? '#ff8b8b' : '#cfc3e8';
  }
  apply('idle');

  // health check → sleepy when Hermes unreachable
  async function health() {
    try { if (!api) throw new Error('no bridge'); await api.models(); apply(current === 'sleepy' ? 'idle' : current); }
    catch { apply('sleepy'); }
  }
  let current = 'idle';
  let happyT = null;
  if (api) { api.onState((s) => {
    const prev = current; current = s;
    if (prev === 'speaking' && s === 'idle') {
      apply('happy');  // finished talking -> happy bounce, then settle
      clearTimeout(happyT);
      happyT = setTimeout(() => { if (current === 'idle') apply('idle'); }, 2400);
    } else apply(s);
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
