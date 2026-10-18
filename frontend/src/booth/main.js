import { layouts, frames, filters, byId, stamp } from '../lib/catalog.js';
import { createSession, formatExpiry } from '../lib/api.js';
import { applyFilter } from './filters.js';
import { compose, toBlob } from './compose.js';
import { openCamera, closeCamera, listCameras, describe, grab } from './camera.js';
import * as sound from './sound.js';

const $ = (s) => document.querySelector(s);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SHOT_LONG = 1600; // px, long side of each saved photo
const PREVIEW_LONG = 640; // px, live preview is filtered per frame so keep it modest

// ---------------- persisted settings ----------------
const KEY = 'jepret.booth';
const defaults = { layout: 'strip4', frame: 'pink', filter: 'normal', caption: '', countdown: 3, reset: 0, mirror: true, sound: true, camera: '' };
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
};
const layout = () => byId(layouts, cfg.layout);
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
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(it.id === current));
    b.dataset.id = it.id;
    render(b, it);
    b.addEventListener('click', () => {
      onPick(it.id);
      for (const x of container.children) x.setAttribute('aria-checked', String(x.dataset.id === it.id));
    });
    container.append(b);
  }
  // arrow keys move within the group like native radios
  container.onkeydown = (e) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    const list = [...container.children];
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

function renderLayoutOpts() {
  radio($('#opt-layout'), layouts, cfg.layout,
    (b, l) => {
      b.className = 'layout-opt';
      b.innerHTML = `${layoutThumb(l, frame())}<span><b>${l.name}</b><small>${l.shots} foto</small></span>`;
    },
    (id) => { cfg.layout = id; save(); });
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
const renderMini = () => compose(mini, layout(), frame(), state.shots, { caption: cfg.caption, date: stamp(), scale: miniScale() });

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

function review() {
  setStep('review');
  compose(finalCanvas, layout(), frame(), state.shots, { caption: cfg.caption, date: stamp() });
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
    const s = await createSession({ strip: state.stripBlob, shots, layout: cfg.layout, frame: cfg.frame, filter: cfg.filter });
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
  dlg.showModal();
});
$('#set-countdown').addEventListener('change', (e) => { cfg.countdown = Number(e.target.value); save(); });
$('#set-reset').addEventListener('change', (e) => { cfg.reset = Number(e.target.value); save(); });
$('#set-mirror').addEventListener('change', (e) => { cfg.mirror = e.target.checked; save(); });
$('#set-sound').addEventListener('change', (e) => { cfg.sound = e.target.checked; save(); });
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
startCamera().then(keepAwake);
requestAnimationFrame(drawPreview);
// make sure the canvas fonts exist before the first strip is drawn
document.fonts.load('800 60px "Bricolage Grotesque"');
document.fonts.load('500 20px "DM Mono"');
