import { layouts, frames, stamp, CODE_RE } from './lib/catalog.js';

const $ = (s, el = document) => el.querySelector(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- nav ----------
const nav = $('#nav');
const onScroll = () => nav.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

$('#year').textContent = new Date().getFullYear();
$('#demo-date').textContent = stamp();

// ---------- hero demo booth ----------
const screen = $('#demo-screen');
const go = $('#demo-go');
const count = $('#demo-count');
const tag = $('#demo-tag');
const face = $('.scr-face use');
const live = $('.scr-live');
const flash = $('.scr-flash');
const tray = $('.tray');
const strip = $('#demo-strip');
const after = $('#after-demo');
const tints = ['var(--pink-soft)', 'var(--yellow-soft)', 'var(--blue-soft)', 'var(--pink-soft)'];
let running = false;

go.addEventListener('click', async () => {
  if (running) return;
  running = true;
  tray.classList.remove('out');
  after.hidden = true;
  screen.dataset.state = 'live';

  for (let i = 0; i < 4; i++) {
    face.setAttribute('href', `#face-${i + 1}`);
    live.style.background = tints[i];
    tag.textContent = `FOTO ${i + 1}/4`;
    for (const n of ['3', '2', '1']) {
      count.textContent = n;
      count.classList.remove('pop');
      void count.offsetWidth;
      count.classList.add('pop');
      await sleep(reduced ? 150 : 520);
    }
    count.textContent = '';
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    await sleep(reduced ? 150 : 650);
  }

  count.textContent = '';
  tag.textContent = 'MENCETAK…';
  tray.style.setProperty('--strip-h', `${strip.offsetHeight + 14}px`);
  tray.classList.add('out');
  await sleep(reduced ? 100 : 2300);

  screen.dataset.state = 'idle';
  go.textContent = 'LAGI';
  $('.scr-idle .mono').textContent = 'Strip sudah jadi ↓';
  $('.scr-hint').textContent = 'mau ulang? tekan lagi';
  after.hidden = false;
  running = false;
});

// ---------- layout previews (drawn from the real layout geometry) ----------
const FACE_TINTS = ['#ffd5e6', '#fff1c2', '#dde6ff', '#f4ecdd'];
const DOTS = ['dots-pink', 'dots-ink', 'dots-blue', 'dots-pink'];

function layoutSvg(l, frame) {
  const cap = l.caption;
  const big = Math.min(cap.h * 0.42, cap.w * 0.2);
  const slots = l.slots
    .map((s, i) => `
      <svg x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" viewBox="0 0 100 75" preserveAspectRatio="xMidYMid slice">
        <rect x="-50" y="-50" width="200" height="175" fill="${FACE_TINTS[i % 4]}"/>
        <rect x="-50" y="-50" width="200" height="175" fill="url(#${DOTS[i % 4]})" opacity=".35"/>
        <use href="#face-${(i % 4) + 1}"/>
      </svg>
      <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="#16110e" stroke-width="6"/>`)
    .join('');
  return `
    <rect width="${l.w}" height="${l.h}" fill="${frame.bg}"/>
    ${slots}
    <text x="${cap.x}" y="${cap.y + cap.h / 2 + big * 0.35}" fill="${frame.text}"
      font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="${big}" letter-spacing="-${big * 0.03}">jepret</text>
    <text x="${cap.x + cap.w}" y="${cap.y + cap.h / 2 + big * 0.35}" text-anchor="end" fill="${frame.text}"
      font-family="DM Mono, monospace" font-size="${big * 0.32}" letter-spacing="${big * 0.03}">${stamp()}</text>
    <circle cx="${cap.x + cap.w - big * 0.25}" cy="${cap.y + cap.h / 2 - big * 0.55}" r="${big * 0.16}" fill="${frame.accent}" stroke="#16110e" stroke-width="5"/>`;
}

const row = $('#lay-row');
const DISPLAY_H = 340;
const items = layouts.map((l) => {
  const fig = document.createElement('figure');
  fig.className = 'lay-item';
  const w = Math.round((l.w / l.h) * DISPLAY_H);
  fig.innerHTML = `
    <svg viewBox="0 0 ${l.w} ${l.h}" width="${w}" height="${DISPLAY_H}" role="img" aria-label="Contoh layout ${l.name}"></svg>
    <figcaption><b>${l.name}</b><span>${l.note}</span></figcaption>`;
  row.append(fig);
  return { l, svg: fig.querySelector('svg') };
});

function paint(frameId) {
  const frame = frames.find((f) => f.id === frameId);
  for (const { l, svg } of items) svg.innerHTML = layoutSvg(l, frame);
  for (const b of colors.children) b.setAttribute('aria-checked', String(b.dataset.id === frameId));
}

const colors = $('#lay-colors');
for (const f of frames) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.role = 'radio';
  b.dataset.id = f.id;
  b.innerHTML = `<span class="swatch" style="--sw:${f.bg}"></span>${f.name}`;
  b.addEventListener('click', () => paint(f.id));
  colors.append(b);
}
// wait for the display font so the SVG captions are measured with it
document.fonts.ready.then(() => paint('pink'));
paint('pink');

// ---------- code form ----------
$('#code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#code-in');
  const code = input.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    input.setCustomValidity('Kode 6 huruf/angka, contoh K7M2QX');
    input.reportValidity();
    return;
  }
  location.href = `/s/${code}`;
});
$('#code-in').addEventListener('input', (e) => e.target.setCustomValidity(''));
