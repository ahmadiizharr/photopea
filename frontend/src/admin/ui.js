export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escape anything typed by a person before it goes into innerHTML. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const idr = new Intl.NumberFormat('id-ID');
export const rupiah = (n) => `Rp ${idr.format(n)}`;
export const priceLabel = (n) => (n ? rupiah(n) : 'Gratis');

export const pill = (on, onText = 'Aktif', offText = 'Draft') => `<span class="pill${on ? ' on' : ''}">${on ? onText : offText}</span>`;

export const ICONS = {
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/></svg>',
};

let toastTimer;
export function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

/**
 * Modal form. `body` is HTML; `submit(form)` may throw to keep the dialog open with the message.
 * Resolves with submit's return value, or null when cancelled.
 */
export function openForm({ title, body, ok = 'Simpan', wide = false, submit, onOpen }) {
  const dlg = $('#dlg');
  const form = $('#dlg-form');
  const err = $('#dlg-error');
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = body;
  $('#dlg-ok').textContent = ok;
  dlg.classList.toggle('wide', wide);
  err.hidden = true;
  onOpen?.(form);
  dlg.showModal();
  return new Promise((resolve) => {
    const onSubmit = async (e) => {
      if (e.submitter?.value === 'cancel') return;
      e.preventDefault();
      const btn = $('#dlg-ok');
      btn.disabled = true;
      try {
        const out = await submit(form);
        cleanup();
        dlg.close();
        resolve(out ?? true);
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      } finally {
        btn.disabled = false;
      }
    };
    const onClose = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
    };
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
  });
}

export const confirmBox = (title, text, ok = 'Hapus') =>
  openForm({ title, body: `<p>${esc(text)}</p>`, ok, submit: async () => true });

/** Read a form into an object; numbers for inputs marked data-num, booleans for checkboxes. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.dataset.num !== undefined) out[el.name] = Number(String(el.value).replace(/\D/g, '') || 0);
    else out[el.name] = el.value.trim();
  }
  return out;
}
