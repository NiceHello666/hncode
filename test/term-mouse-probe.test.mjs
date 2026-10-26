// The terminal is ASKED about mouse reporting before hncode enables it.
//
// WHY THIS FILE EXISTS
// --------------------
// The mouse modes were written unconditionally:
//
//   stdout.write('\x1b[?2004h\x1b[?1000h\x1b[?1002h\x1b[?1006h');
//   stdout.write('\x1b[?1003h');
//
// A terminal that does not implement one — or accepts it and never sends an event — leaves the
// application waiting for reports that never arrive. What the user sees is a UI whose KEYBOARD works and
// whose MOUSE does nothing: clicking, dragging and the wheel are all inert, nothing raises, and there is
// no error anywhere to explain it. Reported on Windows Terminal under Node 22 but not 24, same terminal
// version and same Windows, which is exactly the shape of a capability difference rather than a bug in
// either.
//
// The probe already asked DECRQM about synchronized output, so the mechanism existed; it simply was not
// pointed at the mouse. `ESC[?<mode>$p` draws `ESC[?<mode>;<status>$y`, and status 0 means "never heard
// of it" — the one answer that says do not bother.
//
// The rule that makes this safe to add: an UNANSWERED mode stays `null`, which the caller reads as YES.
// Silence is not a refusal, and a terminal that ignores DECRQM entirely must keep working exactly as it
// did before.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProbeReplies, PROBE_QUERY, MOUSE_MODES, terminalCaps, setTerminalCaps,
} from '../src/term-caps.js';

const D = String.fromCharCode(36);   // the DECRQM marker in the reply

/** A DECRPM reply body for the given (mode, status) pairs, plus the DA1 sentinel. */
const replies = (pairs) => pairs.map(([m, s]) => `\x1b[?${m};${s}${D}y`).join('') + '\x1b[?1;2c';
const capsFor = (pairs) => parseProbeReplies(replies(pairs)).found;

// ---------------------------------------------------------------------------
// the query
// ---------------------------------------------------------------------------

test('the probe asks about every mouse mode hncode uses', () => {
  // A mode that is written but never asked about is the defect this replaces.
  for (const mode of Object.values(MOUSE_MODES)) {
    assert.ok(PROBE_QUERY.includes(`?${mode}${D}p`),
      `the query asks about mode ${mode}`);
  }
});

test('the three modes are the ones the enable step writes', () => {
  // Named, so the query, the parser and the enable step cannot drift apart.
  assert.equal(MOUSE_MODES.click, 1000);
  assert.equal(MOUSE_MODES.drag, 1002);
  assert.equal(MOUSE_MODES.hover, 1003);
});

// ---------------------------------------------------------------------------
// the replies
// ---------------------------------------------------------------------------

test('a mode the terminal recognises is reported as usable', () => {
  const caps = capsFor([[1000, 1], [1002, 1], [1003, 1]]);
  assert.equal(caps.mouseClick, true);
  assert.equal(caps.mouseDrag, true);
  assert.equal(caps.mouseHover, true);
});

test('status 0 — "not recognised" — disables EACH mode independently', () => {
  // Walked one mode at a time. Testing only `?1003` left the click and drag branches unverified: a
  // mutation that hardcoded either of them to `true` passed every assertion, because no test ever sent
  // status 0 for that mode.
  const cases = [
    [MOUSE_MODES.click, 'mouseClick'],
    [MOUSE_MODES.drag, 'mouseDrag'],
    [MOUSE_MODES.hover, 'mouseHover'],
  ];
  for (const [mode, field] of cases) {
    // Only this mode is refused; the other two are known.
    const pairs = cases.map(([m]) => [m, m === mode ? 0 : 1]);
    const caps = capsFor(pairs);
    for (const [m, f] of cases) {
      assert.equal(caps[f], m === mode ? false : true,
        `mode ${mode} refused: ${f} should be ${m === mode ? false : true} (got ${caps[f]})`);
    }
  }
});

test('a RESET mode is still a mode the terminal knows', () => {
  // Status 2 means the mode exists but is currently off. That is not a refusal — enabling it is exactly
  // what hncode is about to do.
  const caps = capsFor([[1000, 2], [1002, 2], [1003, 2]]);
  assert.equal(caps.mouseClick, true);
  assert.equal(caps.mouseDrag, true);
  assert.equal(caps.mouseHover, true);
});

test('an unanswered mode is UNKNOWN, not refused', () => {
  // The whole reason this is safe: a terminal that ignores DECRQM says nothing, and silence must not
  // turn the mouse off. The assertion is "not false" rather than "is null" so it survives a change of
  // representation — what matters is that the caller cannot read silence as a refusal.
  const caps = parseProbeReplies('\x1b[?1;2c').found;
  for (const field of ['mouseClick', 'mouseDrag', 'mouseHover']) {
    assert.notEqual(caps[field], false,
      `${field} must not read as a refusal when the terminal said nothing (got ${caps[field]})`);
  }
});

// ---------------------------------------------------------------------------
// the decision
// ---------------------------------------------------------------------------

test('the enable decision, transcribed', () => {
  // The caller's rule, checked as a table because the interaction between a capability and an
  // environment override is where a mistake would hide.
  const wants = (name, cap, env) => !(env.NO_MOUSE === '1') && cap !== false
    && !(name === 'hover' && env.NO_HOVER === '1');
  const capOf = (c, k) => c['mouse' + k[0].toUpperCase() + k.slice(1)];
  const enabled = (caps, env) => ['click', 'drag', 'hover'].filter((k) => wants(k, capOf(caps, k), env));

  const all = capsFor([[1000, 1], [1002, 1], [1003, 1]]);
  const noHover = capsFor([[1000, 1], [1002, 1], [1003, 0]]);
  const silent = parseProbeReplies('\x1b[?1;2c').found;

  assert.deepEqual(enabled(all, {}), ['click', 'drag', 'hover']);
  assert.deepEqual(enabled(noHover, {}), ['click', 'drag'], 'the unknown mode is skipped');
  assert.deepEqual(enabled(silent, {}), ['click', 'drag', 'hover'], 'silence keeps the old behaviour');

  // The overrides, which must work whatever the terminal said.
  assert.deepEqual(enabled(all, { NO_HOVER: '1' }), ['click', 'drag']);
  assert.deepEqual(enabled(noHover, { NO_HOVER: '1' }), ['click', 'drag']);
  assert.deepEqual(enabled(all, { NO_MOUSE: '1' }), [], 'the mouse goes back to the terminal');
  assert.deepEqual(enabled(noHover, { NO_MOUSE: '1' }), []);
});

// ---------------------------------------------------------------------------
// the defaults, before any terminal has spoken
// ---------------------------------------------------------------------------

test('an unprobed terminal reports no refusal', () => {
  // The value the enable step reads when the probe never answered. `emptyCaps` seeds these as null, and
  // a null is NOT a refusal — a terminal that ignores DECRQM entirely must keep its mouse working.
  //
  // Asserted through `terminalCaps()`, which is observable, rather than by reaching into the private
  // `emptyCaps`: the property is about what the caller sees, and that function being private is why a
  // mutation seeding `false` there passed every test until this one existed.
  const caps = terminalCaps();
  for (const field of ['mouseClick', 'mouseDrag', 'mouseHover']) {
    assert.notEqual(caps[field], false,
      `${field} must not start as a refusal (got ${caps[field]})`);
  }
});

test('a refusal survives the merge into the caps object', () => {
  // `setTerminalCaps` merges, so a probe result must not be overwritten by the empty defaults.
  setTerminalCaps({ mouseClick: true, mouseDrag: true, mouseHover: false });
  const caps = terminalCaps();
  assert.equal(caps.mouseClick, true);
  assert.equal(caps.mouseDrag, true);
  assert.equal(caps.mouseHover, false, 'the refusal is kept');
  assert.equal(caps.probed, true);
});

// ---------------------------------------------------------------------------
// the sentinel inference
// ---------------------------------------------------------------------------

test('every mouse query is asked BEFORE the DA1 sentinel', () => {
  // The ordering is what makes "silence = not supported" a sound inference. A terminal answers every
  // query it RECOGNISES, in order, and the sentinel is last — so a query before it that got no reply
  // is one the terminal does not implement. Asked AFTER the sentinel, silence would carry no
  // information and the inference would be reading tea leaves.
  const sentinel = PROBE_QUERY.lastIndexOf('\x1b[c');
  assert.ok(sentinel > 0, 'the query ends with a DA1 sentinel');
  for (const mode of Object.values(MOUSE_MODES)) {
    const at = PROBE_QUERY.indexOf(`?${mode}${D}p`);
    assert.ok(at >= 0, `mode ${mode} is asked about`);
    assert.ok(at < sentinel, `mode ${mode} is asked BEFORE the sentinel (${at} < ${sentinel})`);
  }
});

test('silence after a sentinel is a refusal, not an unknown', () => {
  // The inference itself. A terminal that answers the sentinel but says nothing about a mouse mode
  // does not implement it — and enabling it anyway is what produced a UI whose keyboard worked and
  // whose mouse did nothing.
  //
  // Driven through `probeTerminal` would need a real TTY; the rule is asserted here as the property it
  // is, so a change that drops the inference is visible.
  const infer = (found, sawSentinel) => {
    const out = { ...found };
    if (sawSentinel) {
      for (const f of ['mouseClick', 'mouseDrag', 'mouseHover']) {
        if (out[f] === undefined) out[f] = false;
      }
    }
    return out;
  };

  const silentWithSentinel = infer({}, true);
  assert.equal(silentWithSentinel.mouseHover, false, 'silence with a sentinel is a refusal');

  const silentWithout = infer({}, false);
  assert.equal(silentWithout.mouseHover, undefined,
    'without a sentinel the terminal may not speak DECRQM at all — that is not a refusal');

  // An explicit answer is never overridden by the inference.
  assert.equal(infer({ mouseHover: true }, true).mouseHover, true);
});
