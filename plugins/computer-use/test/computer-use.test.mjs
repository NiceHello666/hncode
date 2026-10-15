// hncode cu — the tool surface, the result formatting, and the Steps sequencer.
//
// WHY THESE TESTS LOOK THE WAY THEY DO
// ------------------------------------
// The plugin drives a real desktop, so most of what it does needs the machine it runs on: a screen
// to capture, a window to read, a mouse to move. Two things can still be pinned without one, and
// they are the two that break silently:
//
//   * the SURFACE — every tool registered, every tool accepting the arguments it advertises, and a
//     refusal that names the platform's mechanism rather than returning an empty result. A tool
//     that returns "" for "not supported here" reads to a model as "there is nothing there";
//   * the STEPS SEQUENCER — the ordering, the stop-on-failure, and the two ways it could recurse.
//
// Anything that must touch the real desktop is marked and skipped on a platform that cannot run
// it, rather than asserted in a way that passes by accident.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const PLUGIN = '../plugins/computer-use';

/** Register the plugin against a recording stub and hand back the tools by name. */
async function loadTools() {
  const mod = await import(`${PLUGIN}/index.js`);
  const registered = [];
  mod.install({
    registerTool: (s) => registered.push(s),
    registerCommand: () => {},
    log: () => {},
  });
  return { byName: Object.fromEntries(registered.map((t) => [t.name, t])), registered };
}

const { byName, registered } = await loadTools();

// ---------------------------------------------------------------------------
// the surface
// ---------------------------------------------------------------------------

test('every tool is registered exactly once, with a name and a description', () => {
  const names = registered.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate names');
  assert.ok(names.length >= 25, `registered ${names.length} tools`);
  for (const t of registered) {
    assert.ok(t.name && /^[A-Z][A-Za-z]+$/.test(t.name), `tool name looks wrong: ${t.name}`);
    assert.ok(t.description && t.description.length > 30, `${t.name} needs a real description`);
    assert.equal(typeof t.execute, 'function', `${t.name} has an execute`);
    assert.equal(t.parameters && t.parameters.type, 'object', `${t.name} declares an object schema`);
  }
});

test('the tools the plugin promises are all there', () => {
  // Named individually because a rename is otherwise invisible: a tool that disappears from the
  // list is a capability the model can no longer use, and nothing else would fail.
  const expected = [
    'Screenshot', 'ListWindows', 'ListDisplays', 'GetScreenSize',
    'GetUITree', 'FindElement', 'GetElementInfo', 'GetFocusedElement', 'WaitForElement',
    'ClickElement', 'SetElementText', 'SelectElement', 'ExpandCollapse', 'ScrollIntoView',
    'MouseMove', 'GetCursorPos', 'MouseClick', 'MouseDrag', 'MouseScroll',
    'KeyboardType', 'KeyboardKey',
    'WindowFocus', 'WindowResize', 'WindowClose',
    'Steps',
  ];
  for (const name of expected) {
    assert.ok(byName[name], `${name} is registered`);
  }
});

test('a tool that needs an argument says so rather than acting on nothing', async () => {
  // A missing coordinate must not become a click at 0,0 — the top-left corner is where menus live.
  // And a missing TYPE argument must not be typed as the word "undefined" into whatever has focus.
  assert.match(await byName.KeyboardType.execute({}, {}), /must be a string/);
  assert.match(await byName.KeyboardType.execute({ text: '' }, {}), /empty/);
  assert.match(await byName.KeyboardKey.execute({}, {}), /Error|unknown key|no key/i);
  assert.match(await byName.WindowFocus.execute({}, {}), /Error|not available|no such window|no window/i);
  assert.match(await byName.Screenshot.execute({ mode: 'region' }, {}), /needs width and height/);
  assert.match(await byName.Screenshot.execute({ mode: 'window' }, {}), /needs hwnd/);
  assert.match(await byName.SetElementText.execute({ index: 0 }, {}), /Error|not available|no matching/i);
});

// ---------------------------------------------------------------------------
// what an unsupported platform says
// ---------------------------------------------------------------------------

test('a platform without a capability names the mechanism, not just "no"', async () => {
  // The whole point of the { unsupported } shape. "unsupported" alone leaves the model retrying
  // the same call; naming xdotool or a permission gives it something to do instead.
  const { present } = await import(`${PLUGIN}/format.js`);
  const out = present({ unsupported: 'screen capture on Wayland needs grim (install: grim)' });
  assert.match(out, /Not available on this machine/);
  assert.match(out, /grim/, 'the reason survives to the caller');
  assert.doesNotMatch(out, /^Error:/, 'and it is not dressed up as an error to retry');
});

test('an empty tree explains itself rather than reading as "nothing here"', async () => {
  const { presentTree } = await import(`${PLUGIN}/format.js`);
  const out = presentTree({ elements: [] }, { hwnd: '42' });
  assert.match(out, /No elements found/);
  assert.match(out, /game|canvas|custom-rendered/, 'it names the likely cause');
  assert.match(out, /Screenshot/, 'and suggests the fallback');
});

test('a tree is rendered as indexed lines the element tools can consume', async () => {
  const { presentTree } = await import(`${PLUGIN}/format.js`);
  const out = presentTree({
    elements: [
      { index: 0, controlType: 'Button', name: 'Save', automationId: 'btnSave', x: 10, y: 20, width: 80, height: 24, enabled: true },
      { index: 1, controlType: 'Edit', name: 'Name', automationId: '', x: 0, y: 0, width: 0, height: 0, enabled: false },
    ],
  }, {});
  assert.match(out, /^\[0\] Button "Save" #btnSave @10,20 80x24$/m, 'a live element shows its box');
  assert.match(out, /\[1\] Edit "Name" \(off screen\) \[disabled\]/, 'and a dead one says why');
});

test('a search that finds nothing says how to look instead', async () => {
  const { presentMatches } = await import(`${PLUGIN}/format.js`);
  const out = presentMatches({ matches: [], total: 0 }, '"Save"');
  assert.match(out, /No element matched/);
  assert.match(out, /GetUITree/, 'it names the tool that shows what IS there');
});

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

test('Steps runs its steps in order', async () => {
  const out = await byName.Steps.execute({
    steps: [{ tool: 'GetScreenSize' }, { tool: 'GetCursorPos' }],
  }, {});
  assert.match(out, /all ok/);
  const first = out.indexOf('GetScreenSize');
  const second = out.indexOf('GetCursorPos');
  assert.ok(first > 0 && second > first, `steps ran in order:\n${out}`);
});

test('Steps stops at the first failure by default', async () => {
  // The reason this matters: a later step acts on a screen that never reached the expected state,
  // so a half-finished sequence run to completion is worse than one that stopped.
  const out = await byName.Steps.execute({
    steps: [{ tool: 'GetScreenSize' }, { tool: 'NotATool' }, { tool: 'GetCursorPos' }],
  }, {});
  assert.match(out, /NotATool: FAILED/);
  assert.match(out, /Stopped: step 2 failed\. 1 step\(s\) not run\./);
  // The third step must not have RUN. Asserting on its name would be wrong: the failure message
  // lists every known tool, and `GetCursorPos` is one of them, so the name is present either way.
  // A step heading is the reliable evidence — `[3] ` only appears if the step executed.
  assert.doesNotMatch(out, /^\[3\] /m, 'the third step did not run');
});

test('a step can opt out of stopping', async () => {
  const out = await byName.Steps.execute({
    steps: [{ tool: 'NotATool', continueOnError: true }, { tool: 'GetScreenSize' }],
  }, {});
  assert.match(out, /NotATool: FAILED/);
  assert.match(out, /GetScreenSize: ok/, 'the sequence continued');
});

test('stopOnError false runs everything', async () => {
  const out = await byName.Steps.execute({
    stopOnError: false,
    steps: [{ tool: 'NotATool' }, { tool: 'GetScreenSize' }],
  }, {});
  assert.match(out, /GetScreenSize: ok/);
});

test('Steps refuses to call itself', async () => {
  // The recursion guard: a self-call would nest without limit, and one level expresses any sequence.
  const out = await byName.Steps.execute({ steps: [{ tool: 'Steps', args: { steps: [] } }] }, {});
  assert.match(out, /cannot call itself/);
});

test('Steps rejects an empty or malformed list', async () => {
  assert.match(await byName.Steps.execute({ steps: [] }, {}), /non-empty array/);
  assert.match(await byName.Steps.execute({}, {}), /non-empty array/);
  assert.match(await byName.Steps.execute({ steps: [{ args: {} }] }, {}), /no tool name/);
});

test('an unknown step name lists what IS available', async () => {
  // So the model can correct itself from the message rather than re-reading the tool list.
  const out = await byName.Steps.execute({ steps: [{ tool: 'Nope' }] }, {});
  assert.match(out, /unknown tool "Nope"/);
  assert.match(out, /ClickElement/);
  assert.match(out, /Screenshot/);
});

test('a very long step result is truncated, with the size stated', async () => {
  const out = await byName.Steps.execute({ steps: [{ tool: 'GetUITree', args: { depth: 8, maxNodes: 400 } }] }, {});
  if (out.length > 1200) {
    assert.match(out, /more characters\)/, 'a truncation says how much was cut');
  }
  assert.ok(out.length < 5000, `the summary stays bounded (${out.length} chars)`);
});

// ---------------------------------------------------------------------------
// against the real desktop
// ---------------------------------------------------------------------------

const canTouchDesktop = process.platform === 'win32';

test('the platform dispatch exposes one surface for every tool', async () => {
  // The tools never branch on platform; they call a method by name. A method missing from the
  // dispatch table is an undefined call, which is why the list is asserted rather than sampled.
  const p = await import(`${PLUGIN}/platform/index.js`);
  const b = await p.backend();
  const need = [
    'screenBounds', 'captureRegion', 'captureWindow', 'listWindows', 'windowRect',
    'focusWindow', 'resizeWindow', 'closeWindow', 'listDisplays',
    'getTree', 'findElements', 'elementInfo', 'focusedElement', 'waitForElement',
    'clickElement', 'setElementText', 'selectElement', 'expandCollapse', 'scrollIntoView',
    'moveTo', 'cursorPos', 'clickAt', 'clickHere', 'drag', 'scroll', 'typeText', 'keyPress',
  ];
  for (const m of need) {
    assert.equal(typeof b[m], 'function', `the dispatch table has ${m}`);
  }
});

test('a real screen is reported with a positive size', { skip: !canTouchDesktop }, async () => {
  const out = await byName.GetScreenSize.execute({}, {});
  const m = /(\d+)x(\d+)/.exec(out);
  assert.ok(m, `a size came back: ${out}`);
  assert.ok(Number(m[1]) > 0 && Number(m[2]) > 0, `the desktop has area: ${out}`);
});

test('a real screenshot is a valid PNG of the size claimed', { skip: !canTouchDesktop }, async () => {
  const out = await byName.Screenshot.execute({ mode: 'region', x: 0, y: 0, width: 100, height: 60 }, {});
  // A LOCKED or disconnected session refuses screen capture while everything else keeps working —
  // Windows will not hand pixels to a process with no visible desktop. That is the environment, not
  // a defect, and the error says so; the PNG assertions below only apply when a capture happened.
  if (/desktop is not interactive/.test(out)) {
    assert.match(out, /unlock it|Screenshot\(\{mode:"window"\}\)/, 'the refusal explains the cause');
    return;
  }
  const file = /: (.+.png)/.exec(out);
  assert.ok(file, `a path came back: ${out}`);
  const buf = fs.readFileSync(file[1].trim());
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  // IHDR width/height at fixed offsets — this is what proves the capture honoured the request
  // rather than returning the whole screen under a smaller name.
  assert.equal(buf.readUInt32BE(16), 100);
  assert.equal(buf.readUInt32BE(20), 60);
  fs.unlinkSync(file[1].trim());
});

test('the walk numbers elements by POSITION, not by a shared sibling count', () => {
  // THE bug this guards. `Walk` pushed the running output count as each child's index, so every
  // SIBLING received the same number: six tab items all became `[7]`, and resolving an index
  // returned whichever of them happened to be found first.
  //
  // The rule is the PowerShell the backend actually generates, so this reads the source rather
  // than a restatement: the index must be assigned where the element is EMITTED, and the value
  // pushed for a child must not be a count taken before its siblings were emitted.
  const src = fs.readFileSync(new URL('../plugins/computer-use/platform/win-uia.js', import.meta.url), 'utf8');
  const walk = src.slice(src.indexOf('const WALK = '), src.indexOf('`;', src.indexOf('const WALK = ')));

  assert.match(walk, /\$idx = \$out\.Count/, 'the index is the position among emitted elements');
  assert.doesNotMatch(walk, /\$stack\.Push\(@\(\$kids\[\$i\], \(\$depth \+ 1\), \$out\.Count\)\)/,
    'a PUSH must not stamp the index: every sibling would read the same count');
  assert.match(walk, /\$stack\.Push\(@\(\$kids\[\$k\], \(\$depth \+ 1\)\)\)/,
    'children are pushed with element and depth only');
});

test('a rendered tree exposes one distinct index per element', { skip: !canTouchDesktop }, async () => {
  // The user-visible half: whatever the desktop looks like right now, the tree a tool returns must
  // not repeat an index. That IS checkable on a live window — it needs a single snapshot, with no
  // assumption that the window holds still afterwards.
  const uia = await import('../plugins/computer-use/platform/win-uia.js');
  const wins = await byName.ListWindows.execute({}, {});
  const hwnd = /\n\s+(\d+) "/.exec(wins)?.[1];
  if (!hwnd) return; // nothing to inspect on a bare desktop

  const tree = await uia.getTree({ hwnd });
  if (Array.isArray(tree)) return; // the accessibility layer is switched off
  const indices = tree.elements.map((e) => e.index);
  assert.ok(indices.length > 0, 'the window exposed at least one element');
  assert.equal(new Set(indices).size, indices.length,
    `indices must be distinct, got ${JSON.stringify(indices.slice(0, 12))}`);

  // And they must be 0..n-1 with no gaps: a position, not an arbitrary id.
  const sorted = indices.slice().sort((a, b) => a - b);
  assert.deepEqual(sorted, Array.from({ length: sorted.length }, (_, i) => i),
    'indices are 0..n-1 with no gaps');
});
test('the real control tree comes back with usable elements', { skip: !canTouchDesktop }, async () => {
  // The desktop has a taskbar with at least one button, on any Windows install.
  const out = await byName.GetUITree.execute({ depth: 3, maxNodes: 60, controlTypes: ['Button'] }, {});
  if (/Not available/.test(out)) return; // an accessibility layer that is switched off
  assert.match(out, /element\(s\)/);
  assert.match(out, /\[0\]/, 'the first element is indexed');
  assert.match(out, /@-?\d+,-?\d+/, 'and carries a rectangle');
});

test('a real window list comes back with handles', { skip: !canTouchDesktop }, async () => {
  const out = await byName.ListWindows.execute({}, {});
  if (/Not available|No visible windows/.test(out)) return;
  assert.match(out, /window\(s\):/);
  assert.match(out, /\d+ "/, 'a handle and a title');
});
