// Hex Men: browser client.
// All game rules come from the server (/api/rules), so the UI never has its
// own copy of them. All user-provided text is inserted with textContent.

import { $, $$, h, plural, moveIcon, preloadMoveArt } from './dom.js';
import { createWheel } from './wheel.js';
import * as teamUi from './team-ui.js';

const SESSION_KEY = 'clash.session'; // per tab, so two tabs can play each other
const NAME_KEY = 'clash.name';
const MODE_KEY = 'clash.create';
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

// Keys that open and close the two wheels.
const MENU_KEYS = { def: 'z', atk: 'x' };
const MENU_BY_KEY = Object.fromEntries(Object.entries(MENU_KEYS).map(([group, key]) => [key, group]));

const DOUBLE_MS = 500; // two clicks or taps on the same move within this time lock it in
const MENU_CLOSE_MS = 600; // the wheel closes this long after a move is picked from it

const GROUPS = {
  def: { trigger: '#trig-def', pick: '#pick-def', art: '#art-def', type: 'defense', label: 'Defend' },
  atk: { trigger: '#trig-atk', pick: '#pick-atk', art: '#art-atk', type: 'attack', label: 'Attack' },
};

// ---------------------------------------------------------------- state ----

let rules = null; // { load, defenses, attacks }
let moveById = {};
let maxScore = 12; // number of cells on the meter
let session = null; // { code, token, seat | id, mode }
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

// The wheel and double-click.
let wheel = null; // created once the rules have loaded
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
  for (const view of ['lobby', 'room', 'team', 'game']) $(`#view-${view}`).hidden = view !== name;
  $('#app').dataset.view = name;
  const inRoom = name !== 'lobby' && name !== 'none';
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
  teamUi.reset();
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
    goToLobby(next.mode === 'team' ? 'Everyone left, so the room was closed.' : `${next.opponent.name || 'The host'} closed the room.`);
    return;
  }
  // The other player left the room (or never came back to the waiting room).
  if (next.mode !== 'team' && state && state.mode !== 'team') {
    if (state.opponent.joined && !next.opponent.joined) {
      notice(`${state.opponent.name} left the room.`);
    } else if (!state.opponent.joined && next.opponent.joined) {
      notice('');
    }
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
  session = { code: info.code, token: info.token, seat: info.seat, id: info.id, mode: info.mode || '1v1' };
  saveSession();
  history.replaceState(null, '', `#${info.code}`);
  notice('');
  connect();
}

// -------------------------------------------------------------- lobby -----

/** What the create form asks for: a 1v1 room, or a team room with its size and wins. */
function createBody() {
  const body = { name: playerName(), mode: selectedMode() };
  if (body.mode === 'team') {
    body.size = Number(document.querySelector('input[name="size"]:checked').value);
    body.target = readTarget();
  }
  saveCreateChoices(body);
  return body;
}

const selectedMode = () => document.querySelector('input[name="mode"]:checked').value;

function readTarget() {
  const { minTarget, maxTarget, defaultTarget } = rules.team;
  const input = $('#target');
  const raw = Math.round(Number(input.value));
  const value = Number.isFinite(raw) && input.value !== '' ? Math.min(maxTarget, Math.max(minTarget, raw)) : defaultTarget;
  input.value = String(value);
  return value;
}

function stepTarget(delta) {
  const { minTarget, maxTarget } = rules.team;
  const next = Math.min(maxTarget, Math.max(minTarget, readTarget() + delta));
  $('#target').value = String(next);
  saveCreateChoices({ mode: selectedMode(), size: Number(document.querySelector('input[name="size"]:checked').value), target: next });
}

function saveCreateChoices(choices) {
  try {
    localStorage.setItem(MODE_KEY, JSON.stringify({ mode: choices.mode, size: choices.size, target: choices.target }));
  } catch {
    /* ignore */
  }
}

function restoreCreateChoices() {
  try {
    const saved = JSON.parse(localStorage.getItem(MODE_KEY) || 'null');
    if (!saved) return;
    if (saved.mode === 'team') document.querySelector('input[name="mode"][value="team"]').checked = true;
    if ([2, 3, 4].includes(saved.size)) document.querySelector(`input[name="size"][value="${saved.size}"]`).checked = true;
    const { minTarget, maxTarget } = rules.team;
    if (Number.isInteger(saved.target) && saved.target >= minTarget && saved.target <= maxTarget) $('#target').value = String(saved.target);
  } catch {
    /* ignore */
  }
}

/** Show the team options only for Team vs Team, and say who the link is for. */
function syncCreateForm() {
  const team = selectedMode() === 'team';
  $('#team-options').hidden = !team;
  $('#create-hint').textContent = team
    ? 'You will get a link to send to your friends. Everyone joins, picks a team and gets ready.'
    : "You'll get a link to send to your opponent.";
}

async function createRoom() {
  if (busy) return;
  busy = true;
  notice('');
  try {
    enterRoom(await api('/api/rooms', { method: 'POST', body: createBody() }));
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
      notice(
        info.mode === 'team'
          ? info.started
            ? 'That team game has already started. Create your own room below.'
            : 'That team room is full. Create your own room below.'
          : 'That room already has two players. Create your own room below.',
      );
      return;
    }
    $('#invite-kind').textContent = info.mode === 'team' ? `the ${info.size}v${info.size} team room` : 'room';
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
  if (playing && state.mode === 'team') {
    const inMatch = !state.spectating;
    const message = inMatch
      ? 'Leave this game? Your match counts as lost and you leave your team.'
      : 'Leave this game? You leave your team and stop watching.';
    if (!window.confirm(message)) return;
  } else if (playing) {
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

/** The colour a move wears: a defense has its own, an attack borrows the first defense that answers it. */
const colorOf = (id) => {
  const move = moveById[id];
  return move.type === 'attack' ? move.counters[0] : move.id;
};

/** Put a move's picture into `container` (or empty it). Leaves it alone if it is already showing. */
function setArt(container, id) {
  if ((container.dataset.id || '') === (id || '')) return;
  container.dataset.id = id || '';
  container.replaceChildren(...(id ? [moveIcon(id)] : []));
}

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
    moveIcon(move.id, 'load-art'),
    h('span', { class: 'move-name', text: move.name }),
    h('span', { class: 'move-note', text: '+1 point' }),
    keyCap(move.id),
  );
}

// What each wheel shows, in the order the moves sit around it.
let wheelMoves = { def: [], atk: [] };

function buildWheelMoves() {
  const answersOf = (id) => rules.attacks.filter((attack) => attack.counters.includes(id)).map((attack) => attack.name);
  wheelMoves = {
    def: rules.defenses.map((move) => ({
      id: move.id,
      name: move.name,
      value: null,
      colors: [move.id, move.id],
      label: `${move.name}, answers ${answersOf(move.id).join(', ')}, key ${KEYS[move.id].toUpperCase()}`,
    })),
    atk: rules.attacks.map((move) => ({
      id: move.id,
      name: move.name,
      value: move.value,
      colors: [move.counters[0], move.counters[1] || move.counters[0]],
      label: `${move.name}, unlocks at ${move.value}, answered by ${move.counters.map(moveName).join(' or ')}, key ${KEYS[move.id].toUpperCase()}`,
    })),
  };
}

const youLegal = (id) => Boolean(state && state.you && state.you.legal.includes(id));
const pointsMissing = (id) => (state && state.you ? Math.max(0, moveById[id].value - state.you.score) : 0);

function slotInfo(id) {
  const move = moveById[id];
  const locked = move.type === 'attack' && !youLegal(id);
  return { selected: selected === id, locked, note: locked ? `Needs ${pointsMissing(id)} more` : '' };
}

/** The text in the middle of the wheel for the highlighted move. */
function hubInfo(id, group) {
  if (!id) return { name: GROUPS[group].label, sub: group === 'def' ? 'Pick a defense.' : 'Pick an attack.', note: '' };
  const move = moveById[id];
  const key = `Key ${KEYS[id].toUpperCase()}`;
  if (move.type === 'defense') {
    const answers = rules.attacks.filter((attack) => attack.counters.includes(id)).map((attack) => attack.name);
    return { name: move.name, sub: `Answers ${answers.join(', ')}`, note: selected === id ? 'Selected' : key };
  }
  const sub = `Unlocks at ${move.value}. Answered by ${move.counters.map(moveName).join(' or ')}.`;
  if (!youLegal(id)) return { name: move.name, sub, note: `Locked: needs ${pointsMissing(id)} more` };
  return { name: move.name, sub, note: selected === id ? 'Selected' : key };
}

function buildPicker() {
  $('#g-load').replaceChildren(loadButton(rules.load));
  buildWheelMoves();
  for (const [group, key] of Object.entries(MENU_KEYS)) {
    $(`#key-${group}`).textContent = key.toUpperCase();
    $(GROUPS[group].trigger).setAttribute('aria-keyshortcuts', key.toUpperCase());
  }
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  $('#tip').dataset.text = coarse ? 'Double-tap a move to lock it in.' : 'Double-click a move to lock it in.';
  $('#wheel-tip').textContent = coarse
    ? 'Tap a move to pick it. Double-tap to lock it in.'
    : 'Click a move to pick it. Double-click to lock it in.';

  wheel = createWheel({
    layer: $('#wheel'),
    slotInfo,
    hubInfo,
    onPick: (id) => pickWithPointer(id, true),
  });
}

const canActNow = () => Boolean(state) && state.status === 'playing' && !state.spectating && !state.you.locked;

/** The lock bar's text, with the move's picture when there is one. */
function setSelection(text, id = null) {
  setArt($('#sel-art'), id);
  $('#sel-text').textContent = text;
}

function updatePicker(s) {
  const watching = Boolean(s.spectating);
  const canAct = s.status === 'playing' && !s.you.locked && !watching;

  $('#picker').hidden = watching;
  $$('#picker .move').forEach((button) => {
    button.disabled = !canAct;
    button.setAttribute('aria-pressed', String(selected === button.dataset.move));
  });

  for (const [group, parts] of Object.entries(GROUPS)) {
    const pick = selected && moveById[selected].type === parts.type ? selected : null;
    const trigger = $(parts.trigger);
    trigger.classList.toggle('has-pick', Boolean(pick));
    trigger.style.setProperty('--c', pick ? `var(--${colorOf(pick)})` : 'var(--text)');
    $(parts.pick).textContent = pick ? moveName(pick) : 'Choose';
    $(parts.pick).classList.toggle('is-empty', !pick);
    setArt($(parts.art), pick);
    trigger.disabled = !canAct;
    trigger.setAttribute('aria-label', `${parts.label} wheel${pick ? `, ${moveName(pick)} selected` : ''}`);
  }
  if (!canAct) closeMenus();

  $('#tip').textContent = canAct ? $('#tip').dataset.text || '' : '';

  const lockbar = $('#lockbar');
  lockbar.hidden = s.status !== 'playing' || watching;
  const lock = $('#btn-lock');
  if (s.you.locked) {
    setSelection(selected ? `Locked in: ${moveName(selected)}` : 'Locked in', selected);
    lock.disabled = true;
  } else if (selected) {
    setSelection(`Selected: ${moveName(selected)}`, selected);
    lock.disabled = false;
  } else {
    setSelection('Choose a move');
    lock.disabled = true;
  }
  if (wheel && wheel.isOpen) wheel.refresh();
}

/** Show a short message in the lock bar, then go back to the normal label. */
function flashSelection(message) {
  setSelection(message);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    if (state) updatePicker(state);
  }, 1800);
}

// ---------------------------------------------------------- the wheels ----

function openMenuFor(group) {
  if (!canActNow()) return;
  closeMenus();
  openMenu = group;
  $(GROUPS[group].trigger).setAttribute('aria-expanded', 'true');
  const picked = selected && moveById[selected].type === GROUPS[group].type ? selected : null;
  const firstUsable = wheelMoves[group].find((move) => youLegal(move.id));
  wheel.open(group, wheelMoves[group], {
    label: `${GROUPS[group].label} wheel`,
    focusId: picked || (firstUsable && firstUsable.id),
  });
}

function closeMenus() {
  clearTimeout(menuCloseTimer);
  menuCloseTimer = null;
  const group = openMenu;
  openMenu = null;
  if (!wheel) return;
  const hadFocus = wheel.isOpen && $('#wheel').contains(document.activeElement);
  wheel.close();
  for (const parts of Object.values(GROUPS)) $(parts.trigger).setAttribute('aria-expanded', 'false');
  if (hadFocus && group) $(GROUPS[group].trigger).focus({ preventScroll: true });
}

function toggleMenu(group) {
  if (openMenu === group) closeMenus();
  else openMenuFor(group);
}

/** Arrow keys on an open wheel: move the highlight round the ring, and pick that move. */
function stepMenu(step) {
  if (!openMenu || !wheel.isOpen) return;
  // The wheel opens with a move highlighted but not picked. The first arrow
  // press picks what is highlighted, so no move is ever skipped.
  const active = wheel.activeId;
  if (typeof step === 'number' && active && youLegal(active) && active !== selected) {
    chooseMove(active);
    return;
  }
  const id = typeof step === 'number' ? wheel.step(step, youLegal) : wheel.edge(step, youLegal);
  if (id) chooseMove(id);
}

function scheduleMenuClose() {
  clearTimeout(menuCloseTimer);
  menuCloseTimer = setTimeout(closeMenus, MENU_CLOSE_MS);
}

// ----------------------------------------------------- choosing a move ----

/** Highlights a move. Returns true when it is now the selected move. */
function chooseMove(id) {
  if (!canActNow()) return false;
  const move = moveById[id];
  if (!youLegal(id)) {
    // Inside the wheel the middle already says what is missing.
    if (!(wheel && wheel.isOpen)) flashSelection(`${move.name} unlocks at ${move.value}. Your score is ${state.you.score}.`);
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
  if (!canActNow() || !session || locking) return;
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

/** The same sentences for someone watching: names instead of "you". */
function describeWatch(entry, s) {
  const a = s.you.name;
  const b = s.opponent.name;
  const am = moveById[entry.you];
  const bm = moveById[entry.opp];
  const aAttacked = entry.attacker === 'you';
  const [att, dfn] = aAttacked ? [a, b] : [b, a];
  const [atkMove, defMove] = aAttacked ? [am, bm] : [bm, am];
  const [aWins, bWins] = [entry.result === 'win', entry.result === 'lose'];

  switch (entry.kind) {
    case 'quiet':
      if (am.type === 'load' && bm.type === 'load') return 'Both players loaded and gained 1 point.';
      if (am.type !== 'load' && bm.type !== 'load') return 'Both players defended. Nothing changed.';
      if (am.type === 'load') return `${a} loaded and gained 1 point. ${b} defended with ${bm.name}.`;
      return `${b} loaded and gained 1 point. ${a} defended with ${am.name}.`;
    case 'blocked':
      return `${dfn} blocked ${att}'s ${atkMove.name} with ${defMove.name}. ${att} lost ${plural(entry.penalty, 'point')}.`;
    case 'hit': {
      const how = defMove.type === 'load' ? `${dfn} was loading` : `${dfn} used ${defMove.name}`;
      return `${how}, but ${atkMove.name} is only blocked by ${atkMove.counters.map(moveName).join(' or ')}. ${att} wins.`;
    }
    case 'reflect':
      return `${dfn} used Rebound against ${att}'s Dam and reflected it back. ${dfn} wins.`;
    case 'swap':
      return `${dfn} used Rebound against ${att}'s Touch E, so the scores were swapped. ${a} now has ${entry.scores.you} and ${b} has ${entry.scores.opp}.`;
    case 'absorb': {
      const how = defMove.type === 'load' ? `${dfn} was loading` : `${dfn} used ${defMove.name}`;
      const mine = aAttacked ? entry.scores.you : entry.scores.opp;
      return `${how}, so ${att}'s Touch E absorbed their ${plural(entry.absorbed, 'point')}. ${att} now has ${mine}.`;
    }
    case 'touch-loses':
      return `${att} used Touch E, but ${dfn} attacked with ${defMove.name}. Touch E loses to any other attack, so ${dfn} wins.`;
    case 'clash': {
      const [win, lose, wm, lm] = aWins ? [a, b, am, bm] : bWins ? [b, a, bm, am] : [a, b, am, bm];
      return `Both attacked. ${win}'s ${wm.name} (${wm.value}) beat ${lose}'s ${lm.name} (${lm.value}).`;
    }
    case 'clash-same':
      return `Both players used ${am.name}. Each loses ${plural(entry.penalty, 'point')}.`;
    default:
      return '';
  }
}

function timeoutNoteWatch(entry, s) {
  const { you, opp } = entry.timedOut || {};
  if (you && opp) return ' Time ran out for both players, so Load was played for each.';
  if (you) return ` Time ran out for ${s.you.name}, so Load was played for them.`;
  if (opp) return ` Time ran out for ${s.opponent.name}, so Load was played for them.`;
  return '';
}

const describe = (entry, s) =>
  s.spectating ? describeWatch(entry, s) + timeoutNoteWatch(entry, s) : describeCore(entry, s) + timeoutNote(entry, s);

// -------------------------------------------------------------- render ----

function statusText(s) {
  if (s.status === 'finished') return '';
  const opp = s.opponent.name;
  if (s.spectating) {
    const locked = [s.you, s.opponent].filter((p) => p.locked).map((p) => p.name);
    const note = locked.length === 2 ? ' Both have locked in.' : locked.length === 1 ? ` ${locked[0]} has locked in.` : '';
    return `Watching ${s.you.name} vs ${opp}. Round ${s.round}.${note}`;
  }
  if (s.you.locked) return `Locked in. Waiting for ${opp}.`;
  if (s.opponent.locked) return `${opp} has locked in. Your move.`;
  return `Round ${s.round}. Choose your move.`;
}

/** True only once a player in the match has been offline for a few seconds, so
 *  the message doesn't flash while their connection is still opening. */
function opponentOffline(s) {
  const watching = s.status === 'playing' || s.status === 'lobby';
  const away = s.spectating ? !s.you.connected || !s.opponent.connected : s.opponent.joined && !s.opponent.connected;
  const offline = watching && away;
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
  const watching = Boolean(s.spectating);

  $('#ratio-you').textContent = s.you.score;
  $('#ratio-opp').textContent = s.opponent.score;
  $('#ratio').setAttribute(
    'aria-label',
    watching ? `Score: ${s.you.name} ${s.you.score}, ${s.opponent.name} ${s.opponent.score}` : `Score: you ${s.you.score}, ${s.opponent.name} ${s.opponent.score}`,
  );
  $('#ratio-key').textContent = watching ? `${s.you.name} : ${s.opponent.name}` : `You : ${s.opponent.name}`;
  $('#reveal-title').textContent = last ? `Round ${last.round} result` : 'Score';

  $('#clash').hidden = !last;
  if (!last) {
    $('#rv-text').textContent = '';
    return;
  }
  $('#rv-you-name').textContent = watching ? s.you.name : 'You';
  $('#rv-opp-name').textContent = s.opponent.name;
  for (const [side, id] of [['you', last.you], ['opp', last.opp]]) {
    const move = $(`#rv-${side}`);
    move.textContent = moveName(id);
    setArt($(`#rv-${side}-art`), id);
    move.parentElement.className = `played ${side} t-${colorOf(id)}`;
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

/** Team games: the team lobby, order screen, match lobby and end screen. */
function renderTeamStage(s) {
  showView('team');
  selected = null;
  lastRound = null;
  lastHistoryLength = 0;
  offlineSince = null;
  closeMenus();
  $('#timer').hidden = true;
  teamUi.render(s);
}

function render(s) {
  if (s.mode === 'team' && s.status !== 'playing') {
    renderTeamStage(s);
    return;
  }
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
    const away = s.spectating ? 'A player' : s.opponent.name;
    status += ` ${away} is offline. The timer is paused until they are back.`;
  }
  $('#status').textContent = status;
  teamUi.renderStrip(s);

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
  const nameCell = (move) => h('span', { class: 'rule-name' }, moveIcon(move.id, 'rule-art'), move.name);
  const chipsFor = (attack) => h('span', { class: 'chips' }, attack.counters.map(chip));
  const attackRows = rules.attacks.map((attack) =>
    h('tr', {}, h('td', {}, nameCell(attack)), h('td', { text: attack.value }), h('td', {}, chipsFor(attack))),
  );
  const answers = (id) => rules.attacks.filter((attack) => attack.counters.includes(id)).map((attack) => attack.name).join(', ');
  const defenseRows = rules.defenses.map((move) => h('tr', {}, h('td', {}, nameCell(move)), h('td', { text: answers(move.id) })));
  const list = (...items) => h('ul', {}, items.map((text) => h('li', { text })));
  const table = (caption, heads, rows) =>
    h(
      'table',
      { class: 'rules-table' },
      h('caption', { class: 'sr-only', text: caption }),
      h('thead', {}, h('tr', {}, heads.map((text) => h('th', { scope: 'col', text })))),
      h('tbody', {}, rows),
    );

  $('#rules-body').replaceChildren(
    h('h3', { text: 'The basics' }),
    list(
      'The host creates a room and sends the link. In a 1v1 room the guest joins, presses Ready, and the host starts the match.',
      'Both players start at 0 and pick a move each round. Moves stay hidden until both players have locked in.',
      'You have 5 seconds each round. If you have not locked in when time runs out, Load is played for you.',
      'Press Defend or Attack to open a wheel of moves. Click or tap a move to pick it, then press Lock in. Double-click or double-tap a move to lock it in at once.',
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
    h('h3', { text: 'Defenses' }),
    table('Defenses and the attacks they answer', ['Defense', 'Answers'], defenseRows),
    h('h3', { text: 'Attacks' }),
    table('Attacks, the score that unlocks them, and the defenses that answer them', ['Attack', 'Unlocks at', 'Answered by'], attackRows),
    h('h3', { text: 'Team vs Team' }),
    list(
      'The host picks Team vs Team, the team size (2v2, 3v3 or 4v4) and how many wins a team needs (7 to 25).',
      "Everyone starts in Waiting. Press a team's Join button to join it. To switch, press the other team's Join button if it has room, or move to Waiting first.",
      "Player 1 of each team picks the team's name and one of 15 colors. Both teams must be full, and then everyone presses Ready.",
      'Each team secretly sets the order its players will fight in. Any teammate can move players up or down, and the order is final when every teammate confirms. The other team sees nothing until both teams are final.',
      'The match lobby shows both orders and the team score. The two players who are up press Ready, and everyone else watches each round once it is revealed.',
      "The winner of each 1v1 game stays on and wins a point for their team. The loser's team sends its next player, and after the last player it starts again from Player 1. The first team to reach the wins needed takes the game.",
      'Leaving a game in progress counts as a loss for your match. A team with nobody left loses the game.',
    ),
    h('h3', { text: 'Keyboard' }),
    list(
      'Load: L',
      'Defenses: Q Mag, W N.V, E Shield, R Rebound',
      'Attacks: A Path, S Boss, D Dam, F ICY, G Touch E, H Storm, J Beast, K Professor',
      `Wheels: ${MENU_KEYS.def.toUpperCase()} opens the Defend wheel, ${MENU_KEYS.atk.toUpperCase()} opens the Attack wheel. With a wheel open, the arrow keys go round it and pick a move, and Esc closes it.`,
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
  if (!state || state.status !== 'playing' || $('#view-game').hidden || state.spectating) return;

  // Keys that work inside an open wheel.
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
    const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1, Home: 'first', End: 'last' };
    if (event.key in steps) {
      event.preventDefault();
      if (!event.repeat) stepMenu(steps[event.key]);
      return;
    }
  }

  if (event.repeat) return;

  if (event.key === 'Enter') {
    // Other buttons (Leave, Play again) keep their normal Enter behaviour.
    const isMoveControl = target && (target.classList.contains('move') || target.classList.contains('wt') || target.id === 'btn-lock');
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
  for (const radio of $$('input[name="mode"], input[name="size"]')) {
    radio.addEventListener('change', () => {
      syncCreateForm();
      saveCreateChoices({ mode: selectedMode(), size: Number(document.querySelector('input[name="size"]:checked').value), target: readTarget() });
    });
  }
  $('#target-down').addEventListener('click', () => stepTarget(-1));
  $('#target-up').addEventListener('click', () => stepTarget(1));
  $('#target').addEventListener('change', () => stepTarget(0));
  $('#target').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    createRoom();
  });
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

  // Moves: the two wheel buttons, and Load.
  $('#picker').addEventListener('click', (event) => {
    const trigger = event.target.closest('.wt');
    if (trigger) {
      if (!trigger.disabled) toggleMenu(trigger.id === 'trig-def' ? 'def' : 'atk');
      return;
    }
    const button = event.target.closest('button.move');
    if (!button || button.disabled) return;
    closeMenus();
    pickWithPointer(button.dataset.move, false);
  });
  // A click on the faded page around the wheel, or on Close, closes it.
  $('#wheel').addEventListener('click', (event) => {
    if (event.target.closest('.slot')) return;
    if (event.target.closest('#wheel-close') || !event.target.closest('.wheel')) closeMenus();
  });
  $('#btn-lock').addEventListener('click', lockIn);
  document.addEventListener('keydown', onKeyDown);

  $('#btn-rematch').addEventListener('click', () => roomAction('rematch'));
}

/** A team-screen action. Unlike roomAction it never blocks the next click, so
 *  moving a player up twice quickly works. */
async function teamAction(action, body = {}) {
  if (!session) return false;
  try {
    await api(`/api/rooms/${session.code}/${action}`, { method: 'POST', body: { token: session.token, ...body } });
    notice('');
    return true;
  } catch (err) {
    notice(err.message);
    return false;
  }
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
  preloadMoveArt();

  $('#target').min = String(rules.team.minTarget);
  $('#target').max = String(rules.team.maxTarget);
  $('#target').value = String(rules.team.defaultTarget);
  $('#target-hint').textContent = `Pick ${rules.team.minTarget} to ${rules.team.maxTarget}. The first team to win that many matches takes the game.`;
  restoreCreateChoices();
  syncCreateForm();

  teamUi.init({
    act: teamAction,
    teamOptions: rules.team,
    getSession: () => session,
    onLeave: leaveRoom,
    moveName,
  });
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
