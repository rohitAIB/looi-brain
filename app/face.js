// face.js — animated eyes for the LOOI brain. Pure canvas, no deps.
// Expressions lerp smoothly toward targets; blink + idle saccades run automatically.
//   const face = new Face(canvas); face.start(); face.setExpression('happy');

const EXPRESSIONS = {
  //           openness  curve   width   lookX lookY  (curve>0 = happy arc, <0 = sad)
  idle:      { openness: 1.0,  curve:  0.0, width: 1.0, lookX: 0, lookY: 0 },
  listening: { openness: 1.25, curve:  0.0, width: 1.05, lookX: 0, lookY: -0.05 },
  thinking:  { openness: 0.85, curve:  0.0, width: 1.0, lookX: 0.35, lookY: -0.4 },
  speaking:  { openness: 1.05, curve:  0.1, width: 1.0, lookX: 0, lookY: 0 },
  happy:     { openness: 0.9,  curve:  1.0, width: 1.1, lookX: 0, lookY: 0 },
  curious:   { openness: 1.2,  curve:  0.0, width: 1.0, lookX: 0.25, lookY: -0.1 },
  sleepy:    { openness: 0.35, curve:  0.0, width: 1.0, lookX: 0, lookY: 0.2 },
};

const lerp = (a, b, t) => a + (b - a) * t;

export class Face {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.cur = { ...EXPRESSIONS.idle };
    this.target = { ...EXPRESSIONS.idle };
    this.name = 'idle';
    this.blink = 1;                 // 1 = open, dips to 0 on blink
    this._nextBlink = 1500;
    this._saccade = { x: 0, y: 0 };
    this._nextSaccade = 2000;
    this._t = 0;
    this._speaking = false;
    this.color = '#3fb950';
  }

  setExpression(name) {
    if (!EXPRESSIONS[name]) return;
    this.name = name;
    this.target = { ...EXPRESSIONS[name] };
    this._speaking = name === 'speaking';
  }

  start() {
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      this.cv.width = this.cv.clientWidth * dpr;
      this.cv.height = this.cv.clientHeight * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize(); window.addEventListener('resize', resize);
    let last = performance.now();
    const loop = (now) => {
      const dt = Math.min(50, now - last); last = now;
      this._update(dt); this._draw();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }
  stop() { if (this._raf) cancelAnimationFrame(this._raf); }

  _update(dt) {
    this._t += dt;
    const k = Math.min(1, dt / 120);                 // expression easing
    for (const key of Object.keys(this.cur)) this.cur[key] = lerp(this.cur[key], this.target[key], k);

    // Blink
    this._nextBlink -= dt;
    if (this._nextBlink <= 0) { this._blinking = 180; this._nextBlink = 1500 + Math.random() * 4000; }
    if (this._blinking > 0) {
      this._blinking -= dt;
      const p = this._blinking / 180;
      this.blink = Math.abs(p - 0.5) * 2;            // 1→0→1
    } else this.blink = lerp(this.blink, 1, 0.4);

    // Idle saccade (skip when actively engaged)
    this._nextSaccade -= dt;
    if (this._nextSaccade <= 0 && (this.name === 'idle' || this.name === 'happy')) {
      this._saccade = { x: (Math.random() - 0.5) * 0.5, y: (Math.random() - 0.5) * 0.3 };
      this._nextSaccade = 900 + Math.random() * 2500;
    }
    this._saccade.x = lerp(this._saccade.x, this.name === 'idle' ? this._saccade.x : 0, 0.05);
  }

  _draw() {
    const ctx = this.ctx, W = this.cv.clientWidth, H = this.cv.clientHeight;
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2, cy = H / 2;
    const gap = Math.min(W, H) * 0.26;
    const baseW = Math.min(W, H) * 0.15 * this.cur.width;
    const baseH = Math.min(W, H) * 0.22;
    const talk = this._speaking ? (Math.sin(this._t / 90) * 0.12 + 0.05) : 0;
    const open = Math.max(0.05, (this.cur.openness + talk)) * this.blink;
    const lx = (this.cur.lookX + this._saccade.x) * gap * 0.5;
    const ly = (this.cur.lookY + this._saccade.y) * baseH * 0.5;

    for (const side of [-1, 1]) {
      const ex = cx + side * gap + lx;
      const ey = cy + ly;
      ctx.fillStyle = this.color;
      ctx.strokeStyle = this.color;
      ctx.lineWidth = baseW;
      ctx.lineCap = 'round';

      if (this.cur.curve > 0.5) {                    // happy: upward arc ( ^ )
        ctx.beginPath();
        ctx.arc(ex, ey + baseH * 0.15, baseW, Math.PI * 1.15, Math.PI * 1.85);
        ctx.stroke();
      } else {                                       // rounded-rect eye
        const w = baseW, h = baseH * open;
        this._roundRect(ex - w / 2, ey - h / 2, w, h, Math.min(w, h) / 2);
        ctx.fill();
      }
    }
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}
