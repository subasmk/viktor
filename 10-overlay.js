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
  if (api) { api.onState((s) => { current = s; apply(s); }); health(); setInterval(health, 30000); }

  // click vs drag
  let moved = false, downX = 0, downY = 0;
  canvas.addEventListener('pointerdown', (e) => { moved = false; downX = e.screenX; downY = e.screenY; });
  canvas.addEventListener('pointermove', (e) => { if (Math.hypot(e.screenX - downX, e.screenY - downY) > 6) moved = true; });
  canvas.addEventListener('pointerup', () => { if (!moved && api) api.openConsole(); });
  canvas.addEventListener('contextmenu', (e) => { e.preventDefault(); if (api) api.overlayMenu(); });
})();
