// Load & Clash: browser client.
// All game rules come from the server (/api/rules), so the UI never has its
// own copy of them. All user-provided text is inserted with textContent.

const SESSION_KEY = 'clash.session'; // per tab, so two tabs can play each other
const NAME_KEY = 'clash.name';
const CODE_RE = /^[A-Z0-9]{5}$/;

// Keyboard shortcuts. Enter locks in the highlighted move.
const KEYS = {
  load: 'l',
  mag: 'q',
  nv: 'w',
  shield: 'e',
  rebound: 'r',
  path: 'a',
  boss: 's',
  dam: 'd',
  icy: 'f',
  touche: 'g',
  storm: 'h',
  beast: 'j',
  professor: 'k',
};
const MOVE_BY_KEY = Object.fromEntries(Object.entries(KEYS).map(([id, key]) => [key, id]));

// Keys that open and close the two drop-down menus.
const MENU_KEYS = { def: 'z', atk: 'x' };
const MENU_BY_KEY = Object.fromEntries(Object.entries(MENU_KEYS).map(([group, key]) => [key, group]));

const DOUBLE_MS = 500; // two clicks or taps on the same move within this time lock it in
const MENU_CLOSE_MS = 600; // a menu closes this long after a move is picked from it

const MENUS = {
  def: { dd: '#dd-def', trigger: '#trig-def', menu: '#menu-def', pick: '#pick-def', type: 'defense' },
  atk: { dd: '#dd-atk', trigger: '#trig-atk', menu: '#menu-atk', pick: '#pick-atk', type: 'attack' },
};

const $ = (selector, root = document) => root.querySelector(selector);

/** Tiny element builder. Text is always set as text, never as HTML. */
function h(tag, props = {}, ...kids) {
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

// ---------------------------------------------------------------- state ----

let rules = null; // { load, defenses, attacks }
let moveById = {};
let maxScore = 12; // number of cells on the meter
let session = null; // { code, token, seat }
let state = null; // latest view from the server
let selected = null; // move id chosen but not locked in yet
let lastRound = null;
let lastHistoryLength = 0;
let busy = false;
let locking = false;
let roomBusy = false;
let offlineSince = null; // when the opponent was first seen offline
let offlineTimer = null;
let clockOffset = 0; // server time minus this device's time, in ms
let timerLoop = null;

// Drop-down menus and double-click.
let openMenu = null; // 'def' | 'atk' | null
let menuCloseTimer = null;
let lastPick = { id: null, at: 0 };

// Connection: a live stream when it works, polling when it does not.
let stream = null; // EventSource
let transport = 'sse'; // 'sse' | 'poll'
let gotFirstState = false;
let sseErrors = 0;
let sseWatchdog = null;
let reconnectAttempts = 0;
let pollTimer = null;
let pollFailures = 0;
let pollVersion = -1;
let keepAliveTimer = null;
let flashTimer = null;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const moveName = (id) => moveById[id].name;
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ------------------------------------------------------------------ api ----

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Could not reach the server. Check your connection and try again.');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) throw new Error((data && data.error) || `Something went wrong (${res.status}).`);
  return data;
}

function notice(message) {
  const node = $('#notice');
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.textContent = message;
  node.hidden = false;
}

// -------------------------------------------------------------- session ----

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    /* private mode: the game still works until the tab is refreshed */
  }
}

function loadSession() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (stored && CODE_RE.test(stored.code) && typeof stored.token === 'string') return stored;
  } catch {
    /* ignore */
  }
  return null;
}

function clearSession() {
  session = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

function playerName() {
  const name = $('#name').value.trim();
  try {
    if (name) localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  return name;
}

function parseHash() {
  const code = location.hash.replace(/^#/, '').toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

// ---------------------------------------------------------------- views ----

function showView(name) {
  for (const view of ['lobby', 'room', 'game']) $(`#view-${view}`).hidden = view !== name;
  const inRoom = name !== 'lobby';
  $('#roomtag').hidden = !inRoom;
  if (inRoom && session) $('#roomcode').textContent = session.code;
}

function goToLobby(message) {
  stopTransport();
  clearSession();
  state = null;
  selected = null;
  lastRound = null;
  lastHistoryLength = 0;
  offlineSince = null;
  clearTimeout(offlineTimer);
  offlineTimer = null;
  closeMenus();
  history.replaceState(null, '', location.pathname);
  $('#conn').hidden = true;
  $('#timer').hidden = true;
  $('#invite-note').hidden = true;
  $('#create-block').hidden = false;
  $('#btn-show-create').hidden = true;
  showView('lobby');
  notice(message || '');
}

// ----------------------------------------------------------- connection ----

function syncClock(serverNow) {
  if (typeof serverNow === 'number') clockOffset = serverNow - Date.now();
}

function applyState(next) {
  pollVersion = next.version;
  syncClock(next.serverNow);

  if (next.status === 'closed') {
    goToLobby(`${next.opponent.name || 'The host'} closed the room.`);
    return;
  }
  // The other player left the room (or never came back to the waiting room).
  if (state && state.opponent.joined && !next.opponent.joined) {
    notice(`${state.opponent.name} left the room.`);
  } else if (state && !state.opponent.joined && next.opponent.joined) {
    notice('');
  }

  state = next;
  render(next);
}

function stopTransport() {
  if (stream) {
    const old = stream;
    stream = null;
    old.close();
  }
  clearTimeout(sseWatchdog);
  clearTimeout(pollTimer);
  clearInterval(keepAliveTimer);
  sseWatchdog = null;
  pollTimer = null;
  keepAliveTimer = null;
  transport = 'sse';
}

function connect() {
  stopTransport();
  gotFirstState = false;
  sseErrors = 0;
  reconnectAttempts = 0;
  pollVersion = -1;

  // Free hosts put a service to sleep when nothing visits it for a while.
  // A quiet request every few minutes keeps a waiting room alive.
  keepAliveTimer = setInterval(() => fetch('/healthz', { cache: 'no-store' }).catch(() => {}), 4 * 60 * 1000);

  const url = `/api/rooms/${session.code}/events?token=${encodeURIComponent(session.token)}`;
  const source = new EventSource(url);
  stream = source;

  source.addEventListener('state', (event) => {
    if (stream !== source) return;
    gotFirstState = true;
    sseErrors = 0;
    reconnectAttempts = 0;
    clearTimeout(sseWatchdog);
    $('#conn').hidden = true;
    applyState(JSON.parse(event.data));
  });

  source.onerror = () => {
    if (stream !== source) return;
    if (source.readyState === EventSource.CLOSED) {
      handleStreamClosed(source);
      return;
    }
    sseErrors += 1;
    $('#conn').hidden = false; // the browser is retrying by itself
    if (!gotFirstState && sseErrors >= 2) startPolling();
  };

  // Some networks and hosts hold a live stream back until it fills up. If
  // nothing arrives in 5 seconds, ask for the game state by polling instead.
  sseWatchdog = setTimeout(() => {
    if (stream === source && !gotFirstState) startPolling();
  }, 5000);
}

/** A closed stream does not always mean the room is gone: Chrome also reports
 *  it while a page is being refreshed. Ask the server before giving up. */
async function handleStreamClosed(source) {
  const mine = session;
  if (!mine) return;
  try {
    const res = await fetch(`/api/rooms/${mine.code}?token=${encodeURIComponent(mine.token)}`);
    if (stream !== source) return;
    if (res.status === 404) {
      goToLobby('That room is no longer available. Create a new one or enter another code.');
      return;
    }
    if (res.ok) {
      const info = await res.json();
      if (stream !== source) return;
      if (info.seated === false) {
        goToLobby('You are no longer in that room. Create a new one or enter another code.');
        return;
      }
    }
  } catch {
    /* offline, or the page is unloading: fall through and retry */
  }
  if (stream !== source) return;
  reconnectAttempts += 1;
  if (reconnectAttempts > 5) {
    goToLobby('Could not reconnect to that room. Create a new one or enter another code.');
    return;
  }
  $('#conn').hidden = false;
  setTimeout(() => {
    if (stream === source && session) connect();
  }, 2000);
}

function startPolling() {
  if (!session || transport === 'poll') return;
  if (stream) {
    const old = stream;
    stream = null;
    old.close();
  }
  clearTimeout(sseWatchdog);
  transport = 'poll';
  pollFailures = 0;
  pollLoop(session);
}

async function pollLoop(mine) {
  if (session !== mine || transport !== 'poll') return;
  let delay = 1000;
  try {
    const url = `/api/rooms/${mine.code}/state?token=${encodeURIComponent(mine.token)}&v=${pollVersion}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (session !== mine || transport !== 'poll') return;
    if (res.status === 404 || res.status === 403) {
      goToLobby('That room is no longer available. Create a new one or enter another code.');
      return;
    }
    if (!res.ok) throw new Error('poll failed');
    const data = await res.json();
    if (session !== mine || transport !== 'poll') return;
    pollFailures = 0;
    $('#conn').hidden = true;
    if (data.unchanged) syncClock(data.serverNow);
    else applyState(data);
  } catch {
    pollFailures += 1;
    if (pollFailures >= 2) $('#conn').hidden = false;
    delay = 2000;
  }
  if (session === mine) pollTimer = setTimeout(() => pollLoop(mine), delay);
}

function enterRoom(info) {
  session = { code: info.code, token: info.token, seat: info.seat };
  saveSession();
  history.replaceState(null, '', `#${info.code}`);
  notice('');
  connect();
}

// -------------------------------------------------------------- lobby -----

async function createRoom() {
  if (busy) return;
  busy = true;
  notice('');
  try {
    enterRoom(await api('/api/rooms', { method: 'POST', body: { name: playerName() } }));
  } catch (err) {
    notice(err.message);
  } finally {
    busy = false;
  }
}

async function joinRoom(rawCode) {
  if (busy) return;
  const code = String(rawCode || '').toUpperCase();
  if (!CODE_RE.test(code)) {
    notice('Enter the 5-character room code.');
    $('#code').focus();
    return;
  }
  busy = true;
  notice('');
  try {
    enterRoom(await api(`/api/rooms/${code}/join`, { method: 'POST', body: { name: playerName() } }));
  } catch (err) {
    notice(err.message);
  } finally {
    busy = false;
  }
}

async function showInvite(code) {
  try {
    const info = await api(`/api/rooms/${code}`);
    if (info.full) {
      history.replaceState(null, '', location.pathname);
      notice('That room already has two players. Create your own room below.');
      return;
    }
    $('#invite-code').textContent = code;
    $('#invite-note').hidden = false;
    $('#code').value = code;
    $('#create-block').hidden = true;
    $('#btn-show-create').hidden = false;
    $('#name').focus();
  } catch (err) {
    history.replaceState(null, '', location.pathname);
    notice(err.message);
  }
}

/** Leave for good: tell the server (the guest frees the seat, the host closes
 *  the room), then go back to the home screen. */
function leaveRoom() {
  const mine = session;
  const playing = state && state.status === 'playing';
  if (playing) {
    const message = state.isHost
      ? 'Leave this game? The room will close and your opponent will be sent home.'
      : 'Leave this game? Your opponent will be left waiting.';
    if (!window.confirm(message)) return;
  }
  if (mine) {
    fetch(`/api/rooms/${mine.code}/leave`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: mine.token }),
      keepalive: true,
    }).catch(() => {});
  }
  goToLobby('');
}

// -------------------------------------------------------------- meters ----
// The meter is the picture on the home screen: one notch per score, coloured
// by the defense that answers the attack unlocked there.

function buildMeter(container) {
  const byValue = new Map(rules.attacks.map((attack) => [attack.value, attack]));
  const cells = [];
  for (let n = 1; n <= maxScore; n++) {
    const cell = h('span', { class: 'cell', 'data-n': n });
    const attack = byValue.get(n);
    if (attack) {
      cell.classList.add('has');
      cell.title = `${attack.name} unlocks at ${n}`;
      cell.style.setProperty('--c1', `var(--${attack.counters[0]})`);
      cell.style.setProperty('--c2', `var(--${attack.counters[1] || attack.counters[0]})`);
    }
    cells.push(cell);
  }
  container.replaceChildren(...cells);
}

// Plays once on the home screen: the meter fills so the notches are noticed.
function playHeroMeter() {
  const meter = $('#hero-meter');
  buildMeter(meter);
  const cells = [...meter.querySelectorAll('.cell')];
  if (reducedMotion()) {
    cells.forEach((cell) => cell.classList.add('on'));
    return;
  }
  cells.forEach((cell, i) => setTimeout(() => cell.classList.add('on'), 250 + i * 90));
}

// --------------------------------------------------------------- timer ----

function updateTimer() {
  const box = $('#timer');
  if (!state || state.status !== 'playing' || !state.opponent.joined || $('#view-game').hidden) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const fill = $('#timer-fill');
  const num = $('#timer-num');
  if (state.deadline == null) {
    box.classList.add('paused');
    box.classList.remove('urgent');
    fill.style.transform = 'scaleX(1)';
    num.textContent = 'Paused';
    return;
  }
  box.classList.remove('paused');
  const left = Math.max(0, state.deadline - (Date.now() + clockOffset));
  fill.style.transform = `scaleX(${Math.min(1, left / state.roundMs)})`;
  box.classList.toggle('urgent', left <= 2000);
  num.textContent = String(Math.ceil(left / 1000));
}

// -------------------------------------------------------------- picker ----

function keyCap(id) {
  return h('kbd', { 'aria-hidden': 'true', text: KEYS[id].toUpperCase() });
}

const chip = (id) => h('span', { class: 'chip' }, h('i', { class: `dot ${id}` }), moveById[id].name);

function loadButton(move) {
  return h(
    'button',
    {
      type: 'button',
      class: 'move load',
      'data-move': move.id,
      'aria-pressed': 'false',
      'aria-keyshortcuts': KEYS[move.id].toUpperCase(),
    },
    h('span', { class: 'move-name', text: move.name }),
    h('span', { class: 'move-note', text: '+1 point' }),
    keyCap(move.id),
  );
}

/** One row of a Defend or Attack menu. */
function optionFor(move) {
  const isDefense = move.type === 'defense';
  const lead = h('span', { class: 'opt-lead' }, isDefense ? h('i', { class: `dot ${move.id}` }) : h('span', { class: 'badge', text: move.value }));

  let sub;
  if (isDefense) {
    const answers = rules.attacks.filter((attack) => attack.counters.includes(move.id)).map((attack) => attack.name);
    sub = h('span', { class: 'opt-sub', text: `Answers ${answers.join(', ')}` });
  } else {
    sub = h('span', { class: 'opt-sub' }, h('span', { class: 'chips' }, move.counters.map(chip)), h('span', { class: 'lock-note' }));
  }

  const label = isDefense
    ? move.name
    : `${move.name}, unlocks at ${move.value}, answered by ${move.counters.map(moveName).join(' or ')}`;

  return h(
    'button',
    {
      type: 'button',
      role: 'option',
      class: `move opt ${move.type}${isDefense ? ` ${move.id}` : ''}`,
      'data-move': move.id,
      'aria-selected': 'false',
      'aria-label': label,
      'aria-keyshortcuts': KEYS[move.id].toUpperCase(),
      tabindex: '-1',
    },
    lead,
    h('span', { class: 'opt-name', text: move.name }),
    keyCap(move.id),
    sub,
  );
}

function buildPicker() {
  $('#g-load').replaceChildren(loadButton(rules.load));
  $(MENUS.def.menu).replaceChildren(...rules.defenses.map(optionFor));
  $(MENUS.atk.menu).replaceChildren(...rules.attacks.map(optionFor));
  for (const [group, key] of Object.entries(MENU_KEYS)) {
    $(`#key-${group}`).textContent = key.toUpperCase();
    $(MENUS[group].trigger).setAttribute('aria-keyshortcuts', key.toUpperCase());
  }
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  $('#tip').dataset.text = coarse ? 'Double-tap a move to lock it in.' : 'Double-click a move to lock it in.';
}

const canActNow = () => Boolean(state) && state.status === 'playing' && !state.you.locked;

function updatePicker(s) {
  const legal = new Set(s.you.legal);
  const canAct = s.status === 'playing' && !s.you.locked;

  document.querySelectorAll('#picker .move').forEach((button) => {
    const id = button.dataset.move;
    const move = moveById[id];
    button.disabled = !canAct;
    if (button.classList.contains('opt')) {
      // A locked attack stays clickable so that tapping it explains itself.
      const scoreLocked = move.type === 'attack' && !legal.has(id);
      button.setAttribute('aria-disabled', String(canAct && scoreLocked));
      button.setAttribute('aria-selected', String(selected === id));
      if (move.type === 'attack') {
        $('.lock-note', button).textContent = scoreLocked ? `Needs ${move.value - s.you.score} more` : '';
      }
    } else {
      button.setAttribute('aria-pressed', String(selected === id));
    }
  });

  for (const [group, menu] of Object.entries(MENUS)) {
    const pick = selected && moveById[selected].type === menu.type ? selected : null;
    const dd = $(menu.dd);
    dd.classList.toggle('has-pick', Boolean(pick));
    dd.dataset.pick = pick && menu.type === 'defense' ? pick : '';
    $(menu.pick).textContent = pick ? moveName(pick) : 'Choose';
    $(menu.pick).classList.toggle('is-empty', !pick);
    $(menu.trigger).disabled = !canAct;
    $(menu.trigger).setAttribute('aria-label', `${group === 'def' ? 'Defend' : 'Attack'} menu${pick ? `, ${moveName(pick)} selected` : ''}`);
  }
  if (!canAct) closeMenus();

  $('#tip').textContent = canAct ? $('#tip').dataset.text || '' : '';

  const lockbar = $('#lockbar');
  lockbar.hidden = s.status !== 'playing';
  const label = $('#selection');
  const lock = $('#btn-lock');
  if (s.you.locked) {
    label.textContent = selected ? `Locked in: ${moveName(selected)}` : 'Locked in';
    lock.disabled = true;
  } else if (selected) {
    label.textContent = `Selected: ${moveName(selected)}`;
    lock.disabled = false;
  } else {
    label.textContent = 'Choose a move';
    lock.disabled = true;
  }
}

/** Show a short message in the lock bar, then go back to the normal label. */
function flashSelection(message) {
  $('#selection').textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (state) updatePicker(state);
  }, 1800);
}

// ---------------------------------------------------------- the menus ----

function menuOptions(group, { usableOnly = false } = {}) {
  const items = [...document.querySelectorAll(`${MENUS[group].menu} .opt`)];
  return usableOnly ? items.filter((item) => !item.disabled && item.getAttribute('aria-disabled') !== 'true') : items;
}

function openMenuFor(group) {
  if (!canActNow()) return;
  closeMenus();
  const parts = MENUS[group];
  $(parts.menu).hidden = false;
  $(parts.trigger).setAttribute('aria-expanded', 'true');
  openMenu = group;

  // Focus the highlighted move (or the first one you can use) so the arrow keys work.
  const usable = menuOptions(group, { usableOnly: true });
  const target = usable.find((item) => item.dataset.move === selected) || usable[0] || menuOptions(group)[0];
  if (target) target.focus({ preventScroll: true });
  $(parts.menu).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function closeMenus() {
  clearTimeout(menuCloseTimer);
  menuCloseTimer = null;
  for (const parts of Object.values(MENUS)) {
    const menu = $(parts.menu);
    if (!menu.hidden && menu.contains(document.activeElement)) $(parts.trigger).focus({ preventScroll: true });
    menu.hidden = true;
    $(parts.trigger).setAttribute('aria-expanded', 'false');
  }
  openMenu = null;
}

function toggleMenu(group) {
  if (openMenu === group) closeMenus();
  else openMenuFor(group);
}

/** Arrow keys inside an open menu: move the highlight, and select that move. */
function stepMenu(step) {
  if (!openMenu) return;
  const items = menuOptions(openMenu, { usableOnly: true });
  if (!items.length) return;
  const index = items.indexOf(document.activeElement);
  // A menu opens with its first move focused but not chosen. The first arrow
  // press chooses what is focused, so the highlight never skips a move.
  if (typeof step === 'number' && index !== -1 && items[index].dataset.move !== selected) {
    chooseMove(items[index].dataset.move);
    return;
  }
  let next;
  if (step === 'first') next = items[0];
  else if (step === 'last') next = items[items.length - 1];
  else if (index === -1) next = step > 0 ? items[0] : items[items.length - 1];
  else next = items[(index + step + items.length) % items.length];
  next.focus({ preventScroll: true });
  chooseMove(next.dataset.move);
}

function scheduleMenuClose() {
  clearTimeout(menuCloseTimer);
  menuCloseTimer = setTimeout(closeMenus, MENU_CLOSE_MS);
}

// ----------------------------------------------------- choosing a move ----

/** Highlights a move. Returns true when it is now the selected move. */
function chooseMove(id) {
  if (!state || state.status !== 'playing' || state.you.locked) return false;
  const move = moveById[id];
  if (!state.you.legal.includes(id)) {
    flashSelection(`${move.name} unlocks at ${move.value}. Your score is ${state.you.score}.`);
    return false;
  }
  clearTimeout(flashTimer);
  selected = id;
  updatePicker(state);
  return true;
}

/** A click or tap on a move. The same move twice within DOUBLE_MS locks it in. */
function pickWithPointer(id, fromMenu) {
  const now = performance.now();
  const twice = lastPick.id === id && now - lastPick.at <= DOUBLE_MS;
  lastPick = { id, at: now };
  const chosen = chooseMove(id);
  if (twice && chosen) {
    lastPick = { id: null, at: 0 };
    closeMenus();
    lockIn();
    return;
  }
  if (fromMenu && chosen) scheduleMenuClose();
}

async function lockIn() {
  if (!state || state.status !== 'playing' || state.you.locked || !session || locking) return;
  if (!selected) {
    flashSelection('Choose a move first.');
    return;
  }
  locking = true;
  notice('');
  closeMenus();
  $('#btn-lock').disabled = true;
  try {
    await api(`/api/rooms/${session.code}/move`, {
      method: 'POST',
      body: { token: session.token, move: selected, round: state.round },
    });
  } catch (err) {
    notice(err.message);
    if (state) updatePicker(state);
  } finally {
    locking = false;
  }
}

// ------------------------------------------------------- round wording ----

function timeoutNote(entry, s) {
  const { you, opp } = entry.timedOut || {};
  if (you && opp) return ' Time ran out for both players, so Load was played for each.';
  if (you) return ' Time ran out for you, so Load was played for you.';
  if (opp) return ` Time ran out for ${s.opponent.name}, so Load was played for them.`;
  return '';
}

function describeCore(entry, s) {
  const opp = s.opponent.name;
  const youMove = moveById[entry.you];
  const oppMove = moveById[entry.opp];
  const youAttacked = entry.attacker === 'you';

  switch (entry.kind) {
    case 'quiet':
      if (youMove.type === 'load' && oppMove.type === 'load') return 'Both players loaded and gained 1 point.';
      if (youMove.type !== 'load' && oppMove.type !== 'load') return 'Both players defended. Nothing changed.';
      if (youMove.type === 'load') return `You loaded and gained 1 point. ${opp} defended with ${oppMove.name}.`;
      return `${opp} loaded and gained 1 point. You defended with ${youMove.name}.`;

    case 'blocked': {
      const attack = youAttacked ? youMove : oppMove;
      const defense = youAttacked ? oppMove : youMove;
      return youAttacked
        ? `${opp} blocked your ${attack.name} with ${defense.name}. You lost ${plural(entry.penalty, 'point')}.`
        : `You blocked ${opp}'s ${attack.name} with ${defense.name}. ${opp} lost ${plural(entry.penalty, 'point')}.`;
    }

    case 'hit': {
      const attack = youAttacked ? youMove : oppMove;
      const defense = youAttacked ? oppMove : youMove;
      const counters = attack.counters.map(moveName).join(' or ');
      const answered = (subject, were) =>
        defense.type === 'load' ? `${subject} ${were} loading` : `${subject} used ${defense.name}`;
      return youAttacked
        ? `${answered(opp, 'was')}, but ${attack.name} is only blocked by ${counters}. You win.`
        : `${answered('You', 'were')}, but ${attack.name} is only blocked by ${counters}. ${opp} wins.`;
    }

    case 'reflect':
      return youAttacked
        ? `${opp} used Rebound against your Dam and reflected it back. You lose.`
        : `You used Rebound against ${opp}'s Dam and reflected it back. You win.`;

    case 'swap': {
      const who = youAttacked ? `${opp} used Rebound against your Touch E` : `You used Rebound against ${opp}'s Touch E`;
      return `${who}, so the scores were swapped. You now have ${entry.scores.you} and ${opp} has ${entry.scores.opp}.`;
    }

    case 'absorb': {
      const taken = plural(entry.absorbed, 'point');
      if (youAttacked) {
        const how = oppMove.type === 'load' ? 'was loading' : `used ${oppMove.name}`;
        return `${opp} ${how}, so your Touch E absorbed their ${taken}. You now have ${entry.scores.you}.`;
      }
      const how = youMove.type === 'load' ? 'You were loading' : `You used ${youMove.name}`;
      return `${how}, so ${opp}'s Touch E absorbed your ${taken}. You now have ${entry.scores.you}.`;
    }

    case 'touch-loses':
      return youAttacked
        ? `You used Touch E, but ${opp} attacked with ${oppMove.name}. Touch E loses to any other attack, so ${opp} wins.`
        : `${opp} used Touch E, but you attacked with ${youMove.name}. Touch E loses to any other attack, so you win.`;

    case 'clash':
      return entry.result === 'win'
        ? `Both attacked. Your ${youMove.name} (${youMove.value}) beat ${opp}'s ${oppMove.name} (${oppMove.value}).`
        : `Both attacked. ${opp}'s ${oppMove.name} (${oppMove.value}) beat your ${youMove.name} (${youMove.value}).`;

    case 'clash-same':
      return `Both players used ${youMove.name}. Each of you loses ${plural(entry.penalty, 'point')}.`;

    default:
      return '';
  }
}

const describe = (entry, s) => describeCore(entry, s) + timeoutNote(entry, s);

// -------------------------------------------------------------- render ----

function statusText(s) {
  if (s.status === 'finished') return '';
  const opp = s.opponent.name;
  if (s.you.locked) return `Locked in. Waiting for ${opp}.`;
  if (s.opponent.locked) return `${opp} has locked in. Your move.`;
  return `Round ${s.round}. Choose your move.`;
}

/** True only once the opponent has been offline for a few seconds, so the
 *  message doesn't flash while their connection is still opening. */
function opponentOffline(s) {
  const watching = s.status === 'playing' || s.status === 'lobby';
  const offline = watching && s.opponent.joined && !s.opponent.connected;
  if (!offline) {
    offlineSince = null;
    clearTimeout(offlineTimer);
    offlineTimer = null;
    return false;
  }
  if (offlineSince === null) offlineSince = Date.now();
  const elapsed = Date.now() - offlineSince;
  if (elapsed >= 3000) return true;
  if (!offlineTimer) {
    offlineTimer = setTimeout(() => {
      offlineTimer = null;
      if (state) render(state);
    }, 3050 - elapsed);
  }
  return false;
}

/** The result card: the score as a ratio (you : opponent) and the last round. */
function renderReveal(s) {
  const last = s.history[s.history.length - 1];
  const reveal = $('#reveal');

  $('#ratio-you').textContent = s.you.score;
  $('#ratio-opp').textContent = s.opponent.score;
  $('#ratio').setAttribute('aria-label', `Score: you ${s.you.score}, ${s.opponent.name} ${s.opponent.score}`);
  $('#ratio-key').textContent = `You : ${s.opponent.name}`;
  $('#reveal-title').textContent = last ? `Round ${last.round} result` : 'Score';

  $('#clash').hidden = !last;
  if (!last) {
    $('#rv-text').textContent = '';
    return;
  }
  $('#rv-opp-name').textContent = s.opponent.name;
  for (const [side, id] of [['you', last.you], ['opp', last.opp]]) {
    const move = $(`#rv-${side}`);
    move.textContent = moveName(id);
    move.parentElement.className = `played ${side}${moveById[id].type === 'defense' ? ` t-${id}` : ''}`;
  }
  $('#rv-text').textContent = describe(last, s);

  if (s.history.length !== lastHistoryLength) {
    // Only animate when a new round has just resolved, not on every update.
    if (lastHistoryLength !== 0 || s.history.length === 1) {
      reveal.classList.remove('fresh');
      void reveal.offsetWidth; // restart the animation
      reveal.classList.add('fresh');
    }
  }
}

function renderBanner(s) {
  const banner = $('#banner');
  if (s.status !== 'finished') {
    banner.hidden = true;
    return;
  }
  const last = s.history[s.history.length - 1];
  banner.hidden = false;
  $('#banner-title').textContent = s.result === 'win' ? 'You win' : 'You lose';
  $('#banner-text').textContent = last ? describe(last, s) : '';
  const button = $('#btn-rematch');
  const opp = s.opponent.name;
  button.disabled = s.you.wantsRematch;
  button.textContent = s.you.wantsRematch ? 'Waiting for a rematch' : 'Play again';
  $('#rematch-note').textContent = s.you.wantsRematch
    ? `Waiting for ${opp} to accept.`
    : s.opponent.wantsRematch
      ? `${opp} wants to play again.`
      : '';
}

/** The waiting room: who is here, the guest's Ready button, the host's Start button. */
function renderRoom(s) {
  showView('room');
  selected = null;
  lastRound = null;
  lastHistoryLength = 0;
  closeMenus();

  const offline = opponentOffline(s);
  const isHost = s.isHost;
  const hostName = isHost ? s.you.name : s.opponent.name;
  const guestJoined = isHost ? s.opponent.joined : true;
  const guestName = isHost ? s.opponent.name : s.you.name;
  const guestReady = isHost ? s.opponent.ready : s.you.ready;

  const link = `${location.origin}/#${s.code}`;
  $('#waiting-code').textContent = s.code;
  if ($('#invite-link').value !== link) $('#invite-link').value = link;
  $('#invite-block').hidden = !isHost; // the guest is already in

  // Host row.
  $('#pl-host-name').textContent = isHost ? `${hostName} (you)` : hostName;
  const hostStatus = $('#pl-host-status');
  const hostAway = !isHost && offline;
  hostStatus.textContent = hostAway ? 'Offline' : 'Ready';
  hostStatus.className = `pl-status ${hostAway ? 'away' : 'ready'}`;

  // Guest row.
  const row = $('#pl-guest');
  const guestStatus = $('#pl-guest-status');
  row.classList.toggle('empty', !guestJoined);
  $('#pl-guest-tag').hidden = !guestJoined;
  if (!guestJoined) {
    $('#pl-guest-name').textContent = 'Waiting for a player to join';
    guestStatus.textContent = '';
    guestStatus.className = 'pl-status';
  } else {
    $('#pl-guest-name').textContent = isHost ? guestName : `${guestName} (you)`;
    const guestAway = isHost && offline;
    guestStatus.textContent = guestAway ? 'Offline' : guestReady ? 'Ready' : 'Not ready';
    guestStatus.className = `pl-status ${guestAway ? 'away' : guestReady ? 'ready' : ''}`;
  }

  // Buttons and the line of help under them.
  const readyButton = $('#btn-ready');
  readyButton.hidden = isHost;
  readyButton.textContent = s.you.ready ? 'Unready' : 'Ready';
  readyButton.className = s.you.ready ? 'secondary' : 'primary';

  const startButton = $('#btn-start');
  startButton.hidden = !isHost;
  startButton.disabled = !s.canStart;

  let hint;
  if (isHost) {
    if (!s.opponent.joined) hint = 'Keep this tab open until your friend joins.';
    else if (offline) hint = `${s.opponent.name} is offline. You can start when they are back.`;
    else if (!s.opponent.ready) hint = `Waiting for ${s.opponent.name} to get ready.`;
    else hint = `${s.opponent.name} is ready. Start when you like.`;
  } else if (s.you.ready) {
    hint = `You are ready. Waiting for ${hostName} to start the match.`;
  } else {
    hint = `Press Ready when you are set. ${hostName} starts the match.`;
  }
  $('#room-hint').textContent = hint;
}

function render(s) {
  if (s.status === 'waiting' || s.status === 'lobby') {
    renderRoom(s);
    return;
  }

  showView('game');

  if (s.round !== lastRound || s.status !== 'playing') selected = null;
  if (selected && !s.you.legal.includes(selected)) selected = null;
  const roundChanged = s.round !== lastRound;
  lastRound = s.round;

  let status = statusText(s);
  if (opponentOffline(s)) {
    status += ` ${s.opponent.name} is offline. The timer is paused until they are back.`;
  }
  $('#status').textContent = status;

  renderReveal(s);
  lastHistoryLength = s.history.length;
  renderBanner(s);
  if (roundChanged) closeMenus();
  updatePicker(s);
  updateTimer();

  if (roundChanged && s.status === 'playing') notice('');
}

// ----------------------------------------------------------------- rules ----

function renderRules() {
  const chipsFor = (attack) => h('span', { class: 'chips' }, attack.counters.map(chip));
  const rows = rules.attacks.map((attack) =>
    h('tr', {}, h('td', { text: attack.name }), h('td', { text: attack.value }), h('td', {}, chipsFor(attack))),
  );
  const list = (...items) => h('ul', {}, items.map((text) => h('li', { text })));

  $('#rules-body').replaceChildren(
    h('h3', { text: 'The basics' }),
    list(
      'The host creates a room and sends the link. The guest joins, presses Ready, and the host starts the match.',
      'Both players start at 0 and pick a move each round. Moves stay hidden until both players have locked in.',
      'You have 5 seconds each round. If you have not locked in when time runs out, Load is played for you.',
      'Open the Defend or Attack menu to see every move. Tap a move to highlight it, then press Lock in. Double-click or double-tap a move to lock it in at once.',
      'Load adds 1 point to your score.',
      "You can defend at any time. If you are attacked and use a matching defense, the attacker loses points equal to the attack's number.",
      'If you are attacked and do not use a matching defense, including by loading, you lose.',
      'An attack unlocks once your score reaches its number.',
    ),
    h('h3', { text: 'Special rules' }),
    list(
      'Dam against Rebound: the player who used Dam loses.',
      'Touch E against Rebound: the two scores are swapped.',
      "Touch E against any other defense, or against Load: the Touch E player takes the other player's whole score.",
      'Touch E against any other attack: the Touch E player loses.',
      'Both players attack: the bigger attack wins the game. If both use the same attack, each loses that many points and the game goes on.',
    ),
    h('h3', { text: 'Attacks' }),
    h(
      'table',
      { class: 'rules-table' },
      h('caption', { class: 'sr-only', text: 'Attacks, the score that unlocks them, and the defenses that answer them' }),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col', text: 'Attack' }), h('th', { scope: 'col', text: 'Unlocks at' }), h('th', { scope: 'col', text: 'Answered by' }))),
      h('tbody', {}, rows),
    ),
    h('h3', { text: 'Keyboard' }),
    list(
      'Load: L',
      'Defenses: Q Mag, W N.V, E Shield, R Rebound',
      'Attacks: A Path, S Boss, D Dam, F ICY, G Touch E, H Storm, J Beast, K Professor',
      `Menus: ${MENU_KEYS.def.toUpperCase()} opens the Defend menu, ${MENU_KEYS.atk.toUpperCase()} opens the Attack menu. In a menu, the up and down arrows choose a move and Esc closes it.`,
      'Enter locks in your highlighted move.',
    ),
  );
}

// ------------------------------------------------------------ copy link ----

async function copyLink() {
  const input = $('#invite-link');
  const button = $('#btn-copy');
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
  button.textContent = copied ? 'Copied' : 'Press Ctrl+C to copy';
  setTimeout(() => {
    button.textContent = 'Copy link';
  }, 1800);
}

// ---------------------------------------------------------- waiting room ----

async function roomAction(action, body = {}) {
  if (!session || roomBusy) return;
  roomBusy = true;
  notice('');
  try {
    await api(`/api/rooms/${session.code}/${action}`, { method: 'POST', body: { token: session.token, ...body } });
  } catch (err) {
    notice(err.message);
  } finally {
    roomBusy = false;
  }
}

// ------------------------------------------------------------------ keys ----

function onKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  const tag = target && target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'SUMMARY' || tag === 'A') return;
  if (target && target.isContentEditable) return;
  if (!state || state.status !== 'playing' || $('#view-game').hidden) return;

  // Keys that work inside an open menu.
  if (openMenu) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenus();
      return;
    }
    if (event.key === 'Tab') {
      closeMenus(); // the Tab key then moves on as normal
      return;
    }
    const steps = { ArrowDown: 1, ArrowUp: -1, Home: 'first', End: 'last' };
    if (event.key in steps) {
      event.preventDefault();
      if (!event.repeat) stepMenu(steps[event.key]);
      return;
    }
  }

  if (event.repeat) return;

  if (event.key === 'Enter') {
    // Other buttons (Leave, Play again) keep their normal Enter behaviour.
    const isMoveControl = target && (target.classList.contains('move') || target.classList.contains('dd-trigger') || target.id === 'btn-lock');
    if (tag === 'BUTTON' && !isMoveControl) return;
    event.preventDefault();
    lockIn();
    return;
  }

  if (event.key.length !== 1) return;
  const key = event.key.toLowerCase();

  const group = MENU_BY_KEY[key];
  if (group) {
    event.preventDefault();
    if (canActNow()) toggleMenu(group);
    return;
  }

  const id = MOVE_BY_KEY[key];
  if (!id) return;
  event.preventDefault();
  const chosen = chooseMove(id);
  if (chosen) closeMenus();
}

// ------------------------------------------------------------------ init ----

function wireEvents() {
  $('#btn-create').addEventListener('click', createRoom);
  $('#join-form').addEventListener('submit', (event) => {
    event.preventDefault();
    joinRoom($('#code').value);
  });
  $('#code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  $('#name').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!$('#invite-note').hidden) joinRoom($('#code').value);
    else createRoom();
  });
  $('#btn-show-create').addEventListener('click', () => {
    $('#create-block').hidden = false;
    $('#btn-show-create').hidden = true;
    $('#invite-note').hidden = true;
    $('#code').value = '';
    history.replaceState(null, '', location.pathname);
  });

  $('#btn-copy').addEventListener('click', copyLink);
  $('#invite-link').addEventListener('focus', (event) => event.target.select());
  $('#btn-leave').addEventListener('click', leaveRoom);

  // Waiting room.
  $('#btn-ready').addEventListener('click', () => roomAction('ready', { ready: !(state && state.you.ready) }));
  $('#btn-start').addEventListener('click', () => roomAction('start'));

  // Moves: the two menu buttons, and every move inside the picker.
  $('#picker').addEventListener('click', (event) => {
    const trigger = event.target.closest('.dd-trigger');
    if (trigger) {
      if (!trigger.disabled) toggleMenu(trigger.id === 'trig-def' ? 'def' : 'atk');
      return;
    }
    const button = event.target.closest('button.move');
    if (!button || button.disabled) return;
    const fromMenu = button.classList.contains('opt');
    if (!fromMenu) closeMenus();
    pickWithPointer(button.dataset.move, fromMenu);
  });
  document.addEventListener('click', (event) => {
    if (openMenu && !event.target.closest('.dd')) closeMenus();
  });
  $('#btn-lock').addEventListener('click', lockIn);
  document.addEventListener('keydown', onKeyDown);

  $('#btn-rematch').addEventListener('click', () => roomAction('rematch'));
}

async function init() {
  try {
    const stored = localStorage.getItem(NAME_KEY);
    if (stored) $('#name').value = stored;
  } catch {
    /* ignore */
  }

  try {
    rules = await api('/api/rules');
  } catch (err) {
    notice(err.message);
    return;
  }
  moveById = Object.fromEntries([rules.load, ...rules.defenses, ...rules.attacks].map((m) => [m.id, m]));
  rules.attacks.sort((a, b) => a.value - b.value);
  maxScore = rules.attacks[rules.attacks.length - 1].value;

  buildPicker();
  renderRules();
  wireEvents();
  timerLoop = setInterval(updateTimer, 100);

  const hashCode = parseHash();
  const stored = loadSession();
  if (stored && (!hashCode || hashCode === stored.code)) {
    // Resuming after a refresh: hide the lobby until the first state arrives.
    session = stored;
    showView('none');
    connect();
    return;
  }

  showView('lobby');
  playHeroMeter();
  if (hashCode) showInvite(hashCode);
}

init();
