export class CameraError extends Error {
  constructor(kind, cause) {
    super(kind);
    this.kind = kind;
    this.cause = cause;
  }
}

export async function openCamera(video, deviceId) {
  if (!window.isSecureContext) throw new CameraError('insecure');
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported');
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  const video_ = deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: 'user', ...size };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: video_ });
  } catch (e) {
    throw new CameraError(e.name || 'unknown', e);
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  if (!video.videoWidth) await new Promise((r) => video.addEventListener('loadedmetadata', r, { once: true }));
  return stream;
}

export function closeCamera(video) {
  const s = video.srcObject;
  if (s) for (const t of s.getTracks()) t.stop();
  video.srcObject = null;
}

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'videoinput');
}

export function describe(err) {
  const inApp = /Instagram|FBAN|FBAV|TikTok|Line\//i.test(navigator.userAgent);
  switch (err?.kind) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        title: 'Izin kamera ditolak',
        text: inApp
          ? 'Browser di dalam aplikasi ini sering memblokir kamera. Buka link ini di Chrome atau Safari.'
          : 'Ketuk ikon gembok/kamera di bilah alamat, izinkan kamera, lalu tekan Coba lagi.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return { title: 'Kamera tidak ditemukan', text: 'Sambungkan webcam atau pilih kamera lain di Pengaturan.' };
    case 'NotReadableError':
    case 'AbortError':
      return { title: 'Kamera sedang dipakai', text: 'Tutup aplikasi lain yang memakai kamera (Zoom, Meet, kamera bawaan), lalu coba lagi.' };
    case 'insecure':
      return { title: 'Butuh koneksi aman', text: 'Kamera hanya bisa dibuka lewat https://. Buka booth dari alamat https.' };
    case 'unsupported':
      return { title: 'Browser tidak mendukung kamera', text: 'Coba buka di Chrome, Safari, atau Firefox versi terbaru.' };
    default:
      return { title: 'Kamera tidak bisa dibuka', text: 'Coba muat ulang halaman. Kalau tetap gagal, pakai foto dari galeri.' };
  }
}

/** Largest centred crop of (sw × sh) with the given aspect (w / h). */
export function coverCrop(sw, sh, aspect) {
  if (sw / sh > aspect) {
    const w = sh * aspect;
    return { sx: (sw - w) / 2, sy: 0, sw: w, sh };
  }
  const h = sw / aspect;
  return { sx: 0, sy: (sh - h) / 2, sw, sh: h };
}

/**
 * Draw `source` (video / image / bitmap) cropped to `aspect` into a new canvas
 * whose long side is at most `maxLong`.
 */
export function grab(source, srcW, srcH, aspect, maxLong, mirror) {
  const c = coverCrop(srcW, srcH, aspect);
  const scale = Math.min(1, maxLong / Math.max(c.sw, c.sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(c.sw * scale);
  canvas.height = Math.round(c.sh * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (mirror) {
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(source, c.sx, c.sy, c.sw, c.sh, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}
