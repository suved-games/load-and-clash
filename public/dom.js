// Small helpers shared by the browser scripts. Text is always inserted with
// textContent, never as HTML.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Tiny element builder. */
export function h(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Same idea for SVG elements. */
export function s(tag, props = {}, ...kids) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') node.setAttribute('class', value);
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, String(value));
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ------------------------------------------------------------ move art ----
// Every move has a square picture at /img/moves/<id>.png. The pictures are
// cropped to the hands and centred, so showing them at equal width and height
// keeps each one in proportion.

export const MOVE_IDS = [
  'load', 'mag', 'nv', 'shield', 'rebound',
  'path', 'boss', 'dam', 'icy', 'touche', 'storm', 'beast', 'professor',
];

export const iconUrl = (id) => `/img/moves/${id}.png`;

/** An <img> for a move. Size it with CSS (the .mico class). */
export function moveIcon(id, extra = '') {
  return h('img', {
    class: `mico${extra ? ` ${extra}` : ''}`,
    src: iconUrl(id),
    alt: '',
    width: 256,
    height: 256,
    draggable: 'false',
    decoding: 'async',
  });
}

export function preloadMoveArt() {
  for (const id of MOVE_IDS) {
    const img = new Image();
    img.src = iconUrl(id);
  }
}
