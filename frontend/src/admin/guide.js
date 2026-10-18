import { formats } from '../lib/catalog.js';
import { esc } from './ui.js';

const COLORS = ['#ff7eb3', '#3aa0ff', '#22c07a', '#8a5cff', '#ffb020', '#ff6a3d', '#14b8c4', '#c45cff'];
const RECOMMENDED = '4r-strip/4-kembar';
const SAFE = 36;
const cm = (inch) => (inch * 2.54).toFixed(1).replace('.', ',');

function diagram(f, p) {
  const label = Math.round(Math.min(f.w, f.h) / 14);
  const slots = p.slots.map((s) => `
    <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${COLORS[(s.photo - 1) % COLORS.length]}"/>
    <text x="${s.x + s.w / 2}" y="${s.y + s.h / 2}" font-size="${label}" font-family="DM Mono, monospace" font-weight="500" fill="#fff" text-anchor="middle" dominant-baseline="middle">${s.photo}</text>`).join('');
  const cut = f.cut_x ? `<line x1="${f.cut_x}" y1="0" x2="${f.cut_x}" y2="${f.h}" stroke="#1d4fd8" stroke-width="8" stroke-dasharray="30 20"/>` : '';
  return `
    <svg viewBox="0 0 ${f.w} ${f.h}" role="img" aria-label="${esc(p.name)}">
      <rect width="${f.w}" height="${f.h}" fill="#fbf7ef"/>
      <rect x="${SAFE}" y="${SAFE}" width="${f.w - 2 * SAFE}" height="${f.h - 2 * SAFE}" fill="none" stroke="#ff3d8b" stroke-width="6" stroke-dasharray="24 16"/>
      ${slots}${cut}
    </svg>`;
}

function printLine(f) {
  const [pw, ph] = f.print.page;
  if (f.print.per_page > 1) return `Dicetak ${f.print.per_page} per lembar ${pw}×${ph} in lalu dipotong`;
  return `Dicetak 1 per lembar ${pw}×${ph} in`;
}

export function renderGuide(view) {
  view.innerHTML = `
    <div class="head">
      <div class="head-title">
        <span class="head-icon" aria-hidden="true" style="background:var(--blue-soft)"><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><rect x="3" y="7" width="18" height="10" rx="1.5"/><path d="M7 7v4M11 7v3M15 7v4M19 7v3"/></svg></span>
        <div><p class="mono">Untuk desainer</p><h1>Panduan ukuran &amp; template</h1>
        <p class="sub">Buat frame di Canva/Photoshop/Figma dari template di bawah, lalu upload PNG-nya di pack.</p></div>
      </div>
    </div>
    <ul class="rules">
      <li><b>PNG transparan</b>Simpan sebagai PNG dengan latar transparan. Bagian tempat foto harus benar-benar bolong (alpha 0).</li>
      <li><b>Ukuran persis</b>Pakai ukuran piksel di tiap format (300 dpi). File 2× lebih besar boleh; diperkecil otomatis.</li>
      <li><b>Batas aman 3 mm</b>Jaga teks, logo, dan lubang foto minimal 36 px dari tepi. Printer sering memotong pinggir.</li>
      <li><b>Lubang foto ≥ 300 px</b>Rasio 4:3 (melebar) paling pas untuk kamera/webcam. Lubang bentuk bebas (bulat, awan) boleh; foto diisi ke kotak luarnya.</li>
      <li><b>Strip 4R: jangan lewati garis tengah</b>4R · 2 strip dipotong di x = 600 px. Lubang yang melintasi garis itu ditolak.</li>
      <li><b>Maks 8 foto per sesi</b>Lubang dengan nomor sama memakai foto yang sama, misalnya strip kiri dan kanan kembar.</li>
    </ul>
    ${formats.map((f) => `
      <section class="card fmt" id="fmt-${f.id}">
        <div class="fmt-head">
          <h2>${esc(f.name)}</h2>
          <ul class="fmt-specs">
            <li>${f.w} × ${f.h} px</li>
            <li>${f.inch[0]} × ${f.inch[1]} in · ${cm(f.inch[0])} × ${cm(f.inch[1])} cm</li>
            <li>kertas ${esc(f.paper)}</li>
          </ul>
        </div>
        <p>${esc(f.note)} ${printLine(f)}.</p>
        <div class="presets">
          ${f.presets.map((p) => `
            <figure class="preset" style="margin:0">
              ${diagram(f, p)}
              ${`${f.id}/${p.id}` === RECOMMENDED ? '<span class="badge-rec">Rekomendasi</span>' : ''}
              <b>${esc(p.name)}</b>
              <a class="btn btn-ghost btn-sm" href="/api/admin/guides/${f.id}/${p.id}.png" download>Unduh template PNG</a>
            </figure>`).join('')}
        </div>
      </section>`).join('')}`;
}
