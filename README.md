# jepret — photobox di browser

Live: https://work.mangaisekai.com

Booth foto yang jalan di browser HP/laptop/kiosk. Strip tersusun di canvas, diunggah, lalu tamu scan QR
(atau ketik kode 6 huruf) untuk mengunduh strip, foto per jepretan, dan GIF. Foto terhapus otomatis
setelah 7 hari.

## Alur tamu di booth (`/booth/`)

Satu layar penuh per langkah, tombol aksi di bar bawah:

1. **Frame** — layout bawaan (gratis) atau frame upload, dikelompokkan per kategori (tab) lalu per pack
   beserta harganya.
2. **Paket** — pilih paket harga dan jumlah cetak; rincian dan total tampil. Lalu **Bayar**:
   - *Bayar di kasir*: booth menampilkan kode bayar 4 huruf; kasir menekan **Lunas** di dashboard, booth
     lanjut sendiri (cek tiap 2 detik).
   - *Kode voucher*: voucher gratis langsung lanjut; voucher potongan mengurangi total, sisanya ke kasir.
   Tanpa paket aktif dan frame gratis, langkah ini dilewati.

   Begitu lunas, tamu punya **3 menit** untuk Foto dan Cek (ubah di Pengaturan booth: 2/3/5 menit atau
   tanpa batas). Sisa waktu tampil di pojok kanan atas. Waktu habis: belum foto → foto mulai sendiri;
   sedang foto → diselesaikan; di layar Cek → langsung disimpan. Tamu tetap dapat fotonya.
3. **Foto** — kamera dengan 15 filter (thumbnail live), hitung mundur, jepret.
4. **Cek** — ulang per foto atau semua.
5. **Unduh** — QR, kode, unduh strip, cetak.
6. **Selesai** — layar terima kasih, kembali ke awal sendiri.

```
backend/   FastAPI (Python 3.12) — API, pemrosesan gambar (Pillow), QR (segno), SQLite
frontend/  Vite + vanilla JS — landing (/), booth (/booth/), hasil (/s/KODE), dashboard (/admin/)
shared/    layouts.json — geometri layout, warna, filter, ukuran cetak; dipakai backend DAN frontend
deploy/    unit systemd + config nginx yang sedang terpasang
```

## Dashboard superadmin (`/admin/`)

- **Galeri template** — pack frame (kategori, harga, Aktif/Draft). Upload PNG transparan per ukuran cetak; server
  mencari lubang foto sendiri (area alpha < 128), menomorinya, dan mencatat masalah cetak (terlalu dekat
  tepi, melewati garis potong, lubang kecil, piksel semi-transparan). Nomor foto per lubang bisa diubah
  (strip kembar / semua beda). Frame aktif di pack aktif langsung muncul di booth; kategori pack jadi tab.
  Harga pack ditambahkan ke total tamu yang memakai frame dari pack itu (di atas harga paket).
- **Paket harga** — nama, harga, cetak termasuk, harga cetak tambahan, maks cetak.
- **Kasir** — antrean kode bayar dari booth (diperbarui tiap 3 detik): **Lunas** atau **Batalkan**, plus
  riwayat dengan link ke sesi foto. Kode yang tidak dibayar batal sendiri setelah 1 jam. Belum ada
  payment gateway; order sudah siap kalau nanti QRIS ditambahkan (webhook tinggal menandai lunas).
- **Voucher** — buat satu kode sendiri atau sampai 200 kode acak sekaligus: gratis atau potongan Rp,
  maks pemakaian per kode, tanggal berlaku. Pemakaian dari order yang batal dikembalikan.
- **Panduan ukuran** — spesifikasi dan template PNG siap edit untuk desainer:

| Format | Piksel (300 dpi) | Cetak |
|---|---|---|
| 4R · 2 strip | 1200×1800 | 1 per 4×6 in, dipotong di x = 600 |
| 4R penuh | 1200×1800 | 1 per 4×6 in |
| 5R | 1500×2100 | 1 per 5×7 in |
| 5R landscape (wedding) | 2100×1500, pita tulisan 1980×290 di bawah | 1 per 7×5 in |
| Polaroid (5R ÷ 2) | 1050×1500 | 2 per 7×5 in (5R landscape) |
| 2R | 750×1050 | 1 per 2,5×3,5 in |

Akun superadmin (satu akun, password di-hash scrypt, disimpan di luar repo):

```bash
cd /srv/photobox/backend && .venv/bin/python -m app.cli set-admin   # tulis /etc/photobox/admin.env (0600)
systemctl restart photobox
```

## Data contoh (dummy)

Untuk mencoba alur pack → booth → total tanpa mendesain frame sendiri:

```bash
cd /srv/photobox/backend && .venv/bin/python -m app.cli seed-demo   # tanya password superadmin
.venv/bin/python -m app.cli seed-demo --remove                      # hapus lagi
```

Membuat lewat API admin: pack **Demo · Klasik** (gratis), **Demo · Pastel** (Rp 10.000), **Demo · Wedding**
(Rp 25.000), **Demo · Wisuda** (Rp 15.000), dan **Demo · Draft** (tidak tampil di booth), berisi 9 frame dalam
4 kategori; paket **Demo Basic** dan **Demo Premium**; voucher **DEMO-GRATIS** dan **DEMO-HEMAT10**
(potongan Rp 10.000). Hanya item bernama "Demo …"/"DEMO-…" yang diganti atau dihapus, jadi menjalankannya
lagi tidak menggandakan data. `--url` dan `--user` untuk server lain (bawaan `http://127.0.0.1:8090`, `admin`).

## Cetak dari booth

Pengaturan booth → centang **Booth punya printer**. Di layar Unduh, tombol **Cetak N lembar** menyusun
lembar seukuran kertas (strip bawaan: 2 strip per 4R) dan membuka dialog cetak. Jumlah lembar mengikuti
paket yang dibayar; tanpa paket, jumlahnya diatur di layar itu. Untuk kiosk tanpa
dialog: jadikan printer foto printer bawaan, lalu jalankan
`chrome --kiosk --kiosk-printing https://work.mangaisekai.com/booth/` dan centang **Cetak otomatis**.

## Jalankan lokal

```bash
cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
.venv/bin/uvicorn app.main:app --port 8090          # API + frontend/dist

cd frontend && npm install
npm run dev                                          # :5173, /api & /media diproksikan ke :8090
npm run build                                        # -> frontend/dist (disajikan oleh FastAPI)
```

Kamera hanya bisa dibuka lewat `https://` atau `localhost`.

## Deploy (server ini)

- Kode: `/srv/photobox` (symlink `/root/photobox`)
- Service: `photobox.service` — uvicorn di `127.0.0.1:8090`, `DynamicUser` tanpa hak root
- Data: `/var/lib/photobox` (`photobox.db` + `media/<KODE>/`)
- nginx: `/etc/nginx/conf.d/photobox.conf`, SSL Let's Encrypt (webroot `/var/www/letsencrypt`,
  diperpanjang `certbot-renew.timer`), di belakang Cloudflare (proxied)

Update setelah mengubah kode:

```bash
cd /srv/photobox/frontend && npm run build
systemctl restart photobox
```

## API (untuk aplikasi Android nanti)

Dokumentasi interaktif: `/api/docs`.

| Method | Path | Isi |
|---|---|---|
| GET | `/api/layouts` | layout, warna kertas, filter (isi `shared/layouts.json`) |
| GET | `/api/booth` | pack aktif (nama, deskripsi, kategori, harga) + frame upload yang aktif (dengan `pack_id`, `pack_price`) + paket harga aktif |
| POST | `/api/orders` | JSON `package`, `template`, `prints`, opsional `voucher` → order (`code`, `subtotal`, `discount`, `total`, `status` `pending`/`paid`) |
| GET | `/api/orders/{id}` | status order (booth menunggu `paid`) |
| POST | `/api/orders/{id}/cancel` | tamu batal sebelum bayar; pemakaian voucher dikembalikan |
| POST | `/api/sessions` | multipart: `strip` (file), `shots` (file, 1..N), `layout` + `frame` **atau** `template` (ID frame upload), `filter`, `order` (ID order lunas, sekali pakai; paket & total diambil dari sini) **atau** `package` + `prints` → sesi |
| GET | `/api/sessions/{kode}` | metadata + URL file |
| GET | `/api/sessions/{kode}/qr.svg` | QR ke `/s/{kode}` |
| GET | `/media/{kode}/{strip.jpg,anim.gif,shot-N.jpg}` | file; `?dl=1` untuk unduh |
| GET | `/api/frames/{id}/{frame.png,preview.webp}` | file frame (publik hanya kalau aktif) |
| * | `/api/admin/...` | dashboard: login, pack, frame, paket, template, kasir (`orders`), voucher (cookie + header `X-Requested-With: jepret`) |

Semua gambar di-encode ulang dari piksel (EXIF/GPS dibuang), maksimal 8 MB per file.
