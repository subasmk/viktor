// SpriteMascot - the Shiba mascot. Same setState() interface as the pixel
// Mascot (mascot.js), but each state shows a hand-drawn pose from
// assets/shiba/. State -> pose:
//   idle/smug -> idle (sitting, shades, smug)   listening -> paw at ear
//   working   -> think (paw on chin)            speaking  -> mid-speech
//   happy     -> excited (jump + sparkles)      sit       -> chill (reclined)
//   sleep     -> sleep (curled up, Zzz)         sleepy/error -> defeated
//   annoyed   -> glare, arms crossed            walk      -> walk1/walk2 frames
//   peek      -> peeking over the edge          wave      -> greeting paw
(function (global) {
  const POSES = {
    idle: 'idle', smug: 'idle', listening: 'listening', working: 'think',
    speaking: 'speaking', happy: 'excited', sit: 'chill', sleep: 'sleep',
    sleepy: 'defeated', error: 'defeated', annoyed: 'annoyed',
    peek: 'peek', wave: 'wave',
  };
  const FILES = ['idle', 'listening', 'speaking', 'think', 'excited', 'chill',
    'sleep', 'defeated', 'annoyed', 'peek', 'wave', 'walk1', 'walk2'];

  class SpriteMascot {
    constructor(img) {
      this.img = img;
      this.state = '';
      this.frameTimer = null;
      this.cache = {};
      for (const f of FILES) { const i = new Image(); i.src = 'assets/shiba/' + f + '.png'; this.cache[f] = i; }
      this.setState('idle');
    }
    show(file) { if (this.cache[file]) this.img.src = this.cache[file].src; }
    setState(s) {
      if (this.frameTimer) { clearInterval(this.frameTimer); this.frameTimer = null; }
      this.state = s;
      this.img.className = 'shiba-' + s;
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
