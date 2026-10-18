export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const FIELDS = {
  name: 'Nama', price: 'Harga', prints_included: 'Cetak termasuk', extra_print_price: 'Harga cetak tambahan',
  max_prints: 'Maks cetak', description: 'Deskripsi', username: 'Username', password: 'Password',
};

function detailText(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail) && detail.length) {
    const d = detail[0];
    const field = FIELDS[d.loc?.at(-1)] ?? d.loc?.at(-1);
    if (d.type === 'value_error') return d.msg.replace(/^Value error, /, '');
    return field ? `${field} tidak valid.` : 'Isian tidak valid.';
  }
  return '';
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

export async function api(method, path, body) {
  const init = { method, credentials: 'same-origin', headers: { 'X-Requested-With': 'jepret' } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Tidak ada koneksi ke server.');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== '/api/admin/login') onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, detailText(data?.detail) || `Server menjawab ${res.status}`);
  return data;
}
