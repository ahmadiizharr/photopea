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
  fn(img.data);
  ctx.putImageData(img, 0, 0);
}
