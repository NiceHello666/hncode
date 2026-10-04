---
name: diff-review
description: Review a change for the bugs that actually ship, ranked by blast radius
---

# Reviewing a diff

Review the change, not the code style. Formatting is what a formatter is for.

Work through the categories below IN ORDER — a bug you find in category 1 matters more
than ten in category 5, and reviewers who start at the bottom miss the top.

## 1. Does it do what it claims? (highest value)

Read the commit/PR description, then read the code as if the description were a lie.

- Is every promised behaviour actually present? A description that says "and it
  validates the input" when no validation exists is the most common real defect.
- Is anything present that the description does NOT mention? An unrelated refactor, a
  changed default, an edited config. Silent scope is how bugs travel.

## 2. Blast radius — what ELSE does this touch?

For every changed function, find its other callers and check each one.

This is the category that catches the bugs that ship, because the author only tested
the path they were thinking about. Specifically:
- changed signature or return shape -> every caller
- changed default / config value -> every behaviour that relied on the old default
- changed shared helper -> every feature that shares it
- renamed/removed export -> every import

State the callers you checked. "I checked all 4 callers" is a review; "LGTM" is not.

## 3. Boundaries and empty cases

- Empty input, one element, many elements.
- The FIRST and LAST iteration — off-by-one lives here.
- `null` / `undefined` / missing key vs. empty string vs. zero. Are they distinguished,
  and does the code treat them the way the caller expects?
- Concurrency: two calls at once, or a re-entrant call.
- Is the state actually reset between runs, or does it accumulate?

## 4. Errors: swallowed, or handled?

- `try {} catch {}` with an empty body — what can no longer be diagnosed?
- A `catch` that continues with partial state. Does every later line still hold?
- An error path that reports success (returns the old value, writes a default, logs and
  carries on).
- Are failures distinguishable? "It returned falsy" cannot be debugged.

## 5. Cleanup and limits

- What grows without bound: a cache, a log, an array, a subscription, a timer?
- What is added but never removed (listener, interval, temp file, lock)?
- What happens on the early-return path — is the cleanup skipped?
- Timeouts on anything that can hang.

## 6. Tests: do they fail for the right reason?

- Would this test PASS if the fix were reverted? If yes it does not test the fix — say
  so, this is the single most common test defect.
- Does it assert on the bug's actual symptom, or on an incidental detail?
- Is a passing test only passing because an assertion was loosened or a case deleted?

## 7. Then, and only then: readability

- A name that lies about what it does.
- A comment that no longer matches the code (worse than no comment).
- A near-duplicate of an existing helper that will drift from it.

## Output format

Ranked, worst first. For each finding:

```
<file>:<line> — <what is wrong>
Why it matters: <the concrete failure it causes>
Suggested: <the smallest correct change>
```

Then, separately, "Checked and fine" — the categories you verified, so the author knows
what you actually looked at rather than assuming silence means approval.

If you found nothing in a category, say "nothing found" rather than omitting it. A
review with no gaps in its coverage is worth more than a list of nitpicks, and saying
which parts you did NOT review is often the most useful sentence in the whole review.
