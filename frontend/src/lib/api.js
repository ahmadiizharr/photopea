export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(path, init) {
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Tidak ada koneksi ke server.');
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body?.detail || `Server menjawab ${res.status}`);
  return body;
}

export function createSession({ strip, shots, layout, frame, filter }) {
  const fd = new FormData();
  fd.append('strip', strip, 'strip.jpg');
  shots.forEach((b, i) => fd.append('shots', b, `shot-${i + 1}.jpg`));
  fd.append('layout', layout);
  fd.append('frame', frame);
  fd.append('filter', filter);
  return call('/api/sessions', { method: 'POST', body: fd });
}

export const getSession = (code) => call(`/api/sessions/${encodeURIComponent(code)}`);

export function formatExpiry(iso) {
  return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
