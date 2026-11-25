// The wheel menu: a ring of moves around the middle of the screen.
// This file only draws and highlights. The game decides what a pick means.
//
//   createWheel({ layer, slotInfo, hubInfo, onPick })
//     layer     the #wheel element in index.html
//     slotInfo  (id) => { selected, locked, note }   current look of one slot
//     hubInfo   (id|null, group) => { name, sub, note }  text for the middle
//     onPick    (id) => void   a click, tap or Space on a slot

import { $, s } from './dom.js';

const SIZE = 440; // the SVG is drawn in a 440 x 440 box and scaled to fit
const CX = SIZE / 2;
const CY = SIZE / 2;
const R_OUT = 216;
const R_IN = 92;
const RIM = 10; // the coloured band on the outer edge

const point = (angle, radius) => [CX + radius * Math.cos(angle), CY + radius * Math.sin(angle)];
const fmt = (n) => Math.round(n * 100) / 100;

/** The outline of a slice of a ring, between two angles and two radii. */
function slice(a0, a1, r0, r1) {
  const [x0, y0] = point(a0, r1);
  const [x1, y1] = point(a1, r1);
  const [x2, y2] = point(a1, r0);
  const [x3, y3] = point(a0, r0);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${fmt(x0)} ${fmt(y0)}A${r1} ${r1} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}L${fmt(x2)} ${fmt(y2)}A${r0} ${r0} 0 ${large} 0 ${fmt(x3)} ${fmt(y3)}Z`;
}

export function createWheel({ layer, slotInfo, hubInfo, onPick }) {
  const ring = $('.wheel', layer);
  const hubName = $('.hub-name', layer);
  const hubSub = $('.hub-sub', layer);
  const hubNote = $('.hub-note', layer);

  const svg = s('svg', { viewBox: `0 0 ${SIZE} ${SIZE}`, focusable: 'false', 'aria-hidden': 'false' });
  ring.prepend(svg);

  let group = null;
  let slots = []; // [{ id, el, move }]
  let activeId = null;

  const find = (id) => slots.find((slot) => slot.id === id) || null;

  function showHub() {
    const info = hubInfo(activeId, group) || {};
    hubName.textContent = info.name || '';
    hubSub.textContent = info.sub || '';
    hubNote.textContent = info.note || '';
  }

  function setActive(id) {
    activeId = id;
    for (const slot of slots) slot.el.classList.toggle('active', slot.id === id);
    showHub();
  }

  function buildSlot(move, index, count) {
    const mid = -Math.PI / 2 + (index * 2 * Math.PI) / count; // the first slot sits at the top
    const half = Math.PI / count;
    const a0 = mid - half;
    const a1 = mid + half;
    const big = count <= 4;

    const [c1, c2] = move.colors;
    const el = s('g', {
      class: 'slot',
      role: 'menuitemradio',
      tabindex: '-1',
      'aria-checked': 'false',
      'data-move': move.id,
      'aria-label': move.label,
    });
    el.style.setProperty('--c', `var(--${c1})`);

    // Parts, from back to front.
    el.append(s('path', { class: 'bg', d: slice(a0, a1, R_IN, R_OUT) }));
    if (c1 === c2) {
      el.append(s('path', { class: `rim c-${c1}`, d: slice(a0, a1, R_OUT - RIM, R_OUT) }));
    } else {
      el.append(s('path', { class: `rim c-${c1}`, d: slice(a0, mid, R_OUT - RIM, R_OUT) }));
      el.append(s('path', { class: `rim c-${c2}`, d: slice(mid, a1, R_OUT - RIM, R_OUT) }));
    }
    const inset = 0.03;
    el.append(s('path', { class: 'halo', d: slice(a0 + inset, a1 - inset, R_IN + 6, R_OUT - RIM - 4) }));

    // The picture, the name and a small note, centred in the slice.
    const radius = (R_IN + R_OUT - RIM) / 2;
    const [x, y] = point(mid, radius);
    const art = big ? 84 : 60;
    const content = s('g', { class: 'content', transform: `translate(${fmt(x)} ${fmt(y)})` });
    content.append(
      s('image', {
        href: `/img/moves/${move.id}.png`,
        x: -art / 2,
        y: big ? -58 : -48,
        width: art,
        height: art,
        preserveAspectRatio: 'xMidYMid meet',
      }),
      s('text', { class: `s-name${big ? ' big' : ''}`, y: big ? 44 : 28, text: move.name }),
      s('text', { class: 's-note', y: big ? 62 : 44 }),
    );
    if (move.value != null) {
      content.append(
        s('circle', { class: 's-badge-bg', cx: big ? -44 : -29, cy: big ? -60 : -42, r: 11 }),
        s('text', { class: 's-badge', x: big ? -44 : -29, y: big ? -55.5 : -37.5, text: move.value }),
      );
    }
    el.append(content);
    return el;
  }

  function refresh() {
    for (const slot of slots) {
      const info = slotInfo(slot.id) || {};
      slot.el.classList.toggle('selected', Boolean(info.selected));
      slot.el.classList.toggle('locked', Boolean(info.locked));
      slot.el.setAttribute('aria-checked', String(Boolean(info.selected)));
      slot.el.setAttribute('aria-disabled', String(Boolean(info.locked)));
      $('.s-note', slot.el).textContent = info.note || '';
    }
    showHub();
  }

  function open(groupName, moves, { label, focusId } = {}) {
    group = groupName;
    svg.replaceChildren();
    slots = moves.map((move, index) => {
      const el = buildSlot(move, index, moves.length);
      svg.append(el);
      return { id: move.id, el, move };
    });
    ring.dataset.group = groupName;
    ring.setAttribute('aria-label', label || 'Moves');
    layer.hidden = false;
    document.body.classList.add('wheel-open');
    refresh();
    const start = find(focusId) || slots[0];
    if (start) {
      setActive(start.id);
      start.el.focus({ preventScroll: true });
    }
  }

  function close() {
    if (layer.hidden) return;
    layer.hidden = true;
    document.body.classList.remove('wheel-open');
    svg.replaceChildren();
    slots = [];
    activeId = null;
    group = null;
  }

  /** Move the highlight to the next (or previous) slot that can be used. */
  function step(delta, usable = () => true) {
    const usableSlots = slots.filter((slot) => usable(slot.id));
    if (!usableSlots.length) return null;
    const at = usableSlots.findIndex((slot) => slot.id === activeId);
    let next;
    if (at === -1) next = delta > 0 ? usableSlots[0] : usableSlots[usableSlots.length - 1];
    else next = usableSlots[(at + delta + usableSlots.length) % usableSlots.length];
    next.el.focus({ preventScroll: true });
    setActive(next.id);
    return next.id;
  }

  function edge(which, usable = () => true) {
    const usableSlots = slots.filter((slot) => usable(slot.id));
    const next = which === 'first' ? usableSlots[0] : usableSlots[usableSlots.length - 1];
    if (!next) return null;
    next.el.focus({ preventScroll: true });
    setActive(next.id);
    return next.id;
  }

  // Pointer and keyboard on the slots themselves.
  svg.addEventListener('click', (event) => {
    const el = event.target.closest('.slot');
    if (!el) return;
    setActive(el.dataset.move);
    onPick(el.dataset.move);
  });
  svg.addEventListener('pointerover', (event) => {
    const el = event.target.closest('.slot');
    if (el && el.dataset.move !== activeId) setActive(el.dataset.move);
  });
  svg.addEventListener('focusin', (event) => {
    const el = event.target.closest('.slot');
    if (el && el.dataset.move !== activeId) setActive(el.dataset.move);
  });
  svg.addEventListener('keydown', (event) => {
    if (event.key !== ' ') return;
    const el = event.target.closest('.slot');
    if (!el) return;
    event.preventDefault();
    onPick(el.dataset.move);
  });

  return {
    open,
    close,
    refresh,
    step,
    edge,
    setActive,
    get isOpen() {
      return !layer.hidden;
    },
    get group() {
      return group;
    },
    get activeId() {
      return activeId;
    },
  };
}
