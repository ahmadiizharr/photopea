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

export function createSession({ strip, shots, layout, frame, filter, template, pkg, prints, order }) {
  const fd = new FormData();
  fd.append('strip', strip, 'strip.jpg');
  shots.forEach((b, i) => fd.append('shots', b, `shot-${i + 1}.jpg`));
  if (template) fd.append('template', template);
  else {
    fd.append('layout', layout);
    fd.append('frame', frame);
  }
  fd.append('filter', filter);
  if (pkg != null) fd.append('package', String(pkg));
  if (prints != null) fd.append('prints', String(prints));
  if (order) fd.append('order', order);
  return call('/api/sessions', { method: 'POST', body: fd });
}

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Freeze the guest's choice into an order; paid at once when a voucher (or nothing) covers it. */
export const createOrder = (body) => call('/api/orders', json(body));
export const getOrder = (id) => call(`/api/orders/${encodeURIComponent(id)}`, { cache: 'no-store' });
export const cancelOrder = (id) => call(`/api/orders/${encodeURIComponent(id)}/cancel`, { method: 'POST' });

/** Frames and price packages the dashboard has switched on. */
export const getBooth = () => call('/api/booth');

export const getSession = (code) => call(`/api/sessions/${encodeURIComponent(code)}`);

export function formatExpiry(iso) {
  return new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
