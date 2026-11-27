// Small pieces shared by the Team vs Team and Tournament screens.

import { h } from './dom.js';

export const tag = (text, cls = '') => h('span', { class: cls ? `tag ${cls}` : 'tag', text });

/** A player's name with small tags for You, Host and Offline. */
export function nameBlock(p) {
  return h(
    'span',
    { class: 'p-name' },
    h('span', { class: 'p-text', text: p.name }),
    p.isYou ? tag('You', 'you') : null,
    p.isHost ? tag('Host') : null,
    p.online === false ? tag('Offline', 'away') : null,
  );
}

export const chip = (text, kind = '') => h('span', { class: kind ? `state ${kind}` : 'state', text });

export function heading(title, hint) {
  return h('header', { class: 't-head' }, h('h2', { text: title }), hint ? h('p', { class: 'hint', text: hint }) : null);
}

/** Keep keyboard focus on the same control after a screen is redrawn. */
export function captureFocus(root) {
  const el = document.activeElement;
  if (!el || !root.contains(el) || !el.dataset || !el.dataset.fk) return null;
  return { fk: el.dataset.fk, start: el.selectionStart, end: el.selectionEnd };
}

export function restoreFocus(saved, root) {
  if (!saved) return;
  const el = root.querySelector(`[data-fk="${CSS.escape(saved.fk)}"]`);
  if (!el || el.disabled) return;
  el.focus({ preventScroll: true });
  if (saved.start != null && typeof el.setSelectionRange === 'function') {
    try {
      el.setSelectionRange(saved.start, saved.end);
    } catch {
      /* not a text box */
    }
  }
}

// ------------------------------------------------------------ invite box ----

let copiedAt = 0;

export function resetCopied() {
  copiedAt = 0;
}

async function copyInvite(input, button) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(input.value);
    copied = true;
  } catch {
    input.select();
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
  }
  copiedAt = Date.now();
  button.textContent = copied ? 'Copied' : 'Press Ctrl+C to copy';
  setTimeout(() => {
    button.textContent = 'Copy link';
  }, 1800);
}

/** "N more players can join" with the invite link and a Copy button. */
export function inviteBlock(code, remaining) {
  const input = h('input', { type: 'text', readonly: true, 'aria-label': 'Invite link', value: `${location.origin}/#${code}` });
  input.addEventListener('focus', () => input.select());
  const button = h('button', { type: 'button', class: 'secondary', text: Date.now() - copiedAt < 1800 ? 'Copied' : 'Copy link', 'data-fk': 'copy' });
  button.addEventListener('click', () => copyInvite(input, button));
  return h(
    'div',
    { class: 'invite-block' },
    h('p', {}, `${remaining} more ${remaining === 1 ? 'player' : 'players'} can join. Send this link, or give them the room code `, h('strong', { text: code }), '.'),
    h('div', { class: 'copyrow' }, input, button),
  );
}
