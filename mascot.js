// Shared pixel-mascot renderer with per-state emotion animations:
// idle (blink + ear twitch), listening (sound arcs), working (looking around +
// thought dots), speaking (mouth + bounce), happy (sparkles + jump via CSS),
// sleepy (dim + floating Z).
(function (global) {
  const COL = { O: '#241239', X: '#efe7ff', K: '#241239', G: '#b05cff' };
  const BODY = [
    "....OO....OO....",
    "...OXXO..OXXO...",
    "...OXXXOOXXXO...",
    "..OXXXXXXXXXXO..",
    "..OXXXXXXXXXXO..",
    "..OXXXXXXXXXXO..",
    "EYEROW6XXXXXXXXX",
    "EYEROW7XXXXXXXXX",
    "..OXXXXXXXXXXO..",
    "MOUTHROW9XXXXXXX",
    "..OXXXXXXXXXXO..",
    "...OXXXXXXXXO...",
    "....OXXXXXXO....",
    "....OOO..OOO....",
    "...OXXO..OXXO...",
  ];
  // Left ear flopped down (idle twitch frame).
  const BODY_TWITCH = BODY.slice();
  BODY_TWITCH[0] = "..........OO....";
  BODY_TWITCH[1] = ".........OXXO...";

  // Sitting: same cat, folded into a seat with feet out front.
  const BODY_SIT = BODY.slice();
  BODY_SIT[11] = "..OXXXXXXXXXXO..";
  BODY_SIT[12] = ".OXXXXXXXXXXXXO.";
  BODY_SIT[13] = ".OXXXXXXXXXXXXO.";
  BODY_SIT[14] = "..OO........OO..";

  // Walking: legs mid-stride (A) and passing (B); the window itself moves.
  const BODY_WALK_A = BODY.slice();
  BODY_WALK_A[14] = "..OXXO....OXXO..";
  const BODY_WALK_B = BODY.slice();
  BODY_WALK_B[14] = ".....OXXOXXO....";

  const EYES = {
    open:      ["..OXGKXXXXKGXO..", "..OXKKXXXXKKXO.."],
    blink:     ["..OXXXXXXXXXXO..", "..OXKKXXXXKKXO.."],
    listening: ["..OXGGXXXXGGXO..", "..OXKKXXXXKKXO.."],
    happy:     ["..OXKXXXXXXKXO..", "..OXKXKXXKXKXO.."],
    lookL:     ["..OGKXXXXKGXXO..", "..OKKXXXXKKXXO.."],
    lookR:     ["..OXXGKXXXXKGO..", "..OXXKKXXXXKKO.."],
    sleepy:    ["..OXXXXXXXXXXO..", "..OXKKXXXXKKXO.."],
    smug:      ["..OXXXXXXXKGXO..", "..OXXXXXXXKKXO.."],
    annoyed:   ["..OXXXXXXXXXXO..", "..OXKKXXXXKKXO.."],
  };
  const MOUTH = {
    closed: "..OXXXXKKXXXXO..",
    open:   "..OXXXKKKKXXXO..",
    flat:   "..OXKKKKKKKKXO..",
  };
  // Anger vein (annoyed), pulsing two frames.
  const VEIN_A = [[13, 0], [14, 1], [12, 1], [13, 2]];
  const VEIN_B = [[13, 0], [14, 0], [13, 1], [12, 1], [14, 2], [13, 2]];

  // Accent pixels (grid cells) drawn over/around the body per animation frame.
  const ARCS_A = [[0, 6], [15, 6]];
  const ARCS_B = [[0, 5], [1, 7], [15, 5], [14, 7]];
  const DOTS = [[], [[7, 0]], [[6, 0], [8, 0]], [[6, 0], [7, 0], [8, 0], [9, 0]]];
  const SPARK_A = [[1, 1], [14, 2]];
  const SPARK_B = [[2, 2], [14, 1]];
  const SPARK_C = [[1, 1], [14, 1]];
  const Z_A = [[12, 0], [13, 0], [14, 0], [13, 1], [12, 2], [13, 2], [14, 2]];
  const Z_B = [[13, 1], [14, 1], [15, 1], [14, 2], [13, 3], [14, 3], [15, 3]];

  const ANIM_MS = { listening: 450, working: 520, speaking: 180, happy: 300, sleepy: 900, walk: 170, sleep: 1100, smug: 700, annoyed: 450 };

  function drawFrame(canvas, opts) {
    const { eyes, mouth, dim, dy, extras, body } = opts;
    const ctx = canvas.getContext('2d');
    const P = canvas.width / 16;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (dim) ctx.globalAlpha = 0.55;
    if (dy) ctx.translate(0, dy);
    ctx.shadowColor = 'rgba(176,92,255,.8)';
    ctx.shadowBlur = Math.max(4, P * 1.2);
    (body || BODY).forEach((row, y) => {
      let r = row;
      if (row.startsWith('EYEROW6')) r = eyes[0];
      if (row.startsWith('EYEROW7')) r = eyes[1];
      if (row.startsWith('MOUTHROW9')) r = mouth;
      [...r].forEach((ch, x) => {
        const c = COL[ch];
        if (!c) return;
        ctx.fillStyle = c;
        ctx.fillRect(x * P, y * P, Math.ceil(P), Math.ceil(P));
      });
    });
    // blush
    ctx.fillStyle = 'rgba(176,92,255,.5)';
    ctx.fillRect(3 * P, 9 * P, P, P);
    ctx.fillRect(12 * P, 9 * P, P, P);
    (extras || []).forEach(([x, y, light]) => {
      ctx.fillStyle = light ? '#efe7ff' : '#b05cff';
      ctx.fillRect(x * P, y * P, Math.ceil(P), Math.ceil(P));
    });
    ctx.restore();
  }

  class Mascot {
    constructor(canvas) {
      this.canvas = canvas;
      this.state = 'idle';
      this.frame = 0;
      this._timer = null;
      this._eyeOverride = null;
      this._twitching = false;
      this.render();
      this._scheduleBlink();
      this._scheduleTwitch();
    }
    _scheduleBlink() {
      clearTimeout(this._blinkTimer);
      this._blinkTimer = setTimeout(() => {
        if ((this.state === 'idle' || this.state === 'sit') && !this._twitching) {
          this._eyeOverride = EYES.blink; this.render();
          setTimeout(() => { this._eyeOverride = null; this.render(); }, 160);
        }
        this._scheduleBlink();
      }, 2500 + Math.random() * 3500);
    }
    _scheduleTwitch() {
      clearTimeout(this._twitchTimer);
      this._twitchTimer = setTimeout(() => {
        if (this.state === 'idle' && !this._eyeOverride) {
          this._twitching = true; this.render();
          setTimeout(() => { this._twitching = false; this.render(); }, 240);
        }
        this._scheduleTwitch();
      }, 6000 + Math.random() * 6000);
    }
    setState(s) {
      this.state = s;
      this.frame = 0;
      clearInterval(this._timer); this._timer = null;
      if (ANIM_MS[s]) this._timer = setInterval(() => { this.frame++; this.render(); }, ANIM_MS[s]);
      this.render();
    }
    render() {
      const f = this.frame;
      let eyes = EYES[this.state] || EYES.open;
      let mouth = MOUTH.closed;
      let dim = false, dy = 0, extras = [], body = BODY;
      switch (this.state) {
        case 'idle':
          if (this._eyeOverride) eyes = this._eyeOverride;
          if (this._twitching) body = BODY_TWITCH;
          break;
        case 'sit':
          if (this._eyeOverride) eyes = this._eyeOverride;
          body = BODY_SIT;
          break;
        case 'walk':
          eyes = EYES.lookR;
          body = f % 2 ? BODY_WALK_A : BODY_WALK_B;
          dy = f % 2 ? 0 : 1;
          break;
        case 'sleep':
          eyes = EYES.sleepy;
          dim = true; dy = 3;
          extras = (f % 2 ? Z_B : Z_A).map(([x, y]) => [x, y, false]);
          break;
        case 'smug':
          eyes = EYES.smug;
          mouth = f % 2 ? MOUTH.open : MOUTH.closed;
          break;
        case 'annoyed':
          eyes = EYES.annoyed;
          mouth = MOUTH.flat;
          extras = (f % 2 ? VEIN_B : VEIN_A).map(([x, y]) => [x, y, true]);
          break;
        case 'listening':
          extras = (f % 2 ? ARCS_B : ARCS_A).map(([x, y]) => [x, y, false]);
          break;
        case 'working':
          eyes = f % 2 ? EYES.lookR : EYES.lookL;
          extras = DOTS[f % 4].map(([x, y]) => [x, y, false]);
          break;
        case 'speaking':
          eyes = EYES.open;
          mouth = f % 2 ? MOUTH.open : MOUTH.closed;
          dy = f % 2 ? 3 : 0;
          break;
        case 'happy':
          mouth = MOUTH.open;
          extras = [SPARK_A, SPARK_B, SPARK_C][f % 3].map(([x, y]) => [x, y, true]);
          break;
        case 'sleepy':
          dim = true;
          extras = (f % 2 ? Z_B : Z_A).map(([x, y]) => [x, y, false]);
          break;
      }
      drawFrame(this.canvas, { eyes, mouth, dim, dy, extras, body });
    }
  }

  global.CompanionMascot = { Mascot };
})(window);
