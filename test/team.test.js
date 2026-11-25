import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COLORS,
  TeamError,
  addPlayer,
  advance,
  chooseTeam,
  contrast,
  createTeamRoom,
  currentPlayers,
  movePlayer,
  playMove,
  removePlayer,
  requestRematch,
  setConfirm,
  setMatchReady,
  setReady,
  setStyle,
  syncTimer,
  viewFor,
} from '../src/team.js';

// ------------------------------------------------------------- helpers ----

const ctxAt = (now = 1000, offline = new Set()) => ({ now, online: (p) => !offline.has(p.id) });
const throwsTeam = (fn, status) =>
  assert.throws(fn, (err) => err instanceof TeamError && (status === undefined || err.status === status));

function newRoom(size = 2, target = 7) {
  return createTeamRoom({ code: 'ABCDE', size, target, roundMs: 5000 });
}

function join(room, name) {
  return addPlayer(room, { token: `token-${name}`, name, streams: new Set(), lastPoll: 0 });
}

/** Red = R1..Rn, Blue = B1..Bn, in that join order. */
function fullRoom(size = 2, target = 7) {
  const room = newRoom(size, target);
  const red = [];
  const blue = [];
  for (let i = 1; i <= size; i++) {
    red.push(join(room, `R${i}`));
    blue.push(join(room, `B${i}`));
  }
  for (const p of red) chooseTeam(room, p.id, 0);
  for (const p of blue) chooseTeam(room, p.id, 1);
  return { room, red, blue };
}

/** All ready, order confirmed unchanged: ends in the match lobby. */
function lobbyRoom(size = 2, target = 7) {
  const made = fullRoom(size, target);
  const ctx = ctxAt();
  for (const p of made.room.players) setReady(made.room, p.id, true);
  assert.equal(advance(made.room, ctx), true);
  for (const p of made.room.players) setConfirm(made.room, p.id, true);
  assert.equal(made.room.stage, 'matchlobby');
  return { ...made, ctx };
}

function startMatch(room, ctx) {
  for (const p of currentPlayers(room)) setMatchReady(room, p.id, true);
  assert.equal(advance(room, ctx), true);
  assert.equal(room.stage, 'playing');
}

/** Plays one quick game: both load, then the winner attacks with Path while the loser loads. */
function playGame(room, ctx, winnerTeam) {
  const [a, b] = room.match.players;
  playMove(room, a, 'load', 1, ctx);
  playMove(room, b, 'load', 1, ctx);
  playMove(room, room.match.players[winnerTeam], 'path', 2, ctx);
  playMove(room, room.match.players[1 - winnerTeam], 'load', 2, ctx);
}

// -------------------------------------------------------------- set-up ----

test('a team room needs a team size of 2, 3 or 4 and 7 to 25 wins', () => {
  for (const size of [2, 3, 4]) assert.equal(newRoom(size).size, size);
  for (const size of [1, 5, '3', undefined]) {
    throwsTeam(() => createTeamRoom({ code: 'A', size, target: 10, roundMs: 5000 }), 400);
  }
  for (const target of [7, 10, 25]) assert.equal(newRoom(2, target).target, target);
  for (const target of [6, 26, 7.5, '10', undefined]) {
    throwsTeam(() => createTeamRoom({ code: 'A', size: 2, target, roundMs: 5000 }), 400);
  }
});

test('there are 15 distinct colours, each with readable text on top', () => {
  assert.equal(COLORS.length, 15);
  assert.equal(new Set(COLORS.map((c) => c.id)).size, 15);
  assert.equal(new Set(COLORS.map((c) => c.hex)).size, 15);
  for (const color of COLORS) {
    assert.match(color.hex, /^#[0-9a-f]{6}$/);
    assert.ok(contrast(color.hex, color.ink) >= 3.5, `${color.id} text contrast`);
  }
});

test('the room holds exactly two teams worth of players, and the first is the host', () => {
  const room = newRoom(2);
  const first = join(room, 'Asha');
  for (const name of ['B', 'C', 'D']) join(room, name);
  assert.equal(room.hostId, first.id);
  throwsTeam(() => join(room, 'E'), 409);
  assert.equal(room.players.length, 4);
});

test('players with the same name get a number added', () => {
  const room = newRoom(3);
  join(room, 'Ravi');
  const second = join(room, 'ravi');
  const third = join(room, 'Ravi');
  assert.equal(second.name, 'ravi 2');
  assert.equal(third.name, 'Ravi 3');
});

test('everybody starts in the waiting section', () => {
  const room = newRoom(2);
  const p = join(room, 'Asha');
  assert.equal(p.team, null);
  assert.deepEqual(room.teams.map((t) => t.members), [[], []]);
});

// -------------------------------------------------------------- lobby ----

test('players join a team, and a full team turns people away', () => {
  const room = newRoom(2);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => join(room, n));
  chooseTeam(room, a.id, 0);
  chooseTeam(room, b.id, 0);
  throwsTeam(() => chooseTeam(room, c.id, 0), 409);
  assert.deepEqual(room.teams[0].members, [a.id, b.id]);
  chooseTeam(room, c.id, 1);
  assert.equal(c.team, 1);
});

test('a player can switch straight to the other team when it has room, or via the waiting section', () => {
  const room = newRoom(2);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => join(room, n));
  chooseTeam(room, a.id, 0);
  chooseTeam(room, b.id, 1);
  chooseTeam(room, c.id, 1);
  chooseTeam(room, a.id, 1 - 1 === 0 ? 0 : 1); // already there: nothing happens
  throwsTeam(() => chooseTeam(room, a.id, 1), 409); // Team 2 is full

  chooseTeam(room, c.id, null); // c steps out to the waiting section
  assert.equal(c.team, null);
  chooseTeam(room, a.id, 1); // a takes the free spot
  chooseTeam(room, c.id, 0); // and c fills the spot a left
  assert.deepEqual(room.teams.map((t) => t.members.length), [1, 2]);
  assert.equal(room.teams[0].members[0], c.id);
});

test('changing team clears Ready; Ready needs a team', () => {
  const room = newRoom(2);
  const a = join(room, 'A');
  throwsTeam(() => setReady(room, a.id, true), 409);
  chooseTeam(room, a.id, 0);
  setReady(room, a.id, true);
  assert.equal(a.ready, true);
  chooseTeam(room, a.id, 1);
  assert.equal(a.ready, false);
  throwsTeam(() => setReady(room, a.id, 'yes'), 400);
  throwsTeam(() => chooseTeam(room, a.id, 2), 400);
});

test('the game moves on only when both teams are full and everyone is ready and online', () => {
  const { room, red, blue } = fullRoom(2);
  const everyone = [...red, ...blue];
  for (const p of everyone.slice(0, 3)) setReady(room, p.id, true);
  assert.equal(advance(room, ctxAt()), false);

  setReady(room, everyone[3].id, true);
  assert.equal(advance(room, ctxAt(1000, new Set([everyone[3].id]))), false, 'an offline player blocks it');
  assert.equal(room.stage, 'teams');
  assert.equal(advance(room, ctxAt()), true);
  assert.equal(room.stage, 'order');
});

test('a team that is not full cannot start, even if everyone is ready', () => {
  const room = newRoom(2);
  const players = ['A', 'B', 'C'].map((n) => join(room, n));
  chooseTeam(room, players[0].id, 0);
  chooseTeam(room, players[1].id, 0);
  chooseTeam(room, players[2].id, 1);
  for (const p of players) setReady(room, p.id, true);
  assert.equal(advance(room, ctxAt()), false);
});

test('a waiting player blocks the start', () => {
  const { room, red, blue } = fullRoom(2);
  chooseTeam(room, blue[1].id, null);
  for (const p of [...red, blue[0]]) setReady(room, p.id, true);
  assert.equal(advance(room, ctxAt()), false);
});

// --------------------------------------------------------- name, colour ----

test('Player 1 of a team sets its name and colour, and nobody else', () => {
  const { room, red, blue } = fullRoom(2);
  setStyle(room, red[0].id, { name: '  The   Rockets <b> ', color: 'orange' });
  assert.equal(room.teams[0].name, 'The Rockets b');
  assert.equal(room.teams[0].color, 'orange');
  throwsTeam(() => setStyle(room, red[1].id, { name: 'Nope' }), 403);
  throwsTeam(() => setStyle(room, blue[1].id, { color: 'green' }), 403);
  setStyle(room, blue[0].id, { color: 'green' });
  assert.equal(room.teams[1].color, 'green');
});

test('team names can be any text up to 20 characters, but not empty or the same as the other team', () => {
  const { room, red, blue } = fullRoom(2);
  setStyle(room, red[0].id, { name: 'Ünïcode ⚡ squad of the north' });
  assert.equal(room.teams[0].name.length, 20);
  throwsTeam(() => setStyle(room, red[0].id, { name: '   ' }), 400);
  throwsTeam(() => setStyle(room, blue[0].id, { name: room.teams[0].name.toUpperCase() }), 409);
  assert.equal(room.teams[1].name, 'Team Blue');
});

test('the two teams cannot share a colour, and only the 15 basic colours exist', () => {
  const { room, red, blue } = fullRoom(2);
  throwsTeam(() => setStyle(room, red[0].id, { color: 'blue' }), 409);
  throwsTeam(() => setStyle(room, red[0].id, { color: 'turquoise' }), 400);
  throwsTeam(() => setStyle(room, red[0].id, { color: 5 }), 400);
  setStyle(room, red[0].id, { color: 'pink' });
  setStyle(room, blue[0].id, { color: 'red' }); // red is free now
  assert.deepEqual(room.teams.map((t) => t.color), ['pink', 'red']);
});

test('a player who is not on a team cannot style one', () => {
  const room = newRoom(2);
  const a = join(room, 'A');
  throwsTeam(() => setStyle(room, a.id, { name: 'X' }), 403);
});

// ---------------------------------------------------------- team order ----

function orderRoom(size = 3) {
  const made = fullRoom(size);
  for (const p of made.room.players) setReady(made.room, p.id, true);
  advance(made.room, ctxAt());
  assert.equal(made.room.stage, 'order');
  return made;
}

test('any teammate can reorder; a change clears every confirmation', () => {
  const { room, red } = orderRoom(3);
  setConfirm(room, red[0].id, true);
  setConfirm(room, red[1].id, true);
  movePlayer(room, red[2].id, red[2].id, 'up');
  assert.deepEqual(room.teams[0].members, [red[0].id, red[2].id, red[1].id]);
  assert.deepEqual(room.teams[0].confirmed, []);
  movePlayer(room, red[1].id, red[0].id, 'down');
  assert.deepEqual(room.teams[0].members, [red[2].id, red[0].id, red[1].id]);
  movePlayer(room, red[0].id, red[2].id, 'up'); // already first: nothing happens
  assert.deepEqual(room.teams[0].members, [red[2].id, red[0].id, red[1].id]);
});

test('you cannot reorder the other team, or move someone who is not on your team', () => {
  const { room, red, blue } = orderRoom(2);
  throwsTeam(() => movePlayer(room, red[0].id, blue[0].id, 'down'), 400);
  throwsTeam(() => movePlayer(room, red[0].id, red[1].id, 'sideways'), 400);
});

test('the order is final once every teammate confirms, and the match lobby opens when both teams are final', () => {
  const { room, red, blue } = orderRoom(2);
  setConfirm(room, red[0].id, true);
  assert.equal(room.teams[0].final, false);
  setConfirm(room, red[1].id, true);
  assert.equal(room.teams[0].final, true);
  assert.equal(room.stage, 'order');
  throwsTeam(() => movePlayer(room, red[0].id, red[0].id, 'down'), 409);
  throwsTeam(() => setConfirm(room, red[0].id, false), 409);

  setConfirm(room, blue[0].id, true);
  setConfirm(room, blue[1].id, false);
  assert.equal(room.stage, 'order');
  setConfirm(room, blue[1].id, true);
  assert.equal(room.stage, 'matchlobby');
  assert.deepEqual(room.up, [0, 0]);
  assert.equal(room.score.join('-'), '0-0');
});

test("the other team's order stays hidden until both are final", () => {
  const { room, red, blue } = orderRoom(3);
  // Put Red's players in a different order than the alphabet would give.
  movePlayer(room, red[0].id, red[0].id, 'down');
  movePlayer(room, red[0].id, red[0].id, 'down');
  assert.deepEqual(room.teams[0].members, [red[1].id, red[2].id, red[0].id]);

  const asBlue = viewFor(room, blue[0], ctxAt());
  assert.equal(asBlue.stage, 'order');
  assert.equal(asBlue.teams[0].orderHidden, true);
  assert.deepEqual(asBlue.teams[0].members.map((m) => m.name), ['R1', 'R2', 'R3'], 'listed alphabetically, not in order');
  assert.equal(asBlue.teams[0].up, null);
  assert.equal(asBlue.teams[0].members[0].confirmed, null);
  assert.equal(asBlue.teams[1].orderHidden, false);

  const asRed = viewFor(room, red[0], ctxAt());
  assert.deepEqual(asRed.teams[0].members.map((m) => m.name), ['R2', 'R3', 'R1']);
  assert.equal(asRed.teams[0].members[0].confirmed, false);

  for (const p of room.players) setConfirm(room, p.id, true);
  const later = viewFor(room, blue[0], ctxAt());
  assert.equal(later.stage, 'matchlobby');
  assert.deepEqual(later.teams[0].members.map((m) => m.name), ['R2', 'R3', 'R1']);
  assert.equal(later.teams[0].orderHidden, false);
});

test('the new Player 1 of a reordered team gets the name and colour controls', () => {
  const { room, red } = orderRoom(2);
  assert.equal(viewFor(room, red[0], ctxAt()).me.canStyle, true);
  assert.equal(viewFor(room, red[1], ctxAt()).me.canStyle, false);
  movePlayer(room, red[0].id, red[1].id, 'up');
  assert.equal(viewFor(room, red[0], ctxAt()).me.canStyle, false);
  assert.equal(viewFor(room, red[1], ctxAt()).me.canStyle, true);
  setStyle(room, red[1].id, { name: 'Second wind' });
});

// --------------------------------------------------------- match lobby ----

test('only the two players who are up can press Ready, and the match starts when both do', () => {
  const { room, red, blue, ctx } = lobbyRoom(2);
  throwsTeam(() => setMatchReady(room, red[1].id, true), 403);
  setMatchReady(room, red[0].id, true);
  assert.equal(advance(room, ctx), false);
  setMatchReady(room, blue[0].id, true);
  assert.equal(advance(room, ctxAt(1000, new Set([blue[0].id]))), false, 'the other player must be online');
  assert.equal(advance(room, ctx), true);
  assert.equal(room.stage, 'playing');
  assert.deepEqual(room.match.players, [red[0].id, blue[0].id]);
  assert.equal(room.matchNo, 1);
  assert.equal(red[0].matchReady, false);
});

test('a player can take their Ready back', () => {
  const { room, red, ctx } = lobbyRoom(2);
  setMatchReady(room, red[0].id, true);
  setMatchReady(room, red[0].id, false);
  setMatchReady(room, currentPlayers(room)[1].id, true);
  assert.equal(advance(room, ctx), false);
});

// --------------------------------------------------------------- games ----

test('the winner stays on and the loser team moves to its next player, wrapping round', () => {
  const { room, red, blue, ctx } = lobbyRoom(3, 25);
  const seen = [];
  for (let i = 0; i < 4; i++) {
    startMatch(room, ctx);
    seen.push(room.match.players.map((id) => room.players.find((p) => p.id === id).name).join(' v '));
    playGame(room, ctx, 0); // Red keeps winning
  }
  assert.deepEqual(seen, ['R1 v B1', 'R1 v B2', 'R1 v B3', 'R1 v B1']);
  assert.deepEqual(room.score, [4, 0]);
  assert.deepEqual(room.up, [0, 1]);

  startMatch(room, ctx);
  playGame(room, ctx, 1); // Blue wins this one
  assert.deepEqual(room.score, [4, 1]);
  assert.deepEqual(room.up, [1, 1], 'Red moves on to R2, Blue keeps B2');
  assert.equal(room.stage, 'matchlobby');
  assert.equal(currentPlayers(room).map((p) => p.name).join(' v '), 'R2 v B2');
  assert.equal(room.lastMatch.winnerTeam, 1);
  assert.equal(red.length + blue.length, 6);
});

test('in a 2v2 the order wraps after the second player', () => {
  const { room, ctx } = lobbyRoom(2, 25);
  const faced = [];
  for (let i = 0; i < 3; i++) {
    startMatch(room, ctx);
    faced.push(room.match.names.join(' v '));
    playGame(room, ctx, 0);
  }
  assert.deepEqual(faced, ['R1 v B1', 'R1 v B2', 'R1 v B1']);
});

test('every game starts again at 0-0', () => {
  const { room, ctx } = lobbyRoom(2, 25);
  startMatch(room, ctx);
  playGame(room, ctx, 0);
  startMatch(room, ctx);
  assert.deepEqual(room.match.scores, [0, 0]);
  assert.equal(room.match.round, 1);
});

test('the first team to reach the number of wins takes the game', () => {
  const { room, ctx } = lobbyRoom(2, 7);
  for (let i = 0; i < 6; i++) {
    startMatch(room, ctx);
    playGame(room, ctx, 0);
    assert.equal(room.stage, 'matchlobby');
  }
  startMatch(room, ctx);
  playGame(room, ctx, 0);
  assert.equal(room.stage, 'over');
  assert.equal(room.winner, 0);
  assert.equal(room.overReason, 'target');
  assert.deepEqual(room.score, [7, 0]);
});

test('the winning team can be the second team', () => {
  const { room, ctx } = lobbyRoom(2, 7);
  for (let i = 0; i < 7; i++) {
    startMatch(room, ctx);
    playGame(room, ctx, 1);
  }
  assert.equal(room.winner, 1);
});

// --------------------------------------------------- moves and the timer ----

test('moves are checked: round, unlocked attacks, double lock-in, spectators', () => {
  const { room, red, blue, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  throwsTeam(() => playMove(room, red[0].id, 'professor', 1, ctx), 400);
  throwsTeam(() => playMove(room, red[0].id, 'fireball', 1, ctx), 400);
  throwsTeam(() => playMove(room, red[0].id, 'load', 3, ctx), 409);
  throwsTeam(() => playMove(room, red[1].id, 'load', 1, ctx), 403);
  playMove(room, red[0].id, 'load', 1, ctx);
  throwsTeam(() => playMove(room, red[0].id, 'mag', 1, ctx), 409);
  playMove(room, blue[0].id, 'mag', 1, ctx);
  assert.equal(room.match.round, 2);
  assert.deepEqual(room.match.scores, [1, 0]);
});

test('the round timer starts when both players are online, pauses when one is not, and plays Load on expiry', () => {
  const { room, red, blue, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  const m = room.match;
  assert.equal(m.deadline, null);
  assert.equal(syncTimer(room, ctxAt(2000)), true);
  assert.equal(m.deadline, 7000);
  assert.equal(syncTimer(room, ctxAt(3000)), false);

  assert.equal(syncTimer(room, ctxAt(3500, new Set([blue[0].id]))), true);
  assert.equal(m.deadline, null);
  assert.equal(syncTimer(room, ctxAt(4000)), true);
  assert.equal(m.deadline, 9000);

  playMove(room, red[0].id, 'mag', 1, ctxAt(5000)); // Red locks in, Blue does not
  throwsTeam(() => playMove(room, blue[0].id, 'load', 1, ctxAt(9000)), 409);
  assert.equal(syncTimer(room, ctxAt(9000)), true);
  assert.equal(m.round, 2);
  assert.deepEqual(m.history[0].timedOut, [false, true]);
  assert.deepEqual(m.history[0].moves, ['mag', 'load']);
  assert.deepEqual(m.scores, [0, 1]);
  assert.equal(m.deadline, 14000, 'the next round gets a fresh timer');
});

test('when both run out of time both play Load', () => {
  const { room, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  syncTimer(room, ctxAt(1000));
  syncTimer(room, ctxAt(7000));
  assert.deepEqual(room.match.history[0].timedOut, [true, true]);
  assert.deepEqual(room.match.scores, [1, 1]);
});

test('the timer does nothing outside a match', () => {
  const { room } = lobbyRoom(2);
  assert.equal(syncTimer(room, ctxAt(99999)), false);
});

// ------------------------------------------------------------- views ----

test('spectators see names, scores and who has locked in, but never an unrevealed move', () => {
  const { room, red, blue, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  playMove(room, red[0].id, 'load', 1, ctx);

  const spectator = viewFor(room, red[1], ctx);
  assert.equal(spectator.spectating, true);
  assert.equal(spectator.you.name, 'R1');
  assert.equal(spectator.you.locked, true);
  assert.equal(spectator.opponent.name, 'B1');
  assert.equal(spectator.opponent.locked, false);
  assert.deepEqual(spectator.history, []);
  assert.deepEqual(spectator.you.legal, []);
  assert.doesNotMatch(JSON.stringify(spectator), /"load"/, 'a pending move must not appear anywhere');

  const opponent = viewFor(room, blue[0], ctx);
  assert.equal(opponent.spectating, false);
  assert.equal(opponent.opponent.locked, true);
  // The list of moves you may play naturally names every move; take it out and
  // nothing else may mention the opponent's pending Load.
  assert.doesNotMatch(JSON.stringify({ ...opponent, you: { ...opponent.you, legal: [] } }), /"load"/);
  assert.doesNotMatch(JSON.stringify(opponent), /pending/);

  playMove(room, blue[0].id, 'mag', 1, ctx);
  const revealed = viewFor(room, blue[1], ctx);
  assert.equal(revealed.history.length, 1);
  assert.equal(revealed.history[0].you, 'load');
  assert.equal(revealed.history[0].opp, 'mag');
  assert.equal(revealed.round, 2);
});

test('players see the match from their own side, and spectators from the first team', () => {
  const { room, red, blue, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  assert.equal(viewFor(room, blue[0], ctx).you.name, 'B1');
  assert.equal(viewFor(room, blue[0], ctx).you.team, 1);
  assert.equal(viewFor(room, red[0], ctx).you.name, 'R1');
  assert.equal(viewFor(room, blue[1], ctx).you.name, 'R1');
});

test('the match lobby view lists who is up and what happened last', () => {
  const { room, ctx } = lobbyRoom(2, 25);
  startMatch(room, ctx);
  playGame(room, ctx, 0);
  const view = viewFor(room, room.players[3], ctx);
  assert.equal(view.stage, 'matchlobby');
  assert.deepEqual(view.score, [1, 0]);
  assert.deepEqual(view.current.map((c) => c.name), ['R1', 'B2']);
  assert.equal(view.lastMatch.number, 1);
  assert.equal(view.lastMatch.winnerTeam, 0);
  assert.deepEqual(view.lastMatch.names, ['R1', 'B1']);
  assert.equal(view.lastMatch.last.result, 'win');
  assert.deepEqual(view.teams.map((t) => t.up), [0, 1]);
});

test('the last match records the winning round with both moves, team 1 first, for every viewer', () => {
  const { room, ctx } = lobbyRoom(2, 25);
  startMatch(room, ctx);
  playGame(room, ctx, 1); // team 2's player wins with Path against Load
  for (const player of room.players) {
    const { lastMatch } = viewFor(room, player, ctx);
    assert.equal(lastMatch.winnerTeam, 1);
    assert.equal(lastMatch.forfeit, false);
    assert.equal(lastMatch.last.round, 2);
    assert.equal(lastMatch.last.you, 'load'); // the first team's player
    assert.equal(lastMatch.last.opp, 'path'); // the second team's player
    assert.equal(lastMatch.last.result, 'lose'); // seen from the first team's side
    assert.deepEqual(lastMatch.last.timedOut, { you: false, opp: false });
  }
});

test('the waiting section is listed in the lobby view', () => {
  const room = newRoom(2);
  const a = join(room, 'A');
  join(room, 'B');
  chooseTeam(room, a.id, 0);
  const view = viewFor(room, a, ctxAt());
  assert.deepEqual(view.waiting.map((w) => w.name), ['B']);
  assert.equal(view.me.team, 0);
  assert.equal(view.teams[0].members[0].isYou, true);
});

// ------------------------------------------------------------- leaving ----

test('someone leaving the team lobby just frees their spot, and the host passes on', () => {
  const room = newRoom(2);
  const [a, b] = ['A', 'B'].map((n) => join(room, n));
  chooseTeam(room, a.id, 0);
  removePlayer(room, a.id);
  assert.deepEqual(room.teams[0].members, []);
  assert.equal(room.hostId, b.id);
  assert.equal(room.stage, 'teams');
  join(room, 'C');
  assert.equal(room.players.length, 2);
});

test('the room closes when the last player leaves', () => {
  const room = newRoom(2);
  const a = join(room, 'A');
  removePlayer(room, a.id);
  assert.equal(room.stage, 'closed');
});

test('a player leaving during the order step can finish it for their team', () => {
  const { room, red } = orderRoom(2);
  setConfirm(room, red[0].id, true);
  removePlayer(room, red[1].id);
  assert.equal(room.teams[0].final, true);
});

test('a team with nobody left forfeits', () => {
  const { room, red } = orderRoom(2);
  removePlayer(room, red[0].id);
  assert.equal(room.stage, 'order');
  removePlayer(room, red[1].id);
  assert.equal(room.stage, 'over');
  assert.equal(room.winner, 1);
  assert.equal(room.overReason, 'forfeit');
});

test('leaving between games keeps the right player up', () => {
  const { room, red, blue, ctx } = lobbyRoom(3, 25);
  startMatch(room, ctx);
  playGame(room, ctx, 0); // Blue moves to B2
  startMatch(room, ctx);
  playGame(room, ctx, 0); // Blue moves to B3
  assert.deepEqual(room.up, [0, 2]);

  removePlayer(room, blue[0].id); // someone before the pointer leaves
  assert.deepEqual(room.up, [0, 1]);
  assert.equal(currentPlayers(room)[1].name, 'B3');

  removePlayer(room, blue[2].id); // the player who was up leaves: the next one is up (wrapping)
  assert.equal(currentPlayers(room)[1].name, 'B2');
  assert.equal(room.stage, 'matchlobby');
  assert.equal(red.length, 3);
});

test('a player who leaves mid-game forfeits it and their team does not skip a second player', () => {
  const { room, red, blue, ctx } = lobbyRoom(3, 25);
  startMatch(room, ctx);
  removePlayer(room, blue[0].id); // B1 quits while playing R1
  assert.equal(room.stage, 'matchlobby');
  assert.deepEqual(room.score, [1, 0]);
  assert.equal(room.lastMatch.forfeit, true);
  assert.equal(currentPlayers(room).map((p) => p.name).join(' v '), 'R1 v B2');

  startMatch(room, ctx);
  removePlayer(room, red[0].id); // R1 quits
  assert.deepEqual(room.score, [1, 1]);
  assert.equal(currentPlayers(room).map((p) => p.name).join(' v '), 'R2 v B2');
});

test('a spectator leaving mid-game does not disturb the match', () => {
  const { room, red, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  removePlayer(room, red[1].id);
  assert.equal(room.stage, 'playing');
  assert.equal(room.match.players.length, 2);
});

test('the last player of a team quitting mid-game ends it', () => {
  const { room, red, blue, ctx } = lobbyRoom(2);
  startMatch(room, ctx);
  removePlayer(room, red[1].id);
  removePlayer(room, red[0].id);
  assert.equal(room.stage, 'over');
  assert.equal(room.winner, 1);
  assert.equal(blue.length, 2);
});

// ------------------------------------------------------------- rematch ----

test('a rematch needs everyone and returns to the team lobby with the same teams', () => {
  const { room, red, blue, ctx } = lobbyRoom(2, 7);
  setStyle(room, red[0].id, { name: 'Falcons', color: 'teal' });
  for (let i = 0; i < 7; i++) {
    startMatch(room, ctx);
    playGame(room, ctx, 0);
  }
  assert.equal(room.stage, 'over');
  for (const p of [red[0], red[1], blue[0]]) requestRematch(room, p.id);
  assert.equal(room.stage, 'over');
  requestRematch(room, blue[1].id);
  assert.equal(room.stage, 'teams');
  assert.deepEqual(room.score, [0, 0]);
  assert.equal(room.teams[0].name, 'Falcons');
  assert.equal(room.teams[0].color, 'teal');
  assert.equal(room.teams[0].members.length, 2);
  assert.ok(room.players.every((p) => !p.ready && !p.rematch));
  assert.equal(room.teams[0].final, false);
  throwsTeam(() => requestRematch(room, red[0].id), 409);
});
