// A module-level function must not name anything declared inside `startTUI`.
//
// WHY THIS FILE EXISTS
// --------------------
// `runTurn` is declared at module level; `generateTitle` is declared inside `startTUI`. The
// two are in DIFFERENT scopes, so `runTurn` calling `generateTitle(...)` threw
// `ReferenceError: generateTitle is not defined` — on EVERY turn, because the guard that
// decides whether to name a session is `!session.title`, which a failed naming leaves true.
//
// The exception reached the `unhandledRejection` handler, which saves and `process.exit(1)`s.
// So a cosmetic failure — labelling a session — killed the process mid-turn, and the only
// trace was a line in ~/.hncode/exit.log naming a file and a line but not the reason the name
// was unreachable.
//
// `node --check` cannot see this: the file parses. No existing test caught it because the
// mismatched pair spans 3000 lines and two scopes, and nothing here ran a turn at all.
//
// A GENERAL "no module-level function calls a startTUI name" SCAN WAS TRIED AND REMOVED.
// `dispatch` destructures `notice`/`openPicker` out of its `h` PARAMETER and `runTurn`
// destructures `view`, so a call of a same-named local is correct — and a regex cannot
// separate that from a call of `startTUI`'s closure. It flagged ten legitimate calls, and an
// assertion that fails on correct code gets deleted, which protects less than not writing it.
//
// The facts that made the crash possible are asserted directly instead. Together they cover
// the shape: the name was not in scope, a module-level function reached for it, and a throw
// there ended the process.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('src/tui.js'), 'utf8');
const lines = src.split(/\r?\n/);

const START = lines.findIndex((l) => /^export async function startTUI\(/.test(l));
assert.ok(START > 0, 'startTUI is declared at module level');

/** Function names declared directly inside `startTUI` (indent 2). */
function startTUINames() {
  const names = new Set();
  for (let i = START; i < lines.length; i++) {
    const m = /^  (?:async )?function ([A-Za-z0-9_]+)/.exec(lines[i]);
    if (m) names.add(m[1]);
  }
  return names;
}

/** Module-level functions as { name, from, to } line windows. */
function moduleLevelFunctions() {
  const out = [];
  const re = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/;
  for (let i = 0; i < START; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    let to = START;
    for (let j = i + 1; j < START; j++) {
      if (/^(export )?(async )?function /.test(lines[j]) || /^export (const|class) /.test(lines[j])) { to = j; break; }
    }
    out.push({ name: m[1], from: i, to });
  }
  return out;
}

/** A function body with comments removed, so a comment naming an identifier is not a match. */
function bodyOf(fn) {
  return lines.slice(fn.from, fn.to).join('\n')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

test('the harness found the two scopes it asserts about', () => {
  // A control. If `startTUI` moved or the regex stopped matching, every assertion below would
  // pass vacuously — the failure mode this file exists to prevent.
  const inner = startTUINames();
  assert.ok(inner.size > 50, `startTUI's inner functions were found (${inner.size})`);
  assert.ok(inner.has('generateTitle'), 'generateTitle is one of them');
  const outer = moduleLevelFunctions();
  assert.ok(outer.some((f) => f.name === 'runTurn'), 'runTurn is module level');
  assert.ok(outer.some((f) => f.name === 'dispatch'), 'dispatch is module level');
});

test('runTurn reaches the namer through the host, not by a bare name', () => {
  const runTurn = moduleLevelFunctions().find((f) => f.name === 'runTurn');
  const body = bodyOf(runTurn);
  assert.ok(!/[^.\w]generateTitle\s*\(/.test(body),
    'runTurn must not call generateTitle() directly — it is startTUI-scoped');
  assert.match(body, /sessHost\.generateTitle\(/, 'it goes through the host');
  assert.match(body, /makeTitle: sessHost\.makeTitle/, 'and passes the attached implementation');
});

test('startTUI attaches the naming implementation to the host', () => {
  assert.match(src, /sessHost\.makeTitle = generateTitle;/,
    'the host carries the namer so runTurn can reach it');
});

test('a naming failure cannot end the turn', () => {
  // `SessionHost.generateTitle` contains a makeTitle that REJECTS, but not a throw while the
  // argument object is BUILT — which is the shape this crash took. The call is wrapped so a
  // missing or broken implementation degrades to "unnamed session", not process exit.
  const runTurn = moduleLevelFunctions().find((f) => f.name === 'runTurn');
  const body = bodyOf(runTurn);
  // The CALL site, not the declaration of the guard flag — the flag is declared far earlier.
  const at = body.indexOf('sessHost.generateTitle(');
  assert.ok(at > 0, 'the namer is called in runTurn');
  const before = body.slice(Math.max(0, at - 200), at);
  assert.match(before, /try \{/, 'the naming call is inside a try');
  const after = body.slice(at, at + 400);
  assert.match(after, /catch/, 'and a throw is caught');
});

test('SessionHost.generateTitle cannot itself throw', async () => {
  // The other half of the containment: the method must return '' rather than propagate, in
  // both a missing and a rejecting implementation.
  const { SessionHost } = await import('../src/session-host.js');
  const host = new SessionHost({ state: { chat: [] }, cfg: {}, session: { title: '' }, view: {} });
  assert.equal(await host.generateTitle('hi', { makeTitle: host.makeTitle }), '',
    'a missing implementation returns empty rather than throwing');
  host.makeTitle = async () => { throw new Error('naming exploded'); };
  assert.equal(await host.generateTitle('hi', { makeTitle: host.makeTitle }), '',
    'a rejecting implementation is contained');
});

// ---------------------------------------------------------------------------
// the general scan: no module-level function may call a name that only exists inside startTUI
// ---------------------------------------------------------------------------

test('no module-level function calls a startTUI-only name', () => {
  // The two crashes this guards against, both of which exited the process via
  // `unhandledRejection`: `runTurn` calling `generateTitle()` (session naming) and then
  // `submit()` (the queue drain), plus `dispatch` calling `refreshKeybindings()` — the last one
  // never fired only because nobody edited their keybindings in that build.
  //
  // An earlier version of this scan was removed for false positives: `dispatch` destructures
  // `notice` out of its `h` parameter, and a regex cannot tell that from a closure call. The fix
  // is to RESOLVE what each function binds — its parameters, its destructured locals, and
  // anything the module level declares — and only then flag an unresolved name.
  const inner = startTUINames();

  // Everything the module level binds: functions, consts, classes and imports.
  const moduleBindings = new Set();
  for (const m of src.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/gm)) moduleBindings.add(m[1]);
  for (const m of src.matchAll(/^(?:export )?(?:const|let|var|class) ([A-Za-z0-9_]+)/gm)) moduleBindings.add(m[1]);
  for (const m of src.matchAll(/^import \{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) moduleBindings.add(part.trim().split(/\s+as\s+/).pop().trim());
  }

  const problems = [];
  let scanned = 0;
  for (const fn of moduleLevelFunctions()) {
    const body = bodyOf(fn);
    // Names THIS function binds: its parameters and its own declarations. A call of one of
    // these is a local — which is exactly the case that made the blunt scan unusable.
    const local = new Set();
    for (const m of body.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z0-9_]+)/g)) local.add(m[1]);
    // Destructuring binds EVERY name inside the braces, and `const { notice } = h` is how a
    // module-level function legitimately reaches a closure name — the case that made the first
    // version of this scan useless. One pattern per form: `const { a, b } = h` and
    // `const { a } = h`. The leading `const`/`let` is required so an object LITERAL in the body
    // is not mistaken for bindings.
    for (const m of body.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split(':').pop().split('=')[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean)) local.add(clean);
      }
    }
    for (const m of body.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
      for (const name of m[1].split(',')) {
        const clean = name.trim().split('=')[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean)) local.add(clean);
      }
    }
    for (const m of lines[fn.from].matchAll(/([A-Za-z0-9_]+)/g)) local.add(m[1]);
    for (const n of inner) {
      if (local.has(n) || moduleBindings.has(n)) continue;
      scanned++;
      if (new RegExp(`(^|[^A-Za-z0-9_$.])${n}\\s*\\(`).test(body)) problems.push(`${fn.name}() -> ${n}()`);
    }
  }

  // Control: the scan has to have actually looked at things, or an empty result means nothing.
  assert.ok(scanned > 1000, `name/function pairs compared (${scanned})`);
  assert.deepEqual(problems, [],
    `this name lives inside startTUI and is unreachable from a module-level function:\n${problems.join('\n')}`);
});

test('the scan would have caught the crashes it guards', () => {
  // A control with teeth: reproduce each real bug as a synthetic source and check the scan's
  // rule flags it. Without this the assertion above could pass because the regex never matches
  // anything.
  const rule = (inner, local, moduleBindings, body, fnName) => {
    for (const n of inner) {
      if (local.has(n) || moduleBindings.has(n)) continue;
      if (new RegExp(`(^|[^A-Za-z0-9_$.])${n}\\s*\\(`).test(body)) return `${fnName}() -> ${n}()`;
    }
    return '';
  };
  const inner = new Set(['generateTitle', 'submit', 'refreshKeybindings']);
  const none = new Set();
  assert.match(rule(inner, none, none, 'await generateTitle(text);', 'runTurn'), /generateTitle/);
  assert.match(rule(inner, none, none, 'void submit(next);', 'runTurn'), /submit/);
  assert.match(rule(inner, none, none, 'const now = refreshKeybindings();', 'dispatch'), /refreshKeybindings/);
  // And it must NOT flag the legitimate forms.
  assert.equal(rule(inner, none, none, 'h.refreshKeybindings();', 'dispatch'), '', 'a host method is fine');
  assert.equal(rule(inner, new Set(['submit']), none, 'submit(next);', 'other'), '', 'a local shadows it');
  assert.equal(rule(inner, none, new Set(['submit']), 'submit(next);', 'other'), '', 'a module binding is fine');
});