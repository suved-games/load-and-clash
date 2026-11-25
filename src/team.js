// Team vs Team mode for "Hex Men".
//
// Pure rules: no network, no timers. server.js calls these functions and
// tells them what time it is and who is online.
//
// How a team game runs:
//   teams        everybody waits, picks Team 1 or Team 2, then presses Ready.
//                When both teams are full and everyone is ready, the order step starts.
//   order        each team privately sets the order its players will fight in.
//                Any teammate can move players up or down; the order becomes final
//                once every teammate on that team has pressed Confirm.
//   matchlobby   both orders are public. The two players who are up press Ready.
//   playing      a normal 1v1 game between those two players. Everyone else watches.
//   over         one team reached the number of wins it needed.
//
// After a 1v1 game the winner stays and wins a point for their team. The loser's
// team moves on to its next player in order (after the last player it starts
// again from the first). Each game starts at 0-0.

import { isKnownMove, isLegalMove, legalMoves, resolveRound } from './engine.js';

export class TeamError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const TEAM_SIZES = Object.freeze([2, 3, 4]);
export const MIN_TARGET = 7;
export const MAX_TARGET = 25;
export const DEFAULT_TARGET = 10;
export const TEAM_NAME_MAX = 20;
export const PLAYER_NAME_MAX = 16;

// ------------------------------------------------------------- colours ----

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const INK_LIGHT = '#ffffff';
const INK_DARK = '#1b1b20';

// The 15 basic colours. `ink` is the text colour that reads best on top of it.
export const COLORS = Object.freeze(
  [
    ['red', 'Red', '#e53935'],
    ['orange', 'Orange', '#f4801a'],
    ['yellow', 'Yellow', '#fbc926'],
    ['lime', 'Lime', '#8fc93a'],
    ['green', 'Green', '#2e9e4f'],
    ['teal', 'Teal', '#0e8f86'],
    ['cyan', 'Cyan', '#12b5d0'],
    ['sky', 'Sky blue', '#3ea6f2'],
    ['blue', 'Blue', '#2563eb'],
    ['navy', 'Navy', '#1c2f6e'],
    ['purple', 'Purple', '#7c3aed'],
    ['pink', 'Pink', '#ec4899'],
    ['brown', 'Brown', '#7b4a2a'],
    ['grey', 'Grey', '#6b7280'],
    ['black', 'Black', '#1b1b20'],
  ].map(([id, name, hex]) =>
    Object.freeze({ id, name, hex, ink: contrast(hex, INK_LIGHT) >= contrast(hex, INK_DARK) ? INK_LIGHT : INK_DARK }),
  ),
);

const COLOR_IDS = new Set(COLORS.map((c) => c.id));

export function optionsForClient() {
  return {
    sizes: [...TEAM_SIZES],
    minTarget: MIN_TARGET,
    maxTarget: MAX_TARGET,
    defaultTarget: DEFAULT_TARGET,
    teamNameMax: TEAM_NAME_MAX,
    colors: COLORS,
  };
}

// --------------------------------------------------------------- helpers ----

const other = (team) => 1 - team;
const playerById = (room, id) => room.players.find((p) => p.id === id) || null;

export const capacity = (room) => room.size * 2;

export function cleanTeamName(raw) {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, TEAM_NAME_MAX);
}

function newTeam(name, color) {
  return { name, color, members: [], confirmed: [], final: false };
}

function uniqueName(room, name) {
  const taken = new Set(room.players.map((p) => p.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; n < 100; n++) {
    const suffix = ` ${n}`;
    const candidate = name.slice(0, PLAYER_NAME_MAX - suffix.length) + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

function requirePlayer(room, id) {
  const player = playerById(room, id);
  if (!player) throw new TeamError(403, 'You are not a player in this room.');
  return player;
}

// ------------------------------------------------------------- creating ----

export function createTeamRoom({ code, size, target, roundMs }) {
  if (!TEAM_SIZES.includes(size)) throw new TeamError(400, 'Choose a team size of 2, 3 or 4 players.');
  if (!Number.isInteger(target) || target < MIN_TARGET || target > MAX_TARGET) {
    throw new TeamError(400, `Wins needed must be a whole number from ${MIN_TARGET} to ${MAX_TARGET}.`);
  }
  return {
    mode: 'team',
    code,
    size,
    target,
    roundMs,
    stage: 'teams',
    players: [],
    nextId: 1,
    hostId: null,
    teams: [newTeam('Team Red', 'red'), newTeam('Team Blue', 'blue')],
    score: [0, 0],
    up: [0, 0], // index in each team's order of the player who is up
    match: null,
    matchNo: 0,
    lastMatch: null,
    winner: null,
    overReason: null,
    lastActive: Date.now(),
    version: 0,
    connSig: '',
  };
}

/** `player` needs { token, name }. It gets an id, and starts in the waiting section. */
export function addPlayer(room, player) {
  if (room.stage !== 'teams') {
    throw new TeamError(409, 'That game has already started. Ask the host for a new room code.');
  }
  if (room.players.length >= capacity(room)) throw new TeamError(409, 'This room is full.');
  player.id = room.nextId++;
  player.name = uniqueName(room, player.name);
  player.team = null;
  player.ready = false;
  player.matchReady = false;
  player.rematch = false;
  room.players.push(player);
  if (room.hostId === null) room.hostId = player.id;
  return player;
}

// ----------------------------------------------------------- team lobby ----

/** Move to Team 1 (0), Team 2 (1) or back to the waiting section (null). */
export function chooseTeam(room, id, team) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'teams') throw new TeamError(409, 'Teams can only be changed before the game begins.');
  if (team !== null && team !== 0 && team !== 1) throw new TeamError(400, 'Choose Team 1, Team 2 or the waiting section.');
  if (player.team === team) return;
  if (team !== null && room.teams[team].members.length >= room.size) {
    throw new TeamError(409, `${room.teams[team].name} is full. Ask someone on it to move to the waiting section first.`);
  }
  if (player.team !== null) {
    const old = room.teams[player.team];
    old.members = old.members.filter((m) => m !== id);
  }
  player.team = team;
  player.ready = false; // a new team means getting ready again
  if (team !== null) room.teams[team].members.push(id);
}

export function setReady(room, id, ready) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'teams') throw new TeamError(409, 'You can only change this in the team lobby.');
  if (typeof ready !== 'boolean') throw new TeamError(400, 'Say whether you are ready.');
  if (ready && player.team === null) throw new TeamError(409, 'Join a team first, then press Ready.');
  player.ready = ready;
}

/** Player 1 of a team (first in its order) sets the name and the colour. */
export function canStyleTeam(room, id, team) {
  return team === 0 || team === 1 ? room.teams[team].members[0] === id : false;
}

export function setStyle(room, id, { name, color } = {}) {
  const player = requirePlayer(room, id);
  if (player.team === null) throw new TeamError(403, 'Join a team first.');
  if (!canStyleTeam(room, id, player.team)) {
    throw new TeamError(403, 'Only Player 1 of the team can change its name and colour.');
  }
  const team = room.teams[player.team];
  const rival = room.teams[other(player.team)];
  let nextName = team.name;
  let nextColor = team.color;
  if (name !== undefined) {
    nextName = cleanTeamName(name);
    if (!nextName) throw new TeamError(400, 'Give your team a name.');
    if (nextName.toLowerCase() === rival.name.toLowerCase()) {
      throw new TeamError(409, 'The other team already uses that name. Pick a different one.');
    }
  }
  if (color !== undefined) {
    if (typeof color !== 'string' || !COLOR_IDS.has(color)) throw new TeamError(400, 'Pick one of the colours shown.');
    if (color === rival.color) throw new TeamError(409, 'The other team already uses that colour. Pick a different one.');
    nextColor = color;
  }
  team.name = nextName;
  team.color = nextColor;
}

// ----------------------------------------------------------- team order ----

function enterOrder(room) {
  room.stage = 'order';
  for (const team of room.teams) {
    team.confirmed = [];
    team.final = false;
  }
  for (const p of room.players) p.ready = false;
}

function enterMatchLobby(room) {
  room.stage = 'matchlobby';
  room.up = [0, 0];
  room.matchNo = 0;
  room.lastMatch = null;
  for (const p of room.players) p.matchReady = false;
}

/** After someone confirms or leaves: is a team finished? Are both? */
function checkOrderDone(room) {
  for (const team of room.teams) {
    if (!team.final && team.members.length > 0 && team.confirmed.length === team.members.length) team.final = true;
  }
  if (room.teams[0].final && room.teams[1].final) enterMatchLobby(room);
}

/** Move `targetId` one place up or down in their own team's order. Any teammate may do it. */
export function movePlayer(room, actorId, targetId, direction) {
  const actor = requirePlayer(room, actorId);
  if (room.stage !== 'order') throw new TeamError(409, 'The order can only be changed on the order screen.');
  if (actor.team === null) throw new TeamError(403, 'You are not on a team.');
  const team = room.teams[actor.team];
  if (team.final) throw new TeamError(409, 'Your team has already finalised its order.');
  if (direction !== 'up' && direction !== 'down') throw new TeamError(400, 'Move a player up or down.');
  const from = team.members.indexOf(targetId);
  if (from === -1) throw new TeamError(400, 'That player is not on your team.');
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= team.members.length) return;
  [team.members[from], team.members[to]] = [team.members[to], team.members[from]];
  team.confirmed = []; // any change means everybody confirms again
}

export function setConfirm(room, id, confirmed) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'order') throw new TeamError(409, 'There is nothing to confirm right now.');
  if (player.team === null) throw new TeamError(403, 'You are not on a team.');
  if (typeof confirmed !== 'boolean') throw new TeamError(400, 'Say whether you confirm the order.');
  const team = room.teams[player.team];
  if (team.final) throw new TeamError(409, 'Your team has already finalised its order.');
  team.confirmed = team.confirmed.filter((m) => m !== id);
  if (confirmed) team.confirmed.push(id);
  checkOrderDone(room);
}

// ---------------------------------------------------------- match lobby ----

/** The two players who are up: [player of team 0, player of team 1]. */
export function currentPlayers(room) {
  return room.teams.map((team, t) => playerById(room, team.members[room.up[t]]));
}

export function setMatchReady(room, id, ready) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'matchlobby') throw new TeamError(409, 'There is no match to get ready for.');
  if (typeof ready !== 'boolean') throw new TeamError(400, 'Say whether you are ready.');
  const [a, b] = currentPlayers(room);
  if (!(a && a.id === id) && !(b && b.id === id)) {
    throw new TeamError(403, 'Only the two players who are up can press Ready. Everyone else watches.');
  }
  player.matchReady = ready;
}

function startMatch(room) {
  const [a, b] = currentPlayers(room);
  room.matchNo += 1;
  room.match = {
    players: [a.id, b.id],
    names: [a.name, b.name],
    scores: [0, 0],
    pending: [null, null],
    round: 1,
    history: [],
    deadline: null,
  };
  room.stage = 'playing';
  for (const p of room.players) p.matchReady = false;
}

/** Moves the game on whenever its conditions are met. Returns true if anything changed. */
export function advance(room, ctx) {
  const { online } = ctx;
  if (room.stage === 'teams') {
    const full = room.teams.every((team) => team.members.length === room.size);
    if (full && room.players.every((p) => p.ready && online(p))) {
      enterOrder(room);
      return true;
    }
  } else if (room.stage === 'matchlobby') {
    const [a, b] = currentPlayers(room);
    if (a && b && a.matchReady && b.matchReady && online(a) && online(b)) {
      startMatch(room);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- match ----

function gameOver(room, winnerTeam, reason) {
  room.stage = 'over';
  room.winner = winnerTeam;
  room.overReason = reason;
  room.match = null;
  for (const p of room.players) {
    p.matchReady = false;
    p.rematch = false;
  }
}

/** The winner stays and earns a point; the loser's team moves on to its next player. */
function finishMatch(room, winnerTeam, { advanceLoser = true, forfeit = false } = {}) {
  const match = room.match;
  const loserTeam = other(winnerTeam);
  room.score[winnerTeam] += 1;
  if (advanceLoser) {
    const count = room.teams[loserTeam].members.length;
    room.up[loserTeam] = count ? (room.up[loserTeam] + 1) % count : 0;
  }
  const last = match.history[match.history.length - 1] || null;
  room.lastMatch = {
    number: room.matchNo,
    winnerTeam,
    names: [...match.names],
    rounds: match.history.length,
    forfeit,
    last: last ? { ...last } : null,
  };
  room.match = null;
  if (room.score[winnerTeam] >= room.target) {
    gameOver(room, winnerTeam, 'target');
  } else {
    room.stage = 'matchlobby';
    for (const p of room.players) p.matchReady = false;
  }
}

function settleRound(room, ctx, timedOut = [false, false]) {
  const match = room.match;
  const moves = [match.pending[0], match.pending[1]];
  const outcome = resolveRound(moves, match.scores);
  match.scores = outcome.scores;
  match.history.push({
    round: match.round,
    moves,
    kind: outcome.kind,
    attacker: outcome.attacker,
    penalty: outcome.penalty,
    absorbed: outcome.absorbed,
    scores: [...outcome.scores],
    finished: outcome.finished,
    winner: outcome.winner,
    timedOut,
  });
  match.pending = [null, null];
  match.deadline = null;
  if (outcome.finished) {
    finishMatch(room, outcome.winner);
    return;
  }
  match.round += 1;
  const [a, b] = match.players.map((id) => playerById(room, id));
  if (a && b && ctx.online(a) && ctx.online(b)) match.deadline = ctx.now + room.roundMs;
}

export function playMove(room, id, move, round, ctx) {
  requirePlayer(room, id);
  const match = room.match;
  if (room.stage !== 'playing' || !match) throw new TeamError(409, 'There is no match in progress.');
  const seat = match.players.indexOf(id);
  if (seat === -1) throw new TeamError(403, 'You are watching this match. Only the two players pick moves.');
  if (round !== undefined && round !== match.round) {
    throw new TeamError(409, 'That round already ended. Choose your move for the new round.');
  }
  if (match.pending[seat] !== null) throw new TeamError(409, 'You already locked in a move this round.');
  if (!isKnownMove(move)) throw new TeamError(400, 'Unknown move.');
  if (!isLegalMove(move, match.scores[seat])) {
    throw new TeamError(400, 'That attack is not unlocked yet. Build up your score first.');
  }
  if (match.deadline !== null && ctx.now >= match.deadline) throw new TeamError(409, 'Time ran out for this round.');
  match.pending[seat] = move;
  if (match.pending[0] !== null && match.pending[1] !== null) settleRound(room, ctx);
}

/** Runs the round timer: starts it, pauses it while a player is offline, and
 *  plays Load for anyone who has not locked in when it runs out. */
export function syncTimer(room, ctx) {
  const match = room.match;
  if (room.stage !== 'playing' || !match) return false;
  const [a, b] = match.players.map((id) => playerById(room, id));
  const both = Boolean(a && b && ctx.online(a) && ctx.online(b));
  if (!both) {
    if (match.deadline === null) return false;
    match.deadline = null;
    return true;
  }
  if (match.deadline === null) {
    match.deadline = ctx.now + room.roundMs;
    return true;
  }
  if (ctx.now >= match.deadline) {
    const timedOut = [match.pending[0] === null, match.pending[1] === null];
    for (let seat = 0; seat < 2; seat++) if (match.pending[seat] === null) match.pending[seat] = 'load';
    settleRound(room, ctx, timedOut);
    return true;
  }
  return false;
}

// ---------------------------------------------------- leaving / rematch ----

/** A player leaves, or has been away too long. The game goes on without them. */
export function removePlayer(room, id) {
  const player = playerById(room, id);
  if (!player) return;
  const match = room.match;
  const matchSeat = room.stage === 'playing' && match ? match.players.indexOf(id) : -1;

  if (player.team !== null) {
    const team = room.teams[player.team];
    const index = team.members.indexOf(id);
    team.members.splice(index, 1);
    team.confirmed = team.confirmed.filter((m) => m !== id);
    if (index !== -1 && index < room.up[player.team]) room.up[player.team] -= 1;
    room.up[player.team] = team.members.length ? room.up[player.team] % team.members.length : 0;
  }
  room.players = room.players.filter((p) => p.id !== id);
  if (room.hostId === id) room.hostId = room.players.length ? room.players[0].id : null;
  if (room.players.length === 0) {
    room.stage = 'closed';
    return;
  }

  if (room.stage === 'order' || room.stage === 'matchlobby' || room.stage === 'playing') {
    const empty = room.teams.findIndex((team) => team.members.length === 0);
    if (empty !== -1) {
      gameOver(room, other(empty), 'forfeit'); // a team with nobody left forfeits
      return;
    }
  }
  if (room.stage === 'order') checkOrderDone(room);
  else if (matchSeat !== -1) finishMatch(room, other(matchSeat), { advanceLoser: false, forfeit: true });
}

function resetToTeams(room) {
  room.stage = 'teams';
  room.score = [0, 0];
  room.up = [0, 0];
  room.match = null;
  room.matchNo = 0;
  room.lastMatch = null;
  room.winner = null;
  room.overReason = null;
  for (const team of room.teams) {
    team.confirmed = [];
    team.final = false;
  }
  for (const p of room.players) {
    p.ready = false;
    p.matchReady = false;
    p.rematch = false;
  }
}

/** Back to the team lobby (same teams) once every player has asked for it. */
export function requestRematch(room, id) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'over') throw new TeamError(409, 'The game is not over yet.');
  player.rematch = true;
  if (room.players.every((p) => p.rematch)) resetToTeams(room);
}

// ---------------------------------------------------------------- views ----

/** One finished round, from the point of view of `seat` (0 or 1). */
export function entryView(entry, seat) {
  const opp = other(seat);
  return {
    round: entry.round,
    you: entry.moves[seat],
    opp: entry.moves[opp],
    kind: entry.kind,
    attacker: entry.attacker === null ? null : entry.attacker === seat ? 'you' : 'opp',
    penalty: entry.penalty,
    absorbed: entry.absorbed,
    timedOut: { you: entry.timedOut[seat], opp: entry.timedOut[opp] },
    scores: { you: entry.scores[seat], opp: entry.scores[opp] },
    result: !entry.finished ? null : entry.winner === seat ? 'win' : 'lose',
  };
}

/** What one player is allowed to see. The other team's order stays hidden until
 *  both orders are final, and nobody sees a move before the round is revealed. */
export function viewFor(room, viewer, ctx) {
  const { now, online } = ctx;
  const stage = room.stage;
  const orderPublic = stage === 'matchlobby' || stage === 'playing' || stage === 'over';

  const memberView = (p, team, showConfirm) => ({
    id: p.id,
    name: p.name,
    online: online(p),
    ready: p.ready,
    matchReady: p.matchReady,
    rematch: p.rematch,
    isYou: p.id === viewer.id,
    isHost: p.id === room.hostId,
    confirmed: showConfirm ? team.confirmed.includes(p.id) : null,
  });

  const teamView = (t) => {
    const team = room.teams[t];
    const own = viewer.team === t;
    const hideOrder = stage === 'order' && !own;
    let members = team.members.map((id) => playerById(room, id)).filter(Boolean);
    if (hideOrder) members = [...members].sort((x, y) => x.name.localeCompare(y.name));
    return {
      index: t,
      name: team.name,
      color: team.color,
      members: members.map((p) => memberView(p, team, own && stage === 'order')),
      orderHidden: hideOrder,
      final: team.final,
      up: orderPublic ? room.up[t] : null,
      score: room.score[t],
    };
  };

  const view = {
    mode: 'team',
    code: room.code,
    version: room.version,
    serverNow: now,
    roundMs: room.roundMs,
    stage,
    status: stage,
    size: room.size,
    target: room.target,
    capacity: capacity(room),
    me: {
      id: viewer.id,
      name: viewer.name,
      team: viewer.team,
      ready: viewer.ready,
      matchReady: viewer.matchReady,
      rematch: viewer.rematch,
      isHost: viewer.id === room.hostId,
      canStyle: viewer.team !== null && canStyleTeam(room, viewer.id, viewer.team),
    },
    teams: [teamView(0), teamView(1)],
    waiting: room.players
      .filter((p) => p.team === null)
      .map((p) => ({ id: p.id, name: p.name, online: online(p), isYou: p.id === viewer.id, isHost: p.id === room.hostId })),
    score: [...room.score],
    matchNo: room.matchNo,
    winner: room.winner,
    overReason: room.overReason,
    lastMatch: room.lastMatch
      ? {
          number: room.lastMatch.number,
          winnerTeam: room.lastMatch.winnerTeam,
          names: room.lastMatch.names,
          rounds: room.lastMatch.rounds,
          forfeit: room.lastMatch.forfeit,
          last: room.lastMatch.last ? entryView(room.lastMatch.last, 0) : null,
        }
      : null,
    current: null,
    // Match fields, in the same shape the one-on-one screen uses.
    round: 0,
    deadline: null,
    spectating: false,
    result: null,
  };

  if (stage === 'matchlobby' || stage === 'playing') {
    view.current = currentPlayers(room).map((p) =>
      p ? { id: p.id, name: p.name, online: online(p), matchReady: p.matchReady, isYou: p.id === viewer.id } : null,
    );
  }

  if (stage === 'playing' && room.match) {
    const match = room.match;
    const mySeat = match.players.indexOf(viewer.id);
    const spectating = mySeat === -1;
    const near = spectating ? 0 : mySeat; // spectators watch from the first team's side
    const far = other(near);
    const nearPlayer = playerById(room, match.players[near]);
    const farPlayer = playerById(room, match.players[far]);
    view.round = match.round;
    view.deadline = match.deadline;
    view.spectating = spectating;
    view.you = {
      name: match.names[near],
      team: near,
      score: match.scores[near],
      locked: match.pending[near] !== null,
      legal: spectating ? [] : legalMoves(match.scores[near]),
      connected: nearPlayer ? online(nearPlayer) : false,
      wantsRematch: false,
    };
    view.opponent = {
      name: match.names[far],
      team: far,
      joined: true,
      connected: farPlayer ? online(farPlayer) : false,
      score: match.scores[far],
      locked: match.pending[far] !== null,
      wantsRematch: false,
    };
    view.history = match.history.map((entry) => entryView(entry, near));
  }
  return view;
}
