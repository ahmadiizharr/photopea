# jepret — photobox di browser

Live: https://work.mangaisekai.com

Booth foto yang jalan di browser HP/laptop: pilih layout, hitung mundur, jepret, strip tersusun di
canvas, diunggah, lalu tamu scan QR (atau ketik kode 6 huruf) untuk mengunduh strip, foto per
jepretan, dan GIF. Foto terhapus otomatis setelah 7 hari.

```
backend/   FastAPI (Python 3.12) — API, pemrosesan gambar (Pillow), QR (segno), SQLite
frontend/  Vite + vanilla JS — landing (/), booth (/booth/), hasil (/s/KODE), dashboard (/admin/)
shared/    layouts.json — geometri layout, warna, filter, ukuran cetak; dipakai backend DAN frontend
deploy/    unit systemd + config nginx yang sedang terpasang
```

## Dashboard superadmin (`/admin/`)

- **Galeri template** — pack frame (harga, Aktif/Draft). Upload PNG transparan per ukuran cetak; server
  mencari lubang foto sendiri (area alpha < 128), menomorinya, dan mencatat masalah cetak (terlalu dekat
  tepi, melewati garis potong, lubang kecil, piksel semi-transparan). Nomor foto per lubang bisa diubah
  (strip kembar / semua beda). Frame aktif di pack aktif langsung muncul di booth, dikelompokkan per pack.
  Harga pack ditambahkan ke total tamu yang memakai frame dari pack itu (di atas harga paket).
- **Paket harga** — nama, harga, cetak termasuk, harga cetak tambahan, maks cetak. Tamu memilih paket di
  booth, total dihitung otomatis, bayar ke kasir (belum ada payment gateway).
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
(Rp 25.000), dan **Demo · Draft** (tidak tampil di booth), berisi 7 frame, plus paket **Demo Basic** dan
**Demo Premium**. Hanya item bernama "Demo …" yang diganti atau dihapus, jadi menjalankannya lagi tidak
menggandakan data. `--url` dan `--user` untuk server lain (bawaan `http://127.0.0.1:8090`, `admin`).

## Cetak dari booth

Pengaturan booth → centang **Booth punya printer**. Setelah simpan, tombol **Cetak N lembar** menyusun
lembar seukuran kertas (strip bawaan: 2 strip per 4R) dan membuka dialog cetak. Untuk kiosk tanpa
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
| GET | `/api/booth` | pack aktif (nama, deskripsi, harga) + frame upload yang aktif (dengan `pack_id`, `pack_price`) + paket harga aktif |
| POST | `/api/sessions` | multipart: `strip` (file), `shots` (file, 1..N), `layout` + `frame` **atau** `template` (ID frame upload), `filter`, opsional `package` + `prints` → sesi; `total` = paket + cetak tambahan + harga pack |
| GET | `/api/sessions/{kode}` | metadata + URL file |
| GET | `/api/sessions/{kode}/qr.svg` | QR ke `/s/{kode}` |
| GET | `/media/{kode}/{strip.jpg,anim.gif,shot-N.jpg}` | file; `?dl=1` untuk unduh |
| GET | `/api/frames/{id}/{frame.png,preview.webp}` | file frame (publik hanya kalau aktif) |
| * | `/api/admin/...` | dashboard: login, pack, frame, paket, template (cookie + header `X-Requested-With: jepret`) |

Semua gambar di-encode ulang dari piksel (EXIF/GPS dibuang), maksimal 8 MB per file.
