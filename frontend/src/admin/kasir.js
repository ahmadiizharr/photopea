import { api } from './api.js';
import { $, confirmBox, esc, rupiah, toast } from './ui.js';

const REFRESH_MS = 3000;
const STATUS = { pending: 'Menunggu', paid: 'Lunas', used: 'Sudah foto', cancelled: 'Batal' };
const time = (iso) => new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

function ago(iso) {
  const min = Math.floor((Date.now() - new Date(iso)) / 60000);
  return min < 1 ? 'baru saja' : `${min} menit lalu`;
}

function details(o) {
  return [
    o.package_name && `Paket ${esc(o.package_name)}`,
    o.prints ? `${o.prints} cetak` : '',
    o.frame_name && `Frame ${esc(o.frame_name)}`,
    o.voucher && `Voucher ${esc(o.voucher)} (−${rupiah(o.discount)})`,
  ].filter(Boolean).join(' · ');
}

const ticket = (o) => `
  <article class="card order" data-id="${o.id}">
    <p class="mono">Kode bayar · ${ago(o.created_at)}</p>
    <p class="order-code">${esc(o.code)}</p>
    <p class="order-total">${rupiah(o.total)}</p>
    <p class="order-meta">${details(o) || 'Tanpa paket'}</p>
    <div class="order-actions">
      <button class="btn btn-pink" type="button" data-act="paid">Lunas</button>
      <button class="btn btn-ghost btn-sm" type="button" data-act="cancel">Batalkan</button>
    </div>
  </article>`;

export async function renderKasir(view) {
  view.innerHTML = `<section id="kasir">
    <div class="head">
      <div class="head-title">
        <span class="head-icon" aria-hidden="true" style="background:var(--yellow)">Rp</span>
        <div><p class="mono">Pembayaran</p><h1>Kasir</h1></div>
      </div>
      <p class="sub mono" id="kasir-sync"></p>
    </div>
    <div class="note-bar"><span>Tamu menunjukkan <b>kode bayar</b> dari layar booth. Terima pembayarannya, lalu tekan <b>Lunas</b>: booth langsung lanjut ke kamera. Kode yang tidak dibayar batal sendiri setelah 1 jam.</span></div>
    <h2 class="section-title">Menunggu pembayaran</h2>
    <div class="orders" id="pending"></div>
    <h2 class="section-title">Riwayat</h2>
    <div class="card table-wrap">
      <table>
        <thead><tr><th>Jam</th><th>Kode</th><th>Rincian</th><th class="num">Total</th><th>Status</th><th>Sesi</th><th class="num">Aksi</th></tr></thead>
        <tbody id="history"></tbody>
      </table>
    </div></section>`;

  const root = $('#pending', view);
  let orders = [];

  const draw = () => {
    const waiting = orders.filter((o) => o.status === 'pending');
    root.innerHTML = waiting.map(ticket).join('') || '<p class="empty card">Belum ada yang menunggu. Kode bayar dari booth muncul di sini.</p>';
    $('#history', view).innerHTML = orders.filter((o) => o.status !== 'pending').map((o) => `
      <tr data-id="${o.id}">
        <td>${time(o.created_at)}</td>
        <td><code class="vcode">${esc(o.code)}</code></td>
        <td class="note-cell" title="${details(o)}">${details(o) || '—'}</td>
        <td class="num">${rupiah(o.total)}</td>
        <td><span class="pill${o.status === 'cancelled' ? '' : ' on'}">${STATUS[o.status]}</span></td>
        <td>${o.session ? `<a class="textlink" href="/s/${esc(o.session)}" target="_blank" rel="noopener">${esc(o.session)}</a>` : '—'}</td>
        <td class="actions">${o.status === 'paid' ? '<button class="btn btn-ghost btn-sm" type="button" data-act="cancel">Batalkan</button>' : ''}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="empty">Belum ada transaksi.</td></tr>';
    document.title = waiting.length ? `(${waiting.length}) Kasir — jepret` : 'Dashboard — jepret';
  };

  const refresh = async () => {
    try {
      orders = await api('GET', '/api/admin/orders');
      draw();
      $('#kasir-sync', view).textContent = `Diperbarui ${time(new Date().toISOString())}`;
    } catch (x) {
      if (x.status !== 401) $('#kasir-sync', view).textContent = 'Gagal memuat, mencoba lagi…';
    }
  };
  await refresh();
  const timer = setInterval(() => {
    // stop once the dashboard moved to another page
    if (!document.body.contains(root)) { clearInterval(timer); document.title = 'Dashboard — jepret'; return; }
    refresh();
  }, REFRESH_MS);

  // on the page's own wrapper: it goes away with the page, listener included
  $('#kasir', view).addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    const row = btn?.closest('[data-id]');
    if (!row) return;
    const o = orders.find((x) => x.id === row.dataset.id);
    if (!o) return;
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'paid') {
        await api('POST', `/api/admin/orders/${o.id}/paid`);
        toast(`${o.code} lunas · booth lanjut ke kamera`);
      } else if (await confirmBox('Batalkan pesanan?', `Kode ${o.code} (${rupiah(o.total)}) dibatalkan.${o.voucher ? ' Voucher-nya bisa dipakai lagi.' : ''}`, 'Batalkan')) {
        await api('POST', `/api/admin/orders/${o.id}/cancel`);
        toast(`${o.code} dibatalkan`);
      }
      await refresh();
    } catch (x) {
      toast(x.message);
      btn.disabled = false;
    }
  });
}
