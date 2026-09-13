// How expensive is one paint? If composeFrame is slow, it starves the SSE read
// loop (single-threaded), capping the token acceptance rate.
import { makeState, composeFrame, diffFrame } from 'file:///D:/hncode/src/tui.js';

function build(msgs, textLen) {
  const state = makeState({ cfg: { model: 'm', maxContextTokens: 100000 }, session: { workspace: 'D:/hncode' }, opts: {} });
  state.cwd = 'D:/hncode';
  for (let i = 0; i < msgs; i++) {
    state.chat.push({ role: 'user', text: `question ${i} `.repeat(Math.ceil(textLen / 10)) });
    state.chat.push({ role: 'assistant', text: 'answer **bold** and `code` here.\n- item one\n- item two\n' + 'lorem ipsum '.repeat(Math.ceil(textLen / 12)) });
  }
  state.chat.push({ role: 'assistant', text: 'streaming…' });
  return state;
}

for (const [msgs, textLen] of [[10, 400], [60, 800], [200, 1500], [400, 2000]]) {
  const state = build(msgs, textLen);
  const t0 = Date.now();
  const N = 20;
  let prev = null;
  for (let i = 0; i < N; i++) {
    const f = composeFrame(state, 120, 40);
    diffFrame(prev, f);
    prev = f;
  }
  const per = (Date.now() - t0) / N;
  // streaming case: append a few chars each paint (invalidates the last line)
  const t1 = Date.now();
  for (let i = 0; i < N; i++) {
    const last = state.chat[state.chat.length - 1];
    last.text += 'x';
    const f = composeFrame(state, 120, 40);
    diffFrame(prev, f);
    prev = f;
  }
  const perStream = (Date.now() - t1) / N;
  console.log(
    String(msgs).padStart(4) + ' msgs, ' + String(textLen).padStart(4) + ' chars/msg  ',
    'paint ' + per.toFixed(2) + 'ms',
    ' streaming paint ' + perStream.toFixed(2) + 'ms',
    ' => max ' + Math.round(1000 / Math.max(per, perStream)) + ' fps',
  );
}
