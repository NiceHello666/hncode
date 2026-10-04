---
name: root-cause
description: Debug by finding the actual cause, not by patching symptoms
---

# Root-cause debugging

A bug report names a SYMPTOM. The first plausible cause you find is usually not the
cause — it is the one that happened to be near the symptom. Work in this order.

## 1. Make it fail on purpose, first

Before reading code, get a reproduction you control: a command, a test, or a script.
If you cannot make it fail, you cannot know when you have fixed it — and you will
"fix" it, see the symptom stop by coincidence, and ship a latent bug.

Write down:
- the exact command
- the exact wrong output
- the exact output you expect

If the user has not given you a reproduction, ask for it or construct one from their
description. Report progress only once step 1 is done.

## 2. Locate the boundary, not the line

Find the last point where the value is CORRECT and the first point where it is WRONG.
That gap is the bug, and it is usually 1-3 lines wide.

Print/inspect the actual value at the boundary rather than reasoning about what it
"must" be. Most wrong fixes come from reading the code, deciding what it does, and
being subtly wrong about that.

## 3. Read the failing thing's contract

Before changing a function, read the thing it CALLS (the real signature, not the call
site) and the thing that calls it. A "bug in function X" is very often X obeying its
contract while the caller passes the wrong thing.

Verify at the source: the signature, the config default, the schema, the docs. Do not
infer a contract from a single call site.

## 4. State the cause as a mechanism

Write it out in one sentence of the form:

> `<observed wrong thing>` happens because `<mechanism>`, which `<code path>` does.

If you cannot fill in the mechanism, you have a correlation, not a cause. Go back to
step 2.

A real cause explains:
- why it fails NOW and did not before (if it is a regression),
- why it fails HERE and not in the similar-looking place,
- what else the same mechanism affects.

## 5. Fix the mechanism, then prove it

Change the smallest thing that removes the mechanism. Then:

- Re-run the reproduction from step 1 and show it now produces the right output.
- Try to make it fail AGAIN another way. A fix that only handles the exact input you
  tested is not a fix.
- Check the neighbours of the mechanism: if the same bug exists in three places and you
  fixed one, say so.

## Anti-patterns — stop if you catch yourself doing these

- **Guard the symptom.** Adding a null check where the value should never be null hides
  the producer that returns null wrongly. Find the producer.
- **Try things until it works.** If you cannot say WHY the last change helped, you do
  not understand the state; revert it and go back to step 2.
- **Trust the comment.** Comments describe intent at the time of writing. The code is
  the truth. A stale comment is itself a finding worth reporting.
- **Blame the framework.** "It's a race condition" / "the library is buggy" is a
  hypothesis, not a conclusion. Demonstrate it.
- **Fix in the test.** Loosening an assertion to make it pass turns a real failure into
  silent breakage.

## Reporting

Lead with the cause and the mechanism, then the fix, then the evidence:

```
Cause: <one sentence with the mechanism>
Fix:   <file>:<line> — <what changed and why that removes the cause>
Proof: <the command you ran and its before/after output>
```

Say plainly what you did NOT verify. "The reproduction now passes; I did not test the
Windows path" is useful. "Fixed!" with no evidence is not.
