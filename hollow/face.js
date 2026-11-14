// HOLLOW face: a 1:1 port of the "ASCII Talking Face" design handoff
// ("Talking Face Animation/design_handoff_ascii_talking_face/README.md" and reference/Talking Face.dc.html).
//
// An original, procedurally sculpted head (signed-distance shapes, no image assets) is ray-marched once into a
// luminance grid, then sampled every frame with jaw / lip / brow / eyelid deformations and mapped to ASCII.
// The arithmetic below is copied expression for expression from the reference so that frames are bit-identical:
// renderAt(t) reproduces the 28 golden frames in frames/frames.json exactly (see web-tests/face_golden.mjs).
//
// HOLLOW integration (the only behaviour added on top of the handoff):
//   mode "talking"           the seeded speech timeline plays (jaw, lip shapes, brows, blinks), exactly as in the
//                            reference loop. Speech time only advances while talking, so each answer continues the
//                            timeline where the last one stopped.
//   mode "idle" / "thinking" mouth closed (open = 0, wide = 0, which is the reference's own closed pose); blinks keep
//                            coming from the same blink schedule on the real-time clock; head drift continues.
// Loaded as a classic script (global HollowFace) and also usable from Node via require() for the golden test.
(function (root) {
  "use strict";
  const A = 1.229;                                  // face height / width
  const RAMPS = { ascii: " .,:;$$#%@", dots: " ·.:∙•●" };   // index 0 = darkest; '$' is intentionally doubled
  // Facial landmark constants (normalised u/v of the rendered head; they line up with the SDF sculpt).
  const MX = 0.506, MY = 0.78, MHW = 0.115, CHIN = 0.95;
  const EYES = [[0.32, 0.505], [0.66, 0.505]], ERX = 0.1, ERY = 0.034, BROWY = 0.45;
  const sm = (a, b, x) => { const q = Math.max(0, Math.min(1, (x - a) / (b - a))); return q * q * (3 - 2 * q); };

  // ---- 1. Procedural head -> luminance grid (ww = cols*3, hh = rows*4 samples), ray-marched once per size ----
  function buildGrid(W, H) {
    const ww = W * 3, hh = H * 4, g = new Float32Array(ww * hh);
    const len = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
    const ell = (px, py, pz, cx, cy, cz, rx, ry, rz) => {   // ellipsoid SDF approximation k0*(k0-1)/k1
      const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
      const k0 = len(x, y, z), k1 = len(x / rx, y / ry, z / rz);
      return k0 * (k0 - 1) / (k1 || 1e-6);
    };
    const sph = (px, py, pz, cx, cy, cz, r) => len(px - cx, py - cy, pz - cz) - r;
    const cap = (px, py, pz, ax, ay, az, bx, by, bz, r) => {   // capsule from a to b
      const pax = px - ax, pay = py - ay, paz = pz - az, bax = bx - ax, bay = by - ay, baz = bz - az;
      const h = Math.max(0, Math.min(1, (pax * bax + pay * bay + paz * baz) / (bax * bax + bay * bay + baz * baz)));
      return len(pax - bax * h, pay - bay * h, paz - baz * h) - r;
    };
    // Polynomial smooth union; smax with a negated shape is a smooth subtraction.
    const smin = (a, b, k) => { const h = Math.max(0, Math.min(1, 0.5 + 0.5 * (b - a) / k)); return b * (1 - h) + a * h - k * h * (1 - h); };
    const smax = (a, b, k) => -smin(-a, -b, k);
    // The sculpt, combined in the exact order of the handoff table (ax = |x| mirrors left/right).
    const sdf = (x, y, z) => {
      const ax = Math.abs(x);
      let d = ell(x, y, z, 0, 0.13, -0.02, 0.36, 0.44, 0.41);                    // 1 cranium
      d = smin(d, ell(x, y, z, 0, -0.17, 0.05, 0.29, 0.33, 0.32), 0.08);        // 2 face mass
      d = smin(d, ell(x, y, z, 0, -0.42, 0.13, 0.12, 0.095, 0.15), 0.1);        // 3 chin
      d = smin(d, ell(ax, y, z, 0.15, -0.33, 0.1, 0.12, 0.13, 0.2), 0.08);      // 4 jaw
      d = smin(d, ell(ax, y, z, 0.19, -0.1, 0.2, 0.1, 0.065, 0.12), 0.06);      // 5 cheekbones
      d = smin(d, ell(x, y, z, 0, 0.08, 0.28, 0.28, 0.05, 0.12), 0.05);         // 6 brow ridge
      d = smin(d, ell(ax, y, z, 0.36, -0.02, -0.02, 0.035, 0.095, 0.06), 0.03); // 7 ears
      d = smax(d, -sph(ax, y, z, 0.165, -0.01, 0.37, 0.1), 0.04);               // 8 eye sockets
      d = smin(d, sph(ax, y, z, 0.165, -0.008, 0.235, 0.068), 0.015);           // 9 eyeballs
      d = smin(d, ell(ax, y, z, 0.165, 0.028, 0.27, 0.08, 0.02, 0.05), 0.025);  // 10 upper lids
      d = smin(d, cap(x, y, z, 0, 0.02, 0.37, 0, -0.18, 0.48, 0.032), 0.04);    // 11 nose bridge
      d = smin(d, sph(x, y, z, 0, -0.2, 0.455, 0.05), 0.04);                    // 12 nose tip
      d = smin(d, sph(ax, y, z, 0.05, -0.22, 0.4, 0.038), 0.03);                // 13 nostril wings
      d = smax(d, -sph(ax, y, z, 0.03, -0.25, 0.43, 0.014), 0.01);              // 14 nostrils
      d = smax(d, -cap(x, y, z, 0, -0.23, 0.41, 0, -0.3, 0.41, 0.012), 0.02);   // 15 philtrum
      d = smin(d, ell(x, y, z, 0, -0.318, 0.37, 0.1, 0.026, 0.05), 0.025);      // 16 upper lip
      d = smin(d, ell(x, y, z, 0, -0.37, 0.365, 0.09, 0.03, 0.05), 0.025);      // 17 lower lip
      d = smax(d, -ell(x, y, z, 0, -0.344, 0.41, 0.12, 0.005, 0.06), 0.006);    // 18 mouth line
      d = smax(d, -ell(x, y, z, 0, -0.405, 0.38, 0.06, 0.012, 0.04), 0.02);     // 19 chin crease
      return d;
    };
    const nrm = (x, y, z) => {   // central differences, h = 0.002
      const h = 0.002;
      const nx = sdf(x + h, y, z) - sdf(x - h, y, z), ny = sdf(x, y + h, z) - sdf(x, y - h, z), nz = sdf(x, y, z + h) - sdf(x, y, z - h);
      const l = len(nx, ny, nz) || 1; return [nx / l, ny / l, nz / l];
    };
    const L = [-0.55, 0.42, 0.72], Ll = len(...L); L[0] /= Ll; L[1] /= Ll; L[2] /= Ll;   // key light, upper-left-front
    for (let j = 0; j < hh; j++) {
      const y = (0.5 - (j + 0.5) / hh) * A;
      for (let i = 0; i < ww; i++) {
        const x = (i + 0.5) / ww - 0.5;
        if (x * x / 0.17 + (y - 0.05) * (y - 0.05) / 0.38 > 1) continue;   // outside the head ellipse: speed-up only
        // Orthographic ray down -z from z = 0.7.
        let z = 0.7, hit = false;
        for (let k = 0; k < 60; k++) { const d = sdf(x, y, z); if (d < 0.0015) { hit = true; break; } z -= Math.max(d, 0.002); if (z < -0.6) break; }
        if (!hit || y < -0.53) continue;
        const [nx, ny, nz] = nrm(x, y, z);
        let ao = 0; for (let s = 1; s <= 4; s++) { const h = 0.03 * s; ao += (h - sdf(x + nx * h, y + ny * h, z + nz * h)) / Math.pow(2, s); }
        ao = Math.max(0, Math.min(1, 1 - ao * 6));
        const dif = Math.max(0, nx * L[0] + ny * L[1] + nz * L[2]);
        const rz = 2 * dif * nz - L[2];                         // z of the reflected light vector
        const sp = Math.pow(Math.max(0, rz), 30) * 0.18;        // specular
        const rim = Math.pow(1 - Math.max(0, nz), 3) * 0.12;    // rim light
        const fade = Math.max(0, Math.min(1, (y + 0.53) / 0.04));   // floating head: fade out under the chin, no neck
        const lit = (0.06 + 1.05 * Math.pow(dif, 0.8) + sp + rim) * (0.25 + 0.75 * ao);
        g[j * ww + i] = Math.max(0, Math.min(1, lit * fade));
      }
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
      this.rows = Math.round(this.cols * A * 0.6);   // cols = 90 -> rows = 66
      this.speech = buildSpeech();
      this.grid = null;
      this.mode = 'idle';
      this.energy = 0;
      this.ts = 0;                                   // speech-timeline clock (advances only while talking)
      this.p = { mouthOpen: 0, wide: 0, brow: 0, blink: 0 };   // last frame's expression (read by the tests)
      this._fs = null;
    }
    _grid() { return this.grid || (this.grid = buildGrid(this.cols, this.rows)); }
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
      const fs = Math.max(3, Math.min((innerHeight - this.reserve) / this.rows, innerWidth * 0.92 / (this.cols * 0.6)));
      if (this._fs !== fs) { this.el.style.fontSize = fs + 'px'; this._fs = fs; }
    }
    draw(t, dt) {
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
  if (typeof module !== 'undefined' && module.exports) module.exports = { HollowFace, buildSpeech, viseme };
})(typeof self !== 'undefined' ? self : globalThis);
