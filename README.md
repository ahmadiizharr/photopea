# jepret — photobox di browser

Live: https://work.mangaisekai.com

Booth foto yang jalan di browser HP/laptop: pilih layout, hitung mundur, jepret, strip tersusun di
canvas, diunggah, lalu tamu scan QR (atau ketik kode 6 huruf) untuk mengunduh strip, foto per
jepretan, dan GIF. Foto terhapus otomatis setelah 7 hari.

```
backend/   FastAPI (Python 3.12) — API, pemrosesan gambar (Pillow), QR (segno), SQLite
frontend/  Vite + vanilla JS — landing (/), booth (/booth/), hasil (/s/KODE)
shared/    layouts.json — geometri layout, warna, filter; dipakai backend DAN frontend
deploy/    unit systemd + config nginx yang sedang terpasang
```

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
| POST | `/api/sessions` | multipart: `strip` (file), `shots` (file, 1..N), `layout`, `frame`, `filter` → sesi |
| GET | `/api/sessions/{kode}` | metadata + URL file |
| GET | `/api/sessions/{kode}/qr.svg` | QR ke `/s/{kode}` |
| GET | `/media/{kode}/{strip.jpg,anim.gif,shot-N.jpg}` | file; `?dl=1` untuk unduh |

Semua gambar di-encode ulang dari piksel (EXIF/GPS dibuang), maksimal 8 MB per file.
