// Animated dot-matrix voice orb. Modes: idle, listening, speaking, working, offline.
(function (global) {
  class Orb {
    constructor(canvas) {
      this.c = canvas;
      this.x = canvas.getContext('2d');
      this.mode = 'idle';
      this.level = 0;       // 0..1 live energy (mic / tts envelope)
      this.t = 0;
      this._raf = null;
      this._loop = this._loop.bind(this);
      this.start();
    }
    setMode(m) { this.mode = m; }
    setLevel(l) { this.level = Math.max(0, Math.min(1, l)); }
    start() { if (!this._raf) this._raf = requestAnimationFrame(this._loop); }
    stop() { cancelAnimationFrame(this._raf); this._raf = null; }
    _loop() {
      this._raf = requestAnimationFrame(this._loop);
      this.t += 0.016;
      const { x: ctx, c } = this;
      const CX = c.width / 2, CY = c.height / 2, R = c.width * 0.447;
      ctx.clearRect(0, 0, c.width, c.height);

      const modeAmp = { idle: 0.55, listening: 0.9, speaking: 1.0, working: 1.15, offline: 0.18 }[this.mode] ?? 0.5;
      const speed = this.mode === 'working' ? 2.6 : this.mode === 'speaking' ? 2.0 : 1.0;
      const live = this.level * (this.mode === 'speaking' || this.mode === 'listening' ? 1.4 : 0.4);
      const t = this.t * speed;
      const step = c.width / 29;

      for (let gy = 0; gy < 29; gy++) {
        for (let gx = 0; gx < 29; gx++) {
          const px = gx * step + step / 2, py = gy * step + step / 2;
          const dx = px - CX, dy = py - CY, d = Math.sqrt(dx * dx + dy * dy);
          if (d > R) continue;
          const wave = Math.sin(gx * .7 + t * 2) + Math.cos(gy * .5 + t * 1.3) + Math.sin((gx + gy) * .4 + t * 1.7);
          const edge = 1 - d / R;
          const amp = modeAmp + live * edge;
          const s = Math.max(0.6, 1.6 + Math.max(0, wave) * 2.4 * edge * amp);
          const a = (.18 + .72 * Math.max(0, wave / 2.4) * edge) * Math.min(1, amp);
          ctx.beginPath(); ctx.arc(px, py, s, 0, 7);
          ctx.fillStyle = this.mode === 'offline'
            ? `rgba(120,110,130,${a})`
            : wave > 1.1 ? `rgba(217,168,255,${a})` : `rgba(147,51,234,${a * .8})`;
          ctx.fill();
        }
      }
      // core
      const coreR = 24 + Math.sin(t * 3) * 3 + live * 14;
      ctx.beginPath(); ctx.arc(CX, CY, coreR, 0, 7);
      ctx.fillStyle = this.mode === 'offline' ? '#3a3540' : '#e9d5ff';
      ctx.shadowColor = this.mode === 'offline' ? 'transparent' : '#b05cff';
      ctx.shadowBlur = 40 + live * 30;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
  global.CompanionOrb = { Orb };
})(window);
