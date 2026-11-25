// Hex Men: zero-dependency multiplayer server.
//
// Transport: plain HTTP. Each player opens a Server-Sent Events stream to
// receive live state, and POSTs their moves. Some hosts and phone networks
// buffer streams, so the same state can also be fetched by polling
// (GET /api/rooms/:code/state). No WebSocket library is needed, so there is
// nothing to install and it runs on any Node 20+ host.
//
// Moves are secret until both players have locked in: the state sent to a
// player only says *whether* the opponent has locked in, never what they chose.
//
// Round timer: each round lasts ROUND_MS (5 seconds). A player who has not
// locked in when it runs out plays Load. The timer only runs while both
// players are connected, so a dropped connection never costs anyone a game.
//
// Two kinds of room share this server. A one-on-one room (the code below) has
// a host and one guest. A team room (rules in src/team.js, glue at the bottom
// of the API section) holds 4, 6 or 8 players split into two teams.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt } from 'node:crypto';
import {
  isKnownMove,
  isLegalMove,
  legalMoves,
  resolveRound,
  rulesForClient,
} from './src/engine.js';
import * as Team from './src/team.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const ROUND_MS = Number(process.env.ROUND_MS) || 5000;
// Render (and most hosts) put a proxy in front of the server. RENDER is set
// automatically on Render; set TRUST_PROXY=1 yourself on other hosts.
const TRUST_PROXY = Boolean(process.env.TRUST_PROXY || process.env.RENDER);

const MAX_ROOMS = 5000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // drop rooms nobody has touched for 3 hours
const POLL_GRACE_MS = 5000; // a polling player counts as connected for this long after their last poll
const GUEST_AWAY_MS = Number(process.env.GUEST_AWAY_MS) || 2 * 60 * 1000; // a guest who vanishes from the waiting room loses their seat after this long
const CLOSED_ROOM_MS = 60 * 1000; // how long a room the host closed is kept, so the guest can be told
const MAX_HISTORY = 200;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const CODE_LENGTH = 5;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** @type {Map<string, any>} */
const rooms = new Map();

// ---------------------------------------------------------------- rooms ----

function cleanName(raw, fallback) {
  const name = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);
  return name || fallback;
}

function makePlayer(name) {
  return { token: randomBytes(16).toString('hex'), name, streams: new Set(), lastPoll: 0, awaySince: null };
}

const isClosed = (room) => (room.mode === 'team' ? room.stage : room.status) === 'closed';

/** Team rooms ask this server who is online and what time it is. */
const teamCtx = (now = Date.now()) => ({ now, online: (player) => isConnected(player, now) });

function playerByToken(room, token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  return room.players.find((p) => p && p.token === token) || null;
}

function isConnected(player, now = Date.now()) {
  return Boolean(player) && (player.streams.size > 0 || now - player.lastPoll < POLL_GRACE_MS);
}

function bothConnected(room, now = Date.now()) {
  return isConnected(room.players[0], now) && isConnected(room.players[1], now);
}

function newCode() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  throw new Error('Could not allocate a room code');
}

function createRoom(hostName) {
  const code = newCode();
  const host = makePlayer(hostName);
  const room = {
    mode: '1v1',
    code,
    lastActive: Date.now(),
    players: [host, null],
    // waiting  = the host is alone in the waiting room
    // lobby    = both players are in the waiting room; the host starts when the guest is ready
    // playing  = a match is running
    // finished = a match just ended (rematch possible)
    // closed   = the host left, so the room is over
    status: 'waiting',
    guestReady: false, // the host counts as ready by being the host
    guestAwaySince: null, // when the guest was first seen offline in the waiting room
    scores: [0, 0],
    pending: [null, null],
    round: 1,
    history: [],
    result: null, // { winner: 0|1 }
    rematch: [false, false],
    deadline: null, // when the current round's timer ends (ms since epoch), or null while paused
    version: 0, // goes up every time the state changes, so pollers can skip unchanged state
    conn: [false, false], // last connection state we told the players about
  };
  rooms.set(code, room);
  return { room, player: host };
}

function createTeamRoomWithHost(hostName, size, target) {
  const code = newCode();
  const room = Team.createTeamRoom({ code, size, target, roundMs: ROUND_MS }); // throws on bad options
  const host = makePlayer(hostName);
  Team.addPlayer(room, host);
  rooms.set(code, room);
  return { room, player: host };
}

function seatOf(room, token) {
  if (typeof token !== 'string' || token.length === 0) return -1;
  for (let seat = 0; seat < 2; seat++) {
    const p = room.players[seat];
    if (p && p.token === token) return seat;
  }
  return -1;
}

function clearGame(room) {
  room.scores = [0, 0];
  room.pending = [null, null];
  room.round = 1;
  room.history = [];
  room.result = null;
  room.rematch = [false, false];
  room.deadline = null;
}

function resetMatch(room) {
  clearGame(room);
  room.status = 'playing'; // the timer tick starts the clock once both players are connected
}

/** The guest is gone (they left, or never came back): the host is alone again. */
function removeGuest(room) {
  room.players[1] = null;
  room.guestReady = false;
  room.guestAwaySince = null;
  room.conn[1] = false;
  clearGame(room);
  room.status = 'waiting';
}

function canStart(room, now = Date.now()) {
  return room.status === 'lobby' && Boolean(room.players[1]) && room.guestReady && bothConnected(room, now);
}

// ----------------------------------------------------------- state views ----

function historyFor(entry, seat) {
  const opp = 1 - seat;
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

/** What one player is allowed to know. Never includes the opponent's pending move. */
function viewFor(room, seat) {
  const opp = 1 - seat;
  const me = room.players[seat];
  const them = room.players[opp];
  const playing = room.status === 'playing';
  const now = Date.now();
  return {
    code: room.code,
    version: room.version,
    serverNow: now,
    roundMs: ROUND_MS,
    deadline: playing ? room.deadline : null,
    status: room.status,
    round: room.round,
    result: !room.result ? null : room.result.winner === seat ? 'win' : 'lose',
    isHost: seat === 0,
    canStart: seat === 0 && canStart(room, now), // only ever true for the host
    you: {
      name: me.name,
      score: room.scores[seat],
      locked: room.pending[seat] !== null,
      legal: playing ? legalMoves(room.scores[seat]) : [],
      wantsRematch: room.rematch[seat],
      ready: seat === 0 ? true : room.guestReady,
    },
    opponent: {
      name: them ? them.name : null,
      joined: Boolean(them),
      connected: isConnected(them, now),
      score: room.scores[opp],
      locked: room.pending[opp] !== null,
      wantsRematch: room.rematch[opp],
      ready: opp === 0 ? Boolean(them) : room.guestReady,
    },
    history: room.history.map((entry) => historyFor(entry, seat)),
  };
}

function send(res, payload) {
  res.write(`event: state\ndata: ${JSON.stringify(payload)}\n\n`);
}

function broadcast(room) {
  room.version += 1;
  room.lastActive = Date.now();
  if (room.mode === 'team') {
    const ctx = teamCtx();
    for (const player of room.players) {
      if (player.streams.size === 0) continue;
      const view = Team.viewFor(room, player, ctx);
      for (const res of player.streams) send(res, view);
    }
    return;
  }
  for (let seat = 0; seat < 2; seat++) {
    const player = room.players[seat];
    if (!player) continue;
    const view = viewFor(room, seat);
    for (const res of player.streams) send(res, view);
  }
}

// ----------------------------------------------------- rounds and timer ----

/** Resolve the round using both pending moves. `timedOut` says whose move was
 *  filled in with Load because the timer ran out. */
function settleRound(room, timedOut = [false, false]) {
  const moves = [room.pending[0], room.pending[1]];
  const outcome = resolveRound(moves, room.scores);
  room.scores = outcome.scores;
  room.history.push({
    round: room.round,
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
  if (room.history.length > MAX_HISTORY) room.history.shift();
  room.pending = [null, null];
  room.deadline = null;
  if (outcome.finished) {
    room.status = 'finished';
    room.result = { winner: outcome.winner };
  } else {
    room.round += 1;
    if (bothConnected(room)) room.deadline = Date.now() + ROUND_MS;
  }
}

/** The timer ran out: anyone who has not locked in plays Load. */
function expireRound(room) {
  const timedOut = [room.pending[0] === null, room.pending[1] === null];
  for (let seat = 0; seat < 2; seat++) if (room.pending[seat] === null) room.pending[seat] = 'load';
  settleRound(room, timedOut);
  broadcast(room);
}

/** Starts, pauses or expires one room's round timer, and tells the players if
 *  anyone's connection changed. Called whenever a connection opens or closes,
 *  and several times a second by tick(). */
function updateRoom(room, now = Date.now()) {
  if (room.mode === 'team') {
    updateTeamRoom(room, now);
    return;
  }
  const conn = [isConnected(room.players[0], now), isConnected(room.players[1], now)];
  let changed = conn[0] !== room.conn[0] || conn[1] !== room.conn[1];
  room.conn = conn;

  if (room.status === 'playing') {
    const both = conn[0] && conn[1];
    if (!both && room.deadline !== null) {
      room.deadline = null; // pause while someone is offline
      changed = true;
    } else if (both && room.deadline === null) {
      room.deadline = now + ROUND_MS;
      changed = true;
    } else if (room.deadline !== null && now >= room.deadline) {
      expireRound(room);
      return;
    }
  } else if (room.deadline !== null) {
    room.deadline = null;
  }

  // A guest who joined the waiting room and then vanished (closed the tab)
  // should not block the seat forever. After a couple of minutes the seat is freed.
  if (room.status === 'lobby') {
    if (!conn[1]) {
      if (room.guestAwaySince === null) room.guestAwaySince = now;
      else if (now - room.guestAwaySince >= GUEST_AWAY_MS) {
        removeGuest(room);
        changed = true;
      }
    } else {
      room.guestAwaySince = null;
    }
  }

  if (changed) broadcast(room);
}

/** Team rooms: tell everybody when someone's connection changes, drop players
 *  who have been gone too long, move the game on, and run the round timer. */
function updateTeamRoom(room, now) {
  if (room.stage === 'closed') return;
  const ctx = teamCtx(now);
  let changed = false;

  const signature = room.players.map((p) => `${p.id}${ctx.online(p) ? '+' : '-'}`).join(' ');
  if (signature !== room.connSig) {
    room.connSig = signature;
    changed = true;
  }

  // Somebody who vanished (closed the tab) must not hold up everyone else for ever.
  for (const player of [...room.players]) {
    if (ctx.online(player)) player.awaySince = null;
    else if (player.awaySince === null) player.awaySince = now;
    else if (now - player.awaySince >= GUEST_AWAY_MS) {
      Team.removePlayer(room, player.id);
      changed = true;
    }
  }
  if (room.stage === 'closed') return;

  if (Team.advance(room, ctx)) changed = true;
  if (Team.syncTimer(room, ctx)) changed = true;
  if (changed) broadcast(room);
}

function tick() {
  const now = Date.now();
  for (const room of rooms.values()) updateRoom(room, now);
}

// --------------------------------------------------------------- helpers ----

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

async function readJson(req, limit = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Request body must be a JSON object.');
  }
}

function clientIp(req) {
  const forwarded = TRUST_PROXY ? req.headers['x-forwarded-for'] : null;
  if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// Small guard against someone scripting thousands of rooms: 20 new rooms per
// IP address every 10 minutes.
const createLog = new Map();
function allowCreate(ip) {
  const now = Date.now();
  const recent = (createLog.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (recent.length >= 20) {
    createLog.set(ip, recent);
    return false;
  }
  recent.push(now);
  createLog.set(ip, recent);
  return true;
}

function getRoom(code) {
  const room = rooms.get(String(code).toUpperCase());
  if (!room || isClosed(room)) throw new HttpError(404, 'Room not found. Check the code and try again.');
  return room;
}

function requireSeat(room, token) {
  const seat = seatOf(room, token);
  if (seat === -1) throw new HttpError(403, 'You are not a player in this room.');
  return seat;
}

// ------------------------------------------------------------------ API ----

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (pathname === '/api/rules' && method === 'GET') {
    return json(res, 200, { ...rulesForClient(), team: Team.optionsForClient() });
  }

  if (pathname === '/api/rooms' && method === 'POST') {
    if (!allowCreate(clientIp(req))) {
      throw new HttpError(429, 'Too many rooms created. Wait a few minutes and try again.');
    }
    if (rooms.size >= MAX_ROOMS) throw new HttpError(503, 'The server is full. Try again later.');
    const body = await readJson(req);
    if (body.mode !== undefined && body.mode !== '1v1' && body.mode !== 'team') {
      throw new HttpError(400, 'Choose 1v1 or Team vs Team.');
    }
    if (body.mode === 'team') {
      const { room, player } = createTeamRoomWithHost(cleanName(body.name, 'Player 1'), body.size, body.target);
      return json(res, 201, { code: room.code, token: player.token, mode: 'team', id: player.id });
    }
    const { room, player } = createRoom(cleanName(body.name, 'Player 1'));
    return json(res, 201, { code: room.code, token: player.token, seat: 0, mode: '1v1' });
  }

  const match = pathname.match(
    /^\/api\/rooms\/([A-Za-z0-9]+)(?:\/(events|state|join|move|rematch|ready|start|leave|team|order|confirm|style|matchready))?$/,
  );
  if (!match) throw new HttpError(404, 'Not found.');
  const [, rawCode, action] = match;
  const code = rawCode.toUpperCase();
  if (!CODE_RE.test(code)) throw new HttpError(404, 'Room not found. Check the code and try again.');

  // A closed room is still told to its guest through the open stream, but
  // nobody can use it any more.
  const room = getRoom(code);
  if (room.mode === 'team') return handleTeamApi(req, res, url, room, action, method);

  // Is the room there, and does it have space? Used by invite links. With a
  // token it also says whether that token still has a seat in the room.
  if (!action && method === 'GET') {
    const token = url.searchParams.get('token');
    return json(res, 200, {
      code: room.code,
      mode: '1v1',
      status: room.status,
      full: Boolean(room.players[1]),
      seated: token ? seatOf(room, token) !== -1 : undefined,
    });
  }

  if (action === 'join' && method === 'POST') {
    if (room.players[1]) throw new HttpError(409, 'This room already has two players.');
    const body = await readJson(req);
    const guest = makePlayer(cleanName(body.name, 'Player 2'));
    room.players[1] = guest;
    room.guestReady = false;
    room.guestAwaySince = null;
    clearGame(room);
    room.status = 'lobby'; // the host starts the match once the guest is ready
    broadcast(room);
    return json(res, 200, { code: room.code, token: guest.token, seat: 1 });
  }

  // The guest says they are ready (or not ready) in the waiting room.
  if (action === 'ready' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (seat === 0) throw new HttpError(403, 'The host does not need to get ready. Start the match when your opponent is ready.');
    if (room.status !== 'lobby') throw new HttpError(409, 'You can only change this in the waiting room.');
    if (typeof body.ready !== 'boolean') throw new HttpError(400, 'Say whether you are ready.');
    room.guestReady = body.ready;
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  // Only the host can start the match, and only when the guest is ready.
  if (action === 'start' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (seat !== 0) throw new HttpError(403, 'Only the host can start the match.');
    if (room.status !== 'lobby') throw new HttpError(409, 'The match cannot be started right now.');
    if (!room.guestReady) throw new HttpError(409, `${room.players[1].name} is not ready yet.`);
    if (!bothConnected(room)) throw new HttpError(409, `${room.players[1].name} is offline. Wait until they are back.`);
    resetMatch(room);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  // Leave for good. The guest frees their seat; the host closes the room.
  if (action === 'leave' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (seat === 0) {
      room.status = 'closed';
      room.deadline = null;
    } else {
      removeGuest(room);
    }
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  if (action === 'events' && method === 'GET') {
    const seat = requireSeat(room, url.searchParams.get('token'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n:${' '.repeat(2048)}\n\n`); // padding helps proxies that buffer small writes
    const player = room.players[seat];
    player.streams.add(res);
    updateRoom(room); // tells the opponent this player is connected, and may start the timer
    send(res, viewFor(room, seat));
    req.on('close', () => {
      player.streams.delete(res);
      if (rooms.get(code) === room) updateRoom(room); // tells the opponent, and pauses the timer
    });
    return undefined;
  }

  // Polling fallback: same state as the stream. `v` is the version the player
  // already has; if nothing changed the reply is tiny.
  if (action === 'state' && method === 'GET') {
    const seat = requireSeat(room, url.searchParams.get('token'));
    const player = room.players[seat];
    player.lastPoll = Date.now();
    updateRoom(room); // a player who just started polling is now connected
    const since = Number(url.searchParams.get('v'));
    if (since === room.version) return json(res, 200, { unchanged: true, serverNow: Date.now() });
    return json(res, 200, viewFor(room, seat));
  }

  if (action === 'move' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (room.status !== 'playing') throw new HttpError(409, 'The game is not in progress.');
    if (body.round !== undefined && body.round !== room.round) {
      throw new HttpError(409, 'That round already ended. Choose your move for the new round.');
    }
    if (room.pending[seat] !== null) throw new HttpError(409, 'You already locked in a move this round.');
    if (!isKnownMove(body.move)) throw new HttpError(400, 'Unknown move.');
    if (!isLegalMove(body.move, room.scores[seat])) {
      throw new HttpError(400, 'That attack is not unlocked yet. Build up your score first.');
    }
    if (room.deadline !== null && Date.now() >= room.deadline) {
      throw new HttpError(409, 'Time ran out for this round.');
    }
    room.pending[seat] = body.move;
    if (room.pending[0] !== null && room.pending[1] !== null) settleRound(room);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  if (action === 'rematch' && method === 'POST') {
    const body = await readJson(req);
    const seat = requireSeat(room, body.token);
    if (room.status !== 'finished') throw new HttpError(409, 'The game is not over yet.');
    room.rematch[seat] = true;
    if (room.rematch[0] && room.rematch[1]) resetMatch(room);
    broadcast(room);
    return json(res, 200, { ok: true });
  }

  throw new HttpError(405, 'Method not allowed.');
}

// ------------------------------------------------------------ team rooms ----

function requireTeamPlayer(room, token) {
  const player = playerByToken(room, token);
  if (!player) throw new HttpError(403, 'You are not a player in this room.');
  return player;
}

async function handleTeamApi(req, res, url, room, action, method) {
  // Invite links ask whether there is a free place. With a token, whether that token still has one.
  if (!action && method === 'GET') {
    const token = url.searchParams.get('token');
    const started = room.stage !== 'teams';
    return json(res, 200, {
      code: room.code,
      mode: 'team',
      status: room.stage,
      size: room.size,
      target: room.target,
      started,
      full: started || room.players.length >= Team.capacity(room),
      seated: token ? Boolean(playerByToken(room, token)) : undefined,
    });
  }

  if (action === 'join' && method === 'POST') {
    const body = await readJson(req);
    const guest = makePlayer(cleanName(body.name, `Player ${room.players.length + 1}`));
    Team.addPlayer(room, guest);
    broadcast(room);
    return json(res, 200, { code: room.code, token: guest.token, mode: 'team', id: guest.id });
  }

  if (action === 'events' && method === 'GET') {
    const player = requireTeamPlayer(room, url.searchParams.get('token'));
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 2000\n:${' '.repeat(2048)}\n\n`);
    player.streams.add(res);
    updateRoom(room); // tells the others this player is connected
    send(res, Team.viewFor(room, player, teamCtx()));
    req.on('close', () => {
      player.streams.delete(res);
      if (rooms.get(room.code) === room) updateRoom(room);
    });
    return undefined;
  }

  if (action === 'state' && method === 'GET') {
    const player = requireTeamPlayer(room, url.searchParams.get('token'));
    player.lastPoll = Date.now();
    updateRoom(room);
    const since = Number(url.searchParams.get('v'));
    if (since === room.version) return json(res, 200, { unchanged: true, serverNow: Date.now() });
    return json(res, 200, Team.viewFor(room, player, teamCtx()));
  }

  if (method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson(req);
  const player = requireTeamPlayer(room, body.token);
  const ctx = teamCtx();

  switch (action) {
    case 'team':
      Team.chooseTeam(room, player.id, body.team);
      break;
    case 'ready':
      Team.setReady(room, player.id, body.ready);
      break;
    case 'style':
      Team.setStyle(room, player.id, { name: body.name, color: body.color });
      break;
    case 'order':
      Team.movePlayer(room, player.id, body.id, body.direction);
      break;
    case 'confirm':
      Team.setConfirm(room, player.id, body.confirmed);
      break;
    case 'matchready':
      Team.setMatchReady(room, player.id, body.ready);
      break;
    case 'move':
      Team.playMove(room, player.id, body.move, body.round, ctx);
      break;
    case 'rematch':
      Team.requestRematch(room, player.id);
      break;
    case 'leave':
      Team.removePlayer(room, player.id);
      break;
    default:
      throw new HttpError(405, 'Method not allowed.');
  }

  if (room.stage !== 'closed') {
    Team.advance(room, ctx);
    Team.syncTimer(room, ctx);
  }
  broadcast(room);
  return json(res, 200, { ok: true });
}

// -------------------------------------------------------- static files ----

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
};

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
  if (rel.includes('\0')) throw new HttpError(400, 'Bad request.');
  if (rel === '/guide') rel = '/guide.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(403, 'Forbidden.');

  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': rel.startsWith('/img/') ? 'public, max-age=3600' : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).pipe(res);
  });
}

// --------------------------------------------------------------- server ----

const server = http.createServer(async (req, res) => {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(key, value);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') return json(res, 200, { ok: true, rooms: rooms.size });
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err instanceof HttpError || err instanceof Team.TeamError ? err.status : 500;
    if (status === 500) console.error(err);
    if (res.headersSent) {
      res.end();
      return undefined;
    }
    return json(res, status, { error: status === 500 ? 'Something went wrong on the server.' : err.message });
  }
});

// Keep SSE connections alive through proxies, run the round timers, and drop
// abandoned rooms.
const keepAlive = setInterval(() => {
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (player) for (const res of player.streams) res.write(': ping\n\n');
    }
  }
}, 20_000);

const ticker = setInterval(tick, 200);

const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const connected = room.players.some((p) => isConnected(p, now));
    if (isClosed(room) && now - room.lastActive > CLOSED_ROOM_MS) rooms.delete(code);
    else if (!connected && now - room.lastActive > ROOM_IDLE_MS) rooms.delete(code);
  }
}, 5 * 60 * 1000);
keepAlive.unref();
ticker.unref();
sweeper.unref();

function shutdown() {
  console.log('Shutting down...');
  server.close(() => process.exit(0));
  for (const room of rooms.values()) {
    for (const player of room.players) {
      if (player) for (const res of player.streams) res.end();
    }
  }
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Hex Men is running at http://localhost:${PORT}`);
});
