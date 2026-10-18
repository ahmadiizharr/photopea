import { api } from './api.js';
import { $, ICONS, confirmBox, esc, formData, openForm, rupiah, toast } from './ui.js';

const kindLabel = (v) => (v.kind === 'gratis' ? 'Gratis' : `Potongan ${rupiah(v.value)}`);
const dateLabel = (iso) => (iso ? new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${iso}T00:00:00`)) : 'Tanpa batas');
const today = () => new Date().toISOString().slice(0, 10);

function state(v) {
  if (!v.active) return ['Nonaktif', ''];
  if (v.expires_at && v.expires_at < today()) return ['Kedaluwarsa', ''];
  if (v.used >= v.max_uses) return ['Habis', ''];
  return ['Aktif', ' on'];
}

const fields = `
  <div class="grid2">
    <label class="row"><span>Jenis</span>
      <select class="field" name="kind">
        <option value="gratis">Gratis (lunas penuh)</option>
        <option value="potongan">Potongan harga</option>
      </select>
    </label>
    <label class="row" data-for="potongan"><span>Besar potongan</span><input class="field" name="value" data-num inputmode="numeric" placeholder="10000" /></label>
    <label class="row"><span>Jumlah kode</span><input class="field" name="count" data-num inputmode="numeric" value="1" /></label>
    <label class="row"><span>Maks pemakaian <small>(per kode)</small></span><input class="field" name="max_uses" data-num inputmode="numeric" value="1" /></label>
    <label class="row"><span>Berlaku sampai <small>(opsional)</small></span><input class="field" name="expires_at" type="date" /></label>
    <label class="row" data-for="single"><span>Kode sendiri <small>(opsional, 1 kode)</small></span><input class="field" name="code" maxlength="24" placeholder="WISUDA-UNY" autocomplete="off" /></label>
  </div>
  <label class="row"><span>Catatan <small>(opsional)</small></span><input class="field" name="note" maxlength="80" placeholder="Acara wisuda 20 Okt" /></label>`;

function newVouchers() {
  return openForm({
    title: 'Buat voucher',
    body: fields,
    ok: 'Buat',
    onOpen: (form) => {
      const sync = () => {
        form.querySelector('[data-for="potongan"]').hidden = form.elements.kind.value !== 'potongan';
        form.querySelector('[data-for="single"]').hidden = Number(form.elements.count.value || 1) > 1;
      };
      form.elements.kind.addEventListener('change', sync);
      form.elements.count.addEventListener('input', sync);
      sync();
    },
    submit: (form) => {
      const d = formData(form);
      const body = {
        kind: d.kind, value: d.value, count: Math.max(1, d.count), max_uses: Math.max(1, d.max_uses),
        expires_at: d.expires_at || null, note: d.note, code: d.count > 1 ? null : d.code || null,
      };
      if (body.count > 200) throw new Error('Maksimal 200 kode sekali buat.');
      return api('POST', '/api/admin/vouchers', body);
    },
  });
}

/** Freshly generated codes in one box, ready to copy or print for the kasir. */
function showCodes(list) {
  const text = list.map((v) => v.code).join('\n');
  return openForm({
    title: `${list.length} voucher dibuat`,
    body: `<p>${esc(kindLabel(list[0]))} · maks ${list[0].max_uses}× per kode · ${esc(dateLabel(list[0].expires_at))}</p>
      <textarea class="field codes" readonly rows="${Math.min(12, list.length + 1)}">${esc(text)}</textarea>`,
    ok: 'Salin semua kode',
    submit: async () => {
      await navigator.clipboard?.writeText(text);
      toast('Kode disalin');
    },
  });
}

export async function renderVouchers(view) {
  const list = await api('GET', '/api/admin/vouchers');
  const live = list.filter((v) => state(v)[0] === 'Aktif').length;
  const used = list.reduce((n, v) => n + v.used, 0);
  view.innerHTML = `
    <div class="head">
      <div class="head-title">
        <span class="head-icon" aria-hidden="true">✦</span>
        <div><p class="mono">Pembayaran</p><h1>Voucher</h1></div>
      </div>
      <button class="btn btn-pink" type="button" id="add">+ Buat voucher</button>
    </div>
    <div class="note-bar"><span>Tamu memasukkan kode di layar <b>Bayar</b> booth. Voucher <b>Gratis</b> melunasi seluruh tagihan; <b>Potongan</b> mengurangi total, sisanya dibayar di kasir. Kode dari pesanan yang batal bisa dipakai lagi.</span></div>
    <div class="stats">
      <div class="stat pink"><p class="mono">Total kode</p><b>${list.length}</b></div>
      <div class="stat mint"><p class="mono">Masih berlaku</p><b>${live}</b></div>
      <div class="stat"><p class="mono">Sudah dipakai</p><b>${used}×</b></div>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Kode</th><th>Jenis</th><th class="num">Dipakai</th><th>Berlaku sampai</th><th>Catatan</th><th>Status</th><th class="num">Aksi</th></tr></thead>
        <tbody>
          ${list.map((v) => {
            const [label, on] = state(v);
            return `
            <tr data-code="${esc(v.code)}">
              <td><code class="vcode">${esc(v.code)}</code></td>
              <td>${esc(kindLabel(v))}</td>
              <td class="num">${v.used} / ${v.max_uses}</td>
              <td>${esc(dateLabel(v.expires_at))}</td>
              <td class="note-cell" title="${esc(v.note)}">${esc(v.note) || '—'}</td>
              <td><button class="pill${on}" type="button" data-act="toggle" title="${v.active ? 'Nonaktifkan' : 'Aktifkan'}">${label}</button></td>
              <td class="actions"><button class="icon-btn danger" type="button" data-act="delete" aria-label="Hapus ${esc(v.code)}">${ICONS.trash}</button></td>
            </tr>`;
          }).join('') || '<tr><td colspan="7" class="empty">Belum ada voucher.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  const reload = () => renderVouchers(view);
  $('#add', view).addEventListener('click', async () => {
    const made = await newVouchers();
    if (!made) return;
    if (made.length > 1) await showCodes(made);
    else toast(`Voucher ${made[0].code} dibuat`);
    reload();
  });
  $('tbody', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const v = list.find((x) => x.code === btn.closest('tr').dataset.code);
    try {
      if (btn.dataset.act === 'toggle') {
        await api('PATCH', `/api/admin/vouchers/${encodeURIComponent(v.code)}`, { active: !v.active });
        reload();
      } else if (await confirmBox('Hapus voucher?', `Kode ${v.code} tidak bisa dipakai lagi.`)) {
        await api('DELETE', `/api/admin/vouchers/${encodeURIComponent(v.code)}`);
        toast('Voucher dihapus');
        reload();
      }
    } catch (x) { toast(x.message); }
  });
}
