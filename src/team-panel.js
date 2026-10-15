// The team panel: who is on the team, what each is doing, and a composer to message them.
//
// WHY A PANEL AND NOT ONLY THE COMMAND
// ------------------------------------
// `/team msg alice ...` works, but a team is a thing you WATCH. The question a user has is "is
// anyone stuck, and who do I need to nudge" — and answering it from the command line means running
// `/team list`, reading four lines, and remembering them. The panel keeps the roster and each
// member's recent traffic on screen while you type.
//
// SHAPE
// -----
// Left: the roster, one line per member — name, live state, unread count. Below it a one-line
// composer. Enter sends to the selected member; Tab moves between members; Esc leaves.
//
// It follows tasks-browser.js: a pure renderer plus a key handler, so both are testable without a
// terminal.
import fs from 'node:fs';
import { C } from './colors.js';
import { visualWidth, fit } from './term.js';
import { readTeamFile } from './team/store.js';
import { readMailbox, writeToMailbox } from './team/mailbox.js';
import { readTasks, formatTasks } from './team/tasks.js';
import { TEAM_LEAD_NAME } from './team/constants.js';


/** The state a panel needs, created once when it opens. */
export function makeTeamPanel(teamName) {
  return {
    teamName,
    selectedIndex: 0,
    /** 'roster' or 'compose', so a keystroke means one thing at a time. */
    mode: 'roster',
    composing: '',
    caret: 0,
    flash: '',
    /** How much of each member's recent mail to show. */
    mailLines: 4,
  };
}

/**
 * The members as rows, in roster order.
 *
 * The LEAD is included and is selectable: the user is the boss, and talking to the lead is how
 * they give the team its work.
 */
export function teamRows(panel) {
  const team = readTeamFile(panel.teamName);
  if (!team || !Array.isArray(team.members)) return [];
  return team.members.map((m) => {
    // Unread mail TO this member from someone ELSE. The user's own sends are stamped
    // `from: TEAM_LEAD_NAME` and sit in the recipient's box until it reads them, so counting
    // them made the roster show `1 new` for a message the user had just typed themselves —
    // a badge nothing could ever clear and nothing ever delivered.
    const unread = readMailbox(panel.teamName, m.name)
      .filter((x) => !x.read && x.from !== TEAM_LEAD_NAME).length;
    return {
      name: m.name,
      model: m.model || '',
      color: m.color || '',
      // By ROLE: a team that names its own leader still shows it as the lead.
      isLead: m.role === 'lead',
      unread,
      // The member's own PHASE — what it is doing, not whether a flag is set. `starting` covers
      // one written before the phase existed; `working` means a tool is actually running, and
      // `thinking` means it is blocked on the model, which is most of a round.
      //
      // `lead` is decided by ROLE, not by the name matching the wire alias. The alias test never
      // matched a real lead (`addMember` gives the role to the first member added, whose name is
      // its own — `NiceHello_01`, not `team-lead`), so the branch was dead and every lead fell
      // through to its phase.
      state: (m.role === 'lead') ? 'lead'
        : (m.phase || (m.isActive === false ? 'idle' : 'starting')),
    };
  });
}

/** The traffic for one member: what they said, and what was said to them, newest last. */
export function memberTraffic(teamName, name, limit = 4) {
  const box = readMailbox(teamName, name);
  return box.slice(-limit).map((m) => ({
    from: m.from,
    text: String(m.text || '').split('\n')[0].slice(0, 100),
    at: m.timestamp,
  }));
}

/** Draw the panel. Exactly `rows` lines, each `cols` wide. */
export function renderTeamPanel(panel, cols, rows) {
  const out = [];
  const push = (s) => { out.push(fit(s, cols)); };

  const team = readTeamFile(panel.teamName);
  const memberCount = (team && team.members) ? team.members.length : 0;
  const title = team
    ? ` Team "${panel.teamName}" — ${memberCount} member(s)`
    : ` Team "${panel.teamName}" — the roster is gone`;

  push(C.border + '─'.repeat(cols) + C.reset);
  push(C.cyan + C.bold + title + C.reset
    + (panel.flash ? `   ${C.yellow}${panel.flash}${C.reset}` : ''));

  const roster = teamRows(panel);
  if (!roster.length) {
    push('  ' + C.gray + 'No members. Add one with /team add <name>.' + C.reset);
  }

  // The roster, then the selected member's traffic, then the composer.
  const composerRows = 3;
  const trafficRoom = Math.max(0, Math.min(panel.mailLines + 2, rows - roster.length - composerRows - 6));

  for (let i = 0; i < roster.length && out.length < rows - composerRows - trafficRoom - 2; i++) {
    const m = roster[i];
    const sel = i === panel.selectedIndex;
    const ptr = sel ? `${C.cyan}❯${C.reset} ` : '  ';
    const name = (m.isLead ? `${m.name} (lead)` : m.name).padEnd(20);
    // The states a member can be in, each with its own colour: green is a tool actually running,
    // cyan is blocked on the model, grey is waiting for work, yellow is an agent that has not
    // begun. `starting` used to fall through to `not started`, so a lead mid-launch claimed the
    // one thing that was certainly false about it — this is the row the user read as "my lead
    // never came up", and the correct reading was "it is on its way".
    const state = m.state === 'lead' ? `${C.gray}lead${C.reset}`
      : m.state === 'working' ? `${C.green}working${C.reset}`
        : m.state === 'thinking' ? `${C.cyan}thinking${C.reset}`
          : m.state === 'idle' ? `${C.gray}idle${C.reset}`
            : m.state === 'starting' ? `${C.yellow}starting${C.reset}`
              : `${C.yellow}not started${C.reset}`;
    const mail = m.unread ? `${C.yellow} ${m.unread} new${C.reset}` : '';
    const model = m.model ? `${C.gray} ${m.model}${C.reset}` : '';
    push(sel
      ? `${ptr}${C.cyan}${name}${C.reset}${state}${mail}${model}`
      : `${ptr}${name}${state}${mail}${model}`);
  }

  // What the selected member has been saying.
  const sel = roster[panel.selectedIndex];
  if (sel && trafficRoom > 0) {
    push('');
    push(`  ${C.gray}── ${sel.name} ──${C.reset}`);
    const traffic = memberTraffic(panel.teamName, sel.name, trafficRoom);
    if (!traffic.length) push('  ' + C.gray + '(no messages yet)' + C.reset);
    for (const t of traffic) {
      // `team-lead` is the alias the USER'S own sends carry, so this line reads "you wrote this".
      // It is NOT a statement that the lead is the user — the lead is a rostered agent under its
      // own name. That misreading once removed this very alias check from the inbox reader, which
      // made a message you sent to your lead come back to you as though an agent had sent it.
      const who = t.from === TEAM_LEAD_NAME ? 'you' : t.from;
      push(`  ${C.gray}${who}:${C.reset} ${t.text}`);
    }
  }

  // The shared task list, one line, so "is the team moving" needs no second screen.
  const tasks = readTasks(panel.teamName);
  if (tasks.length && out.length < rows - composerRows - 1) {
    const open = tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled').length;
    push('  ' + C.gray + `${tasks.length - open}/${tasks.length} tasks done${C.reset}`);
  }

  while (out.length < rows - composerRows) out.push(' '.repeat(cols));

  // The composer. One line, always visible, and it SAYS who it will go to — the failure mode of a
  // chat box is sending to the wrong person and only finding out afterwards.
  push(C.border + '─'.repeat(cols) + C.reset);
  if (panel.mode === 'compose') {
    push(`  ${C.cyan}→ ${sel ? sel.name : '?'}${C.reset} ${panel.composing}${C.cyan}█${C.reset}`);
    push('  ' + C.gray + 'Enter send · Esc cancel' + C.reset);
  } else {
    push('  ' + C.gray + 'Enter write · Tab next · ↑↓ select · Esc close' + C.reset);
    push('');
  }

  return out.slice(0, rows);
}

/**
 * Keys for the panel.
 *
 * Returns an action for the caller to perform, rather than performing it: the panel does not own
 * the frame, the agent or the clipboard, and a renderer that acts is a renderer that cannot be
 * tested.
 */
export function handleTeamPanelKey(panel, t) {
  if (!t) return { handled: false };

  if (panel.mode === 'compose') {
    if (t.key === 'escape') { panel.mode = 'roster'; panel.composing = ''; panel.caret = 0; return { handled: true }; }
    if (t.key === 'enter') {
      const text = panel.composing.trim();
      const roster = teamRows(panel);
      const to = roster[panel.selectedIndex];
      panel.composing = '';
      panel.caret = 0;
      panel.mode = 'roster';
      if (!text || !to) return { handled: true };
      return { handled: true, action: 'send', to: to.name, text };
    }
    if (t.key === 'backspace') {
      panel.composing = panel.composing.slice(0, -1);
      panel.caret = panel.composing.length;
      return { handled: true };
    }
    if (t.ch && !t.key?.startsWith('c-')) { panel.composing += t.ch; panel.caret = panel.composing.length; return { handled: true }; }
    return { handled: true };
  }

  const roster = teamRows(panel);
  const n = roster.length;

  if (t.key === 'escape' || t.ch === 'q') return { handled: true, action: 'close' };
  if (t.key === 'enter') { if (n) { panel.mode = 'compose'; panel.composing = ''; } return { handled: true }; }
  if (t.key === 'tab' || t.key === 'down') { if (n) panel.selectedIndex = (panel.selectedIndex + 1) % n; return { handled: true }; }
  if (t.key === 's-tab' || t.key === 'up') { if (n) panel.selectedIndex = (panel.selectedIndex - 1 + n) % n; return { handled: true }; }
  if (t.key === 'home') { panel.selectedIndex = 0; return { handled: true }; }
  if (t.key === 'end') { if (n) panel.selectedIndex = n - 1; return { handled: true }; }
  // `r` marks everything read for the selected member — the way to clear a "3 new" badge you have
  // already looked at in the traffic pane.
  if (t.ch === 'r' && n) return { handled: true, action: 'markRead', name: roster[panel.selectedIndex].name };
  return { handled: false };
}

/** Deliver a message from the panel. Separated so the key handler stays pure. */
export function sendFromPanel(teamName, to, text) {
  if (!to || !text) return false;
  writeToMailbox(teamName, to, { from: TEAM_LEAD_NAME, text: String(text) });
  return true;
}
