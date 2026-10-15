// Where does the subagent's error go?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-errtrace-'));
process.env.HNCODE_HOME = home;

const { runSubagent } = await import('./src/tools/agent.js').then((m) => ({ runSubagent: null })).catch(() => ({ runSubagent: null }));
void runSubagent;

// The internal one is not exported, so drive it through the tool spec and watch the return.
const { spec } = await import('./src/tools/agent.js');

const ctx = {
  tasks: {},
  provider: 'p', model: 'session-model',
  raw: { providers: { p: {} }, models: { 'session-model': { provider: 'p' } } },
  cwd: process.cwd(),
  onOutput: () => {},
  onEvent: () => {},
  _parentMessages: [],
};

console.log('calling Agent directly with no endpoint (it must fail)...');
const r = await spec.execute({ prompt: 'say hi', description: 'trace' }, ctx);
console.log('returned:', JSON.stringify(String(r)).slice(0, 300));

console.log('\nthe tasks:');
for (const t of Object.values(ctx.tasks)) {
  console.log(`  ${t.taskId} ${t.status}  output=${JSON.stringify(String(t.output || '').slice(0, 100))}`);
}

fs.rmSync(home, { recursive: true, force: true });