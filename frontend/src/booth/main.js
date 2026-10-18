import { layouts, frames, filters, formats, byId, stamp } from '../lib/catalog.js';
import { cancelOrder, createOrder, createSession, formatExpiry, getBooth, getOrder } from '../lib/api.js';
import { applyFilter } from './filters.js';
import { compose, toBlob } from './compose.js';
import { openCamera, closeCamera, listCameras, describe, grab } from './camera.js';
import { printStrip } from './print.js';
import * as sound from './sound.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_LONG = 1600; // px, long side of each saved photo
const PREVIEW_LONG = 640; // px, live preview is filtered per frame so keep it modest
const THUMB_W = 112; // filter thumbnails under the camera, refreshed once a second
const THUMB_H = 84;
const DONE_SECS = 8; // thank-you screen, then back to the start
const POLL_MS = 2000; // how often the pay screen asks whether the kasir confirmed

// ---------------- persisted settings ----------------
const KEY = 'jepret.booth';
const defaults = {
  layout: 'strip4', frame: 'pink', filter: 'normal', caption: '', countdown: 3, reset: 0, mirror: true, sound: true, camera: '',
  template: '', package: null, printer: false, autoPrint: false,
  limit: 180, // seconds a paid guest has for shooting and checking; 0 = no limit
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
  step: 'frame',
  cat: 'semua', // frame category tab
  shots: [], // HTMLCanvasElement per capture slot
  current: 0,
  run: 0, // bumps on cancel so an in-flight countdown stops
  shooting: false,
  stripBlob: null,
  localUrl: null,
  camOk: false,
  packs: [], // active packs that have at least one active frame
  templates: [], // uploaded frames switched on in the dashboard
  packages: [], // price packages switched on in the dashboard
  prints: 1,
  order: null, // the paid order this guest is shooting on
  pending: null, // order waiting for the kasir
  printed: false,
  deadline: null, // when a paid session's time runs out (ms)
  timeUp: false,
  warned: false,
};

// ---------------- design: built-in layout or uploaded frame ----------------
const fmtById = Object.fromEntries(formats.map((f) => [f.id, f]));
const money = new Intl.NumberFormat('id-ID');
const rupiah = (n) => `Rp ${money.format(n)}`;
const priceTag = (n) => (n ? rupiah(n) : 'Gratis');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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

// ---------------- steps ----------------
const STEPS = ['frame', 'package', 'shoot', 'review', 'download', 'done'];
const FOCUS = { frame: '#to-next', package: '#to-pay', shoot: '#btn-start', review: '#btn-save', download: '#btn-finish', done: '#btn-new' };

function go(step, { focus = true } = {}) {
  state.step = step;
  document.body.dataset.step = step;
  const now = STEPS.indexOf(step === 'pay' ? 'package' : step);
  $$('.progress li').forEach((li) => {
    const d = STEPS.indexOf(li.dataset.for) - now;
    li.dataset.state = d < 0 ? 'past' : d === 0 ? 'now' : 'next';
    if (d === 0) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  });
  if (step !== 'pay') stopPolling();
  if (step === 'package') { renderPackages(); renderPrints(); }
  if (step === 'pay') renderBill();
  if (step === 'shoot') renderShotRow();
  syncShootUi();
  window.scrollTo(0, 0);
  // keyboard and switch users land on the step's main action; no ring for touch and mouse
  if (focus && FOCUS[step]) $(FOCUS[step])?.focus({ preventScroll: true, focusVisible: false });
}

function syncShootUi() {
  document.body.dataset.shooting = String(state.shooting);
  $('#btn-start').disabled = state.step !== 'shoot' || state.shooting || !state.camOk;
  $('#btn-cancel').hidden = !state.shooting || state.timeUp; // once time is up the run can't be called off
  // once paid, the frame is part of the order and can't be swapped
  $('#shoot-back').hidden = state.shooting || Boolean(state.order);
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
    syncShootUi();
  }
}

function drawPreview(t) {
  requestAnimationFrame(drawPreview);
  if (!state.camOk || !video.videoWidth || state.step !== 'shoot') return;
  const a = aspectOf(state.shooting ? state.current : 0);
  const w = a >= 1 ? PREVIEW_LONG : Math.round(PREVIEW_LONG * a);
  const h = a >= 1 ? Math.round(PREVIEW_LONG / a) : PREVIEW_LONG;
  if (preview.width !== w || preview.height !== h) {
    preview.width = w;
    preview.height = h;
    $('#screen').style.setProperty('--ar', (w / h).toFixed(4));
  }
  grabInto(pctx, video, video.videoWidth, video.videoHeight, a, cfg.mirror);
  applyFilter(pctx, cfg.filter);
  if (!state.shooting) drawFilterThumbs(t);
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

// ---------------- radio groups ----------------
/** Buttons acting as one radio group; items with `heading` render as group titles in between. */
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

// ---------------- 1. frame ----------------
const BASIC = 'Basic';
const catOf = (p) => p.category?.trim() || 'Lainnya';
const heading = (name, price, note) => ({
  heading: `<b>${esc(name)}</b><span class="opt-price${price ? '' : ' free'}">${priceTag(price)}</span>${note ? `<small>${esc(note)}</small>` : ''}`,
});

function layoutThumb(l, f) {
  const slots = l.slots.map((s) => `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" fill="#fff" stroke="#16110e" stroke-width="18"/>`).join('');
  return `<svg viewBox="0 0 ${l.w} ${l.h}" aria-hidden="true"><rect width="${l.w}" height="${l.h}" fill="${f.bg}"/>${slots}</svg>`;
}

/** Category tabs: only worth showing once the dashboard has frames. */
function categories() {
  if (!state.templates.length) return [];
  const cats = ['semua', BASIC];
  for (const p of state.packs) if (!cats.includes(catOf(p))) cats.push(catOf(p));
  return cats;
}

function renderCats() {
  const cats = categories();
  const box = $('#cats');
  box.hidden = !cats.length;
  if (!cats.includes(state.cat)) state.cat = 'semua';
  box.innerHTML = cats.map((c) => `<button class="chip" type="button" data-cat="${esc(c)}" aria-pressed="${c === state.cat}">${c === 'semua' ? 'Semua' : esc(c)}</button>`).join('');
}
$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  state.cat = b.dataset.cat;
  renderCats();
  renderFrameGrid();
});

function frameItems() {
  const show = (c) => state.cat === 'semua' || state.cat === c;
  const items = [];
  if (!state.templates.length || show(BASIC)) {
    if (state.templates.length) items.push(heading('Layout bawaan', 0, 'Pilih warna kertas dan tulis teksmu sendiri'));
    items.push(...layouts.map((l) => ({ id: `l:${l.id}`, l })));
  }
  for (const p of state.packs) {
    const list = state.templates.filter((t) => t.pack_id === p.id);
    if (show(catOf(p)) && list.length) items.push(heading(p.name, p.price, p.description), ...list.map((t) => ({ id: `t:${t.id}`, t })));
  }
  return items;
}

function renderFrameGrid() {
  const current = currentTemplate() ? `t:${cfg.template}` : `l:${cfg.layout}`;
  radio($('#frame-grid'), frameItems(), current,
    (b, it) => {
      b.className = 'frame-card';
      if (it.l) b.innerHTML = `<span class="fc-thumb">${layoutThumb(it.l, frame())}</span><span class="fc-body"><b>${esc(it.l.name)}</b><small>${it.l.shots} foto</small></span>`;
      else b.innerHTML = `<span class="fc-thumb"><img src="${it.t.preview}" alt="" loading="lazy" /></span><span class="fc-body"><b>${esc(it.t.name)}</b><small>${it.t.n_photos} foto · ${esc(fmtById[it.t.format]?.paper ?? '')}</small></span>`;
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
  const t = l.template;
  document.body.dataset.design = t ? 'frame' : 'builtin';
  overlayFor(l);
  $('#pick').innerHTML = `<span class="pick-thumb">${t ? `<img src="${t.preview}" alt="" />` : layoutThumb(l, frame())}</span>
    <span class="pick-text"><b>${esc(l.name)}</b><small>${t ? `${esc(t.pack_name)} · ` : ''}${l.shots} foto · ${priceTag(t?.pack_price ?? 0)}</small></span>`;
}

radio($('#opt-frame'), frames, cfg.frame,
  (b, f) => { b.className = 'chip'; b.innerHTML = `<span class="swatch" style="--sw:${f.bg}"></span>${f.name}`; },
  (id) => { cfg.frame = id; save(); renderFrameGrid(); syncDesign(); });

const capIn = $('#opt-caption');
capIn.value = cfg.caption;
capIn.addEventListener('input', () => { cfg.caption = capIn.value; save(); });

$('#to-next').addEventListener('click', () => {
  if (state.packages.length) {
    state.prints = currentPackage()?.prints_included ?? 1;
    go('package');
  } else if (bill().total > 0) {
    resetPayUi();
    go('pay');
  } else {
    go('shoot');
  }
});

async function loadBooth() {
  try {
    const b = await getBooth();
    state.packs = b.packs ?? [];
    state.templates = b.frames;
    state.packages = b.packages;
  } catch { /* offline or old server: built-in layouts still work */ }
  if (cfg.template && !currentTemplate()) cfg.template = '';
  if (state.packages.length && !currentPackage()) cfg.package = state.packages[0].id;
  renderCats();
  renderFrameGrid();
  syncDesign();
}

// ---------------- 2. package ----------------
function renderPackages() {
  if (!state.packages.length) return;
  if (!currentPackage()) cfg.package = state.packages[0].id;
  radio($('#pkg-grid'), state.packages, cfg.package,
    (b, p) => {
      b.className = 'pkg-card';
      const extra = p.max_prints > p.prints_included && p.extra_print_price
        ? `Tambah ${rupiah(p.extra_print_price)}/lembar, maks ${p.max_prints}` : '';
      b.innerHTML = `<b>${esc(p.name)}</b><span class="pkg-price">${rupiah(p.price)}</span>
        <span class="pkg-incl">${p.prints_included ? `${p.prints_included} lembar cetak` : 'Tanpa cetak'} · file digital &amp; GIF</span>${extra ? `<small>${extra}</small>` : ''}`;
    },
    (id) => {
      cfg.package = id;
      save();
      state.prints = currentPackage().prints_included;
      renderPrints();
    });
}

function renderPrints() {
  const p = currentPackage();
  $('#prints-box').hidden = !p || !p.max_prints;
  if (p) {
    state.prints = Math.min(p.max_prints, Math.max(0, state.prints));
    $('#prints-n').textContent = state.prints;
    $('#prints-minus').disabled = state.prints <= 0;
    $('#prints-plus').disabled = state.prints >= p.max_prints;
    const rule = layout().print;
    const per = rule?.per_page > 1 ? ` · 1 lembar = ${rule.per_page} ${layout().template ? 'cetakan' : 'strip'}` : '';
    $('#prints-note').textContent = `${p.prints_included} lembar termasuk paket${p.extra_print_price ? `, tambahan ${rupiah(p.extra_print_price)}/lembar` : ''}${per}`;
  }
  renderBill();
}
$('#prints-minus').addEventListener('click', () => { state.prints--; renderPrints(); });
$('#prints-plus').addEventListener('click', () => { state.prints++; renderPrints(); });

/** What the guest pays: package (+ extra prints) + the chosen frame's pack. */
function bill() {
  const p = currentPackage();
  const t = currentTemplate();
  const lines = [];
  if (p) {
    lines.push([`Paket ${p.name}`, p.price]);
    const extra = Math.max(0, state.prints - p.prints_included);
    if (extra && p.extra_print_price) lines.push([`Cetak tambahan ${extra} × ${rupiah(p.extra_print_price)}`, extra * p.extra_print_price]);
  }
  if (t?.pack_price) lines.push([`Frame ${t.name} · ${t.pack_name}`, t.pack_price]);
  return { lines, total: lines.reduce((sum, [, n]) => sum + n, 0) };
}

function renderBill() {
  const { lines, total } = bill();
  const html = `<dl>${lines.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${rupiah(v)}</dd></div>`).join('')}
    <div class="bill-total"><dt>Total</dt><dd>${rupiah(total)}</dd></div></dl>`;
  $('#bill-package').innerHTML = html;
  $('#bill-pay').textContent = lines.map(([k]) => k).join(' + ');
  const tot = `<span class="mono">Total</span>${rupiah(total)}`;
  $('#total-package').innerHTML = tot;
  $('#total-pay').innerHTML = tot;
}

$('#to-pay').addEventListener('click', async () => {
  resetPayUi();
  if (bill().total > 0) { go('pay'); return; }
  // a free package still gets an order, so the session counts like any other
  try {
    handleOrder(await createOrder(orderBody(null)));
  } catch (e) {
    go('pay');
    payError(e.message);
  }
});

// ---------------- 2b. pay: kasir or voucher ----------------
const orderBody = (voucher) => ({
  package: currentPackage()?.id ?? null,
  template: currentTemplate()?.id ?? null,
  prints: currentPackage() ? state.prints : null,
  voucher,
});

function resetPayUi() {
  $('#btn-cashier').hidden = false;
  $('#pay-wait').hidden = true;
  $('#voucher-error').hidden = true;
  $('#pay-error').hidden = true;
}

function payError(text) {
  $('#pay-error').textContent = text;
  $('#pay-error').hidden = false;
}

function handleOrder(o) {
  if (o.status === 'paid') {
    stopPolling();
    state.pending = null;
    state.order = o;
    if (currentPackage()) state.prints = o.prints;
    go('shoot');
    startLimit();
    return;
  }
  state.pending = o;
  $('#btn-cashier').hidden = true;
  $('#pay-wait').hidden = false;
  $('#pay-code').textContent = o.code;
  $('#pay-due').innerHTML = `Bayar <b>${rupiah(o.total)}</b>${o.discount ? ` <span>(voucher −${rupiah(o.discount)})</span>` : ''}`;
  startPolling();
}

let pollTimer = null;
function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const mine = state.pending;
    if (!mine) { stopPolling(); return; }
    try {
      const o = await getOrder(mine.id);
      if (state.pending !== mine) return;
      if (o.status === 'paid') {
        if (cfg.sound) sound.chime();
        handleOrder(o);
      } else if (o.status === 'cancelled') {
        stopPolling();
        state.pending = null;
        resetPayUi();
        payError('Kode bayar dibatalkan. Minta kode baru atau pakai voucher.');
      }
    } catch { /* network blip: ask again next round */ }
  }, POLL_MS);
}
function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
}

/** Give back an order the kasir hasn't confirmed (and the voucher use on it). */
async function dropPending() {
  stopPolling();
  const o = state.pending;
  state.pending = null;
  if (o) await cancelOrder(o.id).catch(() => {});
}

$('#btn-cashier').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  $('#pay-error').hidden = true;
  try {
    handleOrder(await createOrder(orderBody(null)));
  } catch (x) {
    payError(x.message);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-pay-cancel').addEventListener('click', async () => {
  await dropPending();
  resetPayUi();
});

$('#voucher-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#voucher-in');
  const code = input.value.trim();
  if (!code) { input.focus(); return; }
  const btn = e.currentTarget.querySelector('button');
  btn.disabled = true;
  $('#voucher-error').hidden = true;
  $('#pay-error').hidden = true;
  await dropPending(); // a voucher replaces a code already waiting at the kasir
  try {
    const o = await createOrder(orderBody(code));
    input.value = '';
    handleOrder(o);
  } catch (x) {
    resetPayUi();
    $('#voucher-error').textContent = x.message;
    $('#voucher-error').hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$$('[data-back]').forEach((b) => b.addEventListener('click', async () => {
  if (state.step === 'pay') {
    await dropPending();
    go(state.packages.length ? 'package' : 'frame');
  } else {
    go('frame');
  }
}));

// ---------------- 3. shoot ----------------
const thumbCanvases = new Map();
radio($('#filter-strip'), filters, cfg.filter,
  (b, f) => {
    b.className = 'filter-opt';
    const c = document.createElement('canvas');
    c.width = THUMB_W;
    c.height = THUMB_H;
    thumbCanvases.set(f.id, c);
    const name = document.createElement('span');
    name.textContent = f.name;
    b.append(c, name);
  },
  (id) => { cfg.filter = id; save(); });

let thumbsAt = -Infinity;
function drawFilterThumbs(t) {
  if (t - thumbsAt < 1000) return;
  thumbsAt = t;
  const src = grab(video, video.videoWidth, video.videoHeight, THUMB_W / THUMB_H, THUMB_W, cfg.mirror);
  for (const [id, c] of thumbCanvases) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, c.width, c.height);
    applyFilter(ctx, id);
  }
}

function renderShotRow() {
  const row = $('#shot-row');
  row.innerHTML = '';
  const n = layout().shots;
  for (let i = 0; i < n; i++) {
    const li = document.createElement('li');
    const shot = state.shots[i];
    if (shot) {
      const c = document.createElement('canvas');
      c.height = 120;
      c.width = Math.round((shot.width / shot.height) * 120);
      c.getContext('2d').drawImage(shot, 0, 0, c.width, c.height);
      li.append(c);
    } else {
      li.innerHTML = `<span>${i + 1}</span>`;
    }
    if (state.shooting && i === state.current) li.className = 'now';
    row.append(li);
  }
}

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
  state.shooting = true;
  if (state.step !== 'shoot') go('shoot');
  syncShootUi();
  const overlay = overlayFor(layout());
  if (overlay) await overlay.decode().catch(() => {});
  if (!live()) return;
  const total = layout().shots;
  if (!retake) state.shots = Array(total).fill(null);

  for (const i of indices) {
    state.current = i;
    renderShotRow();
    $('#shot-tag').textContent = retake ? `ULANG ${i + 1}` : `FOTO ${i + 1}/${total}`;
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
    renderShotRow();
    await wait(900);
    if (!live()) return;
  }
  state.current = 0;
  state.shooting = false;
  $('#shot-tag').textContent = 'SELESAI';
  review();
}

function cancelShoot() {
  if (state.timeUp) return;
  state.run++;
  state.shooting = false;
  showCount('');
  $('#shot-tag').textContent = 'SIAP';
  // a cancelled retake goes back to review with the old photo; a cancelled first run starts over
  if (state.shots.length && state.shots.every(Boolean)) review();
  else { state.shots = []; renderShotRow(); syncShootUi(); }
}

$('#shoot-back').addEventListener('click', () => go('frame'));

// ---------------- 4. review ----------------
const finalCanvas = $('#final');

function review() {
  go('review');
  const l = layout();
  compose(finalCanvas, l, frame(), state.shots, { caption: cfg.caption, date: stamp(), overlay: overlayFor(l) });
  state.stripBlob = null;
  if (state.timeUp) { saveSession(); return; }
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
}

// ---------------- time limit once paid ----------------
// Paying starts the clock so a guest can't hold the booth; when it runs out the booth finishes for them.
let limitTimer = null;

function startLimit() {
  stopLimit();
  const secs = Number(cfg.limit);
  if (!secs) return;
  state.deadline = Date.now() + secs * 1000;
  state.timeUp = false;
  state.warned = false;
  limitTimer = setInterval(tickLimit, 250);
  tickLimit();
}

function stopLimit() {
  clearInterval(limitTimer);
  limitTimer = null;
  state.deadline = null;
  $('#limit').hidden = true;
}

function tickLimit() {
  const left = Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
  const box = $('#limit');
  box.hidden = state.step !== 'shoot' && state.step !== 'review';
  box.classList.toggle('low', left <= 30);
  $('#limit-time').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  const soon = state.step === 'review' ? 'Disimpan otomatis' : state.shooting ? 'Segera habis' : 'Foto mulai otomatis';
  $('#limit-label').textContent = left > 30 ? 'Sisa waktu' : left > 0 ? soon : 'Waktu habis';
  if (left <= 30 && !state.warned) {
    state.warned = true;
    if (cfg.sound) sound.beep(660);
  }
  if (left > 0) return;
  clearInterval(limitTimer);
  limitTimer = null;
  state.timeUp = true;
  syncShootUi();
  if (state.step === 'review') saveSession();
  else if (state.step === 'shoot' && !state.shooting) {
    if (state.shots.length && state.shots.every(Boolean)) review();
    else if (state.camOk) shoot([...Array(layout().shots).keys()]);
  }
  // mid-shoot the run carries on and review() saves straight after it
}

// ---------------- 5. download ----------------
let resetTimer = null;
/** Prints follow the package that was paid; without one the booth prints for free. */
const printsFixed = () => Boolean(state.order && currentPackage());

async function saveSession() {
  stopLimit();
  go('download');
  $('#saving').hidden = false;
  $('#ticket').hidden = true;
  $('#upload-fail').hidden = true;
  $('#print-row').hidden = true;
  $('#btn-finish').disabled = true;
  try {
    state.stripBlob ??= await toBlob(finalCanvas, 0.92);
    if (state.localUrl) URL.revokeObjectURL(state.localUrl);
    state.localUrl = URL.createObjectURL(state.stripBlob);
    $('#strip-copy').src = state.localUrl;
    $('#dl-local').href = state.localUrl;
    const shots = await Promise.all(state.shots.map((c) => toBlob(c, 0.9)));
    const s = await createSession({
      strip: state.stripBlob, shots, layout: cfg.layout, frame: cfg.frame, filter: cfg.filter,
      template: layout().template?.id, order: state.order?.id, prints: cfg.printer ? state.prints : null,
    });
    $('#qr').src = s.files.qr;
    $('#code').textContent = s.code;
    $('#host').textContent = location.host;
    $('#dl-strip').href = `${s.files.strip}?dl=1`;
    $('#open-result').href = `/s/${s.code}`;
    $('#expire').textContent = `Tersimpan sampai ${formatExpiry(s.expires_at)}`;
    $('#ticket').hidden = false;
    if (cfg.sound) sound.chime();
  } catch (e) {
    $('#upload-fail-text').textContent = `${e.message} Strip-nya masih aman di layar ini.`;
    $('#upload-fail').hidden = false;
  } finally {
    $('#saving').hidden = true;
    $('#btn-finish').disabled = false;
    renderPrintRow();
    if (cfg.printer && cfg.autoPrint && state.prints > 0 && !state.printed) doPrint();
    armAutoReset();
  }
}

function renderPrintRow() {
  $('#print-row').hidden = !cfg.printer || (printsFixed() && state.prints < 1);
  $('#free-prints').hidden = printsFixed();
  $('#free-n').textContent = state.prints;
  $('#free-minus').disabled = state.prints <= 1;
  $('#free-plus').disabled = state.prints >= 10;
  $('#btn-print').textContent = `Cetak ${state.prints} lembar`;
}
$('#free-minus').addEventListener('click', () => { state.prints--; renderPrintRow(); });
$('#free-plus').addEventListener('click', () => { state.prints++; renderPrintRow(); });

function doPrint() {
  state.printed = true;
  printStrip(finalCanvas, layout().print, state.prints);
}

function armAutoReset() {
  clearInterval(resetTimer);
  const secs = Number(cfg.reset);
  const box = $('#auto-reset');
  box.hidden = !secs;
  if (!secs) return;
  let left = secs;
  const tick = () => {
    $('#auto-reset-text').textContent = `Selesai otomatis dalam ${left} dtk`;
    $('#auto-reset-bar').style.transform = `scaleX(${left / secs})`;
    if (left-- <= 0) finish();
  };
  tick();
  resetTimer = setInterval(tick, 1000);
}

// ---------------- 6. done ----------------
let doneTimer = null;
function finish() {
  clearInterval(resetTimer);
  $('#auto-reset').hidden = true;
  go('done');
  let left = DONE_SECS;
  clearInterval(doneTimer);
  const tick = () => {
    $('#done-count').textContent = `Kembali ke awal dalam ${left} dtk`;
    if (left-- <= 0) newSession();
  };
  tick();
  doneTimer = setInterval(tick, 1000);
}

function newSession() {
  stopLimit();
  state.timeUp = false;
  clearInterval(resetTimer);
  clearInterval(doneTimer);
  $('#auto-reset').hidden = true;
  state.run++;
  state.shooting = false;
  state.shots = [];
  state.stripBlob = null;
  state.order = null;
  state.pending = null;
  state.prints = 1;
  state.printed = false;
  $('#shot-tag').textContent = 'SIAP';
  resetPayUi();
  go('frame');
  loadBooth(); // pick up frames and packages changed in the dashboard meanwhile
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
  $('#set-limit').value = String(cfg.limit);
  dlg.showModal();
});
$('#set-countdown').addEventListener('change', (e) => { cfg.countdown = Number(e.target.value); save(); });
$('#set-reset').addEventListener('change', (e) => { cfg.reset = Number(e.target.value); save(); });
$('#set-mirror').addEventListener('change', (e) => { cfg.mirror = e.target.checked; save(); });
$('#set-sound').addEventListener('change', (e) => { cfg.sound = e.target.checked; save(); });
$('#set-printer').addEventListener('change', (e) => { cfg.printer = e.target.checked; save(); });
$('#set-autoprint').addEventListener('change', (e) => { cfg.autoPrint = e.target.checked; save(); });
$('#set-limit').addEventListener('change', (e) => { cfg.limit = Number(e.target.value); save(); });
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
$('#btn-redo').addEventListener('click', () => (state.camOk ? shoot([...Array(layout().shots).keys()]) : go('shoot')));
$('#btn-save').addEventListener('click', saveSession);
$('#btn-retry-upload').addEventListener('click', saveSession);
$('#btn-print').addEventListener('click', doPrint);
$('#btn-finish').addEventListener('click', finish);
$('#btn-new').addEventListener('click', newSession);
$('#cam-retry').addEventListener('click', startCamera);
document.addEventListener('pointerdown', () => { if (state.step === 'download' && cfg.reset) armAutoReset(); });

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea, dialog') || e.metaKey || e.ctrlKey || e.altKey) return;
  if ((e.key === ' ' || e.key === 'Enter') && e.target.closest('button, a')) return; // let buttons handle their own keys
  // PageDown/PageUp: what presenter clickers send, so one works as a shutter remote
  if (e.key === ' ' || e.key === 'Enter' || e.key === 'PageDown' || e.key === 'PageUp') {
    if (state.step === 'shoot' && !state.shooting && state.camOk) { e.preventDefault(); $('#btn-start').click(); }
    else if (state.step === 'done') { e.preventDefault(); newSession(); }
  } else if (e.key === 'Escape' && state.shooting) {
    cancelShoot();
  } else if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenEnabled) toggleFull();
  }
});

go('frame', { focus: false });
renderFrameGrid();
syncDesign();
loadBooth();
startCamera().then(keepAwake);
requestAnimationFrame(drawPreview);
// make sure the canvas fonts exist before the first strip is drawn
document.fonts.load('800 60px "Bricolage Grotesque"');
document.fonts.load('500 20px "DM Mono"');
