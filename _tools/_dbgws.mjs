import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInWorkspace } from 'file:///D:/hncode/src/tui.js';
const out = (m) => process.stderr.write(m + '\n');

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'wscheck-'));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outcheck-'));
fs.writeFileSync(path.join(ws, 'a.txt'), 'x');
fs.writeFileSync(path.join(outside, 'b.txt'), 'y');
fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
fs.writeFileSync(path.join(ws, 'sub', 'c.txt'), 'z');

const state = { cwd: ws, workspace: ws, addDirs: [] };
out('workspace: ' + ws);
out('');
for (const [label, p] of [
  ['ws/a.txt (absolute)', path.join(ws, 'a.txt')],
  ['ws/sub/c.txt', path.join(ws, 'sub', 'c.txt')],
  ['relative a.txt', 'a.txt'],
  ['relative sub/c.txt', 'sub/c.txt'],
  ['ws/new.txt (does NOT exist)', path.join(ws, 'new.txt')],
  ['outside/b.txt', path.join(outside, 'b.txt')],
  ['outside/evil.txt (new)', path.join(outside, 'evil.txt')],
  ['ws itself', ws],
  ['parent of ws', path.dirname(ws)],
]) {
  out(`${label.padEnd(32)} -> ${isInWorkspace(state, p)}`);
}

out('');
out('note: fs.realpathSync on the WINDOWS temp dir may return the 8.3 short name');
out('(e.g. C:\\Users\\ADMINI~1\\...) which would not match path.resolve(cwd).');
out('  cwd resolved : ' + path.resolve(ws));
let real = null;
try { real = fs.realpathSync(ws); } catch {}
out('  realpath(ws) : ' + real);
out('  equal?       : ' + (real === path.resolve(ws)));
