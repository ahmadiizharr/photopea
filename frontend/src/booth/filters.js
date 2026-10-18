// Pixel filters. Done by hand (not ctx.filter) so Safari renders the same thing
// as Chrome, and the preview matches the saved photo exactly.

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const curve = (fn) => Uint8ClampedArray.from({ length: 256 }, (_, i) => clamp(Math.round(fn(i))));
const contrast = (k, mid = 128) => (v) => (v - mid) * k + mid;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function gradient(stops) {
  // stops: [[t, '#rrggbb'], ...] sorted by t
  const out = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)];
  const cols = stops.map(([t, c]) => [t, hex(c)]);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let j = 0;
    while (j < cols.length - 2 && t > cols[j + 1][0]) j++;
    const [t0, c0] = cols[j];
    const [t1, c1] = cols[j + 1];
    const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
    for (let k = 0; k < 3; k++) out[k][i] = c0[k] + (c1[k] - c0[k]) * f;
  }
  return out;
}

const BW = curve(contrast(1.18));
const WARM = [curve((v) => contrast(1.06)(v) * 1.06 + 8), curve((v) => contrast(1.06)(v) * 1.01 + 3), curve((v) => contrast(1.06)(v) * 0.88)];
const FADE = [curve((v) => v * 0.8 + 38), curve((v) => v * 0.78 + 34), curve((v) => v * 0.72 + 40)];
const RISO_IN = curve(contrast(1.25));
const RISO = gradient([[0, '#1a2470'], [0.5, '#ff3d8b'], [1, '#fbf4e6']]);

const lum = (d, i) => (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;
const byte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

/** Darkening toward the corners, as a per-pixel factor ×256. Cached: the preview keeps one size. */
const masks = new Map();
function vignette(w, h, strength) {
  const key = `${w}x${h}x${strength}`;
  let m = masks.get(key);
  if (m) return m;
  m = new Uint16Array(w * h);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(cx, cy);
  for (let y = 0, p = 0; y < h; y++) {
    for (let x = 0; x < w; x++, p++) {
      const t = Math.min(1, Math.max(0, (Math.hypot(x - cx, y - cy) / r - 0.4) / 0.6));
      m[p] = Math.round(256 * (1 - strength * t * t * (3 - 2 * t)));
    }
  }
  if (masks.size > 8) masks.clear();
  masks.set(key, m);
  return m;
}

/**
 * A colour grade: saturation, then per-channel curves (or a tone map from luminance for the
 * monochrome looks), then an optional vignette.
 */
function grade({ sat = 1, r = (v) => v, g = r, b = r, mono = null, vig = 0 }) {
  const R = curve(r);
  const G = curve(g);
  const B = curve(b);
  const S = Math.round(sat * 256);
  return (d, w, h) => {
    const m = vig ? vignette(w, h, vig) : null;
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      let rr = d[i];
      let gg = d[i + 1];
      let bb = d[i + 2];
      if (mono) {
        const y = lum(d, i);
        rr = mono[0][y];
        gg = mono[1][y];
        bb = mono[2][y];
      } else if (S !== 256) {
        const y = lum(d, i);
        rr = byte(y + (((rr - y) * S) >> 8));
        gg = byte(y + (((gg - y) * S) >> 8));
        bb = byte(y + (((bb - y) * S) >> 8));
      }
      rr = R[rr];
      gg = G[gg];
      bb = B[bb];
      if (m) {
        const k = m[p];
        rr = (rr * k) >> 8;
        gg = (gg * k) >> 8;
        bb = (bb * k) >> 8;
      }
      d[i] = rr;
      d[i + 1] = gg;
      d[i + 2] = bb;
    }
  };
}

const grey = (fn) => { const c = curve(fn); return [c, c, c]; };

const impl = {
  normal: null,
  bw(d) {
    for (let i = 0; i < d.length; i += 4) {
      const y = BW[lum(d, i)];
      d[i] = d[i + 1] = d[i + 2] = y;
    }
  },
  hangat(d) {
    const [r, g, b] = WARM;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = r[d[i]];
      d[i + 1] = g[d[i + 1]];
      d[i + 2] = b[d[i + 2]];
    }
  },
  pudar(d) {
    const [r, g, b] = FADE;
    for (let i = 0; i < d.length; i += 4) {
      // 30% desaturate, then lift blacks and cool the shadows a little
      const y = lum(d, i);
      d[i] = r[(d[i] * 7 + y * 3) / 10 | 0];
      d[i + 1] = g[(d[i + 1] * 7 + y * 3) / 10 | 0];
      d[i + 2] = b[(d[i + 2] * 7 + y * 3) / 10 | 0];
    }
  },
  cerah: grade({ sat: 1.35, r: (v) => contrast(1.08)(v) + 6 }),
  dingin: grade({ sat: 0.95, r: (v) => contrast(1.04)(v) * 0.92, g: (v) => contrast(1.04)(v) * 0.98 + 2, b: (v) => contrast(1.04)(v) * 1.05 + 14 }),
  emas: grade({ sat: 1.1, r: (v) => v * 1.06 + 16, g: (v) => v * 0.98 + 8, b: (v) => v * 0.8, vig: 0.25 }),
  pastel: grade({ sat: 0.7, r: (v) => v * 0.8 + 52, g: (v) => v * 0.78 + 44, b: (v) => v * 0.78 + 54 }),
  vintage: grade({ sat: 0.75, r: (v) => v * 0.86 + 34, g: (v) => v * 0.82 + 28, b: (v) => v * 0.68 + 30, vig: 0.35 }),
  matte: grade({ sat: 0.85, r: (v) => contrast(1.05)(v) * 0.8 + 30 }),
  // teal shadows, orange highlights: red gets an S-curve, blue the opposite
  sinema: grade({ sat: 1.1, r: contrast(1.2), g: (v) => contrast(1.04)(v) + 2, b: (v) => contrast(0.82)(v) + 4 }),
  lomo: grade({ sat: 1.4, r: (v) => contrast(1.25)(v) + 6, g: contrast(1.25), b: (v) => contrast(1.25)(v) - 8, vig: 0.6 }),
  sepia: grade({ mono: gradient([[0, '#24170d'], [0.5, '#9a6a40'], [1, '#f7e8ca']]) }),
  noir: grade({ mono: grey(contrast(1.6)), vig: 0.45 }),
  riso(d) {
    const [r, g, b] = RISO;
    for (let i = 0; i < d.length; i += 4) {
      const y = RISO_IN[lum(d, i)];
      d[i] = r[y];
      d[i + 1] = g[y];
      d[i + 2] = b[y];
    }
  },
};

/** Apply filter `id` to the whole canvas in place. */
export function applyFilter(ctx, id) {
  const fn = impl[id];
  if (!fn) return;
  const { width, height } = ctx.canvas;
  const img = ctx.getImageData(0, 0, width, height);
  fn(img.data, width, height);
  ctx.putImageData(img, 0, 0);
}
