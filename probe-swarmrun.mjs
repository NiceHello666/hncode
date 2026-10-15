// Why do swarms come back empty?
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hncode-swarmrun-'));
process.env.HNCODE_HOME = home;

const { spec } = await import('./src/tools/agent-swarm.js');
const { createTask, appendTaskOutput, settleTask } = await import('./src/agent-task.js');

const outLines = [];
const ctx = {
  tasks: {},
  provider: 'p', model: 'session-model',
  raw: { providers: { p: {} }, models: { 'session-model': { provider: 'p' } } },
  cwd: process.cwd(),
  onOutput: (s) => outLines.push(String(s)),
  onEvent: () => {},
  _parentMessages: [],
};

console.log('calling AgentSwarm with 3 items...');
let result;
try {
  result = await spec.execute({
    description: 'audit three files',
    prompt_template: 'review {{item}}',
    items: ['a.js', 'b.js', 'c.js'],
  }, ctx);
} catch (e) {
  console.log('THREW:', e.message);
  console.log(String(e.stack).split('\n').slice(1, 5).join('\n'));
}

console.log('\nresult:', JSON.stringify(String(result)).slice(0, 400));
console.log('\nonOutput lines:');
for (const l of outLines.slice(0, 20)) console.log('   ' + JSON.stringify(l));

console.log('\ntasks created:', Object.keys(ctx.tasks).length);
for (const t of Object.values(ctx.tasks)) {
  console.log(`   ${t.taskId}  ${t.status.padEnd(10)} parent=${t.parentTaskId || '-'}  ${String(t.description).slice(0, 40)}`);
  console.log(`      output: ${JSON.stringify(String(t.output || '').slice(0, 80))}`);
}

fs.rmSync(home, { recursive: true, force: true });