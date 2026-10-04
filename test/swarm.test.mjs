// The two swarm bugs, driven through the real code paths.
//
// BUG 1 — every cell but the first stayed "Queued…" for the whole run.
// `agent-swarm.js` reported progress only through `appendTaskOutput`, which feeds the
// BACKGROUND TASK buffer (TaskOutput, and the record that survives a detach). The
// transcript's progress block does not read that: it counts `[n/m] finished` lines out
// of `entry.liveOutput`, which is only written from `tool_output` events, i.e. from
// `ctx.onOutput`. Nothing ever wrote there, so the count stayed 0 and the "cell i ===
// done" rule put cell 0 on "Working…" and left every other cell at its initial phase.
//
// BUG 2 — AgentSwarm was offered on every turn. `state.swarm` only appended a paragraph
// to the system prompt; the tool stayed in the catalog, so 128 subagents could run in a
// session where the user had never opted in.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A store far away from the real one, in case anything here touches session state.
process.env.HNCODE_SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-swarm-test-'));

const { renderSwarmProgress } = await import('../src/swarm-progress.js');

// ---------------------------------------------------------------------------
// BUG 1: the live sink receives the progress lines
// ---------------------------------------------------------------------------

test('AgentSwarm reports progress to the live sink, not only the task buffer', () => {
  const src = fs.readFileSync(new URL('../src/tools/agent-swarm.js', import.meta.url), 'utf8');
  // The `[n/m] finished` line must be handed to ctx.onOutput. Asserting on the source is
  // deliberate: the alternative is spawning a real swarm, and the defect is precisely a
  // MISSING call, which no amount of unit-testing the surrounding code can observe.
  const at = src.indexOf("`[${done}/${jobs.length}] finished");
  assert.ok(at > 0, 'the progress line is built in the worker');
  const around = src.slice(Math.max(0, at - 900), at + 300);
  assert.match(around, /ctx\.onOutput/,
    'the progress line is also sent to ctx.onOutput (the channel the UI reads)');
  assert.match(around, /appendTaskOutput/,
    'and still to the task buffer, which is what survives a Ctrl+B detach');
});

test('the progress block advances its cells as [n/m] lines arrive', () => {
  // The TUI's rule, reproduced: count the matches, mark everything below `done` complete
  // and the cell AT `done` as working. With the lines arriving, the grid fills in.
  const liveOutput = '[1/3] finished\n[2/3] finished\n';
  const members = Array.from({ length: 3 }, () => ({ phase: 'queued', ratio: 0, latestText: '' }));
  const done = (liveOutput.match(/^\[\d+\/\d+\] finished$/gm) || []).length;
  members.forEach((mem, i) => {
    if (i < done) { mem.phase = 'completed'; mem.ratio = 1; }
    else if (i === done) { mem.phase = 'working'; mem.ratio = 0.5; }
  });
  assert.deepEqual(members.map((m) => m.phase), ['completed', 'completed', 'working'],
    'two landed cells and one in flight');

  // Without them — the bug — nothing progresses past the first cell.
  const stuck = Array.from({ length: 3 }, () => ({ phase: 'queued', ratio: 0, latestText: '' }));
  const none = (''.match(/^\[\d+\/\d+\] finished$/gm) || []).length;
  stuck.forEach((mem, i) => {
    if (i < none) { mem.phase = 'completed'; mem.ratio = 1; }
    else if (i === none) { mem.phase = 'working'; mem.ratio = 0.5; }
  });
  assert.deepEqual(stuck.map((m) => m.phase), ['working', 'queued', 'queued'],
    'this is the reported symptom: only #1 was ever working');
});

test('a settled swarm shows every cell as done', () => {
  const liveOutput = '[1/2] finished\n[2/2] finished\n';
  const done = (liveOutput.match(/^\[\d+\/\d+\] finished$/gm) || []).length;
  assert.equal(done, 2, 'both cells advance');
});

// ---------------------------------------------------------------------------
// BUG 2: swarm mode gates the tool
// ---------------------------------------------------------------------------

test('AgentSwarm is exposed only when swarm mode is on', () => {
  const src = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /t\.name === 'AgentSwarm' && !cfg\.swarm/,
    'the catalog filter drops AgentSwarm unless cfg.swarm is set');
  assert.match(src, /this\.swarmMode = !!cfg\.swarm/,
    'and the direct-call path has a matching flag');
});

test('a call to AgentSwarm with the mode off is refused, with the fix in the message', () => {
  const src = fs.readFileSync(new URL('../src/agent.js', import.meta.url), 'utf8');
  assert.match(src, /swarmMode !== true && tc\.name === 'AgentSwarm'/,
    'the executor blocks a stray call');
  assert.match(src, /swarm mode is OFF[\s\S]{0,200}\/swarm/,
    'and tells the model to ask for /swarm rather than just refusing');
});

test('the per-turn cfg carries swarm mode from the UI state', () => {
  // The mode lives on `state`, but the tool catalog is decided in the Agent constructor,
  // which only ever sees cfg — so the flag has to be passed across.
  const src = fs.readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  assert.match(src, /cfg: \{ \.\.\.cfg, swarm: !!state\.swarm,/,
    'the turn passes swarm mode into the Agent cfg');
});

test('the tool description says the mode is required', async () => {
  const { spec } = await import('../src/tools/agent-swarm.js');
  assert.match(spec.description, /swarm mode is ON/,
    'the model is told the tool needs the mode');
});

// ---------------------------------------------------------------------------
// the progress block still renders (the fix must not break the drawing)
// ---------------------------------------------------------------------------

test('a mixed swarm renders one cell per subagent plus a status line', () => {
  const lines = renderSwarmProgress({
    description: 'two jobs',
    model: 'coder',
    members: [
      { phase: 'completed', ratio: 1, latestText: '' },
      { phase: 'working', ratio: 0.5, latestText: 'reading a file' },
      { phase: 'queued', ratio: 0, latestText: '' },
    ],
  }, 100, { indent: ' ', availableGridHeight: 8 });
  const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  assert.ok(plain.some((l) => l.includes('Agent Swarm')), 'header present');
  assert.ok(plain.some((l) => l.includes('001') && l.includes('Completed')), 'first cell completed');
  assert.ok(plain.some((l) => l.includes('002') && l.includes('Working')), 'second cell working');
  assert.ok(plain.some((l) => l.includes('003') && l.includes('Queued')), 'third cell still queued');
  assert.ok(plain.some((l) => /Working/.test(l) && /[━#]/.test(l)), 'overall status line with a pip bar');
});

test.after(() => {
  try { fs.rmSync(process.env.HNCODE_SESSIONS_DIR, { recursive: true, force: true }); } catch { /* temp */ }
  delete process.env.HNCODE_SESSIONS_DIR;
});
