---
name: verify-claims
description: Prove work is done before saying so — evidence, not confidence
---

# Verifying your own work

The failure this prevents: reporting "done / fixed / works" when what actually happened
is "I wrote code that looks right". Those are different states, and conflating them is
how a bug reaches the user wearing a green checkmark.

## The rule

**Every claim in your final message must trace to something you RAN or READ in this
session.** If you cannot name the command or the file, downgrade the claim.

| What you know for a fact | What you may say |
|---|---|
| you ran it and saw the right output | "verified: `<command>` outputs `<result>`" |
| you read the code and reasoned about it | "reasoned through, NOT executed" |
| you changed it and ran nothing | "changed `<file>`, not yet run" |
| you did not look | say nothing, or "I did not check" |

The middle rows are fine to report. "I did not run this" is a useful sentence. What is
not fine is collapsing row 3 into row 1.

## Before claiming done

1. **Run the thing.** Compiles != runs. Loads != works. Say which you did.
   - Changed a file with an entry point? Execute it.
   - Changed a function? Call it, or run its test.
   - Changed a UI? Say plainly that you did not look at it if you did not.
2. **Check the OTHER direction.** You tested the happy path; what happens on the error
   path, the empty input, the second call? A fix that only handles the input you tried
   is half a fix.
3. **Confirm the test would have caught it.** Mentally revert your change: does the test
   now fail? If not, the test proves nothing.
4. **Re-read your own diff** as a reviewer, not as the author. Look for: a leftover
   debug line, a stale comment, a name that no longer matches, an edited import you did
   not need, a file you touched twice by accident.

## Reporting honestly

- Lead with the outcome, then the evidence: `Fixed X. Verified with <command> -> <output>.`
- Say what you did NOT cover: "tested on Windows only", "did not test the resume path".
- If it failed, say what you tried and what you need — not a softer word for failure.
  "The approach does not work because Y; I need Z" beats "mostly working".
- If you are unsure, say which part. "Confident about the parser, unsure about the
  encoding" is actionable. Vague confidence is not.

## Uncertainty has a vocabulary — use it precisely

- **verified** — you ran it and observed the result. Use only here.
- **likely** — the evidence points this way but you did not confirm.
- **assumed** — you took something as true without checking; name what would change if
  it is false.
- **unknown** — you have not looked.

Do not use "should work", "this will", or "correct now" for row 2 or 3 above. Those
phrases assert verification you did not perform.

## When you cannot verify

Sometimes there is genuinely no way to run it: no credentials, no device, no compiler.
Then say so EXPLICITLY and name what would verify it:

> Changed the retry loop. I cannot run it here (needs a live endpoint); to verify, call
> `fetchWithRetry` against a URL that fails once and confirm it returns on the second try.

That message is far more useful than a confident claim, because the next person knows
exactly where to look.

## Guard against your own summary drifting

Long sessions erode accuracy: by the end you are summarising work you no longer
remember the details of. If you are unsure whether you ran something earlier, re-run it
or re-check the file. The cost is one command; the cost of a wrong "verified" is a
broken commit and a user who stops trusting your reports.
