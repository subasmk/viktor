// SpriteMascot - the Shiba mascot. Same setState() interface as the pixel
// Mascot (mascot.js), but each state shows a pose image from assets/shiba/
// (user-supplied art). State -> pose:
//   idle/smug -> idle (sitting, shades, smug)   listening -> paw at ear
//   working   -> think (paw on chin)            speaking  -> mid-speech
//   happy     -> excited (jump + sparkles)      sit       -> chill (reclined)
//   sleep     -> sleep (curled up, Zzz)         sleepy/error -> defeated
//   annoyed   -> glare, arms crossed            walk      -> walk1/walk2 frames
//   peek      -> peeking over the edge          wave      -> greeting paw
//
// Animation pack: poses are still images, so life comes from motion layered
// on top - pop-in on every pose change (WAAPI, so it never fights the CSS
// state animations), idle micro-motion (tilts, squash, tiny hops), and an FX
// layer (floating Zzz, sparkles, anger vein, listening rings, thinking dots).
(function (global) {
  const POSES = {
    idle: 'idle', smug: 'idle', listening: 'listening', working: 'think',
    speaking: 'speaking', happy: 'excited', sit: 'chill', sleep: 'sleep',
    sleepy: 'defeated', error: 'defeated', annoyed: 'annoyed',
    peek: 'peek', wave: 'wave',
  };
  const FILES = ['idle', 'listening', 'speaking', 'think', 'excited', 'chill',
    'sleep', 'defeated', 'annoyed', 'peek', 'wave', 'walk1', 'walk2'];
  const IDLE_STATES = ['idle', 'smug', 'sit'];

  class SpriteMascot {
    constructor(img, fx, dots) {
      this.img = img;
      this.fx = fx || null;       // particle layer (absolutely positioned)
      this.dots = dots || null;   // thinking-dots element for `working`
      this.state = '';
      this.frameTimer = null;
      this.fxTimer = null;
      this.idleTimer = null;
      this.cache = {};
      for (const f of FILES) { const i = new Image(); i.src = 'assets/shiba/' + f + '.png'; this.cache[f] = i; }
      this.setState('idle');
    }
    show(file) { if (this.cache[file]) this.img.src = this.cache[file].src; }

    // --- FX layer -------------------------------------------------------
    particle(text, cls) {
      if (!this.fx) return;
      const el = document.createElement('span');
      el.className = 'fxp ' + (cls || '');
      el.textContent = text;
      el.style.left = (52 + Math.random() * 36) + '%';
      el.style.top = (2 + Math.random() * 16) + '%';
      this.fx.appendChild(el);
      const drift = (Math.random() * 26 - 8) + 'px';
      el.animate([
        { transform: 'translate(0,0) scale(.6)', opacity: 0 },
        { transform: 'translate(' + drift + ',-18px) scale(1)', opacity: 1, offset: .25 },
        { transform: 'translate(' + drift + ',-52px) scale(1.25)', opacity: 0 },
      ], { duration: 2100, easing: 'ease-out' }).onfinish = () => el.remove();
    }
    ring() {
      if (!this.fx) return;
      const el = document.createElement('span');
      el.className = 'fxring';
      this.fx.appendChild(el);
      el.animate([
        { transform: 'translate(-50%,-50%) scale(.35)', opacity: .85 },
        { transform: 'translate(-50%,-50%) scale(1.15)', opacity: 0 },
      ], { duration: 1250, easing: 'ease-out' }).onfinish = () => el.remove();
    }
    popFx(text, cls) {   // one big glyph that pops and fades in place
      if (!this.fx) return;
      const el = document.createElement('span');
      el.className = 'fxp big ' + (cls || '');
      el.textContent = text;
      el.style.left = '68%'; el.style.top = '0%';
      this.fx.appendChild(el);
      el.animate([
        { transform: 'scale(.3) rotate(-14deg)', opacity: 0 },
        { transform: 'scale(1.25) rotate(6deg)', opacity: 1, offset: .3 },
        { transform: 'scale(1) rotate(0deg)', opacity: 1, offset: .7 },
        { transform: 'scale(1.05)', opacity: 0 },
      ], { duration: 1500, easing: 'ease-out' }).onfinish = () => el.remove();
    }
    clearFx() {
      if (this.fxTimer) { clearInterval(this.fxTimer); this.fxTimer = null; }
      if (this.fx) this.fx.innerHTML = '';
      if (this.dots) this.dots.classList.remove('on');
    }
    startFx(s) {
      this.clearFx();
      if (s === 'sleep') {
        this.particle('Z');
        this.fxTimer = setInterval(() => this.particle('Z'), 1100);
      } else if (s === 'happy') {
        for (let i = 0; i < 4; i++) setTimeout(() => this.particle('✨'), i * 160);
        this.fxTimer = setInterval(() => this.particle('✨'), 1700);
      } else if (s === 'annoyed') {
        this.popFx('💢');
        this.fxTimer = setInterval(() => this.popFx('💢'), 3600);
      } else if (s === 'peek') {
        this.popFx('❗');
      } else if (s === 'listening') {
        this.ring();
        this.fxTimer = setInterval(() => this.ring(), 1300);
      } else if (s === 'working') {
        if (this.dots) this.dots.classList.add('on');
      }
    }

    // --- idle micro-motion ----------------------------------------------
    clearIdle() {
      if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    }
    startIdle() {
      this.clearIdle();
      if (!IDLE_STATES.includes(this.state)) return;
      const tick = () => {
        if (!IDLE_STATES.includes(this.state)) return;
        const moves = [
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-4deg)', offset: .5 }, { transform: 'rotate(0deg)' }],
          [{ transform: 'rotate(0deg)' }, { transform: 'rotate(4deg)', offset: .5 }, { transform: 'rotate(0deg)' }],
          [{ transform: 'scale(1,1)' }, { transform: 'scale(1.04,.93)', offset: .45 }, { transform: 'scale(1,1)' }],
          [{ transform: 'translateY(0)' }, { transform: 'translateY(-7px)', offset: .5 }, { transform: 'translateY(0)' }],
        ];
        try { this.img.animate(moves[Math.floor(Math.random() * moves.length)], { duration: 620, easing: 'ease-in-out' }); } catch {}
        this.idleTimer = setTimeout(tick, 2600 + Math.random() * 3200);
      };
      this.idleTimer = setTimeout(tick, 1800);
    }

    setState(s) {
      if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = null; }
      const changed = s !== this.state;
      this.state = s;
      this.img.className = 'shiba-' + s;
      if (changed) {
        // springy pop-in on every pose change
        try {
          this.img.animate([
            { transform: 'scale(.88) translateY(6px)' },
            { transform: 'scale(1.05) translateY(-3px)', offset: .55 },
            { transform: 'scale(1) translateY(0)' },
          ], { duration: 380, easing: 'cubic-bezier(.34,1.56,.64,1)' });
        } catch {}
        this.startFx(s);
        this.startIdle();
      }
      if (s === 'walk') {
        let flip = false;
        this.show('walk1');
        this.frameTimer = setInterval(() => { flip = !flip; this.show(flip ? 'walk2' : 'walk1'); }, 280);
        return;
      }
      this.show(POSES[s] || 'idle');
    }
  }
  global.SpriteMascot = SpriteMascot;
})(window);
