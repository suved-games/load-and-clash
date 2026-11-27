// Tournament mode for "Hex Men".
//
// Pure rules: no network, no timers. server.js calls these functions and
// tells them what time it is, who is online and how to pick a random number.
//
// How a tournament runs:
//   lobby     4 or 8 players wait and press Ready. When the room is full and
//             everyone is ready, the bracket is drawn at random.
//   bracket   the tournament is under way. It is played in rounds of matches
//             ("stages"). A stage starts when every player who is up in it has
//             pressed Ready, and the next stage starts only when every match
//             of the current stage is over.
//   over      the final is won. The champion is shown to everybody.
//
// 4 players:  Semi-final 1, Semi-final 2, Final.        (one match at a time)
// 8 players:  two groups of 4. Stage 1: the first match of each group, at the
//             same time. Stage 2: the second match of each group, together.
//             Stage 3: both group finals, together. Stage 4: the grand final.
//
// A match is best of 3 or best of 5 duels. A duel is one full game of Hex Men
// (both players start at 0 points and play until someone wins). Both players
// of a match press Ready before every duel. Players who are not playing watch
// a live match: their own group's if there is one, otherwise any other.
//
// A player who leaves loses their current match, and the opponent moves on.

import { isKnownMove, isLegalMove, legalMoves, resolveRound } from './engine.js';
import { entryView } from './team.js';

export class TournamentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SIZES = Object.freeze([4, 8]);
export const BEST_OF = Object.freeze([3, 5]);
export const DEFAULT_SIZE = 4;
export const DEFAULT_BEST_OF = 3;
export const PLAYER_NAME_MAX = 16;

export function optionsForClient() {
  return {
    sizes: [...SIZES],
    bestOf: [...BEST_OF],
    defaultSize: DEFAULT_SIZE,
    defaultBestOf: DEFAULT_BEST_OF,
  };
}

const other = (seat) => 1 - seat;
const playerById = (room, id) => room.players.find((p) => p.id === id) || null;
export const capacity = (room) => room.size;
export const winsNeededFor = (bestOf) => (bestOf + 1) / 2;

// -------------------------------------------------------------- bracket ----

/** The shape of the bracket. `a` and `b` say who fills each side of a match:
 *  { slot: n } is the nth player drawn, { from: id } is the winner of match `id`. */
function layoutFor(size) {
  if (size === 4) {
    return {
      titles: ['Semi-final 1', 'Semi-final 2', 'Final'],
      columns: [['S1', 'S2'], ['F']],
      matches: [
        { id: 'S1', label: 'Semi-final 1', group: null, stage: 0, a: { slot: 0 }, b: { slot: 1 } },
        { id: 'S2', label: 'Semi-final 2', group: null, stage: 1, a: { slot: 2 }, b: { slot: 3 } },
        { id: 'F', label: 'Final', group: null, stage: 2, a: { from: 'S1' }, b: { from: 'S2' } },
      ],
    };
  }
  return {
    titles: ['First matches', 'Second matches', 'Group finals', 'Grand final'],
    columns: [['A1', 'A2', 'B1', 'B2'], ['AF', 'BF'], ['GF']],
    matches: [
      { id: 'A1', label: 'Group A, match 1', group: 'A', stage: 0, a: { slot: 0 }, b: { slot: 1 } },
      { id: 'B1', label: 'Group B, match 1', group: 'B', stage: 0, a: { slot: 4 }, b: { slot: 5 } },
      { id: 'A2', label: 'Group A, match 2', group: 'A', stage: 1, a: { slot: 2 }, b: { slot: 3 } },
      { id: 'B2', label: 'Group B, match 2', group: 'B', stage: 1, a: { slot: 6 }, b: { slot: 7 } },
      { id: 'AF', label: 'Group A final', group: 'A', stage: 2, a: { from: 'A1' }, b: { from: 'A2' } },
      { id: 'BF', label: 'Group B final', group: 'B', stage: 2, a: { from: 'B1' }, b: { from: 'B2' } },
      { id: 'GF', label: 'Grand final', group: null, stage: 3, a: { from: 'AF' }, b: { from: 'BF' } },
    ],
  };
}

const stageCount = (room) => layoutFor(room.size).titles.length;
const matchById = (room, id) => room.matches.find((m) => m.id === id) || null;
const stageMatches = (room, stage = room.stageIndex) => room.matches.filter((m) => m.stage === stage);

/** Is this side of the match still waiting for an earlier match to finish? */
function slotOpen(room, match, seat) {
  const ref = seat === 0 ? match.a : match.b;
  if (ref.from === undefined) return false;
  const feeder = matchById(room, ref.from);
  return !feeder || feeder.state !== 'done';
}

/** 'A' or 'B' for an 8-player tournament, null otherwise. */
function groupOf(room, id) {
  if (room.size !== 8) return null;
  const index = room.draw.indexOf(id);
  if (index === -1) return null;
  return index < 4 ? 'A' : 'B';
}

function shuffled(items, random) {
  const list = [...items];
  for (let i = list.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// ------------------------------------------------------------- creating ----

function uniqueName(room, name) {
  const taken = new Set(Object.values(room.roster).map((n) => n.toLowerCase()));
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
  if (!player) throw new TournamentError(403, 'You are not a player in this room.');
  return player;
}

export function createTournamentRoom({ code, size, bestOf, roundMs }) {
  if (!SIZES.includes(size)) throw new TournamentError(400, 'Choose a tournament of 4 or 8 players.');
  if (!BEST_OF.includes(bestOf)) throw new TournamentError(400, 'Choose best of 3 or best of 5.');
  return {
    mode: 'tournament',
    code,
    size,
    bestOf,
    winsNeeded: winsNeededFor(bestOf),
    roundMs,
    stage: 'lobby',
    players: [],
    roster: {}, // id -> name, kept for players who have left, so the bracket can still show them
    nextId: 1,
    hostId: null,
    draw: [], // player ids in the order they were drawn
    matches: [],
    stageIndex: 0,
    stageStarted: false,
    champion: null,
    lastActive: Date.now(),
    version: 0,
    connSig: '',
  };
}

/** `player` needs { token, name }. It gets an id and starts not ready. */
export function addPlayer(room, player) {
  if (room.stage !== 'lobby') {
    throw new TournamentError(409, 'That tournament has already started. Ask the host for a new room code.');
  }
  if (room.players.length >= capacity(room)) throw new TournamentError(409, 'This room is full.');
  player.id = room.nextId++;
  player.name = uniqueName(room, player.name);
  player.ready = false;
  player.rematch = false;
  room.players.push(player);
  room.roster[player.id] = player.name;
  if (room.hostId === null) room.hostId = player.id;
  return player;
}

// ---------------------------------------------------------------- lobby ----

export function setReady(room, id, ready) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'lobby') throw new TournamentError(409, 'The tournament has already started.');
  if (typeof ready !== 'boolean') throw new TournamentError(400, 'Say whether you are ready.');
  player.ready = ready;
}

function startTournament(room, ctx) {
  room.draw = shuffled(
    room.players.map((p) => p.id),
    ctx.random || ((n) => Math.floor(Math.random() * n)),
  );
  room.matches = layoutFor(room.size).matches.map((def) => ({
    id: def.id,
    label: def.label,
    group: def.group,
    stage: def.stage,
    a: def.a,
    b: def.b,
    players: [def.a.slot !== undefined ? room.draw[def.a.slot] : null, def.b.slot !== undefined ? room.draw[def.b.slot] : null],
    state: 'pending', // pending -> ready <-> live -> done
    ready: [false, false],
    wins: [0, 0],
    duelsPlayed: 0,
    game: null,
    lastDuel: null,
    winner: null, // seat
    winnerId: null,
    forfeit: false,
  }));
  room.stageIndex = 0;
  room.stageStarted = false;
  room.champion = null;
  room.stage = 'bracket';
  for (const p of room.players) p.rematch = false;
  refreshStates(room);
}

// ------------------------------------------------------------- matches ----

/** Matches whose players are known and whose stage has come are 'ready'. */
function refreshStates(room) {
  for (const m of room.matches) {
    if (m.state === 'done' || m.state === 'live') continue;
    const known = m.players[0] !== null && m.players[1] !== null && !slotOpen(room, m, 0) && !slotOpen(room, m, 1);
    m.state = m.stage === room.stageIndex && known ? 'ready' : 'pending';
  }
}

function finishMatch(room, match, winnerSeat, { forfeit = false } = {}) {
  match.state = 'done';
  match.winner = winnerSeat;
  match.winnerId = winnerSeat === null ? null : match.players[winnerSeat];
  match.forfeit = forfeit;
  match.game = null;
  match.ready = [false, false];
  for (const next of room.matches) {
    if (next.a.from === match.id) next.players[0] = match.winnerId;
    if (next.b.from === match.id) next.players[1] = match.winnerId;
  }
}

/** A match with only one player left (or none) is decided without playing. */
function settleByes(room) {
  let changed = false;
  let again = true;
  while (again) {
    again = false;
    for (const m of room.matches) {
      if (m.state === 'done') continue;
      if (slotOpen(room, m, 0) || slotOpen(room, m, 1)) continue;
      const present = [0, 1].filter((seat) => m.players[seat] !== null);
      if (present.length === 2) continue;
      finishMatch(room, m, present.length === 1 ? present[0] : null, { forfeit: true });
      again = true;
      changed = true;
    }
  }
  return changed;
}

function startDuel(match) {
  match.game = { scores: [0, 0], pending: [null, null], round: 1, history: [], deadline: null };
  match.state = 'live';
  match.ready = [false, false];
}

/** The match this player is up in during the current stage, if it is not over. */
export function currentMatchOf(room, id) {
  return stageMatches(room).find((m) => m.state !== 'done' && m.players.includes(id)) || null;
}

export function setMatchReady(room, id, ready) {
  requirePlayer(room, id);
  if (room.stage !== 'bracket') throw new TournamentError(409, 'There is no match to get ready for.');
  if (typeof ready !== 'boolean') throw new TournamentError(400, 'Say whether you are ready.');
  const match = currentMatchOf(room, id);
  if (!match || match.state !== 'ready') {
    throw new TournamentError(403, 'You are not up right now. Watch the match and wait for your turn.');
  }
  match.ready[match.players.indexOf(id)] = ready;
}

const isOnline = (room, ctx, id) => {
  const player = playerById(room, id);
  return Boolean(player) && ctx.online(player);
};

/** Moves the tournament on whenever its conditions are met. Returns true if anything changed. */
export function advance(room, ctx) {
  let changed = false;

  if (room.stage === 'lobby') {
    if (room.players.length === room.size && room.players.every((p) => p.ready && ctx.online(p))) {
      startTournament(room, ctx);
      changed = true;
    } else {
      return false;
    }
  }
  if (room.stage !== 'bracket') return changed;

  for (let guard = 0; guard < 50; guard++) {
    let step = false;
    if (settleByes(room)) step = true;
    refreshStates(room);

    const matches = stageMatches(room);
    if (matches.every((m) => m.state === 'done')) {
      if (room.stageIndex === stageCount(room) - 1) {
        room.champion = matches[0].winnerId;
        room.stage = 'over';
        for (const p of room.players) p.rematch = false;
        return true;
      }
      room.stageIndex += 1;
      room.stageStarted = false;
      refreshStates(room);
      changed = true;
      continue;
    }

    const bothReady = (m) => m.state === 'ready' && m.ready[0] && m.ready[1] && m.players.every((id) => isOnline(room, ctx, id));
    if (!room.stageStarted) {
      // All matches of a stage start together, once every player who is up is ready.
      const open = matches.filter((m) => m.state !== 'done');
      if (open.length > 0 && open.every(bothReady)) {
        room.stageStarted = true;
        for (const m of open) startDuel(m);
        step = true;
      }
    } else {
      // After that, each match goes on at its own pace: its next duel starts when both players are ready.
      for (const m of matches) {
        if (bothReady(m)) {
          startDuel(m);
          step = true;
        }
      }
    }
    if (step) changed = true;
    else break;
  }
  return changed;
}

// ------------------------------------------------------------------ duels ----

function finishDuel(room, match, winnerSeat) {
  const game = match.game;
  match.wins[winnerSeat] += 1;
  match.duelsPlayed += 1;
  const last = game.history[game.history.length - 1] || null;
  match.lastDuel = {
    number: match.duelsPlayed,
    winnerSeat,
    names: match.players.map((id) => room.roster[id]),
    rounds: game.history.length,
    last: last ? { ...last } : null,
  };
  match.game = null;
  match.ready = [false, false];
  if (match.wins[winnerSeat] >= room.winsNeeded) finishMatch(room, match, winnerSeat);
  else match.state = 'ready'; // both players press Ready before the next duel
}

function settleRound(room, match, ctx, timedOut = [false, false]) {
  const game = match.game;
  const moves = [game.pending[0], game.pending[1]];
  const outcome = resolveRound(moves, game.scores);
  game.scores = outcome.scores;
  game.history.push({
    round: game.round,
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
  game.pending = [null, null];
  game.deadline = null;
  if (outcome.finished) {
    finishDuel(room, match, outcome.winner);
    return;
  }
  game.round += 1;
  if (match.players.every((id) => isOnline(room, ctx, id))) game.deadline = ctx.now + room.roundMs;
}

export function liveMatches(room) {
  return room.matches.filter((m) => m.state === 'live');
}

export function playMove(room, id, move, round, ctx) {
  requirePlayer(room, id);
  if (room.stage !== 'bracket') throw new TournamentError(409, 'There is no match in progress.');
  const match = liveMatches(room).find((m) => m.players.includes(id));
  if (!match) {
    throw new TournamentError(409, currentMatchOf(room, id)
      ? 'Your duel has not started yet. Press Ready first.'
      : 'You are watching. Only the two players of a match pick moves.');
  }
  const game = match.game;
  const seat = match.players.indexOf(id);
  if (round !== undefined && round !== game.round) {
    throw new TournamentError(409, 'That round already ended. Choose your move for the new round.');
  }
  if (game.pending[seat] !== null) throw new TournamentError(409, 'You already locked in a move this round.');
  if (!isKnownMove(move)) throw new TournamentError(400, 'Unknown move.');
  if (!isLegalMove(move, game.scores[seat])) {
    throw new TournamentError(400, 'That attack is not unlocked yet. Build up your score first.');
  }
  if (game.deadline !== null && ctx.now >= game.deadline) throw new TournamentError(409, 'Time ran out for this round.');
  game.pending[seat] = move;
  if (game.pending[0] !== null && game.pending[1] !== null) settleRound(room, match, ctx);
}

/** Runs the round timer of every live match: starts it, pauses it while a
 *  player is offline, and plays Load for anyone who has not locked in. */
export function syncTimer(room, ctx) {
  if (room.stage !== 'bracket') return false;
  let changed = false;
  for (const match of liveMatches(room)) {
    const game = match.game;
    const both = match.players.every((id) => isOnline(room, ctx, id));
    if (!both) {
      if (game.deadline !== null) {
        game.deadline = null;
        changed = true;
      }
    } else if (game.deadline === null) {
      game.deadline = ctx.now + room.roundMs;
      changed = true;
    } else if (ctx.now >= game.deadline) {
      const timedOut = [game.pending[0] === null, game.pending[1] === null];
      for (let seat = 0; seat < 2; seat++) if (game.pending[seat] === null) game.pending[seat] = 'load';
      settleRound(room, match, ctx, timedOut);
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------- leaving / rematch ----

/** A player leaves, or has been away too long. They lose their current match
 *  and their opponent moves on. */
export function removePlayer(room, id) {
  const player = playerById(room, id);
  if (!player) return;
  room.players = room.players.filter((p) => p.id !== id);
  if (room.hostId === id) room.hostId = room.players.length ? room.players[0].id : null;
  if (room.players.length === 0) {
    room.stage = 'closed';
    return;
  }
  if (room.stage !== 'bracket') return;
  for (const m of room.matches) {
    if (m.state === 'done') continue;
    const seat = m.players.indexOf(id);
    if (seat === -1) continue;
    if (m.state === 'ready' || m.state === 'live') finishMatch(room, m, other(seat), { forfeit: true });
    else m.players[seat] = null; // they had already won their way into a later match
  }
}

function resetToLobby(room) {
  room.stage = 'lobby';
  room.draw = [];
  room.matches = [];
  room.stageIndex = 0;
  room.stageStarted = false;
  room.champion = null;
  for (const p of room.players) {
    p.ready = false;
    p.rematch = false;
  }
}

/** Back to the waiting lobby (same room) once every player has asked for it. */
export function requestRematch(room, id) {
  const player = requirePlayer(room, id);
  if (room.stage !== 'over') throw new TournamentError(409, 'The tournament is not over yet.');
  player.rematch = true;
  if (room.players.every((p) => p.rematch)) resetToLobby(room);
}

// ---------------------------------------------------------------- views ----

/** Which live match should this person watch? Their own group's, else any. */
function matchToWatch(room, viewer) {
  const live = liveMatches(room);
  const mine = live.find((m) => m.players.includes(viewer.id));
  if (mine) return mine;
  const group = groupOf(room, viewer.id);
  return live.find((m) => group !== null && m.group === group) || live[0] || null;
}

/** What one player is allowed to see. Nobody sees a move before the round is revealed. */
export function viewFor(room, viewer, ctx) {
  const { now, online } = ctx;
  const inBracket = room.stage === 'bracket';
  const layout = layoutFor(room.size);
  const myMatch = inBracket ? currentMatchOf(room, viewer.id) : null;
  const watched = inBracket ? matchToWatch(room, viewer) : null;

  // Which screen this player is on.
  let screen = room.stage; // lobby, over or closed
  if (inBracket) {
    if (myMatch && myMatch.state === 'live') screen = 'playing';
    else if (myMatch && myMatch.state === 'ready' && room.stageStarted) screen = 'matchlobby';
    else if (watched) screen = 'playing';
    else screen = 'bracket';
  }

  const playerView = (p) => ({
    id: p.id,
    name: p.name,
    online: online(p),
    ready: p.ready,
    rematch: p.rematch,
    isYou: p.id === viewer.id,
    isHost: p.id === room.hostId,
  });

  const slotView = (m, seat) => {
    const id = m.players[seat];
    if (id !== null) {
      const p = playerById(room, id);
      return {
        id,
        name: room.roster[id],
        online: p ? online(p) : false,
        isYou: id === viewer.id,
        left: !p,
        ready: m.state === 'ready' ? m.ready[seat] : false,
      };
    }
    const ref = seat === 0 ? m.a : m.b;
    if (slotOpen(room, m, seat)) {
      const feeder = matchById(room, ref.from);
      return { id: null, name: null, waitingFor: feeder ? feeder.label : null };
    }
    return { id: null, name: null, bye: true };
  };

  const matchView = (m) => ({
    id: m.id,
    label: m.label,
    group: m.group,
    stage: m.stage,
    state: m.state,
    current: m.stage === room.stageIndex,
    duelsPlayed: m.duelsPlayed,
    wins: [...m.wins],
    winnerSeat: m.winner,
    forfeit: m.forfeit,
    slots: [slotView(m, 0), slotView(m, 1)],
  });

  const view = {
    mode: 'tournament',
    code: room.code,
    version: room.version,
    serverNow: now,
    roundMs: room.roundMs,
    stage: room.stage,
    status: screen,
    screen,
    size: room.size,
    bestOf: room.bestOf,
    winsNeeded: room.winsNeeded,
    capacity: capacity(room),
    me: {
      id: viewer.id,
      name: viewer.name,
      ready: viewer.ready,
      rematch: viewer.rematch,
      isHost: viewer.id === room.hostId,
      group: groupOf(room, viewer.id),
      matchId: myMatch ? myMatch.id : null,
    },
    players: room.players.map(playerView),
    titles: layout.titles,
    columns: layout.columns,
    stageNo: room.stageIndex,
    stageStarted: room.stageStarted,
    matches: room.matches.map(matchView),
    // The matches of the stage that just ended, for the advancement screen.
    results:
      inBracket && room.stageIndex > 0
        ? stageMatches(room, room.stageIndex - 1).map((m) => ({
            id: m.id,
            label: m.label,
            winner: m.winnerId === null ? null : room.roster[m.winnerId],
            loser: m.winnerId === null ? null : room.roster[m.players[other(m.winner)]] ?? null,
            wins: [...m.wins],
            forfeit: m.forfeit,
          }))
        : [],
    champion: room.champion === null ? null : { id: room.champion, name: room.roster[room.champion], isYou: room.champion === viewer.id },
    myMatch: null,
    watching: null,
    // Match fields, in the same shape the one-on-one screen uses.
    round: 0,
    deadline: null,
    spectating: false,
    result: null,
  };

  if (myMatch && screen === 'matchlobby') {
    const seat = myMatch.players.indexOf(viewer.id);
    view.myMatch = {
      id: myMatch.id,
      label: myMatch.label,
      seat,
      duelNo: myMatch.duelsPlayed + 1,
      wins: [...myMatch.wins],
      names: myMatch.players.map((id) => room.roster[id]),
      ready: [...myMatch.ready],
      lastDuel: myMatch.lastDuel
        ? {
            number: myMatch.lastDuel.number,
            winnerSeat: myMatch.lastDuel.winnerSeat,
            names: myMatch.lastDuel.names,
            rounds: myMatch.lastDuel.rounds,
            last: myMatch.lastDuel.last ? entryView(myMatch.lastDuel.last, 0) : null,
          }
        : null,
    };
  }

  if (screen === 'playing' && watched) {
    const game = watched.game;
    const mySeat = watched.players.indexOf(viewer.id);
    const spectating = mySeat === -1;
    const near = spectating ? 0 : mySeat; // spectators watch from the first side
    const far = other(near);
    const nearId = watched.players[near];
    const farId = watched.players[far];
    const nearPlayer = playerById(room, nearId);
    const farPlayer = playerById(room, farId);
    view.round = game.round;
    view.deadline = game.deadline;
    view.spectating = spectating;
    view.watching = {
      id: watched.id,
      label: watched.label,
      group: watched.group,
      duelNo: watched.duelsPlayed + 1,
      wins: { you: watched.wins[near], opp: watched.wins[far] },
      sameGroup: spectating && groupOf(room, viewer.id) !== null && groupOf(room, viewer.id) === watched.group,
      others: liveMatches(room).filter((m) => m.id !== watched.id).length,
    };
    view.you = {
      name: room.roster[nearId],
      seat: near,
      score: game.scores[near],
      locked: game.pending[near] !== null,
      legal: spectating ? [] : legalMoves(game.scores[near]),
      connected: nearPlayer ? online(nearPlayer) : false,
      wantsRematch: false,
    };
    view.opponent = {
      name: room.roster[farId],
      seat: far,
      joined: true,
      connected: farPlayer ? online(farPlayer) : false,
      score: game.scores[far],
      locked: game.pending[far] !== null,
      wantsRematch: false,
    };
    view.history = game.history.map((entry) => entryView(entry, near));
  }
  return view;
}
