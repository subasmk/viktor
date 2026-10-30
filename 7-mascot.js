// Shared pixel-mascot renderer: states idle/blink/listening/speaking/working/happy/sleepy.
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
  const EYES = {
    open:      ["..OXGKXXXXKGXO..", "..OXKKXXXXKKXO.."],
    blink:     ["..OXXXXXXXXXXO..", "..OXKKXXXXKKXO.."],
    listening: ["..OXGGXXXXGGXO..", "..OXKKXXXXKKXO.."],
    happy:     ["..OXKXXXXXXKXO..", "..OXKXKXXKXKXO.."],
    working:   ["..OXXXXXXXXXXO..", "..OXKKXXXXKKXO.."],
    sleepy:    ["..OXXXXXXXXXXO..", "..OXKKXXXXKKXO.."],
  };
  const MOUTH = {
    closed: "..OXXXXKKXXXXO..",
    open:   "..OXXXKKKKXXXO..",
  };

  function drawFrame(canvas, eyeRows, mouthRow, dim) {
    const ctx = canvas.getContext('2d');
    const P = canvas.width / 16;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (dim) ctx.globalAlpha = 0.55;
    ctx.shadowColor = 'rgba(176,92,255,.8)';
    ctx.shadowBlur = Math.max(4, P * 1.2);
    BODY.forEach((row, y) => {
      let r = row;
      if (row.startsWith('EYEROW6')) r = eyeRows[0];
      if (row.startsWith('EYEROW7')) r = eyeRows[1];
      if (row.startsWith('MOUTHROW9')) r = mouthRow;
      [...r].forEach((ch, x) => {
        const c = COL[ch];
        if (!c) return;
        ctx.fillStyle = c;
        ctx.fillRect(x * P, y * P, Math.ceil(P), Math.ceil(P));
      });
    });
    ctx.restore();
    // blush
    ctx.fillStyle = 'rgba(176,92,255,.5)';
    ctx.fillRect(3 * P, 9 * P, P, P);
    ctx.fillRect(12 * P, 9 * P, P, P);
  }

  class Mascot {
    constructor(canvas) {
      this.canvas = canvas;
      this.state = 'idle';
      this.speakingFrame = false;
      this._blinkTimer = null;
      this._speakTimer = null;
      this.render();
      this._scheduleBlink();
    }
    _scheduleBlink() {
      clearTimeout(this._blinkTimer);
      this._blinkTimer = setTimeout(() => {
        if (this.state === 'idle') { this._draw('blink'); setTimeout(() => this.render(), 160); }
        this._scheduleBlink();
      }, 2500 + Math.random() * 3500);
    }
    setState(s) {
      this.state = s;
      clearInterval(this._speakTimer); this._speakTimer = null;
      if (s === 'speaking') {
        this._speakTimer = setInterval(() => { this.speakingFrame = !this.speakingFrame; this.render(); }, 180);
      }
      this.render();
    }
    _draw(eyeOverride) {
      const eyes = EYES[eyeOverride || this.state] || EYES.open;
      const mouth = (this.state === 'speaking' && this.speakingFrame) ? MOUTH.open : MOUTH.closed;
      drawFrame(this.canvas, eyes, mouth, this.state === 'sleepy');
    }
    render() { this._draw(); }
  }

  global.CompanionMascot = { Mascot };
})(window);
