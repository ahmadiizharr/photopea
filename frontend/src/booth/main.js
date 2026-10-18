import { layouts, frames, filters, formats, byId, stamp } from '../lib/catalog.js';
import { createSession, formatExpiry, getBooth } from '../lib/api.js';
import { applyFilter } from './filters.js';
import { compose, toBlob } from './compose.js';
import { openCamera, closeCamera, listCameras, describe, grab } from './camera.js';
import { printStrip } from './print.js';
import * as sound from './sound.js';

const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_LONG = 1600; // px, long side of each saved photo
const PREVIEW_LONG = 640; // px, live preview is filtered per frame so keep it modest

// ---------------- persisted settings ----------------
const KEY = 'jepret.booth';
const defaults = {
  layout: 'strip4', frame: 'pink', filter: 'normal', caption: '', countdown: 3, reset: 0, mirror: true, sound: true, camera: '',
  template: '', package: null, printer: false, autoPrint: false,
};
const cfg = { ...defaults, ...load() };
function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch { /* private mode */ }
}

// ---------------- state ----------------
const state = {
  step: 'setup',
  shots: [], // HTMLCanvasElement per slot
  run: 0, // bumps on cancel so an in-flight countdown stops
  stripBlob: null,
  localUrl: null,
  camOk: false,
  packs: [], // active packs that have at least one active frame
  templates: [], // uploaded frames switched on in the dashboard
  packages: [], // price packages switched on in the dashboard
  prints: 1,
};

// ---------------- design: built-in layout or uploaded frame ----------------
const fmtById = Object.fromEntries(formats.map((f) => [f.id, f]));
const money = new Intl.NumberFormat('id-ID');
const rupiah = (n) => `Rp ${money.format(n)}`;

/** An uploaded frame shaped like a built-in layout: one capture slot per photo number, all holes in `holes`. */
function frameLayout(t) {
  const first = [];
  for (const s of t.slots) first[s.photo - 1] ??= s;
  return { id: t.format, name: t.name, w: t.w, h: t.h, shots: t.n_photos, slots: first, holes: t.slots, template: t, print: fmtById[t.format]?.print };
}
const currentTemplate = () => (cfg.template && state.templates.find((t) => t.id === cfg.template)) || null;
const layout = () => {
  const t = currentTemplate();
  return t ? frameLayout(t) : byId(layouts, cfg.layout);
};
const currentPackage = () => state.packages.find((p) => p.id === cfg.package) ?? null;

const overlays = new Map();
function overlayFor(l) {
  if (!l.template) return null;
  let img = overlays.get(l.template.id);
  if (!img) {
    img = new Image();
    img.decoding = 'async';
    img.src = l.template.url;
    img.addEventListener('load', () => { if (state.step === 'shoot') renderMini(); });
    overlays.set(l.template.id, img);
  }
  return img;
}
const frame = () => byId(frames, cfg.frame);
const aspectOf = (i = 0) => {
  const s = layout().slots[i] ?? layout().slots[0];
  return s.w / s.h;
};

const video = $('#video');
const preview = $('#preview');
const pctx = preview.getContext('2d', { willReadFrequently: true });

function setStep(step) {
  state.step = step;
  document.body.dataset.step = step;
  const order = ['setup', 'shoot', 'review', 'done'];
  document.querySelectorAll('.progress li').forEach((li) => {
    const d = order.indexOf(li.dataset.for) - order.indexOf(step);
    li.dataset.state = d < 0 ? 'past' : d === 0 ? 'now' : 'next';
    if (d === 0) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  $('#btn-start').disabled = step !== 'setup' || !state.camOk;
}

// ---------------- camera ----------------
async function startCamera() {
  $('#cam-error').hidden = true;
  $('#cam-wait').hidden = false;
  closeCamera(video);
  state.camOk = false;
  try {
    await openCamera(video, cfg.camera);
    state.camOk = true;
    fillCameraList();
  } catch (e) {
    const { title, text } = describe(e);
    $('#cam-error-title').textContent = title;
    $('#cam-error-text').textContent = text;
    $('#cam-error').hidden = false;
  } finally {
    $('#cam-wait').hidden = true;
    setStep(state.step);
  }
}

function drawPreview() {
  requestAnimationFrame(drawPreview);
  if (!state.camOk || !video.videoWidth) return;
  if (state.step !== 'setup' && state.step !== 'shoot') return;
  const idx = state.step === 'shoot' ? state.current ?? 0 : 0;
  const a = aspectOf(idx);
  const w = a >= 1 ? PREVIEW_LONG : Math.round(PREVIEW_LONG * a);
  const h = a >= 1 ? Math.round(PREVIEW_LONG / a) : PREVIEW_LONG;
  if (preview.width !== w || preview.height !== h) {
    preview.width = w;
    preview.height = h;
    $('#screen').style.setProperty('--ar', (w / h).toFixed(4));
  }
  grabInto(pctx, video, video.videoWidth, video.videoHeight, a, cfg.mirror);
  applyFilter(pctx, cfg.filter);
}

function grabInto(ctx, src, sw, sh, aspect, mirror) {
  const { width: w, height: h } = ctx.canvas;
  let cw = sw, ch = sh, sx = 0, sy = 0;
  if (sw / sh > aspect) { cw = sh * aspect; sx = (sw - cw) / 2; } else { ch = sw / aspect; sy = (sh - ch) / 2; }
  ctx.save();
  if (mirror) { ctx.translate(w, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, sx, sy, cw, ch, 0, 0, w, h);
  ctx.restore();
}

async function fillCameraList() {
  const sel = $('#set-camera');
  const cams = await listCameras();
  sel.innerHTML = '<option value="">Bawaan (kamera depan)</option>';
  cams.forEach((c, i) => {
    const o = new Option(c.label || `Kamera ${i + 1}`, c.deviceId);
    sel.append(o);
  });
  sel.value = cams.some((c) => c.deviceId === cfg.camera) ? cfg.camera : '';
}

// ---------------- setup pane ----------------
function radio(container, items, current, render, onPick) {
  container.innerHTML = '';
  const options = () => [...container.querySelectorAll('[role="radio"]')];
  for (const it of items) {
    if (it.heading) {
      const h = document.createElement('p');
      h.className = 'opt-head';
      h.innerHTML = it.heading;
      container.append(h);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(it.id === current));
    b.dataset.id = it.id;
    render(b, it);
    b.addEventListener('click', () => {
      onPick(it.id);
      for (const x of options()) x.setAttribute('aria-checked', String(x.dataset.id === String(it.id)));
    });
    container.append(b);
  }
  // arrow keys move within the group like native radios
  container.onkeydown = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const list = options();
    const i = list.indexOf(document.activeElement);
    const next = list[(i + keys[e.key] + list.length) % list.length];
    next.focus();
    next.click();
  };
}

function layoutThumb(l, f) {
  const slots = l.slots.map((s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#fff" stroke="#16110e" stroke-width="18"/>`).join('');
  return `<svg viewBox="0 0 ${l.w} ${l.h}" aria-hidden="true"><rect width="${l.w}" height="${l.h}" fill="${f.bg}"/>${slots}</svg>`;
}

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const priceTag = (n) => (n ? rupiah(n) : 'Gratis');
const heading = (name, price, note) => ({
  heading: `<b>${esc(name)}</b><span class="opt-price${price ? '' : ' free'}">${priceTag(price)}</span>${note ? `<small>${esc(note)}</small>` : ''}`,
});

function renderLayoutOpts() {
  const builtins = layouts.map((l) => ({ id: `l:${l.id}`, l }));
  // with uploaded frames, group them per pack so guests see what each pack costs
  const items = state.templates.length
    ? [heading('Layout bawaan', 0), ...builtins, ...state.packs.flatMap((p) => [
      heading(p.name, p.price, p.description),
      ...state.templates.filter((t) => t.pack_id === p.id).map((t) => ({ id: `t:${t.id}`, t })),
    ])]
    : builtins;
  const current = currentTemplate() ? `t:${cfg.template}` : `l:${cfg.layout}`;
  radio($('#opt-layout'), items, current,
    (b, it) => {
      b.className = 'layout-opt';
      if (it.l) b.innerHTML = `${layoutThumb(it.l, frame())}<span><b>${it.l.name}</b><small>${it.l.shots} foto</small></span>`;
      else b.innerHTML = `<img src="${it.t.preview}" alt="" /><span><b>${esc(it.t.name)}</b><small>${it.t.n_photos} foto · ${esc(fmtById[it.t.format]?.paper ?? '')}</small></span>`;
    },
    (id) => {
      if (id.startsWith('t:')) cfg.template = id.slice(2);
      else { cfg.template = ''; cfg.layout = id.slice(2); }
      save();
      syncDesign();
    });
}

function syncDesign() {
  const l = layout();
  document.body.dataset.design = l.template ? 'frame' : 'builtin';
  overlayFor(l);
  renderSetupTotal();
}

/** What the guest pays: package (+ extra prints) + the chosen frame's pack. Null when nothing is charged. */
function bill(prints) {
  const p = currentPackage();
  const t = currentTemplate();
  const parts = [];
  let total = 0;
  if (p) {
    const extra = Math.max(0, prints - p.prints_included);
    total += p.price + extra * p.extra_print_price;
    parts.push(extra && p.extra_print_price ? `${esc(p.name)} + ${extra} cetak tambahan` : esc(p.name));
  }
  if (t?.pack_price) {
    total += t.pack_price;
    parts.push(esc(t.pack_name));
  }
  return parts.length ? { total, text: parts.join(' + ') } : null;
}

function renderSetupTotal() {
  const p = currentPackage();
  const b = bill(p ? p.prints_included : 0);
  const el = $('#setup-total');
  el.hidden = !b;
  if (b) el.innerHTML = `Total ${rupiah(b.total)}<span>${b.text} · bayar ke kasir, lalu tekan MULAI</span>`;
}

function renderPackages() {
  const group = $('#pkg-group');
  group.hidden = !state.packages.length;
  if (!state.packages.length) { cfg.package = null; return; }
  if (!currentPackage()) cfg.package = state.packages[0].id;
  radio($('#opt-package'), state.packages, cfg.package,
    (b, p) => {
      b.className = 'pkg-opt';
      const extra = p.max_prints > p.prints_included && p.extra_print_price
        ? ` · tambah ${rupiah(p.extra_print_price)}/lembar, maks ${p.max_prints}` : '';
      b.innerHTML = `<b>${esc(p.name)}</b><span class="pkg-price">${rupiah(p.price)}</span><small>${p.prints_included ? `${p.prints_included} cetak` : 'tanpa cetak'}${extra}</small>`;
    },
    (id) => { cfg.package = id; save(); renderSetupTotal(); });
}

async function loadBooth() {
  try {
    const b = await getBooth();
    state.packs = b.packs ?? [];
    state.templates = b.frames;
    state.packages = b.packages;
  } catch { /* offline or old server: built-in layouts still work */ }
  if (cfg.template && !currentTemplate()) cfg.template = '';
  renderLayoutOpts();
  renderPackages();
  syncDesign();
}

radio($('#opt-frame'), frames, cfg.frame,
  (b, f) => { b.className = 'chip'; b.innerHTML = `<span class="swatch" style="--sw:${f.bg}"></span>${f.name}`; },
  (id) => { cfg.frame = id; save(); renderLayoutOpts(); });

radio($('#opt-filter'), filters, cfg.filter,
  (b, f) => { b.className = 'chip'; b.textContent = f.name; },
  (id) => { cfg.filter = id; save(); });

renderLayoutOpts();

const capIn = $('#opt-caption');
capIn.value = cfg.caption;
capIn.addEventListener('input', () => { cfg.caption = capIn.value; save(); });

// ---------------- shooting ----------------
const mini = $('#mini');
const miniScale = () => Math.min(260 / layout().w, 520 / layout().h);
const renderMini = () => {
  const l = layout();
  compose(mini, l, frame(), state.shots, { caption: cfg.caption, date: stamp(), scale: miniScale(), overlay: overlayFor(l) });
};

function showCount(n) {
  const el = $('#count');
  el.textContent = n;
  el.classList.remove('pop');
  void el.offsetWidth;
  if (n !== '') el.classList.add('pop');
}

function flash() {
  const el = $('#flash');
  el.classList.remove('on');
  void el.offsetWidth;
  el.classList.add('on');
}

async function shoot(indices, { retake = false } = {}) {
  const run = ++state.run;
  const live = () => run === state.run;
  sound.unlock();
  setStep('shoot');
  const overlay = overlayFor(layout());
  if (overlay) await overlay.decode().catch(() => {});
  if (!live()) return;
  const total = layout().shots;
  if (!retake) state.shots = Array(total).fill(null);
  renderMini();

  for (const i of indices) {
    state.current = i;
    $('#shot-tag').textContent = `FOTO ${i + 1}/${total}`;
    $('#shoot-label').textContent = retake ? `Ulang foto ${i + 1}` : `Foto ${i + 1} dari ${total}`;
    for (let n = Number(cfg.countdown); n > 0; n--) {
      showCount(String(n));
      if (cfg.sound) sound.beep(n === 1 ? 1320 : 880);
      await wait(1000);
      if (!live()) return;
    }
    showCount('');
    if (cfg.sound) sound.shutter();
    flash();
    const shot = grab(video, video.videoWidth, video.videoHeight, aspectOf(i), SHOT_LONG, cfg.mirror);
    applyFilter(shot.getContext('2d', { willReadFrequently: true }), cfg.filter);
    state.shots[i] = shot;
    renderMini();
    await wait(900);
    if (!live()) return;
  }
  state.current = 0;
  $('#shot-tag').textContent = 'SELESAI';
  review();
}

function cancelShoot() {
  state.run++;
  showCount('');
  $('#shot-tag').textContent = 'SIAP';
  // a cancelled retake goes back to review with the old photo; a cancelled first run starts over
  if (state.shots.length && state.shots.every(Boolean)) review();
  else setStep('setup');
}

// ---------------- review ----------------
const finalCanvas = $('#final');

// ---------------- prints + price ----------------
function printLimits() {
  const p = currentPackage();
  if (p) return { min: 0, max: p.max_prints, start: p.prints_included };
  return { min: 0, max: 10, start: 1 };
}

function renderPrints() {
  const p = currentPackage();
  const show = Boolean(p) || cfg.printer;
  $('#prints-box').hidden = !show;
  const { min, max } = printLimits();
  state.prints = Math.min(max, Math.max(min, state.prints));
  $('#prints-n').textContent = state.prints;
  $('#prints-minus').disabled = state.prints <= min;
  $('#prints-plus').disabled = state.prints >= max;
  const rule = layout().print;
  const per = rule?.per_page > 1 ? ` · 1 lembar = ${rule.per_page} ${layout().template ? 'cetakan' : 'strip'}` : '';
  $('#prints-note').textContent = p
    ? `${p.prints_included} lembar termasuk paket${p.extra_print_price ? `, tambahan ${rupiah(p.extra_print_price)}/lembar` : ''}${per}`
    : `${rule ? `${rule.page[0]}×${rule.page[1]} inci` : ''}${per}`;
  const b = bill(state.prints);
  const total = $('#total');
  total.hidden = !b;
  if (b) total.innerHTML = `Total ${rupiah(b.total)}<span>${b.text} · bayar ke kasir</span>`;
}
$('#prints-minus').addEventListener('click', () => { state.prints--; renderPrints(); });
$('#prints-plus').addEventListener('click', () => { state.prints++; renderPrints(); });

function doPrint() {
  printStrip(finalCanvas, layout().print, state.prints);
}

function review() {
  setStep('review');
  const l = layout();
  compose(finalCanvas, l, frame(), state.shots, { caption: cfg.caption, date: stamp(), overlay: overlayFor(l) });
  state.prints = printLimits().start;
  renderPrints();
  const list = $('#thumbs');
  list.innerHTML = '';
  state.shots.forEach((shot, i) => {
    const li = document.createElement('li');
    const img = new Image();
    img.alt = `Foto ${i + 1}`;
    img.src = shot.toDataURL('image/jpeg', 0.7);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-ghost btn-sm';
    b.textContent = 'Ulang';
    b.setAttribute('aria-label', `Ulang foto ${i + 1}`);
    b.addEventListener('click', () => shoot([i], { retake: true }));
    if (!state.camOk) b.disabled = true;
    li.append(img, b);
    list.append(li);
  });
  $('#btn-save').focus({ preventScroll: true });
}

// ---------------- save + QR ----------------
let resetTimer = null;

async function saveSession() {
  setStep('done');
  $('#saving').hidden = false;
  $('#ticket').hidden = true;
  $('#upload-fail').hidden = true;
  $('#btn-new').hidden = true;
  try {
    state.stripBlob ??= await toBlob(finalCanvas, 0.92);
    if (state.localUrl) URL.revokeObjectURL(state.localUrl);
    state.localUrl = URL.createObjectURL(state.stripBlob);
    $('#dl-local').href = state.localUrl;
    const shots = await Promise.all(state.shots.map((c) => toBlob(c, 0.9)));
    const pkg = currentPackage();
    const s = await createSession({
      strip: state.stripBlob, shots, layout: cfg.layout, frame: cfg.frame, filter: cfg.filter,
      template: layout().template?.id, pkg: pkg?.id, prints: pkg || cfg.printer ? state.prints : null,
    });
    $('#qr').src = s.files.qr;
    $('#code').textContent = s.code;
    $('#host').textContent = location.host;
    $('#dl-strip').href = `${s.files.strip}?dl=1`;
    $('#open-result').href = `/s/${s.code}`;
    $('#expire').textContent = `Tersimpan sampai ${formatExpiry(s.expires_at)}`;
    $('#ticket').hidden = false;
    if (cfg.sound) sound.chime();
    armAutoReset();
  } catch (e) {
    $('#upload-fail-text').textContent = `${e.message} Strip-nya masih aman di layar ini.`;
    $('#upload-fail').hidden = false;
  } finally {
    $('#saving').hidden = true;
    $('#btn-new').hidden = false;
    const canPrint = cfg.printer && state.prints > 0;
    const pb = $('#btn-print');
    pb.hidden = !canPrint;
    pb.textContent = `Cetak ${state.prints} lembar`;
    if (canPrint && cfg.autoPrint) doPrint();
  }
}

function armAutoReset() {
  clearInterval(resetTimer);
  const secs = Number(cfg.reset);
  const box = $('#auto-reset');
  box.hidden = !secs;
  if (!secs) return;
  let left = secs;
  const tick = () => {
    $('#auto-reset-text').textContent = `Sesi baru otomatis dalam ${left} dtk`;
    $('#auto-reset-bar').style.transform = `scaleX(${left / secs})`;
    if (left-- <= 0) newSession();
  };
  tick();
  resetTimer = setInterval(tick, 1000);
}

function newSession() {
  clearInterval(resetTimer);
  $('#auto-reset').hidden = true;
  state.run++;
  state.shots = [];
  state.stripBlob = null;
  $('#btn-print').hidden = true;
  $('#shot-tag').textContent = 'SIAP';
  setStep('setup');
  $('#btn-start').focus({ preventScroll: true });
}

// ---------------- gallery fallback (no camera) ----------------
$('#file-pick').addEventListener('change', async (e) => {
  const files = [...e.target.files].slice(0, layout().shots);
  e.target.value = '';
  if (!files.length) return;
  const n = layout().shots;
  const bitmaps = await Promise.all(files.map((f) => createImageBitmap(f, { imageOrientation: 'from-image' }).catch(() => null)));
  const ok = bitmaps.filter(Boolean);
  if (!ok.length) return;
  state.shots = Array.from({ length: n }, (_, i) => {
    const bm = ok[i % ok.length];
    const c = grab(bm, bm.width, bm.height, aspectOf(i), SHOT_LONG, false);
    applyFilter(c.getContext('2d', { willReadFrequently: true }), cfg.filter);
    return c;
  });
  review();
});

// ---------------- settings dialog ----------------
const dlg = $('#settings');
$('#btn-settings').addEventListener('click', () => {
  $('#set-countdown').value = String(cfg.countdown);
  $('#set-reset').value = String(cfg.reset);
  $('#set-mirror').checked = cfg.mirror;
  $('#set-sound').checked = cfg.sound;
  $('#set-printer').checked = cfg.printer;
  $('#set-autoprint').checked = cfg.autoPrint;
  dlg.showModal();
});
$('#set-countdown').addEventListener('change', (e) => { cfg.countdown = Number(e.target.value); save(); });
$('#set-reset').addEventListener('change', (e) => { cfg.reset = Number(e.target.value); save(); });
$('#set-mirror').addEventListener('change', (e) => { cfg.mirror = e.target.checked; save(); });
$('#set-sound').addEventListener('change', (e) => { cfg.sound = e.target.checked; save(); });
$('#set-printer').addEventListener('change', (e) => { cfg.printer = e.target.checked; save(); });
$('#set-autoprint').addEventListener('change', (e) => { cfg.autoPrint = e.target.checked; save(); });
$('#set-camera').addEventListener('change', (e) => { cfg.camera = e.target.value; save(); startCamera(); });
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

// ---------------- fullscreen + wake lock ----------------
const fsBtn = $('#btn-full');
if (!document.fullscreenEnabled) fsBtn.hidden = true;
const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen().catch(() => {}));
fsBtn.addEventListener('click', toggleFull);

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* not allowed, fine */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { keepAwake(); if (!state.camOk) startCamera(); }
});

// ---------------- wiring ----------------
$('#btn-start').addEventListener('click', () => shoot([...Array(layout().shots).keys()]));
$('#btn-cancel').addEventListener('click', cancelShoot);
$('#btn-redo').addEventListener('click', () => (state.camOk ? shoot([...Array(layout().shots).keys()]) : setStep('setup')));
$('#btn-save').addEventListener('click', saveSession);
$('#btn-retry-upload').addEventListener('click', saveSession);
$('#btn-new').addEventListener('click', newSession);
$('#btn-print').addEventListener('click', doPrint);
$('#cam-retry').addEventListener('click', startCamera);
$('.panel').addEventListener('pointerdown', () => { if (state.step === 'done' && cfg.reset) armAutoReset(); });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a')) return; // let buttons handle their own keys
  // PageDown/PageUp: what presenter clickers send, so one works as a shutter remote
  if (e.key === 'PageDown' || e.key === 'PageUp') {
    if (state.step === 'setup' && state.camOk) { e.preventDefault(); $('#btn-start').click(); }
  } else if (e.key === ' ' || e.key === 'Enter') {
    if (state.step === 'setup' && state.camOk) { e.preventDefault(); $('#btn-start').click(); }
    else if (state.step === 'done' && !$('#ticket').hidden) { e.preventDefault(); newSession(); }
  } else if (e.key === 'Escape' && state.step === 'shoot') {
    cancelShoot();
  } else if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenEnabled) toggleFull();
  }
});

setStep('setup');
syncDesign();
loadBooth();
startCamera().then(keepAwake);
requestAnimationFrame(drawPreview);
// make sure the canvas fonts exist before the first strip is drawn
document.fonts.load('800 60px "Bricolage Grotesque"');
document.fonts.load('500 20px "DM Mono"');
