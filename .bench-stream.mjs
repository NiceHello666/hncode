// End-to-end stream throughput: how fast does hncode consume an SSE stream?
// Local mock server, no network. Reports chunks/s, tokens/s, MB/s.
import http from 'node:http';
import { LLM } from 'file:///D:/hncode/src/llm.js';

const CHUNKS = Number(process.argv[2] || 4000);
const CHUNK = 'The quick brown fox jumps over the lazy dog. '.repeat(2); // ~88 bytes

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (let i = 0; i < CHUNKS; i++) {
    const d = i === 0
      ? { choices: [{ delta: { reasoning_content: 'thinking…' } }] }
      : { choices: [{ delta: { content: CHUNK } }] };
    res.write('data: ' + JSON.stringify(d) + '\n\n');
  }
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const cfg = {
  endpoint: `http://127.0.0.1:${port}/`, apiKey: 'x', protocol: 'openai',
  innerModel: 'mock', stream: true, maxOutputTokens: 4096,
};
const llm = new LLM(cfg);

let text = '', think = 0, events = 0;
const t0 = Date.now();
await llm.request([{ role: 'user', content: 'hi' }], (e) => {
  events++;
  if (e.type === 'data') text += e.text;
  else if (e.type === 'think') think += e.text.length;
});
const ms = Date.now() - t0;
const bytes = text.length;
console.log('chunks served      ', CHUNKS);
console.log('events received    ', events);
console.log('elapsed            ', ms + 'ms');
console.log('chunks/s           ', Math.round(CHUNKS / (ms / 1000)));
console.log('chars/s            ', Math.round(bytes / (ms / 1000)));
console.log('est tokens/s       ', Math.round((bytes / 4) / (ms / 1000)));
console.log('MB/s               ', (bytes / 1048576 / (ms / 1000)).toFixed(2));
console.log('think chars        ', think);
server.close();
