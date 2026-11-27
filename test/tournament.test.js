// Tournament mode: draw, brackets, ready rules, best-of matches, leaving, views.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../src/tournament.js';

// A random function that never moves anyone: the draw is then the join order.
const ctxAt = (now = 1000, extra = {}) => ({ now, online: () => true, random: (n) => n - 1, ...extra });

function newRoom(size = 4, bestOf = 3) {
  return T.createTournamentRoom({ code: 'ABCDE', size, bestOf, roundMs: 5000 });
}

function fill(room, count = room.size) {
  for (let i = 1; i <= count; i++) T.addPlayer(room, { token: `t${i}`, name: `P${i}`, streams: new Set() });
  return room;
}

function started(size = 4, bestOf = 3, ctx = ctxAt()) {
  const room = fill(newRoom(size, bestOf));
  for (const p of room.players) T.setReady(room, p.id, true);
  T.advance(room, ctx);
  return { room, ctx };
}

const match = (room, id) => room.matches.find((m) => m.id === id);
const view = (room, id, ctx = ctxAt()) => T.viewFor(room, room.players.find((p) => p.id === id), ctx);

/** Both players of a match press Ready. */
function readyBoth(room, id) {
  for (const pid of match(room, id).players) T.setMatchReady(room, pid, true);
}

/** Starts the current stage: everyone who is up presses Ready. */
function startStage(room, ctx) {
  for (const m of room.matches.filter((x) => x.stage === room.stageIndex && x.state === 'ready')) readyBoth(room, m.id);
  T.advance(room, ctx);
}

/** The winner plays Path against Load, so the duel ends in two rounds. */
function playDuel(room, matchId, winnerId, ctx) {
  const m = match(room, matchId);
  assert.equal(m.state, 'live', `${matchId} should be live`);
  const [a, b] = m.players;
  const loserId = winnerId === a ? b : a;
  T.playMove(room, a, 'load', undefined, ctx);
  T.playMove(room, b, 'load', undefined, ctx);
  T.playMove(room, winnerId, 'path', undefined, ctx);
  T.playMove(room, loserId, 'load', undefined, ctx);
  T.advance(room, ctx);
}

/** Plays a whole match 2-0 (best of 3) or 3-0 (best of 5). The stage must already be running. */
function winMatch(room, matchId, winnerId, ctx) {
  for (let duel = 0; duel < room.winsNeeded; duel++) {
    if (match(room, matchId).state === 'ready') {
      readyBoth(room, matchId);
      T.advance(room, ctx);
    }
    playDuel(room, matchId, winnerId, ctx);
  }
}

// -------------------------------------------------------------- set-up ----

test('a tournament has 4 or 8 players and is best of 3 or best of 5', () => {
  for (const size of [4, 8]) assert.equal(newRoom(size).size, size);
  assert.equal(newRoom(4, 3).winsNeeded, 2);
  assert.equal(newRoom(4, 5).winsNeeded, 3);
  for (const size of [2, 3, 5, 6, 7, 9, '4', undefined]) {
    assert.throws(() => T.createTournamentRoom({ code: 'A', size, bestOf: 3, roundMs: 5000 }), (e) => e.status === 400);
  }
  for (const bestOf of [1, 2, 4, 7, '3', undefined]) {
    assert.throws(() => T.createTournamentRoom({ code: 'A', size: 4, bestOf, roundMs: 5000 }), (e) => e.status === 400);
  }
  assert.deepEqual(T.optionsForClient().sizes, [4, 8]);
  assert.deepEqual(T.optionsForClient().bestOf, [3, 5]);
});

test('players join until the room is full, with unique names; nobody joins once it has started', () => {
  const room = newRoom(4);
  fill(room, 3);
  const dup = T.addPlayer(room, { token: 'x', name: 'P1', streams: new Set() });
  assert.equal(dup.name, 'P1 2');
  assert.throws(() => T.addPlayer(room, { token: 'y', name: 'More', streams: new Set() }), (e) => e.status === 409);
  assert.equal(room.hostId, 1);

  const { room: running } = started(4);
  assert.throws(() => T.addPlayer(running, { token: 'z', name: 'Late', streams: new Set() }), (e) => e.status === 409);
});

test('the bracket is drawn only when the room is full, everyone is ready and everyone is online', () => {
  const room = fill(newRoom(4), 3);
  for (const p of room.players) T.setReady(room, p.id, true);
  assert.equal(T.advance(room, ctxAt()), false);
  assert.equal(room.stage, 'lobby');

  T.addPlayer(room, { token: 't4', name: 'P4', streams: new Set() });
  assert.equal(T.advance(room, ctxAt()), false); // the new player is not ready
  T.setReady(room, 4, true);
  T.setReady(room, 2, false);
  assert.equal(T.advance(room, ctxAt()), false); // Unready works
  T.setReady(room, 2, true);
  assert.equal(T.advance(room, ctxAt(1000, { online: (p) => p.id !== 3 })), false); // someone is offline
  assert.equal(room.stage, 'lobby');
  assert.equal(T.advance(room, ctxAt()), true);
  assert.equal(room.stage, 'bracket');
  assert.throws(() => T.setReady(room, 1, true), (e) => e.status === 409);
});

test('the draw is random: players land in the order the random function gives', () => {
  const room = fill(newRoom(4));
  for (const p of room.players) T.setReady(room, p.id, true);
  T.advance(room, ctxAt(1000, { random: () => 0 })); // always swap with the first
  assert.deepEqual([...room.draw].sort(), [1, 2, 3, 4]);
  assert.notDeepEqual(room.draw, [1, 2, 3, 4]);

  const again = fill(newRoom(8));
  for (const p of again.players) T.setReady(again, p.id, true);
  T.advance(again, ctxAt(1000, { random: (n) => Math.floor(Math.random() * n) }));
  assert.deepEqual([...again.draw].sort((x, y) => x - y), [1, 2, 3, 4, 5, 6, 7, 8]);
});

// ---------------------------------------------------- 4 player tournament ----

test('4 players: semi-final 1, semi-final 2, then the final; both players press Ready before every duel', () => {
  const { room, ctx } = started(4, 3);
  assert.deepEqual(room.matches.map((m) => [m.id, m.state]), [['S1', 'ready'], ['S2', 'pending'], ['F', 'pending']]);
  assert.deepEqual(match(room, 'S1').players, [1, 2]);
  assert.deepEqual(match(room, 'S2').players, [3, 4]);

  // Only the two players who are up can press Ready.
  assert.throws(() => T.setMatchReady(room, 3, true), (e) => e.status === 403);
  assert.equal(view(room, 1).screen, 'bracket');
  assert.equal(view(room, 3).screen, 'bracket');

  T.setMatchReady(room, 1, true);
  assert.equal(T.advance(room, ctx), false); // one is not enough
  T.setMatchReady(room, 1, false);
  T.setMatchReady(room, 1, true);
  T.setMatchReady(room, 2, true);
  assert.equal(T.advance(room, ctx), true);
  assert.equal(match(room, 'S1').state, 'live');
  assert.equal(match(room, 'S2').state, 'pending'); // 4 players: one match at a time

  // The two players play, the others watch.
  assert.equal(view(room, 1).screen, 'playing');
  assert.equal(view(room, 1).spectating, false);
  const watcher = view(room, 3);
  assert.equal(watcher.screen, 'playing');
  assert.equal(watcher.spectating, true);
  assert.equal(watcher.watching.id, 'S1');
  assert.deepEqual(watcher.you.legal, []);

  // Duel 1: P1 wins. The match goes on and both must press Ready again.
  playDuel(room, 'S1', 1, ctx);
  assert.deepEqual(match(room, 'S1').wins, [1, 0]);
  assert.equal(match(room, 'S1').state, 'ready');
  assert.equal(view(room, 1).screen, 'matchlobby');
  assert.equal(view(room, 2).screen, 'matchlobby');
  assert.equal(view(room, 3).screen, 'bracket'); // nothing is live
  const lobby = view(room, 2);
  assert.equal(lobby.myMatch.duelNo, 2);
  assert.deepEqual(lobby.myMatch.wins, [1, 0]);
  assert.equal(lobby.myMatch.lastDuel.number, 1);
  assert.equal(lobby.myMatch.lastDuel.winnerSeat, 0);
  assert.equal(lobby.myMatch.lastDuel.last.you, 'path'); // the winning round, seat 0 first
  assert.equal(lobby.myMatch.lastDuel.last.opp, 'load');
  T.setMatchReady(room, 1, true);
  assert.equal(T.advance(room, ctx), false);
  T.setMatchReady(room, 2, true);
  assert.equal(T.advance(room, ctx), true);

  // Duel 2: P2 wins, so it goes to a third duel.
  playDuel(room, 'S1', 2, ctx);
  assert.deepEqual(match(room, 'S1').wins, [1, 1]);
  readyBoth(room, 'S1');
  T.advance(room, ctx);
  playDuel(room, 'S1', 1, ctx); // 2-1 to P1
  assert.equal(match(room, 'S1').state, 'done');
  assert.equal(match(room, 'S1').winnerId, 1);
  assert.equal(match(room, 'S1').forfeit, false);

  // The bracket advancement screen: the next two players are up.
  assert.equal(room.stageIndex, 1);
  assert.equal(room.stageStarted, false);
  assert.equal(match(room, 'S2').state, 'ready');
  const advancement = view(room, 3);
  assert.equal(advancement.screen, 'bracket');
  assert.equal(advancement.results.length, 1);
  assert.equal(advancement.results[0].winner, 'P1');
  assert.equal(advancement.results[0].loser, 'P2');
  assert.deepEqual(advancement.results[0].wins, [2, 1]);
  assert.deepEqual(match(room, 'F').players, [1, null]);

  startStage(room, ctx);
  winMatch(room, 'S2', 3, ctx);
  assert.equal(room.stageIndex, 2);
  assert.deepEqual(match(room, 'F').players, [1, 3]);
  assert.equal(match(room, 'F').state, 'ready');

  startStage(room, ctx);
  winMatch(room, 'F', 3, ctx);
  assert.equal(room.stage, 'over');
  assert.equal(room.champion, 3);
  const over = view(room, 1);
  assert.equal(over.screen, 'over');
  assert.equal(over.champion.name, 'P3');
  assert.equal(over.champion.isYou, false);
  assert.equal(view(room, 3).champion.isYou, true);
});

test('best of 5 needs 3 duel wins', () => {
  const { room, ctx } = started(4, 5);
  startStage(room, ctx);
  playDuel(room, 'S1', 1, ctx);
  readyBoth(room, 'S1'); T.advance(room, ctx);
  playDuel(room, 'S1', 1, ctx);
  assert.equal(match(room, 'S1').state, 'ready'); // 2-0 is not enough
  readyBoth(room, 'S1'); T.advance(room, ctx);
  playDuel(room, 'S1', 2, ctx);
  readyBoth(room, 'S1'); T.advance(room, ctx);
  playDuel(room, 'S1', 1, ctx);
  assert.equal(match(room, 'S1').state, 'done');
  assert.deepEqual(match(room, 'S1').wins, [3, 1]);
});

test('after the final, everyone asking for a rematch returns to the lobby and a new draw', () => {
  const { room, ctx } = started(4, 3);
  startStage(room, ctx); winMatch(room, 'S1', 1, ctx);
  startStage(room, ctx); winMatch(room, 'S2', 3, ctx);
  startStage(room, ctx); winMatch(room, 'F', 1, ctx);
  assert.equal(room.stage, 'over');
  assert.throws(() => T.requestRematch(newRoom(), 1), (e) => e.status === 403 || e.status === 409);
  T.requestRematch(room, 1);
  T.requestRematch(room, 2);
  T.requestRematch(room, 3);
  assert.equal(room.stage, 'over');
  T.requestRematch(room, 4);
  assert.equal(room.stage, 'lobby');
  assert.equal(room.matches.length, 0);
  assert.equal(room.champion, null);
  assert.ok(room.players.every((p) => !p.ready && !p.rematch));
});

// ---------------------------------------------------- 8 player tournament ----

test('8 players: two groups of 4, the first matches of both groups start together', () => {
  const { room, ctx } = started(8, 3);
  assert.deepEqual(
    room.matches.map((m) => [m.id, m.state]),
    [['A1', 'ready'], ['B1', 'ready'], ['A2', 'pending'], ['B2', 'pending'], ['AF', 'pending'], ['BF', 'pending'], ['GF', 'pending']],
  );
  assert.deepEqual(match(room, 'A1').players, [1, 2]);
  assert.deepEqual(match(room, 'A2').players, [3, 4]);
  assert.deepEqual(match(room, 'B1').players, [5, 6]);
  assert.deepEqual(match(room, 'B2').players, [7, 8]);
  assert.equal(view(room, 1).me.group, 'A');
  assert.equal(view(room, 6).me.group, 'B');
  assert.deepEqual(view(room, 1).columns, [['A1', 'A2', 'B1', 'B2'], ['AF', 'BF'], ['GF']]);
  assert.deepEqual(view(room, 1).titles, ['First matches', 'Second matches', 'Group finals', 'Grand final']);

  // One group being ready is not enough: both first matches start at the same moment.
  readyBoth(room, 'A1');
  assert.equal(T.advance(room, ctx), false);
  T.setMatchReady(room, 5, true);
  assert.equal(T.advance(room, ctx), false);
  T.setMatchReady(room, 6, true);
  assert.equal(T.advance(room, ctx), true);
  assert.equal(match(room, 'A1').state, 'live');
  assert.equal(match(room, 'B1').state, 'live');

  // Group-mates watch their own group's match.
  const a3 = view(room, 3);
  assert.equal(a3.spectating, true);
  assert.equal(a3.watching.id, 'A1');
  assert.equal(a3.watching.sameGroup, true);
  assert.equal(view(room, 7).watching.id, 'B1');
  assert.equal(view(room, 5).spectating, false);
});

test('8 players: the groups move in step, and finished players watch the match still going', () => {
  const { room, ctx } = started(8, 3);
  startStage(room, ctx);

  // Group A finishes first (2-0), while group B is still playing.
  playDuel(room, 'A1', 1, ctx);
  readyBoth(room, 'A1'); T.advance(room, ctx);
  playDuel(room, 'A1', 1, ctx);
  assert.equal(match(room, 'A1').state, 'done');
  assert.equal(match(room, 'B1').state, 'live');
  assert.equal(room.stageIndex, 0); // lock-step: group A waits for group B

  const loser = view(room, 2); // eliminated, so he watches group B's match
  assert.equal(loser.screen, 'playing');
  assert.equal(loser.spectating, true);
  assert.equal(loser.watching.id, 'B1');
  assert.equal(loser.watching.sameGroup, false);
  assert.equal(view(room, 1).watching.id, 'B1'); // so does the winner
  assert.equal(view(room, 3).watching.id, 'B1'); // and group A's waiting players

  playDuel(room, 'B1', 5, ctx);
  assert.equal(room.stageIndex, 0); // B1 is not over yet
  readyBoth(room, 'B1'); T.advance(room, ctx);
  playDuel(room, 'B1', 5, ctx);
  assert.equal(room.stageIndex, 1);
  assert.equal(room.stageStarted, false);
  assert.equal(match(room, 'A2').state, 'ready');
  assert.equal(match(room, 'B2').state, 'ready');
  assert.equal(view(room, 2).screen, 'bracket'); // the advancement screen
  assert.deepEqual(view(room, 2).results.map((r) => [r.id, r.winner]), [['A1', 'P1'], ['B1', 'P5']]);
});

test('8 players: a full tournament to a champion', () => {
  const { room, ctx } = started(8, 3);
  startStage(room, ctx);
  winMatch(room, 'A1', 1, ctx); winMatch(room, 'B1', 5, ctx);
  assert.equal(room.stageIndex, 1);
  startStage(room, ctx);
  winMatch(room, 'A2', 3, ctx); winMatch(room, 'B2', 7, ctx);
  assert.equal(room.stageIndex, 2);
  assert.deepEqual(match(room, 'AF').players, [1, 3]);
  assert.deepEqual(match(room, 'BF').players, [5, 7]);
  startStage(room, ctx);
  winMatch(room, 'AF', 3, ctx); winMatch(room, 'BF', 5, ctx);
  assert.equal(room.stageIndex, 3);
  assert.deepEqual(match(room, 'GF').players, [3, 5]);
  startStage(room, ctx);
  winMatch(room, 'GF', 5, ctx);
  assert.equal(room.stage, 'over');
  assert.equal(room.champion, 5);
  assert.ok(room.matches.every((m) => m.state === 'done'));
});

// ---------------------------------------------------------------- moves ----

test('moves are checked, and nobody can see a move before the round is revealed', () => {
  const { room, ctx } = started(4, 3);
  startStage(room, ctx);
  assert.throws(() => T.playMove(room, 3, 'load', undefined, ctx), (e) => e.status === 409); // watching
  assert.throws(() => T.playMove(room, 1, 'nonsense', undefined, ctx), (e) => e.status === 400);
  assert.throws(() => T.playMove(room, 1, 'path', undefined, ctx), (e) => e.status === 400); // not unlocked
  assert.throws(() => T.playMove(room, 1, 'load', 7, ctx), (e) => e.status === 409); // wrong round
  T.playMove(room, 1, 'load', 1, ctx);
  assert.throws(() => T.playMove(room, 1, 'load', 1, ctx), (e) => e.status === 409); // already locked in

  for (const id of [2, 3]) {
    const v = view(room, id);
    assert.equal(v.history.length, 0);
    assert.equal(v.opponent.locked || v.you.locked, true); // only *that* a move is in
  }
  assert.equal(view(room, 3).you.locked, true); // spectators see from the first side
  assert.equal(view(room, 2).opponent.locked, true);

  T.playMove(room, 2, 'load', 1, ctx);
  const v = view(room, 3);
  assert.equal(v.history.length, 1);
  assert.equal(v.round, 2);
  assert.equal(v.you.score, 1);
});

test('before a duel starts there is nothing to play', () => {
  const { room, ctx } = started(4, 3);
  assert.throws(() => T.playMove(room, 1, 'load', undefined, ctx), (e) => e.status === 409);
  assert.throws(() => T.setMatchReady(room, 1, 'yes'), (e) => e.status === 400);
  const lobby = fill(newRoom(4));
  assert.throws(() => T.setMatchReady(lobby, 1, true), (e) => e.status === 409);
});

// ---------------------------------------------------------------- timer ----

test("each live match has its own round timer, and Load is played when time runs out", () => {
  const { room } = started(8, 3);
  const t0 = ctxAt(10_000);
  startStage(room, t0);
  assert.equal(T.syncTimer(room, t0), true); // timers start
  assert.equal(match(room, 'A1').game.deadline, 15_000);
  assert.equal(match(room, 'B1').game.deadline, 15_000);

  // Player 1 locks in; everyone else runs out of time.
  T.playMove(room, 1, 'load', 1, t0);
  const t1 = ctxAt(15_000);
  assert.equal(T.syncTimer(room, t1), true);
  for (const id of ['A1', 'B1']) {
    const game = match(room, id).game;
    assert.equal(game.history.length, 1);
    assert.equal(game.round, 2);
    assert.deepEqual(game.scores, [1, 1]);
  }
  assert.deepEqual(match(room, 'A1').game.history[0].timedOut, [false, true]);
  assert.deepEqual(match(room, 'B1').game.history[0].timedOut, [true, true]);
  assert.equal(match(room, 'A1').game.deadline, 20_000);

  // The timer pauses while someone is offline.
  const away = ctxAt(16_000, { online: (p) => p.id !== 6 });
  assert.equal(T.syncTimer(room, away), true);
  assert.equal(match(room, 'B1').game.deadline, null);
  assert.equal(match(room, 'A1').game.deadline, 20_000);
});

test('a player who is offline cannot be waited for: the stage does not start without them', () => {
  const { room } = started(4, 3);
  readyBoth(room, 'S1');
  assert.equal(T.advance(room, ctxAt(1000, { online: (p) => p.id !== 2 })), false);
  assert.equal(match(room, 'S1').state, 'ready');
  assert.equal(T.advance(room, ctxAt()), true);
});

// -------------------------------------------------------------- leaving ----

test('leaving the lobby frees a place; the last one out closes the room', () => {
  const room = fill(newRoom(4), 3);
  T.removePlayer(room, 1);
  assert.equal(room.hostId, 2);
  assert.equal(room.players.length, 2);
  T.addPlayer(room, { token: 'n', name: 'New', streams: new Set() });
  T.removePlayer(room, 2); T.removePlayer(room, 3); T.removePlayer(room, 4);
  assert.equal(room.stage, 'closed');
});

test('a player who leaves before their match starts loses it, and their opponent moves on', () => {
  const { room, ctx } = started(4, 3);
  T.removePlayer(room, 1);
  T.advance(room, ctx);
  assert.equal(match(room, 'S1').state, 'done');
  assert.equal(match(room, 'S1').winnerId, 2);
  assert.equal(match(room, 'S1').forfeit, true);
  assert.equal(room.stageIndex, 1);
  assert.deepEqual(match(room, 'F').players, [2, null]);
  assert.equal(view(room, 3).results[0].winner, 'P2');
  assert.equal(room.roster[1], 'P1'); // the bracket can still name them
});

test('a player who leaves in the middle of a duel loses the match', () => {
  const { room, ctx } = started(4, 3);
  startStage(room, ctx);
  playDuel(room, 'S1', 1, ctx);
  readyBoth(room, 'S1'); T.advance(room, ctx);
  T.playMove(room, 2, 'load', 1, ctx);
  T.removePlayer(room, 1); // P1 is ahead 1-0 and leaves
  T.advance(room, ctx);
  assert.equal(match(room, 'S1').winnerId, 2);
  assert.equal(match(room, 'S1').forfeit, true);
  assert.equal(room.stageIndex, 1);
  assert.equal(view(room, 3).screen, 'bracket');
});

test('a player who leaves while waiting for a later match hands that match to the other side', () => {
  const { room, ctx } = started(4, 3);
  T.removePlayer(room, 3); // P3 was due to play semi-final 2
  T.advance(room, ctx);
  startStage(room, ctx);
  winMatch(room, 'S1', 1, ctx);
  assert.equal(match(room, 'S2').state, 'done'); // P4 gets a walkover
  assert.equal(match(room, 'S2').winnerId, 4);
  assert.equal(room.stageIndex, 2); // straight to the final
  assert.deepEqual(match(room, 'F').players, [1, 4]);
  assert.equal(match(room, 'F').state, 'ready');
});

test('the last player standing wins the tournament', () => {
  const { room, ctx } = started(4, 3);
  T.removePlayer(room, 2); T.advance(room, ctx); // P1 moves on
  T.removePlayer(room, 3); T.advance(room, ctx); // P4 moves on
  assert.equal(room.stage, 'bracket');
  assert.deepEqual(match(room, 'F').players, [1, 4]);
  T.removePlayer(room, 4); T.advance(room, ctx);
  assert.equal(room.stage, 'over');
  assert.equal(room.champion, 1);
});

test('8 players: a leaver in a group hands the match on and the tournament keeps going', () => {
  const { room, ctx } = started(8, 3);
  startStage(room, ctx);
  T.removePlayer(room, 6); // B1 is live: P5 wins it
  T.advance(room, ctx);
  assert.equal(match(room, 'B1').winnerId, 5);
  assert.equal(match(room, 'A1').state, 'live');
  assert.equal(room.stageIndex, 0); // still waiting for group A's match
  winMatch(room, 'A1', 2, ctx);
  assert.equal(room.stageIndex, 1);
  assert.deepEqual(match(room, 'AF').players, [2, null]);
  assert.deepEqual(match(room, 'BF').players, [5, null]);
});
