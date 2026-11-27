// Team vs Team screens: the team lobby, the order screen, the match lobby and
// the end screen, plus the score strip above a match. The server sends one
// view per player (see src/team.js), and everything here just draws it.

import { $, h, moveIcon, plural } from './dom.js';
import { captureFocus, chip, heading, inviteBlock, nameBlock, resetCopied, restoreFocus, tag } from './ui-bits.js';

let ctx = null; // { act(action, body) -> Promise<boolean>, teamOptions, getSession(), onLeave(), moveName(id), moveColor(id), describeRound(entry, names) }
let draftName = null; // text typed in the team-name box and not saved yet
let draftTeam = null;

export function init(context) {
  ctx = context;
}

export function reset() {
  draftName = null;
  draftTeam = null;
  resetCopied();
  $('#view-team').replaceChildren();
  const strip = $('#team-strip');
  strip.hidden = true;
  strip.replaceChildren();
}

// --------------------------------------------------------------- helpers ----

const colorInfo = (id) => ctx.teamOptions.colors.find((c) => c.id === id) || ctx.teamOptions.colors[0];

/** Give an element the team's colour through two CSS variables. */
function tint(el, colorId) {
  const color = colorInfo(colorId);
  el.style.setProperty('--team', color.hex);
  el.style.setProperty('--team-ink', color.ink);
  return el;
}

const members = (s) => s.teams.flatMap((t) => t.members);

function progress(s) {
  const at = { teams: 0, order: 1, matchlobby: 2, over: 2 }[s.stage] ?? 0;
  const steps = ['Teams', 'Order', 'Match'];
  return h(
    'ol',
    { class: 'progress', 'aria-label': 'Where the game is' },
    steps.map((label, i) =>
      h('li', { class: i === at ? 'now' : i < at ? 'done' : '', 'aria-current': i === at ? 'step' : null }, h('span', { class: 'n', text: i + 1 }), label),
    ),
  );
}

/** The coloured top of a team panel. */
function panelHead(team, right) {
  return h('header', { class: 'panel-head' }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('h3', { text: team.name }), right);
}

// ----------------------------------------------------- name and colour ----

function styleEditor(s, teamIndex) {
  const team = s.teams[teamIndex];
  const rival = s.teams[1 - teamIndex];
  const max = ctx.teamOptions.teamNameMax;
  const value = draftTeam === teamIndex && draftName !== null ? draftName : team.name;

  const input = h('input', {
    id: `team-name-${teamIndex}`,
    type: 'text',
    maxlength: max,
    autocomplete: 'off',
    spellcheck: 'false',
    value,
    'data-fk': `name-${teamIndex}`,
  });
  input.addEventListener('input', () => {
    draftName = input.value;
    draftTeam = teamIndex;
  });

  const form = h(
    'form',
    { class: 'style-editor', 'aria-label': `${team.name}: name and color` },
    h('div', { class: 'field' }, h('label', { for: input.id, text: 'Team name' }), h('div', { class: 'row' }, input, h('button', { type: 'submit', class: 'secondary', text: 'Save name', 'data-fk': `save-${teamIndex}` }))),
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (await ctx.act('style', { name: input.value })) {
      draftName = null;
      draftTeam = null;
    }
  });

  const swatches = ctx.teamOptions.colors.map((color) => {
    const taken = rival.color === color.id;
    const chosen = team.color === color.id;
    const button = h(
      'button',
      {
        type: 'button',
        class: 'sw',
        role: 'radio',
        'aria-checked': String(chosen),
        'aria-label': taken ? `${color.name}, used by ${rival.name}` : color.name,
        title: taken ? `${color.name} (used by ${rival.name})` : color.name,
        'aria-disabled': taken ? 'true' : null,
        'data-fk': `sw-${teamIndex}-${color.id}`,
      },
      h('span', { class: 'check', 'aria-hidden': 'true', text: chosen ? '✓' : '' }),
    );
    button.style.setProperty('--sw', color.hex);
    button.style.setProperty('--sw-ink', color.ink);
    button.addEventListener('click', () => {
      if (!taken && !chosen) ctx.act('style', { color: color.id });
    });
    return button;
  });
  form.append(h('fieldset', { class: 'swatch-field' }, h('legend', { text: 'Team color' }), h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Team color' }, swatches)));
  return form;
}

/** Player 1 gets the editor. Everyone else on the team is told who does. */
function styleBlock(s, teamIndex) {
  const team = s.teams[teamIndex];
  if (s.me.team !== teamIndex) return null;
  if (s.me.canStyle) return styleEditor(s, teamIndex);
  const first = team.members[0];
  return first ? h('p', { class: 'hint', text: `${first.name} is Player 1, so they choose the team name and color.` }) : null;
}

// ------------------------------------------------------------ team lobby ----

function invitePanel(s) {
  const joined = members(s).length + s.waiting.length;
  return joined >= s.capacity ? null : inviteBlock(s.code, s.capacity - joined);
}

function waitingPanel(s) {
  const list = h(
    'ul',
    { class: 'plist' },
    s.waiting.length
      ? s.waiting.map((p) => h('li', { class: 'prow' }, nameBlock(p)))
      : h('li', { class: 'prow empty', text: 'Nobody is waiting.' }),
  );
  return h(
    'section',
    { class: 'panel waiting', 'aria-label': 'Waiting' },
    h('header', { class: 'panel-head plain' }, h('h3', { text: 'Waiting' }), h('span', { class: 'count', text: s.waiting.length })),
    list,
    h('p', { class: 'hint', text: s.me.team === null ? 'Press a team’s Join button to pick your side.' : 'Players who have not picked a team yet.' }),
  );
}

function teamPanel(s, t) {
  const team = s.teams[t];
  const mine = s.me.team === t;
  const rows = team.members.map((p, i) =>
    h(
      'li',
      { class: 'prow' },
      h('span', { class: 'pos', 'aria-label': `Player ${i + 1}`, text: i + 1 }),
      nameBlock(p),
      p.ready ? chip('Ready', 'ready') : chip('Not ready'),
    ),
  );
  for (let i = team.members.length; i < s.size; i++) {
    rows.push(h('li', { class: 'prow empty' }, h('span', { class: 'pos', 'aria-hidden': 'true', text: i + 1 }), 'Open spot'));
  }

  let action;
  if (mine) {
    action = h('button', { type: 'button', class: 'quiet', text: 'Move to Waiting', 'data-fk': 'to-waiting' });
    action.addEventListener('click', () => ctx.act('team', { team: null }));
  } else {
    const full = team.members.length >= s.size;
    action = h('button', { type: 'button', class: full ? 'secondary' : 'primary', text: full ? 'Team full' : `Join ${team.name}`, disabled: full, 'data-fk': `join-${t}` });
    action.addEventListener('click', () => ctx.act('team', { team: t }));
  }

  const help = !mine && team.members.length >= s.size && s.me.team !== null ? h('p', { class: 'hint', text: 'To swap, ask someone here to move to Waiting first.' }) : null;

  return tint(
    h(
      'section',
      { class: `panel team${mine ? ' mine' : ''}`, 'aria-label': team.name },
      panelHead(team, h('span', { class: 'count', text: `${team.members.length}/${s.size}` })),
      h('ul', { class: 'plist' }, rows),
      h('div', { class: 'panel-actions' }, action),
      help,
      styleBlock(s, t),
    ),
    team.color,
  );
}

function readyBar(s) {
  const me = s.me;
  const all = members(s);
  const missing = s.teams.map((team) => s.size - team.members.length);
  const ready = all.filter((p) => p.ready).length;

  let hint;
  if (me.team === null) hint = 'Join a team first, then press Ready.';
  else if (missing.some((n) => n > 0)) {
    const needs = s.teams.map((team, i) => (missing[i] > 0 ? `${team.name} needs ${plural(missing[i], 'more player')}` : null)).filter(Boolean);
    hint = `${needs.join('. ')}. The game moves on once both teams are full and everyone is ready.`;
  } else if (me.ready) hint = `You are ready. ${ready} of ${all.length} players are ready.`;
  else hint = `Both teams are full. ${ready} of ${all.length} players are ready.`;

  const button = h('button', { type: 'button', class: me.ready ? 'secondary' : 'primary', text: me.ready ? 'Unready' : 'Ready', disabled: me.team === null, 'data-fk': 'ready' });
  button.addEventListener('click', () => ctx.act('ready', { ready: !me.ready }));
  return h('div', { class: 'room-actions' }, button, h('p', { class: 'hint', role: 'status', text: hint }));
}

function teamsScreen(s) {
  return [
    progress(s),
    heading(`${s.size}v${s.size} team game`, `The first team to win ${s.target} matches takes the game.`),
    invitePanel(s),
    h('div', { class: 'team-grid' }, waitingPanel(s), teamPanel(s, 0), teamPanel(s, 1)),
    readyBar(s),
  ];
}

// ----------------------------------------------------------- order screen ----

function ownOrderPanel(s) {
  const t = s.me.team;
  const team = s.teams[t];
  const confirmed = team.members.filter((p) => p.confirmed).length;
  const iConfirmed = Boolean(team.members.find((p) => p.isYou && p.confirmed));

  const rows = team.members.map((p, i) => {
    const up = h('button', { type: 'button', class: 'arrow', 'aria-label': `Move ${p.name} up`, text: '▲', disabled: team.final || i === 0, 'data-fk': `up-${p.id}` });
    const down = h('button', { type: 'button', class: 'arrow', 'aria-label': `Move ${p.name} down`, text: '▼', disabled: team.final || i === team.members.length - 1, 'data-fk': `down-${p.id}` });
    up.addEventListener('click', () => ctx.act('order', { id: p.id, direction: 'up' }));
    down.addEventListener('click', () => ctx.act('order', { id: p.id, direction: 'down' }));
    return h(
      'li',
      { class: 'prow' },
      h('span', { class: 'pos', 'aria-label': `Player ${i + 1}`, text: i + 1 }),
      nameBlock(p),
      p.confirmed ? chip('Confirmed', 'ready') : chip('Not yet'),
      h('span', { class: 'arrows' }, up, down),
    );
  });

  const confirm = h('button', {
    type: 'button',
    class: iConfirmed ? 'secondary' : 'primary',
    text: team.final ? 'Order locked' : iConfirmed ? 'Unconfirm' : 'Confirm order',
    disabled: team.final,
    'data-fk': 'confirm',
  });
  confirm.addEventListener('click', () => ctx.act('confirm', { confirmed: !iConfirmed }));

  const status = team.final ? 'Your order is locked in.' : `${confirmed} of ${team.members.length} teammates confirmed. Moving anyone clears every confirmation.`;
  return tint(
    h(
      'section',
      { class: 'panel team mine', 'aria-label': `${team.name}, your team` },
      panelHead(team, chip(team.final ? 'Locked' : `${confirmed}/${team.members.length} confirmed`, team.final ? 'ready' : '')),
      h('p', { class: 'hint', text: 'Player 1 fights first. Use the arrows to set who plays when.' }),
      h('ol', { class: 'plist ordered' }, rows),
      h('div', { class: 'panel-actions' }, confirm),
      h('p', { class: 'hint', role: 'status', text: status }),
      styleBlock(s, t),
    ),
    team.color,
  );
}

function hiddenOrderPanel(s) {
  const team = s.teams[1 - s.me.team];
  const rows = team.members.map((p) =>
    h('li', { class: 'prow' }, h('span', { class: 'pos unknown', 'aria-hidden': 'true', text: '?' }), nameBlock(p)),
  );
  return tint(
    h(
      'section',
      { class: 'panel team other', 'aria-label': `${team.name}, the other team` },
      panelHead(team, chip(team.final ? 'Locked' : 'Choosing', team.final ? 'ready' : '')),
      h('p', { class: 'hint', text: 'Their order stays hidden until both teams have locked theirs in.' }),
      h('ul', { class: 'plist' }, rows),
    ),
    team.color,
  );
}

function orderScreen(s) {
  return [
    progress(s),
    heading('Set your order', 'Decide who fights first, second and so on. Any teammate can move players, and the order is final once everyone confirms.'),
    h('div', { class: 'order-grid' }, ownOrderPanel(s), hiddenOrderPanel(s)),
  ];
}

// ------------------------------------------------------------ match lobby ----

function scoreboard(s) {
  const side = (t) => {
    const team = s.teams[t];
    return tint(h('div', { class: 'sb-team' }, h('span', { class: 'swatch', 'aria-hidden': 'true' }), h('strong', { text: team.name })), team.color);
  };
  return h(
    'div',
    { class: 'scoreboard', role: 'group', 'aria-label': `Team score: ${s.teams[0].name} ${s.score[0]}, ${s.teams[1].name} ${s.score[1]}` },
    side(0),
    h('div', { class: 'sb-score' }, h('span', { text: s.score[0] }), h('span', { class: 'colon', text: ':' }), h('span', { text: s.score[1] })),
    side(1),
    h('p', { class: 'sb-note hint', text: `First to ${s.target} wins · Match ${s.matchNo + 1}` }),
  );
}

function duelCard(s, t) {
  const player = s.current && s.current[t];
  const team = s.teams[t];
  if (!player) return tint(h('div', { class: 'duel-card' }, h('strong', { text: 'Nobody' })), team.color);
  return tint(
    h(
      'div',
      { class: 'duel-card' },
      h('span', { class: 'who', text: team.name }),
      h('strong', { class: 'p-text', text: player.isYou ? `${player.name} (you)` : player.name }),
      player.online === false ? chip('Offline') : player.matchReady ? chip('Ready', 'ready') : chip('Not ready'),
    ),
    team.color,
  );
}

function orderList(s, t) {
  const team = s.teams[t];
  const rows = team.members.map((p, i) =>
    h(
      'li',
      { class: `prow${i === team.up ? ' up' : ''}` },
      h('span', { class: 'pos', 'aria-label': `Player ${i + 1}`, text: i + 1 }),
      nameBlock(p),
      i === team.up ? chip('Up now', 'up') : null,
    ),
  );
  return tint(
    h('section', { class: 'panel team', 'aria-label': `${team.name} order` }, panelHead(team, h('span', { class: 'count', text: `${s.score[t]} won` })), h('ol', { class: 'plist ordered' }, rows)),
    team.color,
  );
}

function lastMatchLine(s) {
  const last = s.lastMatch;
  if (!last) return null;
  const winner = last.names[last.winnerTeam];
  const loser = last.names[1 - last.winnerTeam];
  const team = s.teams[last.winnerTeam];
  const text = last.forfeit
    ? `Match ${last.number}: ${loser} left, so ${winner} won by forfeit. ${team.name} scores a point.`
    : `Match ${last.number}: ${winner} beat ${loser} in ${plural(last.rounds, 'round')}. ${team.name} scores a point.`;
  return tint(h('p', { class: 'last-match', text }), team.color);
}

/** The round that decided the last match, drawn like the result card in a game:
 *  both moves with their pictures. Team Red's player is on the left and Team
 *  Blue's on the right, as on the score strip. A forfeit has no deciding round. */
function lastRoundCard(s) {
  const last = s.lastMatch;
  const round = last && last.last;
  if (!round || last.forfeit || !round.result) return null;

  const side = (i) => {
    const team = s.teams[i];
    const id = i === 0 ? round.you : round.opp;
    const won = last.winnerTeam === i;
    return tint(
      h(
        'div',
        { class: `played ${i === 0 ? 'you' : 'opp'} t-${ctx.moveColor(id)}` },
        h('span', { class: 'who' }, last.names[i], h('span', { class: 'who-team', text: team.name })),
        h('span', { class: 'art' }, moveIcon(id)),
        h('strong', { class: 'mv', text: ctx.moveName(id) }),
        won ? chip('Won the match', 'up') : null,
      ),
      team.color,
    );
  };

  return h(
    'div',
    { class: 'last-round', role: 'group', 'aria-label': `Match ${last.number}, winning round` },
    h('p', { class: 'lr-title', text: `Match ${last.number}, winning round (round ${round.round})` }),
    h('div', { class: 'clash' }, side(0), h('span', { class: 'vs', text: 'vs' }), side(1)),
    h('p', { class: 'rv-text', text: ctx.describeRound(round, last.names) }),
  );
}

/** How the last match ended: one line, plus the winning round when there was one. */
function lastMatchBlock(s) {
  const line = lastMatchLine(s);
  if (!line) return null;
  return h('section', { class: 'last-block', 'aria-label': `Match ${s.lastMatch.number} result` }, line, lastRoundCard(s));
}

function matchLobbyScreen(s) {
  const me = s.me;
  const [a, b] = s.current || [null, null];
  const iAmUp = (a && a.isYou) || (b && b.isYou);

  let action = null;
  let hint;
  if (iAmUp) {
    action = h('button', { type: 'button', class: me.matchReady ? 'secondary' : 'primary', text: me.matchReady ? 'Unready' : 'Ready', 'data-fk': 'match-ready' });
    action.addEventListener('click', () => ctx.act('matchready', { ready: !me.matchReady }));
    hint = me.matchReady ? 'You are ready. The match starts when your opponent is ready too.' : 'You are up. Press Ready to start the match.';
  } else if (a && b) {
    hint = `You are watching. The match starts when ${a.name} and ${b.name} are both ready.`;
  } else {
    hint = 'Waiting for the next players.';
  }

  const openEditor = me.canStyle ? h('details', { class: 'edit-team' }, h('summary', { text: 'Change team name or color' }), styleEditor(s, me.team)) : null;

  return [
    progress(s),
    heading('Match lobby'),
    scoreboard(s),
    h(
      'section',
      { class: 'duel', 'aria-label': 'Players who are up' },
      duelCard(s, 0),
      h('span', { class: 'vs', text: 'vs' }),
      duelCard(s, 1),
    ),
    h('div', { class: 'room-actions' }, action, h('p', { class: 'hint', role: 'status', text: hint })),
    lastMatchBlock(s),
    h('div', { class: 'order-grid' }, orderList(s, 0), orderList(s, 1)),
    openEditor,
  ];
}

// ------------------------------------------------------------- end screen ----

function overScreen(s) {
  const winner = s.teams[s.winner];
  const loser = s.teams[1 - s.winner];
  const all = members(s);
  const asked = all.filter((p) => p.rematch).length;
  const reason =
    s.overReason === 'forfeit'
      ? `${loser.name} has no players left, so ${winner.name} wins.`
      : `${winner.name} reached ${s.target} wins.`;

  const again = h('button', { type: 'button', class: 'primary', text: s.me.rematch ? 'Waiting for others' : 'Play again', disabled: s.me.rematch, 'data-fk': 'rematch' });
  again.addEventListener('click', () => ctx.act('rematch'));
  const note = s.me.rematch
    ? `${asked} of ${all.length} players want to play again. Everyone keeps their team.`
    : asked
      ? `${asked} of ${all.length} players want to play again.`
      : 'Everyone keeps their team and goes back to the team lobby.';

  return [
    progress(s),
    tint(
      h(
        'section',
        { class: 'banner team-banner', 'aria-label': 'Game over' },
        h('h2', { text: `${winner.name} wins` }),
        h('p', { class: 'final-score', text: `${s.score[0]} : ${s.score[1]}` }),
        h('p', { text: reason }),
        again,
        h('p', { class: 'hint', role: 'status', text: note }),
      ),
      winner.color,
    ),
    lastMatchBlock(s),
    h('div', { class: 'order-grid' }, orderList(s, 0), orderList(s, 1)),
  ];
}

// ----------------------------------------------------------------- public ----

export function render(s) {
  const root = $('#view-team');
  const saved = captureFocus(root);
  const screens = { teams: teamsScreen, order: orderScreen, matchlobby: matchLobbyScreen, over: overScreen };
  const build = screens[s.stage];
  root.dataset.stage = s.stage;
  root.replaceChildren(...(build ? build(s) : []).filter(Boolean));
  restoreFocus(saved, root);
}

/** The score strip above a team match. Hidden for one-on-one games. */
export function renderStrip(s) {
  const strip = $('#team-strip');
  if (s.mode !== 'team' || s.status !== 'playing') {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  strip.hidden = false;
  strip.setAttribute('role', 'group');
  strip.setAttribute('aria-label', `Team score: ${s.teams[0].name} ${s.score[0]}, ${s.teams[1].name} ${s.score[1]}`);
  const side = (t) => {
    const team = s.teams[t];
    const player = s.current && s.current[t];
    return tint(
      h(
        'div',
        { class: `strip-team t${t}` },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('div', { class: 'st-text' }, h('strong', { text: team.name }), h('span', { class: 'st-player', text: player ? player.name : '' })),
        h('span', { class: 'st-score', text: s.score[t] }),
      ),
      team.color,
    );
  };
  strip.replaceChildren(
    side(0),
    h('div', { class: 'strip-mid' }, h('strong', { text: `Match ${s.matchNo}` }), h('span', { class: 'hint', text: `First to ${s.target}` })),
    side(1),
  );
}
