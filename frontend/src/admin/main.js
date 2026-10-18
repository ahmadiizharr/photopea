import { api, setUnauthorizedHandler } from './api.js';
import { $, $$ } from './ui.js';
import { renderGallery } from './gallery.js';
import { renderPack } from './pack.js';
import { renderPackages } from './packages.js';
import { renderGuide } from './guide.js';

const view = $('#view');

function setAuth(state) {
  document.body.dataset.auth = state;
  if (state === 'out') setTimeout(() => $('#login-form [name=username]').focus(), 0);
}

setUnauthorizedHandler(() => {
  if ($('#dlg').open) $('#dlg').close();
  setAuth('out');
});

const routes = [
  [/^#\/galeri$/, 'galeri', () => renderGallery(view)],
  [/^#\/pack\/([a-z0-9]+)$/, 'galeri', (m) => renderPack(view, m[1])],
  [/^#\/paket$/, 'paket', () => renderPackages(view)],
  [/^#\/panduan$/, 'panduan', () => renderGuide(view)],
];

async function route() {
  if (document.body.dataset.auth !== 'in') return;
  const hash = location.hash || '#/galeri';
  const hit = routes.find(([re]) => re.test(hash));
  if (!hit) {
    location.replace('#/galeri');
    return;
  }
  const [re, tab, render] = hit;
  for (const a of $$('.tabs a')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  view.innerHTML = '<p class="mono">Memuat…</p>';
  try {
    await render(hash.match(re));
  } catch (e) {
    if (e.status === 401) return;
    view.innerHTML = `<p class="form-error">${e.message}</p>`;
  }
  view.focus?.();
}

addEventListener('hashchange', route);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const err = $('#login-error');
  err.hidden = true;
  const btn = form.querySelector('button');
  btn.disabled = true;
  try {
    const me = await api('POST', '/api/admin/login', { username: form.username.value, password: form.password.value });
    form.password.value = '';
    start(me.user);
  } catch (x) {
    err.textContent = x.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/admin/logout').catch(() => {});
  setAuth('out');
});

function start(user) {
  $('#who').textContent = user;
  setAuth('in');
  route();
}

api('GET', '/api/admin/me').then((me) => start(me.user)).catch(() => setAuth('out'));
