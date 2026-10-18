// Print the finished strip at real paper size. The page rule comes from shared/layouts.json:
// `page` is [w, h] in inches, `per_page` copies sit side by side (two 2×6 strips on one 4R).

const DPI = 300;

function sheet(canvas, { page: [pw, ph], per_page: per }) {
  const out = document.createElement('canvas');
  out.width = Math.round(pw * DPI);
  out.height = Math.round(ph * DPI);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  const cellW = out.width / per;
  const scale = Math.min(cellW / canvas.width, out.height / canvas.height);
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  for (let i = 0; i < per; i++) {
    ctx.drawImage(canvas, i * cellW + (cellW - w) / 2, (out.height - h) / 2, w, h);
  }
  return out;
}

/** Opens the browser print (silent in Chrome --kiosk-printing). One page per copy. */
export function printStrip(canvas, rule, copies) {
  if (!rule || copies < 1) return;
  const url = sheet(canvas, rule).toDataURL('image/jpeg', 0.95);
  const [pw, ph] = rule.page;
  const root = document.getElementById('print-root');
  root.innerHTML = '';
  for (let i = 0; i < copies; i++) {
    const img = new Image();
    img.src = url;
    img.alt = '';
    img.style.width = `${pw}in`;
    img.style.height = `${ph}in`;
    root.append(img);
  }
  let style = document.getElementById('print-page');
  if (!style) {
    style = document.createElement('style');
    style.id = 'print-page';
    document.head.append(style);
  }
  style.textContent = `@page { size: ${pw}in ${ph}in; margin: 0; }`;
  // let the data-URL images decode before the print snapshot
  Promise.all([...root.querySelectorAll('img')].map((i) => i.decode().catch(() => {}))).then(() => window.print());
}
