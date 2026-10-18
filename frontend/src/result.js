import { getSession, formatExpiry } from './lib/api.js';
import { CODE_RE, layouts, byId } from './lib/catalog.js';

const $ = (s) => document.querySelector(s);
const main = $('#main');

function codeFromUrl() {
  const fromPath = location.pathname.match(/^\/s\/([^/]+)/)?.[1];
  const raw = fromPath || new URLSearchParams(location.search).get('k') || '';
  return decodeURIComponent(raw).trim().toUpperCase();
}

function show(state) {
  main.dataset.state = state;
}

async function run() {
  const code = codeFromUrl();
  if (!CODE_RE.test(code)) return show('missing');
  if (!location.pathname.startsWith(`/s/${code}`)) history.replaceState(null, '', `/s/${code}`);

  let s;
  try {
    s = await getSession(code);
  } catch {
    $('#code-in').value = code;
    return show('missing');
  }

  const made = new Intl.DateTimeFormat('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(s.created_at));
  const layout = byId(layouts, s.layout);
  $('#meta').textContent = `Sesi ${s.code} · ${made} · ${s.layout_name ?? layout.name}`;
  document.title = `Fotomu (${s.code}) — jepret`;

  const strip = $('#strip');
  strip.src = s.files.strip;
  strip.closest('figure').dataset.layout = s.layout;
  $('#dl-strip').href = `${s.files.strip}?dl=1`;

  if (s.files.gif) {
    $('#gif').src = s.files.gif;
    $('#dl-gif').href = `${s.files.gif}?dl=1`;
  } else {
    $('#gif-card').remove();
    $('#dl-gif').remove();
  }

  $('#expire').textContent = `Foto di halaman ini terhapus otomatis ${formatExpiry(s.expires_at)}. Unduh sebelum itu ya.`;

  const list = $('#shots');
  s.files.shots.forEach((src, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<a href="${src}?dl=1" aria-label="Unduh foto ${i + 1}"><img src="${src}" alt="Foto ${i + 1}" loading="lazy" /><span class="mono">Foto ${i + 1} ↓</span></a>`;
    list.append(li);
  });

  const share = $('#share');
  share.addEventListener('click', async () => {
    const url = s.url || location.href;
    if (navigator.share) {
      try { await navigator.share({ title: 'Fotoku di jepret', url }); } catch { /* dismissed */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      share.textContent = 'Link disalin ✓';
    } catch {
      prompt('Salin link ini:', url);
    }
  });

  show('found');
}

$('#code-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#code-in');
  const code = input.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    input.setCustomValidity('Kode 6 huruf/angka, contoh K7M2QX');
    input.reportValidity();
    return;
  }
  location.href = `/s/${code}`;
});
$('#code-in').addEventListener('input', (e) => e.target.setCustomValidity(''));

run();
