import { formats } from '../lib/catalog.js';
import { api } from './api.js';
import { packFields, packMeta } from './gallery.js';
import { $, $$, ICONS, confirmBox, esc, formData, openForm, priceLabel, toast } from './ui.js';

const PHOTO_COLORS = ['#ff7eb3', '#3aa0ff', '#22c07a', '#8a5cff', '#ffb020', '#ff6a3d', '#14b8c4', '#c45cff'];
const fmtById = Object.fromEntries(formats.map((f) => [f.id, f]));
let lastFormat = '4r-strip';

const specLine = (f) =>
  `<b>${f.w}×${f.h} px</b> (${f.inch[0]}×${f.inch[1]} in, 300 dpi). ${esc(f.note)} <a class="textlink" href="#/panduan">Template &amp; panduan →</a>`;

function frameCard(f) {
  const warns = f.issues.filter((i) => i.level !== 'info').length;
  return `
    <article class="card frame-card" data-id="${f.id}">
      <img src="${f.preview}" alt="Pratinjau ${esc(f.name)}" loading="lazy" />
      <h3 title="${esc(f.name)}">${esc(f.name)}</h3>
      <p class="pack-meta">${esc(fmtById[f.format]?.name ?? f.format)} · ${f.slots.length} lubang · ${f.n_photos} foto</p>
      ${warns ? `<span class="warn-count">${warns} catatan cetak</span>` : ''}
      <div class="row-actions">
        <button class="pill${f.status === 'aktif' ? ' on' : ''}" type="button" data-act="toggle" title="Ganti status">${f.status === 'aktif' ? 'Aktif' : 'Draft'}</button>
        <span>
          <button class="icon-btn" type="button" data-act="edit" aria-label="Atur ${esc(f.name)}" title="Atur lubang & nomor foto">${ICONS.edit}</button>
          <button class="icon-btn danger" type="button" data-act="delete" aria-label="Hapus ${esc(f.name)}" title="Hapus">${ICONS.trash}</button>
        </span>
      </div>
    </article>`;
}

/** Slot editor: colour blocks + the real frame on top, a number picker on every hole. */
export async function editFrame(f, { fresh = false } = {}) {
  const fmt = fmtById[f.format];
  let photos = f.slots.map((s) => s.photo);
  const maxN = Math.min(8, f.slots.length);
  const issues = f.issues.map((i) => `<li class="${i.level}">${esc(i.text)}</li>`).join('');
  const body = `
    <div class="editor">
      <div class="stage" id="stage" style="--ar:${f.w} / ${f.h}">
        ${f.slots.map((s, i) => `<div class="blk" data-i="${i}" style="position:absolute;left:${(s.x / f.w) * 100}%;top:${(s.y / f.h) * 100}%;width:${(s.w / f.w) * 100}%;height:${(s.h / f.h) * 100}%"></div>`).join('')}
        <img src="${f.url}" alt="" />
        ${f.slots.map((s, i) => `
          <label class="slot-tag" style="left:${(s.x / f.w) * 100}%;top:${(s.y / f.h) * 100}%;width:${(s.w / f.w) * 100}%;height:${(s.h / f.h) * 100}%">
            <select data-i="${i}" aria-label="Lubang ${i + 1} diisi foto nomor">
              ${Array.from({ length: maxN }, (_, n) => `<option value="${n + 1}">Foto ${n + 1}</option>`).join('')}
            </select>
          </label>`).join('')}
      </div>
      <div style="display:grid;gap:14px">
        <label class="row"><span>Nama frame</span><input class="field" name="name" maxlength="60" required value="${esc(f.name)}" /></label>
        <div class="row"><span>Nomor foto per lubang</span>
          <div class="quick">
            ${fmt?.cut_x ? '<button class="chip" type="button" data-q="twin">Strip kembar</button>' : ''}
            <button class="chip" type="button" data-q="seq">Semua beda</button>
          </div>
          <small>Lubang dengan nomor sama diisi foto yang sama. Tamu difoto sebanyak nomor terbesar.</small>
        </div>
        <p class="spec" id="n-photos"></p>
        <label class="row check"><input type="checkbox" name="active" ${f.status === 'aktif' ? 'checked' : ''} /> <span>Aktif di booth</span></label>
        <ul class="issues">${issues}</ul>
      </div>
    </div>`;

  const paint = (form) => {
    const stage = $('#stage', form);
    photos.forEach((n, i) => {
      $(`.blk[data-i="${i}"]`, stage).style.background = PHOTO_COLORS[(n - 1) % PHOTO_COLORS.length];
      $(`select[data-i="${i}"]`, stage).value = String(n);
    });
    const k = Math.max(...photos);
    $('#n-photos', form).innerHTML = `Tamu difoto <b>${k}×</b> per sesi.`;
  };

  return openForm({
    title: fresh ? 'Frame terunggah — cek dulu' : 'Atur frame',
    body,
    wide: true,
    onOpen: (form) => {
      paint(form);
      $$('select[data-i]', form).forEach((sel) => sel.addEventListener('change', () => {
        photos[Number(sel.dataset.i)] = Number(sel.value);
        paint(form);
      }));
      $$('[data-q]', form).forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.q === 'seq') photos = f.slots.map((_, i) => i + 1);
        else {
          // twin strips: left half numbered 1..n, right half repeats it
          const cut = fmt.cut_x;
          let l = 0;
          let r = 0;
          photos = f.slots.map((s) => (s.x + s.w / 2 < cut ? ++l : ++r));
        }
        paint(form);
      }));
    },
    submit: async (form) => {
      const used = new Set(photos);
      const k = Math.max(...photos);
      if (used.size !== k) throw new Error(`Nomor foto harus berurutan tanpa loncat (1 sampai ${k}).`);
      const d = formData(form);
      return api('PATCH', `/api/admin/frames/${f.id}`, { name: d.name, photos, status: d.active ? 'aktif' : 'draft' });
    },
  });
}

export async function renderPack(view, id) {
  const p = (await api('GET', '/api/admin/packs')).find((x) => x.id === id);
  if (!p) {
    view.innerHTML = '<a class="back" href="#/galeri">← Galeri</a><p class="form-error">Pack tidak ditemukan.</p>';
    return;
  }
  view.innerHTML = `
    <a class="back" href="#/galeri">← Galeri template</a>
    <div class="head">
      <div class="head-title">
        <span class="head-icon" aria-hidden="true" style="background:var(--pink-soft)">◫</span>
        <div><p class="mono">Pack</p><h1>${esc(p.name)}</h1><p class="sub">${packMeta(p)} · ${priceLabel(p.price)} · ${p.status === 'aktif' ? 'tampil di booth' : 'draft'}</p></div>
      </div>
    </div>
    <div class="split">
      <form class="card panel" id="pack-form">
        <h2>Info pack</h2>
        ${packFields(p)}
        <div class="panel-actions">
          <button class="btn btn-ink btn-sm" type="submit">Simpan</button>
          <button class="danger-link" type="button" id="del-pack">Hapus pack</button>
        </div>
      </form>
      <div>
        <form class="card upload" id="up-form">
          <h2>Upload frame</h2>
          <div class="upload-grid">
            <label class="row"><span>Ukuran cetak</span>
              <select class="field" name="format">${formats.map((f) => `<option value="${f.id}"${f.id === lastFormat ? ' selected' : ''}>${esc(f.name)} · ${f.w}×${f.h}</option>`).join('')}</select>
            </label>
            <label class="row"><span>Nama frame</span><input class="field" name="name" maxlength="60" placeholder="Pink Riso" /></label>
          </div>
          <p class="spec" id="spec"></p>
          <label class="drop" id="drop">
            <input type="file" name="file" accept="image/png" hidden />
            <b id="drop-title">Pilih atau seret PNG ke sini</b>
            <small id="drop-sub">Lubang foto transparan · maks 20 MB</small>
          </label>
          <button class="btn btn-pink" type="submit" id="up-btn" disabled>Upload &amp; cek frame</button>
        </form>
        <div class="frames" id="frames">${p.frames.map(frameCard).join('') || '<p class="empty">Belum ada frame. Upload PNG pertama di atas.</p>'}</div>
      </div>
    </div>`;

  const reload = () => renderPack(view, id);

  // ---- pack info ----
  $('#pack-form', view).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('PATCH', `/api/admin/packs/${id}`, formData(e.currentTarget));
      toast('Pack disimpan');
      reload();
    } catch (x) { toast(x.message); }
  });
  $('#del-pack', view).addEventListener('click', async () => {
    const ok = await confirmBox('Hapus pack?', `"${p.name}" dan ${p.frames.length} frame di dalamnya akan dihapus permanen.`);
    if (!ok) return;
    await api('DELETE', `/api/admin/packs/${id}`);
    toast('Pack dihapus');
    location.hash = '#/galeri';
  });

  // ---- upload ----
  const up = $('#up-form', view);
  const fileIn = up.elements.file;
  const drop = $('#drop', view);
  const showSpec = () => { $('#spec', view).innerHTML = specLine(fmtById[up.elements.format.value]); };
  showSpec();
  up.elements.format.addEventListener('change', () => { lastFormat = up.elements.format.value; showSpec(); });
  const pick = (file) => {
    if (!file) return;
    const dt = new DataTransfer();
    dt.items.add(file);
    fileIn.files = dt.files;
    $('#drop-title', view).textContent = file.name;
    $('#drop-sub', view).textContent = `${(file.size / 2 ** 20).toFixed(1)} MB`;
    if (!up.elements.name.value) up.elements.name.value = file.name.replace(/\.png$/i, '').replace(/[-_]+/g, ' ').slice(0, 60);
    $('#up-btn', view).disabled = false;
  };
  fileIn.addEventListener('change', () => pick(fileIn.files[0]));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files[0]); });

  up.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#up-btn', view);
    btn.disabled = true;
    btn.textContent = 'Mengecek frame…';
    const fd = new FormData();
    fd.append('file', fileIn.files[0]);
    fd.append('pack_id', id);
    fd.append('format', up.elements.format.value);
    fd.append('name', up.elements.name.value.trim() || 'Frame tanpa nama');
    try {
      const f = await api('POST', '/api/admin/frames', fd);
      await editFrame(f, { fresh: true });
      reload();
    } catch (x) {
      btn.disabled = false;
      btn.textContent = 'Upload & cek frame';
      $('#drop-sub', view).textContent = x.message;
      toast('Frame belum bisa dipakai');
    }
  });

  // ---- frame cards ----
  $('#frames', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const f = p.frames.find((x) => x.id === btn.closest('[data-id]').dataset.id);
    try {
      if (btn.dataset.act === 'edit') {
        if (await editFrame(f)) reload();
      } else if (btn.dataset.act === 'toggle') {
        await api('PATCH', `/api/admin/frames/${f.id}`, { status: f.status === 'aktif' ? 'draft' : 'aktif' });
        reload();
      } else if (btn.dataset.act === 'delete') {
        if (!(await confirmBox('Hapus frame?', `"${f.name}" akan dihapus permanen dari pack ini.`))) return;
        await api('DELETE', `/api/admin/frames/${f.id}`);
        toast('Frame dihapus');
        reload();
      }
    } catch (x) { toast(x.message); }
  });
}

