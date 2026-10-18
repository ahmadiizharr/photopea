// Draws the printed strip. Geometry comes from shared/layouts.json (print pixels, 300 dpi).

const INK = '#16110e';

/** Riso-style halftone: dot radius grows toward (cx, cy). */
function halftone(ctx, x, y, w, h, cx, cy, reach, step, maxR, color) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = color;
  for (let py = y + step / 2; py < y + h; py += step) {
    for (let px = x + step / 2; px < x + w; px += step) {
      const t = 1 - Math.hypot(px - cx, py - cy) / reach;
      if (t <= 0) continue;
      ctx.beginPath();
      ctx.arc(px, py, maxR * Math.min(1, t * 1.15), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

function placeholder(ctx, s, i, k) {
  ctx.save();
  ctx.fillStyle = 'rgba(22,17,14,.08)';
  ctx.fillRect(s.x, s.y, s.w, s.h);
  ctx.save();
  ctx.setLineDash([14 * k, 10 * k]);
  ctx.strokeStyle = 'rgba(22,17,14,.45)';
  ctx.lineWidth = 3 * k;
  ctx.strokeRect(s.x + 10 * k, s.y + 10 * k, s.w - 20 * k, s.h - 20 * k);
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(22,17,14,.55)';
  ctx.font = `500 ${22 * k}px "DM Mono", monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`FOTO ${i + 1}`, s.x + s.w / 2, s.y + s.h / 2);
  ctx.restore();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {object} layout  entry from layouts.json
 * @param {object} frame   entry from layouts.json frames
 * @param {(HTMLCanvasElement|null)[]} shots  already cropped to the slot aspect + filtered
 * @param {{caption?: string, date: string, scale?: number}} opts
 */
export function compose(canvas, layout, frame, shots, { caption, date, scale = 1 }) {
  const k = scale;
  const W = Math.round(layout.w * k);
  const H = Math.round(layout.h * k);
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // paper
  ctx.fillStyle = frame.bg;
  ctx.fillRect(0, 0, layout.w, layout.h);

  // halftone corners: one behind the photos (shows in the margins), one behind the caption
  const dot = frame.id === 'kertas' ? 'rgba(255,61,139,.55)' : frame.accent;
  halftone(ctx, 0, 0, layout.w, layout.h, 0, 0, Math.min(layout.w, layout.h) * 0.55, 13, 4.6, dot);
  const cap = layout.caption;
  halftone(ctx, cap.x, cap.y, cap.w + (layout.w - cap.x - cap.w), layout.h - cap.y, layout.w, layout.h, Math.max(cap.h * 1.6, cap.w * 0.55), 13, 4.6, dot);

  // photos
  layout.slots.forEach((s, i) => {
    const shot = shots[i];
    if (shot) ctx.drawImage(shot, s.x, s.y, s.w, s.h);
    else placeholder(ctx, s, i, 1);
    ctx.lineWidth = 4;
    ctx.strokeStyle = INK;
    ctx.strokeRect(s.x + 2, s.y + 2, s.w - 4, s.h - 4);
  });

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // caption: big title with a misregistered accent shadow, date in mono underneath
  const title = (caption || 'jepret').trim() || 'jepret';
  let size = Math.min(cap.h * 0.46, cap.w * 0.24);
  const font = (px) => `800 ${px}px "Bricolage Grotesque", system-ui, sans-serif`;
  ctx.font = font(size);
  while (ctx.measureText(title).width > cap.w * 0.8 && size > 14) {
    size *= 0.92;
    ctx.font = font(size);
  }
  const small = Math.max(13, Math.min(size * 0.3, 26));
  const block = size * 0.78 + small * 1.5;
  const base = cap.y + (cap.h - block) / 2 + size * 0.78;

  ctx.fillStyle = frame.accent === frame.bg ? INK : frame.accent;
  ctx.fillText(title, cap.x + size * 0.05, base + size * 0.04);
  ctx.fillStyle = frame.text;
  ctx.fillText(title, cap.x, base);

  ctx.font = `500 ${small}px "DM Mono", monospace`;
  const meta = title.toLowerCase() === 'jepret' ? date : `${date}  ·  jepret`;
  ctx.fillText(meta.toUpperCase(), cap.x + 2, base + small * 1.6);

  // little sticker dot, top-right of the caption
  const r = Math.min(cap.h * 0.13, 30);
  ctx.beginPath();
  ctx.arc(cap.x + cap.w - r - 4, cap.y + cap.h / 2, r, 0, Math.PI * 2);
  ctx.fillStyle = frame.id === 'pink' ? '#fff' : frame.accent;
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = INK;
  ctx.stroke();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

export const toBlob = (canvas, quality = 0.92) =>
  new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode gagal'))), 'image/jpeg', quality));
