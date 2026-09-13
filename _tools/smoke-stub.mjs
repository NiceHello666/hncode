// Smoke-test stub: OpenAI + Anthropic SSE chat servers that act like a coding agent:
//  - turn 1: assistant tool_call -> Bash `echo hncode-smoke-ok`
//  - turn 2 (after tool_result arrives): assistant final text "SMOKE PASS"
// The server inspects the incoming request to also assert the tool schema was sent.

import http from 'node:http';

const PORT_OA = +(process.env.QA_PORT_OA ?? 9241);
const PORT_AN = +(process.env.QA_PORT_AN ?? 9242);

function countTurns(reqBody) {
  // count assistant turns by messages with role assistant that had tool_calls
  return (reqBody.messages || []).filter((m) => m.role === 'assistant').length;
}

const openaiHandler = (req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const hasTools = Array.isArray(j.tools) && j.tools.some((t) => t.type === 'function' && t.function.name === 'Bash');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
    if (!hasTools) { send({ choices: [{ delta: { content: 'ERROR_NO_TOOLS' } }] }); res.end('data:[DONE]\n\n'); return; }
    const localTurns = countTurns(j);
    if (localTurns === 0) {
      send({ choices: [{ delta: { content: 'I will check.' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"echo hncode-smoke-ok"}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ choices: [{ delta: { content: 'SMOKE PASS' } }] });
      send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
};

const anthropicHandler = (req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    const j = JSON.parse(body || '{}');
    const hasTools = Array.isArray(j.tools) && j.tools.some((t) => t.name === 'Bash');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(JSON.stringify(o) + '\n\n');
    if (!hasTools) { send({ type: 'message_delta' }); send({ type: 'message_stop' }); res.end(); return; }
    const localTurns = countTurns(j); // anthropic uses same message roles
    if (localTurns === 0) {
      send({ type: 'message_start', message: { id: 'm' } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking... ' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'a1', name: 'Bash', input: {} } });
      send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json', partial_json: '{"command":"echo hncode-smoke-ok"}' } });
      send({ type: 'content_block_stop', index: 1 });
      send({ type: 'message_delta' });
      send({ type: 'message_stop' });
    } else {
      send({ type: 'message_start', message: { id: 'm2' } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SMOKE PASS' } });
      send({ type: 'content_block_stop', index: 0 });
      send({ type: 'message_delta' });
      send({ type: 'message_stop' });
    }
    res.end();
  });
};

http.createServer(openaiHandler).listen(PORT_OA, '127.0.0.1', () => console.log(`stub-openai on :${PORT_OA}`));
http.createServer(anthropicHandler).listen(PORT_AN, '127.0.0.1', () => console.log(`stub-anthropic on :${PORT_AN}`));
console.log('READY');