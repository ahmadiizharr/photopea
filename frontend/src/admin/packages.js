import { api } from './api.js';
import { $, ICONS, confirmBox, esc, formData, openForm, pill, rupiah, toast } from './ui.js';

const fields = (p = {}) => `
  <label class="row"><span>Nama paket</span><input class="field" name="name" maxlength="40" required value="${esc(p.name)}" placeholder="Fast Snap" /></label>
  <div class="grid2">
    <label class="row"><span>Harga</span><input class="field" name="price" data-num inputmode="numeric" required value="${p.price ?? ''}" placeholder="35000" /></label>
    <label class="row"><span>Cetak termasuk <small>(lembar)</small></span><input class="field" name="prints_included" data-num inputmode="numeric" required value="${p.prints_included ?? 1}" /></label>
    <label class="row"><span>Harga cetak tambahan <small>(per lembar)</small></span><input class="field" name="extra_print_price" data-num inputmode="numeric" value="${p.extra_print_price ?? 0}" placeholder="20000" /></label>
    <label class="row"><span>Maks cetak <small>(per sesi)</small></span><input class="field" name="max_prints" data-num inputmode="numeric" required value="${p.max_prints ?? 5}" /></label>
  </div>
  <label class="row check"><input type="checkbox" name="active" ${p.active === false ? '' : 'checked'} /> <span>Aktif — tampil di booth</span></label>`;

function editPackage(p) {
  return openForm({
    title: p ? 'Ubah paket' : 'Tambah paket',
    body: fields(p),
    submit: (form) => {
      const d = formData(form);
      if (d.max_prints < d.prints_included) throw new Error('Maks cetak tidak boleh lebih kecil dari cetak termasuk.');
      return p ? api('PATCH', `/api/admin/packages/${p.id}`, d) : api('POST', '/api/admin/packages', d);
    },
  });
}

export async function renderPackages(view) {
  const list = await api('GET', '/api/admin/packages');
  const active = list.filter((p) => p.active).length;
  view.innerHTML = `
    <div class="head">
      <div class="head-title">
        <span class="head-icon" aria-hidden="true">▣</span>
        <div><p class="mono">Katalog</p><h1>Paket</h1></div>
      </div>
    </div>
    <div class="note-bar"><span>Paket foto yang tampil di booth. Tamu memilih paket sebelum foto dan membayar ke kasir; cetak tambahan dihitung otomatis.</span></div>
    <div class="stats">
      <div class="stat pink"><p class="mono">Total paket</p><b>${list.length}</b></div>
      <div class="stat mint"><p class="mono">Aktif</p><b>${active}</b></div>
      <div class="stat"><p class="mono">Nonaktif</p><b>${list.length - active}</b></div>
    </div>
    <div class="head" style="margin-bottom:16px">
      <div><h1 style="font-size:28px">Daftar paket</h1><p class="sub">${list.length} paket.</p></div>
      <button class="btn btn-pink btn-sm" type="button" id="add">+ Tambah paket</button>
    </div>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Nama</th><th class="num">Harga</th><th class="num">Inkl. print</th><th class="num">Print+</th><th class="num">Maks</th><th>Status</th><th class="num">Aksi</th></tr></thead>
        <tbody>
          ${list.map((p) => `
            <tr data-id="${p.id}">
              <td><b>${esc(p.name)}</b></td>
              <td class="num">${rupiah(p.price)}</td>
              <td class="num">${p.prints_included}</td>
              <td class="num">${p.extra_print_price ? rupiah(p.extra_print_price) : '—'}</td>
              <td class="num">${p.max_prints}</td>
              <td>${pill(p.active, 'Aktif', 'Nonaktif')}</td>
              <td class="actions">
                <button class="icon-btn" type="button" data-act="edit" aria-label="Ubah ${esc(p.name)}">${ICONS.edit}</button>
                <button class="icon-btn danger" type="button" data-act="delete" aria-label="Hapus ${esc(p.name)}">${ICONS.trash}</button>
              </td>
            </tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada paket. Tanpa paket, booth langsung mulai tanpa pilihan harga.</td></tr>'}
        </tbody>
      </table>
    </div>`;

  const reload = () => renderPackages(view);
  $('#add', view).addEventListener('click', async () => {
    if (await editPackage()) { toast('Paket ditambahkan'); reload(); }
  });
  $('tbody', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const p = list.find((x) => String(x.id) === btn.closest('tr').dataset.id);
    try {
      if (btn.dataset.act === 'edit') {
        if (await editPackage(p)) { toast('Paket disimpan'); reload(); }
      } else if (await confirmBox('Hapus paket?', `"${p.name}" tidak akan tampil lagi di booth.`)) {
        await api('DELETE', `/api/admin/packages/${p.id}`);
        toast('Paket dihapus');
        reload();
      }
    } catch (x) { toast(x.message); }
  });
}
