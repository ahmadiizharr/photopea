// Same file the backend validates against, so layouts never drift between the two.
import catalog from '../../../shared/layouts.json';

export const layouts = catalog.layouts;
export const frames = catalog.frames;
export const filters = catalog.filters;
/** Print sizes for uploaded frames (dashboard) — px at 300 dpi, print page in inches. */
export const formats = catalog.formats;

export const byId = (list, id) => list.find((x) => x.id === id) ?? list[0];

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getDate())}.${p(date.getMonth() + 1)}.${String(date.getFullYear()).slice(2)}`;
}

export const CODE_RE = /^[2-9A-HJ-NP-Z]{6}$/;
