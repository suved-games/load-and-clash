// Tournament screens: the waiting lobby, the bracket, the match lobby between
// duels, the congratulations screen, and the score strip above a match. The
// server sends one view per player (see src/tournament.js); this file only
// draws it.

import { $, h, moveIcon, plural } from './dom.js';
import { captureFocus, chip, heading, inviteBlock, nameBlock, resetCopied, restoreFocus, tag } from './ui-bits.js';

let ctx = null; // { act(action, body) -> Promise<boolean>, moveName(id), moveColor(id), describeRound(entry, names) }

export function init(context) {
  ctx = context;
}

export function reset() {
  resetCopied();
  $('#view-tournament').replaceChildren();
  const strip = $('#tournament-strip');
  strip.hidden = true;
  strip.replaceChildren();
}

// --------------------------------------------------------------- helpers ----

const COLUMN_TITLES = { 4: ['Semi-finals', 'Final'], 8: ['Group matches', 'Group finals', 'Grand final'] };

const matchOf = (s, id) => s.matches.find((m) => m.id === id) || null;
const score = (m) => `${m.wins[0]} : ${m.wins[1]}`;

function rulesLine(s) {
  return `Best of ${s.bestOf}: win ${s.winsNeeded} duels to win a match. A duel is one full game, played until someone wins.`;
}

/** The match this person is up in during the current stage, if it is not over. */
const myOpenMatch = (s) => s.matches.find((m) => m.current && m.state !== 'done' && m.slots.some((slot) => slot.isYou)) || null;

/** Their match in the current stage, even when it is already over. */
const myStageMatch = (s) => s.matches.find((m) => m.current && m.slots.some((slot) => slot.isYou)) || null;

const names = (list) => (list.length <= 2 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);

// ------------------------------------------------------------------ lobby ----

function lobbyScreen(s) {
  const open = s.capacity - s.players.length;
  const ready = s.players.filter((p) => p.ready).length;
  const me = s.me;

  const rows = s.players.map((p) =>
    h('li', { class: 'prow' }, nameBlock(p), p.ready ? chip('Ready', 'ready') : chip('Not ready')),
  );
  for (let i = s.players.length; i < s.capacity; i++) rows.push(h('li', { class: 'prow empty' }, 'Open spot'));

  let hint;
  if (open > 0) hint = `${plural(open, 'more player')} must join. The bracket is drawn at random once the room is full and everyone is ready.`;
  else if (me.ready) hint = `You are ready. ${ready} of ${s.players.length} players are ready. The bracket is drawn when everyone is.`;
  else hint = `The room is full. ${ready} of ${s.players.length} players are ready.`;

  const button = h('button', { type: 'button', class: me.ready ? 'secondary' : 'primary', text: me.ready ? 'Unready' : 'Ready', 'data-fk': 'ready' });
  button.addEventListener('click', () => ctx.act('ready', { ready: !me.ready }));

  return [
    heading(`${s.size}-player tournament`, rulesLine(s)),
    open > 0 ? inviteBlock(s.code, open) : null,
    h(
      'section',
      { class: 'panel plain', 'aria-label': 'Players' },
      h('header', { class: 'panel-head plain' }, h('h3', { text: 'Players' }), h('span', { class: 'count', text: `${s.players.length}/${s.capacity}` })),
      h('ul', { class: 'plist' }, rows),
    ),
    h('div', { class: 'room-actions' }, button, h('p', { class: 'hint', role: 'status', text: hint })),
  ];
}

// ---------------------------------------------------------------- bracket ----

function slotBlock(m, slot, seat) {
  const won = m.state === 'done' && m.winnerSeat === seat;
  const lost = m.state === 'done' && m.winnerSeat !== null && m.winnerSeat !== seat;
  const showWins = m.state === 'live' || m.state === 'done' || m.duelsPlayed > 0;
  const cls = ['bslot', won ? 'won' : '', lost ? 'lost' : '', slot.isYou ? 'mine' : ''].filter(Boolean).join(' ');

  let who;
  if (slot.id !== null && slot.id !== undefined) {
    who = h(
      'span',
      { class: 'p-name' },
      h('span', { class: 'p-text', text: slot.name }),
      slot.isYou ? tag('You', 'you') : null,
      slot.left ? tag('Left', 'away') : slot.online === false ? tag('Offline', 'away') : null,
    );
  } else if (slot.waitingFor) {
    who = h('span', { class: 'p-text open', text: `Winner of ${slot.waitingFor}` });
  } else {
    who = h('span', { class: 'p-text open', text: 'No player' });
  }

  return h(
    'li',
    { class: cls },
    who,
    m.state === 'ready' && slot.ready ? chip('Ready', 'ready') : null,
    showWins && slot.id ? h('span', { class: 'bwins', 'aria-label': `${m.wins[seat]} duels won`, text: m.wins[seat] }) : null,
  );
}

function matchCard(s, m) {
  const mine = m.slots.some((slot) => slot.isYou);
  const state =
    m.state === 'live' ? chip('Live', 'up') : m.state === 'ready' && m.current ? chip(m.duelsPlayed ? 'Next duel' : 'Up next', 'up') : m.state === 'done' ? chip(m.forfeit ? 'Walkover' : 'Done') : null;
  return h(
    'article',
    { class: `bm ${m.state}${mine ? ' mine' : ''}${m.current ? ' current' : ''}`, 'aria-label': m.label },
    h('header', { class: 'bm-head' }, h('h4', { text: m.label }), state),
    h('ul', { class: 'bslots' }, slotBlock(m, m.slots[0], 0), slotBlock(m, m.slots[1], 1)),
  );
}

/** The bracket itself: one column per round, with the final on the right. */
function bracketTree(s) {
  const titles = COLUMN_TITLES[s.size] || [];
  return h(
    'div',
    { class: `bracket cols-${s.columns.length}`, role: 'group', 'aria-label': 'Tournament bracket' },
    s.columns.map((ids, i) =>
      h(
        'section',
        { class: 'bcol', 'aria-label': titles[i] || '' },
        h('h3', { class: 'bcol-title', text: titles[i] || '' }),
        h('div', { class: 'bcol-matches' }, ids.map((id) => matchOf(s, id)).filter(Boolean).map((m) => matchCard(s, m))),
      ),
    ),
  );
}

function resultsBlock(s) {
  if (!s.results.length) return null;
  const lines = s.results.map((r) => {
    let text;
    if (r.winner === null) text = `${r.label}: nobody was left to play.`;
    else if (r.forfeit) text = `${r.label}: ${r.loser ? `${r.loser} left, so ` : ''}${r.winner} moved on.`;
    else text = `${r.label}: ${r.winner} beat ${r.loser} ${Math.max(...r.wins)} : ${Math.min(...r.wins)}.`;
    return h('li', { text });
  });
  return h('section', { class: 't-results', 'aria-label': 'Results so far' }, h('h3', { text: 'Results' }), h('ul', {}, lines));
}

function bracketScreen(s) {
  const first = s.stageNo === 0 && !s.stageStarted;
  const upNow = s.matches.filter((m) => m.current && m.state !== 'done');
  const mine = myOpenMatch(s);

  let action = null;
  let hint;
  if (!s.stageStarted && mine && mine.state === 'ready') {
    const seat = mine.slots.findIndex((slot) => slot.isYou);
    const iAmReady = mine.slots[seat].ready;
    const rival = mine.slots[1 - seat];
    action = h('button', { type: 'button', class: iAmReady ? 'secondary' : 'primary', text: iAmReady ? 'Unready' : 'Ready', 'data-fk': 'match-ready' });
    action.addEventListener('click', () => ctx.act('matchready', { ready: !iAmReady }));
    const missing = upNow.flatMap((m) => m.slots.filter((slot) => slot.id !== null && !slot.ready).map((slot) => slot.name));
    if (iAmReady) hint = missing.length ? `You are ready. Waiting for ${names(missing)} to press Ready.` : 'Everyone is ready. Starting.';
    else hint = `You are up against ${rival.name}. Press Ready to play${upNow.length > 1 ? ', together with the other group' : ''}.`;
  } else if (!s.stageStarted && upNow.length) {
    const missing = upNow.flatMap((m) => m.slots.filter((slot) => slot.id !== null && !slot.ready).map((slot) => slot.name));
    hint = missing.length
      ? `You are watching. The next ${upNow.length > 1 ? 'matches start' : 'match starts'} when ${names(missing)} ${missing.length > 1 ? 'are' : 'is'} ready.`
      : 'Everyone is ready. Starting.';
  } else {
    const waiting = upNow.flatMap((m) => m.slots.filter((slot) => slot.id !== null).map((slot) => slot.name));
    hint = waiting.length ? `Waiting for ${names(waiting)} to get ready for their next duel.` : 'Waiting for the next matches.';
  }

  const title = first ? 'The bracket is drawn' : s.titles[s.stageNo] || 'Bracket';
  const intro = first
    ? 'Players were placed at random. The first matches start when the players who are up press Ready.'
    : `${rulesLine(s)}`;

  return [
    heading(title, intro),
    resultsBlock(s),
    h('div', { class: 'room-actions' }, action, h('p', { class: 'hint', role: 'status', text: hint })),
    bracketTree(s),
  ];
}

// ----------------------------------------------------------- match lobby ----

/** The deciding round of the duel that just ended, drawn like the round
 *  result card: you on the left and your opponent on the right. */
function lastDuelCard(s) {
  const my = s.myMatch;
  const last = my.lastDuel;
  const round = last && last.last;
  if (!round || !round.result) return null;

  const side = (i) => {
    const seat = i === 0 ? my.seat : 1 - my.seat;
    const id = seat === 0 ? round.you : round.opp;
    const won = last.winnerSeat === seat;
    return h(
      'div',
      { class: `played ${i === 0 ? 'you' : 'opp'} t-${ctx.moveColor(id)}` },
      h('span', { class: 'who' }, i === 0 ? 'You' : last.names[seat]),
      h('span', { class: 'art' }, moveIcon(id)),
      h('strong', { class: 'mv', text: ctx.moveName(id) }),
      won ? chip('Won the duel', 'up') : null,
    );
  };

  return h(
    'div',
    { class: 'last-round', role: 'group', 'aria-label': `Duel ${last.number}, winning round` },
    h('p', { class: 'lr-title', text: `Duel ${last.number}, winning round (round ${round.round})` }),
    h('div', { class: 'clash' }, side(0), h('span', { class: 'vs', text: 'vs' }), side(1)),
    h('p', { class: 'rv-text', text: ctx.describeRound(round, last.names) }),
  );
}

function matchLobbyScreen(s) {
  const my = s.myMatch;
  const seat = my.seat;
  const rival = my.names[1 - seat];
  const iAmReady = my.ready[seat];
  const last = my.lastDuel;

  const button = h('button', { type: 'button', class: iAmReady ? 'secondary' : 'primary', text: iAmReady ? 'Unready' : 'Ready', 'data-fk': 'match-ready' });
  button.addEventListener('click', () => ctx.act('matchready', { ready: !iAmReady }));
  const hint = iAmReady ? `You are ready. Duel ${my.duelNo} starts when ${rival} is ready too.` : `Press Ready to start duel ${my.duelNo}.`;

  let summary = null;
  if (last) {
    const winner = last.names[last.winnerSeat];
    summary = h('p', { class: 'last-match', text: `Duel ${last.number}: ${winner} won in ${plural(last.rounds, 'round')}.` });
  }

  const card = (who, wins, isYou, ready) =>
    h(
      'div',
      { class: `duel-card${isYou ? ' you' : ''}` },
      h('span', { class: 'dc-name', text: who }),
      ready ? chip('Ready', 'ready') : chip('Not ready'),
      h('strong', { class: 'dc-wins', text: wins }),
    );

  return [
    heading(my.label, `Best of ${s.bestOf}. First to ${s.winsNeeded} duels wins the match.`),
    h(
      'section',
      { class: 'duel', 'aria-label': 'Duels won' },
      card('You', my.wins[seat], true, iAmReady),
      h('span', { class: 'vs', text: ':' }),
      card(rival, my.wins[1 - seat], false, my.ready[1 - seat]),
    ),
    h('div', { class: 'room-actions' }, button, h('p', { class: 'hint', role: 'status', text: hint })),
    summary,
    lastDuelCard(s),
    bracketTree(s),
  ];
}

// ------------------------------------------------------- congratulations ----

const CONFETTI = 22;

function confetti() {
  const bits = [];
  for (let i = 0; i < CONFETTI; i++) {
    const bit = h('span', { class: `bit c${i % 5}`, 'aria-hidden': 'true' });
    bit.style.setProperty('--x', `${(i * 100) / CONFETTI + ((i * 37) % 7)}%`);
    bit.style.setProperty('--d', `${((i * 53) % 12) / 10}s`);
    bit.style.setProperty('--s', `${10 + ((i * 29) % 14)}px`);
    bits.push(bit);
  }
  return h('div', { class: 'confetti', 'aria-hidden': 'true' }, bits);
}

function overScreen(s) {
  const champ = s.champion;
  const everyone = s.players;
  const asked = everyone.filter((p) => p.rematch).length;
  const final = s.matches[s.matches.length - 1];
  const finalist = final && final.state === 'done' && !final.forfeit ? final : null;

  let headline;
  let lead;
  if (!champ) {
    headline = 'Tournament over';
    lead = 'Everyone left before a winner was decided.';
  } else if (champ.isYou) {
    headline = `Congratulations, ${champ.name}!`;
    lead = `You won the ${s.size}-player tournament.`;
  } else {
    headline = `Congratulations, ${champ.name}!`;
    lead = `${champ.name} won the ${s.size}-player tournament.`;
  }
  let detail = '';
  if (finalist) {
    const seat = finalist.winnerSeat;
    const loser = finalist.slots[1 - seat].name;
    detail = `${s.titles[s.titles.length - 1]}: ${champ.name} beat ${loser} ${Math.max(...finalist.wins)} : ${Math.min(...finalist.wins)}.`;
  } else if (final && final.forfeit && champ) {
    detail = `${s.titles[s.titles.length - 1]}: the other finalist left, so ${champ.name} won.`;
  }

  const again = h('button', { type: 'button', class: 'primary', text: s.me.rematch ? 'Waiting for others' : 'Play again', disabled: s.me.rematch, 'data-fk': 'rematch' });
  again.addEventListener('click', () => ctx.act('rematch'));
  const note = s.me.rematch
    ? `${asked} of ${everyone.length} players want to play again.`
    : asked
      ? `${asked} of ${everyone.length} players want to play again.`
      : 'Everyone goes back to the tournament lobby and a new bracket is drawn.';

  return [
    h(
      'section',
      { class: `banner congrats${champ && champ.isYou ? ' mine' : ''}`, 'aria-label': 'Tournament winner' },
      confetti(),
      h('span', { class: 'crown', 'aria-hidden': 'true', text: '1' }),
      h('h2', { text: headline }),
      h('p', { class: 'lead', text: lead }),
      detail ? h('p', { class: 'hint', text: detail }) : null,
      again,
      h('p', { class: 'hint', role: 'status', text: note }),
    ),
    bracketTree(s),
  ];
}

// ----------------------------------------------------------------- public ----

export function render(s) {
  const root = $('#view-tournament');
  const saved = captureFocus(root);
  const screens = { lobby: lobbyScreen, bracket: bracketScreen, matchlobby: matchLobbyScreen, over: overScreen };
  const build = screens[s.status];
  root.dataset.screen = s.status;
  root.dataset.size = String(s.size);
  root.replaceChildren(...(build ? build(s) : []).filter(Boolean));
  restoreFocus(saved, root);
}

/** The strip above a tournament duel: which match, the duel number, the
 *  duels each side has won, and (for spectators) what else is going on. */
export function renderStrip(s) {
  const strip = $('#tournament-strip');
  if (s.mode !== 'tournament' || s.status !== 'playing' || !s.watching) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  const w = s.watching;
  strip.hidden = false;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', `${w.label}, duel ${w.duelNo}. ${s.you.name} ${w.wins.you}, ${s.opponent.name} ${w.wins.opp}.`);

  const side = (name, wins, cls) =>
    h('div', { class: `ts-side ${cls}` }, h('span', { class: 'ts-name', text: name }), h('strong', { class: 'ts-wins', text: wins }));

  const notes = [];
  if (s.spectating) {
    notes.push(w.sameGroup ? 'Your group is playing.' : 'Watching another match.');
    if (w.others === 1) notes.push('1 other match is live.');
    else if (w.others > 1) notes.push(`${w.others} other matches are live.`);
    const mine = myStageMatch(s);
    if (mine && mine.state === 'done') {
      const seat = mine.slots.findIndex((slot) => slot.isYou);
      const won = mine.winnerSeat === seat;
      notes.unshift(
        mine.forfeit
          ? `Your match, ${mine.label}: ${won ? 'you moved on' : 'you were out'}.`
          : `Your match, ${mine.label}: you ${won ? 'won' : 'lost'} ${mine.wins[seat]} : ${mine.wins[1 - seat]}.`,
      );
    }
  }

  strip.replaceChildren(
    side(s.you.name, w.wins.you, 'you'),
    h(
      'div',
      { class: 'ts-mid' },
      h('strong', { text: w.label }),
      h('span', { class: 'hint', text: `Duel ${w.duelNo}, best of ${s.bestOf}` }),
      notes.length ? h('span', { class: 'hint ts-note', text: notes.join(' ') }) : null,
    ),
    side(s.opponent.name, w.wins.opp, 'opp'),
  );
}
