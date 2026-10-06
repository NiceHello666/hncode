// Thinking-effort → wire mapping.
//
// WHY THESE ASSERTIONS
// --------------------
// `effortWire` had NO test coverage at all, and shipped with two silent substitutions:
//
//   * `on` was mapped to the grade `medium`, on every protocol. `on` means "thinking on",
//     not "medium strength" — the two are different requests, and a model that offers only a
//     plain toggle has no grade to send. The user picked "on" and the tool decided "medium".
//   * An unrecognised grade fell through to `budget || 8000`, so a user-defined grade such
//     as `xhigh` became byte-identical to `on` and `medium`. config.toml's own comments
//     advertise naming your own grades, so this hit the documented feature.
//
// Neither produced an error — both produced a DIFFERENT request than the one asked for,
// which is why they survived: nothing raises, and the UI shows the choice the user made.
import assert from 'node:assert/strict';
import test from 'node:test';

const { effortWire, effortOptions } = await import('../src/config.js');

/** A cfg shaped the way resolveConfig produces it. */
const cfgFor = (protocol, modelEntry = {}) => ({
  model: 'p/m',
  protocol,
  raw: { models: { 'p/m': modelEntry }, providers: {} },
});

const PROTOCOLS = ['openai', 'responses', 'anthropic'];

// ---------------------------------------------------------------------------
// `on` is a toggle, not a grade
// ---------------------------------------------------------------------------

test('on never sends a grade on the two protocols that only accept grade words', () => {
  // `reasoning_effort` and `reasoning.effort` take low/medium/high. There is no value for
  // "on", so the honest request is to omit the field.
  for (const protocol of ['openai', 'responses']) {
    const wire = effortWire(cfgFor(protocol), 'on');
    const text = JSON.stringify(wire);
    assert.ok(!/medium/.test(text), `${protocol}: on produced a grade — ${text}`);
    assert.ok(!/effort/.test(text), `${protocol}: on still sent an effort field — ${text}`);
    assert.deepEqual(wire, {}, `${protocol}: on sends nothing`);
  }
});

test('on sends the plain enable on anthropic, with no invented budget', () => {
  // `thinking: { type: 'enabled' }` IS the toggle; `budget_tokens` is optional. Sending a
  // number turns "on" into "on with THIS budget", which is not what was asked.
  const wire = effortWire(cfgFor('anthropic'), 'on');
  assert.deepEqual(wire, { thinking: { type: 'enabled' } });
  assert.equal(wire.thinking.budget_tokens, undefined, 'no budget was invented');
});

test('on and medium are NOT the same request any more', () => {
  // The regression, stated directly: these were indistinguishable before the fix.
  for (const protocol of PROTOCOLS) {
    const c = cfgFor(protocol, { efforts: ['low', 'medium', 'high'] });
    assert.notDeepEqual(effortWire(c, 'on'), effortWire(c, 'medium'),
      `${protocol}: on and medium must differ`);
  }
});

// ---------------------------------------------------------------------------
// named grades still carry their value
// ---------------------------------------------------------------------------

test('a named grade passes through as a grade word', () => {
  const openai = cfgFor('openai');
  assert.deepEqual(effortWire(openai, 'low'), { reasoning_effort: 'low' });
  assert.deepEqual(effortWire(openai, 'high'), { reasoning_effort: 'high' });
  const resp = cfgFor('responses');
  assert.deepEqual(effortWire(resp, 'low'), { reasoning: { effort: 'low' } });
  assert.deepEqual(effortWire(resp, 'high'), { reasoning: { effort: 'high' } });
});

test('a named grade pins a budget on anthropic, and the grades differ', () => {
  const c = cfgFor('anthropic');
  const low = effortWire(c, 'low').thinking.budget_tokens;
  const high = effortWire(c, 'high').thinking.budget_tokens;
  assert.ok(low > 0 && high > low, `low ${low} should be smaller than high ${high}`);
  assert.deepEqual(effortWire(c, 'medium'), { thinking: { type: 'enabled', budget_tokens: 8000 } });
});

// ---------------------------------------------------------------------------
// an unknown grade must not collapse onto a known one
// ---------------------------------------------------------------------------

test('a user-defined grade does not silently become 8000', () => {
  // config.toml documents `efforts = ["xhigh"]` as a thing a user may write. The old
  // fallback made it byte-identical to `medium` — a known grade with a known budget — which
  // meant "extra high" quietly requested the MIDDLE strength.
  const c = cfgFor('anthropic', { efforts: ['xhigh'] });
  const wire = effortWire(c, 'xhigh');
  assert.deepEqual(wire, { thinking: { type: 'enabled' } }, 'no budget is invented');
  assert.notDeepEqual(wire, effortWire(c, 'medium'), 'and it is NOT medium (the old fallback)');
  // It DOES equal `on`, and that is deliberate: both mean "enable thinking, budget unknown".
  // There is no honest number to send for a grade we have never heard of, so the field is
  // omitted and the provider chooses. Inventing one would be the bug this test guards.
  assert.deepEqual(wire, effortWire(c, 'on'));
});

test('an unknown grade sends no grade word on the grade-word protocols', () => {
  for (const protocol of ['openai', 'responses']) {
    const wire = effortWire(cfgFor(protocol), 'xhigh');
    assert.ok(!/xhigh/.test(JSON.stringify(wire)), `${protocol}: sent the unknown grade verbatim`);
    assert.deepEqual(wire, {}, `${protocol}: sends nothing rather than a wrong value`);
  }
});

// ---------------------------------------------------------------------------
// off, and the offer list
// ---------------------------------------------------------------------------

test('off is null on every protocol, and always was', () => {
  for (const protocol of PROTOCOLS) {
    assert.equal(effortWire(cfgFor(protocol), 'off'), null);
    assert.equal(effortWire(cfgFor(protocol), ''), null);
    assert.equal(effortWire(cfgFor(protocol), null), null);
    assert.equal(effortWire(cfgFor(protocol), undefined), null);
  }
});

test('the offered list is unchanged by this fix', () => {
  // The fix is in the WIRE mapping only: what the UI offers must not change, or a user
  // would lose a choice they had.
  assert.deepEqual(effortOptions(cfgFor('openai', { efforts: ['low', 'high'] }), 'p/m'), ['off', 'low', 'high']);
  assert.deepEqual(effortOptions(cfgFor('openai', { reasoning: true }), 'p/m'), ['off', 'on']);
  assert.deepEqual(effortOptions(cfgFor('openai', { reasoning: false }), 'p/m'), []);
  assert.deepEqual(effortOptions(cfgFor('openai', { always_thinking: true }), 'p/m'), ['on']);
});

test('every offered value maps to something, so the UI cannot offer a dead option', () => {
  // A choice that produced `{}` on a model WITH declared grades would be a lie in the menu.
  for (const protocol of PROTOCOLS) {
    const entry = { efforts: ['low', 'medium', 'high'] };
    const c = cfgFor(protocol, entry);
    for (const opt of effortOptions(c, 'p/m')) {
      const wire = effortWire(c, opt);
      assert.notEqual(wire, undefined, `${protocol}/${opt} produced undefined`);
      if (opt === 'off') assert.equal(wire, null);
      else assert.ok(wire && Object.keys(wire).length > 0, `${protocol}/${opt} sent nothing: ${JSON.stringify(wire)}`);
    }
  }
});
