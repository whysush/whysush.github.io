// HOLLOW face: a 1:1 port of the "ASCII Talking Face" design handoff, second version
// ("Talking Face Animation(1)/design_handoff_ascii_talking_face/README.md" and reference/Talking Face.dc.html).
//
// A front-on head image (assets/face-ref2.png) is cropped, background-removed and cut at the jaw into a luminance
// grid once; every frame then samples that grid with jaw / lip / brow / eyelid deformations and maps it to ASCII.
// The arithmetic is copied expression for expression from the reference so frames are identical: renderAt(t)
// reproduces the 28 golden frames in frames/frames.json (web-tests/face_golden.mjs runs this in Chromium, because the
// grid comes from a browser canvas).
//
// HOLLOW integration (the only behaviour added on top of the handoff):
//   mode "talking"           the seeded speech timeline plays (jaw, lip shapes, brows, blinks), exactly as in the
//                            reference loop. Speech time only advances while talking, so each answer continues the
//                            timeline where the last one stopped.
//   mode "idle" / "thinking" mouth closed (open = 0, wide = 0, which is the reference's own closed pose); blinks keep
//                            coming from the same blink schedule on the real-time clock; head drift continues.
// Loaded as a classic script (global HollowFace).
(function (root) {
  "use strict";
  const CROP = [112, 4, 166, 204];                  // source rect in assets/face-ref2.png: x, y, w, h (image px)
  const A = CROP[3] / CROP[2];                      // face height / width (204/166)
  const RAMPS = { ascii: " .,:;$$#%@", dots: " ·.:∙•●" };   // index 0 = darkest; '$' is intentionally doubled
  // Facial landmark constants (normalised to the crop).
  const MX = 0.506, MY = 0.78, MHW = 0.115, CHIN = 0.95;
  const EYES = [[0.32, 0.505], [0.66, 0.505]], ERX = 0.1, ERY = 0.034, BROWY = 0.45;
  const sm = (a, b, x) => { const q = Math.max(0, Math.min(1, (x - a) / (b - a))); return q * q * (3 - 2 * q); };

  // ---- 1. Source image -> luminance grid (ww = cols*3, hh = rows*4 px), built once per size in a canvas ----
  // Exactly the reference sample(): draw the crop scaled into the canvas, luminance 0.3R+0.59G+0.11B, flood-fill the
  // white background from every border pixel (4-connected, L >= 0.965) to black, cut the neck along the jawline curve
  // (3 px fade), and stretch contrast with (L - 0.1) / 0.6.
  function buildGrid(img, W, H) {
    const ww = W * 3, hh = H * 4;
    const cv = document.createElement('canvas'); cv.width = ww; cv.height = hh;
    const cx = cv.getContext('2d', { willReadFrequently: true });
    const C = CROP; cx.drawImage(img, C[0], C[1], C[2], C[3], 0, 0, ww, hh);
    const d = cx.getImageData(0, 0, ww, hh).data;
    const n = ww * hh, g = new Float32Array(n);
    for (let i = 0; i < n; i++) g[i] = (d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11) / 255;
    const bg = new Uint8Array(n), st = [];
    for (let x = 0; x < ww; x++) st.push(x, (hh - 1) * ww + x);
    for (let y = 0; y < hh; y++) st.push(y * ww, y * ww + ww - 1);
    while (st.length) {
      const i = st.pop(); if (bg[i] || g[i] < 0.965) continue;
      bg[i] = 1; const x = i % ww, y = (i / ww) | 0;
      if (x > 0) st.push(i - 1); if (x < ww - 1) st.push(i + 1);
      if (y > 0) st.push(i - ww); if (y < hh - 1) st.push(i + ww);
    }
    for (let i = 0; i < n; i++) {
      const ix = C[0] + ((i % ww) + 0.5) / ww * C[2], iy = C[1] + (((i / ww) | 0) + 0.5) / hh * C[3];
      // Cut along the jawline so only the head floats (no neck).
      const jawY = Math.max(146, 191 - 46 * ((ix - 196) / 60) ** 2);
      const m = Math.max(0, Math.min(1, (jawY + 1 - iy) / 3));
      g[i] = bg[i] ? 0 : m * Math.max(0, Math.min(1, (g[i] - 0.1) / 0.6));
    }
    return { g, ww, hh };
  }

  // ---- Speech timeline: Lehmer PRNG, rnd() called in exactly the reference order (frames depend on it) ----
  function buildSpeech() {
    let s = 98765; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    const keys = [], brows = [], blinks = []; let t = 0.6;
    keys.push({ t: 0, o: 0, k: 0 });
    for (let p = 0; p < 14; p++) {                       // 14 phrases
      keys.push({ t, o: 0, k: 0 });
      if (rnd() < 0.6) brows.push(t + 0.05);
      if (rnd() < 0.35) blinks.push(t - 0.15);
      const n = 4 + Math.floor(rnd() * 9);               // syllables in this phrase
      for (let i = 0; i < n; i++) {
        const v = rnd();
        const k = v < 0.25 ? -0.3 : v < 0.55 ? 0.18 : 0;           // oo / ee / ah
        const o = k < 0 ? 0.35 + rnd() * 0.25 : k > 0 ? 0.2 + rnd() * 0.25 : 0.55 + rnd() * 0.45;
        t += 0.09 + rnd() * 0.09; keys.push({ t, o, k });
        const c = rnd();
        if (c < 0.3) { t += 0.07; keys.push({ t, o: 0, k: 0.04 }); }        // m / b / p: lips close
        else if (c < 0.55) { t += 0.06; keys.push({ t, o: 0.12, k: 0.1 }); } // s / t
        if (rnd() < 0.12) brows.push(t);
      }
      t += 0.14; keys.push({ t, o: 0, k: 0 });
      t += 0.35 + rnd() * 0.8;                           // pause between phrases
    }
    for (let b = 1.2; b < t; b += 2.4 + rnd() * 2.8) blinks.push(b);
    keys.push({ t, o: 0, k: 0 });
    return { keys, brows, blinks, dur: t };              // loops forever
  }

  // Viseme at speech time t: cosine easing between the surrounding keys -> { o: open, k: wide, t: looped time }.
  function viseme(sp, t) {
    const { keys, dur } = sp; t %= dur;
    let i = 1; while (i < keys.length - 1 && keys[i].t < t) i++;
    const a = keys[i - 1], b = keys[i];
    const f = Math.max(0, Math.min(1, (t - a.t) / (b.t - a.t || 1)));
    const e = (1 - Math.cos(Math.PI * f)) / 2;
    return { o: a.o + (b.o - a.o) * e, k: a.k + (b.k - a.k) * e, t };
  }
  // Brow raise envelope at looped time lt (max over all entries).
  function browAt(sp, lt) {
    let brow = 0;
    for (const b of sp.brows) { const d = lt - b; if (d > -0.12 && d < 0.9) brow = Math.max(brow, d < 0 ? 1 + d / 0.12 : Math.exp(-d * 3)); }
    return brow;
  }
  // Blink at looped time lt: 70 ms close, 190 ms open (max over all entries).
  function blinkAt(sp, lt) {
    let blink = 0;
    for (const b of sp.blinks) { const d = lt - b; if (d >= 0 && d < 0.26) blink = Math.max(blink, d < 0.07 ? d / 0.07 : 1 - (d - 0.07) / 0.19); }
    return blink;
  }

  // ---- 3. Per-cell sampling: one full frame as text (each row followed by "\n") ----
  // t: real time in seconds (head drift); open/wide/brow/blink: expression; energy: smoothed speech energy.
  function renderFrame(grid, W, H, ramp, t, open, wide, brow, blink, energy) {
    const R = ramp.length - 1;
    const { g, ww, hh } = grid;
    const lum = (u, v) => {   // bilinear sample of the luminance grid; out of bounds = 0
      const x = u * ww - 0.5, y = v * hh - 0.5;
      const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
      const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= ww || yy >= hh) ? 0 : g[yy * ww + xx];
      return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
    };
    // Head motion (real-time t): tiny tilt / nod / sway, livelier while speaking.
    const tilt = 0.012 * Math.sin(t * 0.47) + 0.005 * Math.sin(t * 1.3) * energy;
    const nod = 0.005 * Math.sin(t * 0.8) - 0.004 * brow + 0.004 * energy * Math.sin(t * 2.1);
    const sway = 0.006 * Math.sin(t * 0.37);
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    const jawDrop = 0.042 * open;              // chin travel
    const lipGap = 0.03 * open;                // visible mouth opening at the centre
    const hw = MHW * (1 + wide);               // mouth half-width (ee wider, oo narrower)
    let out = '';
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) {
        // Rigid head motion (inverse transform), rotating about the neck pivot 0.4*A below centre.
        let X = ((c + 0.5) / W - 0.5 - sway), Y = ((r + 0.5) / H - 0.5 - nod) * A;
        const px = X, py = Y - 0.4 * A;
        X = px * ct + py * st; Y = -px * st + py * ct + 0.4 * A;
        let u = X + 0.5, v = Y / A + 0.5;
        const dxm = u - MX, ax = Math.abs(dxm);
        // Lip corners stretch (ee) / pucker (oo) horizontally, strongest at mouth level.
        const mw = Math.exp(-(((v - MY) / 0.06) ** 2)) * Math.exp(-((dxm / 0.2) ** 2));
        u = MX + dxm / (1 + wide * 0.9 * mw);
        const curve = Math.max(0, 1 - (ax / hw) ** 2);   // 1 at the centre, 0 at the corners
        let gap = 0;
        if (v > MY - 0.005) {
          // Jaw: everything below the lips hinges down, most at the centre, fading toward the jaw angle.
          const jw = Math.exp(-((dxm / 0.26) ** 2));
          const lower = jawDrop * jw * sm(MY - 0.01, MY + 0.05, v) + lipGap * Math.sqrt(curve) * (1 - sm(MY + 0.02, MY + 0.08, v));
          gap = lipGap * Math.sqrt(curve);
          if (v < MY + gap && ax < hw) {
            // Inside the mouth: dark, with a band of upper teeth when it is open.
            const depth = (v - MY) / (gap || 1);
            const teeth = sm(0.3, 0.6, open) * sm(0.4, 0.1, depth) * sm(hw * 0.8, hw * 0.5, ax) * 0.7;
            out += ramp[Math.round(teeth * R)]; continue;
          }
          v -= Math.min(lower + jawDrop * jw * sm(MY, CHIN, v) * 0.0, lower);   // (reference form; equals "v -= lower")
        } else if (v > MY - 0.09) {
          // Upper lip and cheeks lift slightly.
          v += 0.006 * open * Math.exp(-((dxm / 0.15) ** 2)) * sm(MY - 0.09, MY, v);
        }
        // Brows and forehead raise.
        if (v < BROWY + 0.04) v += 0.012 * brow * sm(0.15, BROWY, v) * (1 - sm(BROWY, BROWY + 0.04, v)) + 0.004 * brow * (1 - sm(0.15, BROWY, v));
        // 4-sample supersample of the cell.
        const cw = 1 / W, chh = 1 / H;
        let b = (lum(u - cw * 0.25, v - chh * 0.25) + lum(u + cw * 0.25, v - chh * 0.25) + lum(u - cw * 0.25, v + chh * 0.25) + lum(u + cw * 0.25, v + chh * 0.25)) / 4;
        // Eyelids: paint skin taken from just above each eye down over it.
        if (blink > 0) for (const [ex, ey] of EYES) {
          const q = ((u - ex) / ERX) ** 2;
          if (q < 1) {
            const half = ERY * Math.sqrt(1 - q);
            const lid = ey - half + 2 * half * blink;
            const cover = sm(lid + 0.006, lid - 0.006, v) * sm(ey - half - 0.006, ey - half + 0.004, v) * sm(1, 0.6, q);
            if (cover > 0) b = b * (1 - cover) + lum(u, ey - half - 0.018) * 0.85 * cover;
          }
        }
        b = Math.pow(b, 1.15);   // gamma
        out += ramp[Math.round(b * R)];
      }
      out += '\n';
    }
    return out;
  }

  class HollowFace {
    // el: the <pre>. opts: cols (70-160, default 90), fps (default 12), speed (default 1), style ('ascii'|'dots'),
    // reserve: vertical pixels kept free below the face when sizing (handoff value 340).
    constructor(el, opts = {}) {
      this.el = el;
      this.cols = opts.cols ?? 90;
      this.fps = opts.fps ?? 12;
      this.speed = opts.speed ?? 1;
      this.ramp = RAMPS[opts.style ?? 'ascii'];
      this.reserve = opts.reserve ?? 340;
      this.heightFrac = opts.heightFrac ?? null;
      this.widthFrac = opts.widthFrac ?? 0.7;
      this.src = opts.src ?? 'assets/face-ref2.png';
      this.img = null;
      // Resolves once the source image has loaded; nothing is drawn before that (as in the reference).
      this.ready = new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => { this.img = img; this.grid = null; resolve(this); };
        img.onerror = reject;
        img.src = this.src;
      });
      this.rows = Math.round(this.cols * A * 0.6);   // cols = 90 -> rows = 66
      this.speech = buildSpeech();
      this.grid = null;
      this.mode = 'idle';
      this.energy = 0;
      this.ts = 0;                                   // speech-timeline clock (advances only while talking)
      this.p = { mouthOpen: 0, wide: 0, brow: 0, blink: 0 };   // last frame's expression (read by the tests)
      this._fs = null;
    }
    _grid() { return this.grid || (this.grid = buildGrid(this.img, this.cols, this.rows)); }
    // Golden-frame render, exactly as the handoff fixtures were made: full talking loop, speech time = t * speed,
    // energy reset to 0 before the frame.
    renderAt(t) {
      const ts = t * this.speed;
      const vs = viseme(this.speech, ts), lt = vs.t;
      const brow = browAt(this.speech, lt), blink = blinkAt(this.speech, lt);
      const energy = 0 * 0.92 + vs.o * 0.08;
      return renderFrame(this._grid(), this.cols, this.rows, this.ramp, t, vs.o, vs.k, brow, blink, energy);
    }
    setMode(m) { this.mode = m; }
    pushChar() { /* the mouth follows the seeded speech timeline while talking; kept for the app's API */ }
    // Font size from the handoff, written to the DOM only when it changes.
    _size() {
      // heightFrac / widthFrac (HOLLOW): the face takes at most this share of the viewport height / width. Without them
      // the handoff rule applies (innerHeight minus a 340 px reserve, or 92% of the width).
      const fs = this.heightFrac
        ? Math.max(3, Math.min(innerHeight * this.heightFrac / this.rows, innerWidth * this.widthFrac / (this.cols * 0.6)))
        : Math.max(3, Math.min((innerHeight - this.reserve) / this.rows, innerWidth * 0.92 / (this.cols * 0.6)));
      if (this._fs !== fs) { this.el.style.fontSize = fs + 'px'; this._fs = fs; }
    }
    draw(t, dt) {
      if (!this.img) return;
      const sp = this.speech;
      let open = 0, wide = 0, brow = 0, blink;
      if (this.mode === 'talking') {
        this.ts += dt * this.speed;
        const vs = viseme(sp, this.ts), lt = vs.t;
        open = vs.o; wide = vs.k;
        brow = browAt(sp, lt); blink = blinkAt(sp, lt);
      } else {
        blink = blinkAt(sp, t % sp.dur);             // idle: keep blinking on the real-time clock, mouth closed
      }
      this.energy = this.energy * 0.92 + open * 0.08;
      this.p = { mouthOpen: open, wide, brow, blink };
      this._size();
      this.el.textContent = renderFrame(this._grid(), this.cols, this.rows, this.ramp, t, open, wide, brow, blink, this.energy);
    }
    // 12 fps, deliberately choppy: setTimeout, each frame redrawn from scratch.
    start() {
      if (this._iv) return;
      const t0 = performance.now();
      let last = 0;
      const tick = () => {
        const t = (performance.now() - t0) / 1000;
        this.draw(t, Math.min(0.25, t - last)); last = t;
        this._iv = setTimeout(tick, 1000 / this.fps);
      };
      tick();
    }
    stop() { clearTimeout(this._iv); this._iv = null; }
  }

  HollowFace.RAMPS = RAMPS;
  root.HollowFace = HollowFace;
})(typeof self !== 'undefined' ? self : globalThis);
