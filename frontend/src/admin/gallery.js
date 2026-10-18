import { api } from './api.js';
import { $, $$, esc, formData, openForm, pill, priceLabel } from './ui.js';

let filter = 'semua';
/** Suggestions for the category field; guests see categories as tabs in the booth. */
const CATEGORIES = ['Klasik', 'Wedding', 'Wisuda', 'Ulang tahun', 'Lucu', 'Corporate', 'Lebaran', 'Natal'];

export function packMeta(p) {
  if (!p.frames.length) return 'Belum ada frame';
  const n = p.frames.map((f) => f.n_photos);
  const lo = Math.min(...n);
  const hi = Math.max(...n);
  return `${p.frames.length} frame · ${lo === hi ? lo : `${lo}–${hi}`} foto`;
}

export const packFields = (p = {}) => `
  <label class="row"><span>Nama pack</span><input class="field" name="name" maxlength="40" required value="${esc(p.name)}" placeholder="Pack Pastel" /></label>
  <label class="row"><span>Deskripsi <small>(opsional)</small></span><input class="field" name="description" maxlength="160" value="${esc(p.description)}" placeholder="Frame pastel lucu buat wisuda" /></label>
  <label class="row"><span>Kategori <small>(jadi tab di booth; kosong = Lainnya)</small></span><input class="field" name="category" maxlength="30" list="pack-categories" value="${esc(p.category)}" placeholder="Wedding" autocomplete="off" /></label>
  <datalist id="pack-categories">${CATEGORIES.map((c) => `<option value="${c}"></option>`).join('')}</datalist>
  <div class="grid2">
    <label class="row"><span>Harga <small>(0 = gratis · ditambahkan ke total tamu)</small></span><input class="field" name="price" data-num inputmode="numeric" value="${p.price ?? 0}" /></label>
    <label class="row"><span>Status</span>
      <select class="field" name="status">
        <option value="draft"${p.status !== 'aktif' ? ' selected' : ''}>Draft</option>
        <option value="aktif"${p.status === 'aktif' ? ' selected' : ''}>Aktif</option>
      </select>
    </label>
  </div>`;

function card(p) {
  const shots = p.frames.slice(0, 4).map((f) => `<img src="${f.preview}" alt="" loading="lazy" />`);
  while (shots.length < 4) shots.push('<span class="ph">kosong</span>');
  return `
    <article class="card pack">
      <div class="pack-shots">${shots.join('')}</div>
      <div class="pack-body">
        <div class="pack-top"><h3>${esc(p.name)}</h3><span class="price${p.price ? '' : ' free'}">${priceLabel(p.price)}</span></div>
        <p class="pack-meta">${p.category ? `${esc(p.category)} · ` : ''}${packMeta(p)}</p>
        <div>${pill(p.status === 'aktif')}</div>
        <a class="btn btn-pink btn-sm" href="#/pack/${p.id}">Kelola pack <span class="arr" aria-hidden="true">→</span></a>
      </div>
    </article>`;
}

export async function newPack() {
  const pack = await openForm({
    title: 'Pack baru',
    body: packFields(),
    ok: 'Buat pack',
    submit: (form) => api('POST', '/api/admin/packs', formData(form)),
  });
  if (pack) location.hash = `#/pack/${pack.id}`;
}

export async function renderGallery(view) {
  const packs = await api('GET', '/api/admin/packs');
  const groups = {
    semua: ['Semua koleksi', () => true],
    gratis: ['Gratis', (p) => !p.price],
    berbayar: ['Berbayar', (p) => p.price > 0],
    draft: ['Draft', (p) => p.status !== 'aktif'],
  };
  const draw = () => {
    const shown = packs.filter(groups[filter][1]);
    view.innerHTML = `
      <div class="head">
        <div class="head-title">
          <span class="head-icon" aria-hidden="true">▦</span>
          <div><p class="mono">Katalog</p><h1>Galeri template</h1></div>
        </div>
        <button class="btn btn-pink" type="button" id="new-pack">+ Pack baru</button>
      </div>
      <div class="note-bar"><span>Frame di pack <b>Aktif</b> langsung muncul di booth, dikelompokkan per pack. Harga pack ditambahkan ke total tamu yang memakai frame-nya. Upload PNG transparan, sistem mencari lubang fotonya sendiri.</span></div>
      <div class="filters" role="group" aria-label="Saring pack">
        ${Object.entries(groups).map(([k, [label, fn]]) => `
          <button class="chip" type="button" data-f="${k}" aria-pressed="${k === filter}">${label} <span>${packs.filter(fn).length}</span></button>`).join('')}
      </div>
      <div class="packs">
        ${shown.map(card).join('')}
        ${filter === 'semua' ? '<button class="pack-add" type="button" id="new-pack-2"><b>+</b>Pack baru</button>' : ''}
      </div>
      ${shown.length || filter === 'semua' ? '' : '<p class="empty">Belum ada pack di sini.</p>'}`;
    $$('[data-f]', view).forEach((b) => b.addEventListener('click', () => { filter = b.dataset.f; draw(); }));
    $('#new-pack', view).addEventListener('click', newPack);
    $('#new-pack-2', view)?.addEventListener('click', newPack);
  };
  draw();
}
