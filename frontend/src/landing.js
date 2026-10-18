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
// Sample photos are Unsplash shots pre-cropped per slot (scripts/make_demo_photos.py).
// Colours come from CSS variables on the row, so switching paper colour never reloads the photos.
const PHOTO_TINTS = ['#ffd5e6', '#fff1c2', '#dde6ff', '#f4ecdd'];

function layoutSvg(l) {
  const cap = l.caption;
  const big = Math.min(cap.h * 0.42, cap.w * 0.2);
  const slots = l.slots
    .map((s, i) => `
      <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="${PHOTO_TINTS[i % 4]}"/>
      <image href="/demo/${l.id}-${i + 1}.webp" x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" preserveAspectRatio="xMidYMid slice"/>
      <rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="none" stroke="#16110e" stroke-width="6"/>`)
    .join('');
  return `
    <rect width="${l.w}" height="${l.h}" style="fill: var(--lay-bg)"/>
    ${slots}
    <text x="${cap.x}" y="${cap.y + cap.h / 2 + big * 0.35}" style="fill: var(--lay-text)"
      font-family="Bricolage Grotesque, sans-serif" font-weight="800" font-size="${big}" letter-spacing="-${big * 0.03}">jepret</text>
    <text x="${cap.x + cap.w}" y="${cap.y + cap.h / 2 + big * 0.35}" text-anchor="end" style="fill: var(--lay-text)"
      font-family="DM Mono, monospace" font-size="${big * 0.32}" letter-spacing="${big * 0.03}">${stamp()}</text>
    <circle cx="${cap.x + cap.w - big * 0.25}" cy="${cap.y + cap.h / 2 - big * 0.55}" r="${big * 0.16}" style="fill: var(--lay-accent)" stroke="#16110e" stroke-width="5"/>`;
}

const row = $('#lay-row');
const DISPLAY_H = 340;
for (const l of layouts) {
  const fig = document.createElement('figure');
  fig.className = 'lay-item';
  const w = Math.round((l.w / l.h) * DISPLAY_H);
  fig.innerHTML = `
    <svg viewBox="0 0 ${l.w} ${l.h}" width="${w}" height="${DISPLAY_H}" role="img" aria-label="Contoh layout ${l.name}">${layoutSvg(l)}</svg>
    <figcaption><b>${l.name}</b><span>${l.note}</span></figcaption>`;
  row.append(fig);
}

function paint(frameId) {
  const frame = frames.find((f) => f.id === frameId);
  row.style.setProperty('--lay-bg', frame.bg);
  row.style.setProperty('--lay-text', frame.text);
  row.style.setProperty('--lay-accent', frame.accent);
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
