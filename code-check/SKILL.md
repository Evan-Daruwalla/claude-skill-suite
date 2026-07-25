---
name: code-check
description: >
  Post-write verification pass on code you just wrote or edited: re-read the
  real diff, make it actually run, confirm non-trivial logic has one runnable
  check behind it, and confirm every changed line traces to the request. Fires
  from the PostToolUse hook after Edit/Write on a code file, and on "check
  this", "verify that code", "did that actually run", "code-check". Not a
  full audit (/audit) and not a bug hunt (/code-review) — this is the
  did-what-I-just-wrote-actually-work pass.
license: MIT
---

# code-check

Enforces the two rules that drift without a trigger — *verify before claiming
done*, and *non-trivial logic ships with one runnable check behind it* —
whether they live in your CLAUDE.md or only in your head. The hook fires
deterministically; running the pass is still the model's job (a hook cannot
invoke a skill).

**SKIP WHEN** the edit was a comment, a string, a doc, or a one-line constant —
say so in one line and move on. Verification that costs more than the change
it guards is theater.

## The pass

1. **Re-read the real diff.** `git diff` (or re-read the file region) — the
   actual bytes on disk, not your memory of what you meant to write. Most
   post-write bugs are visible here and nowhere else.

2. **Make it run.** Cheapest thing that proves it executes: `python -c "import
   mod"`, `node --check file.js`, `tsc --noEmit`, the linter, the existing
   test. If the project has a suite that covers this path, run it and paste
   real output. No output = not verified.

3. **One runnable check behind non-trivial logic.** A branch, loop, parser, or
   money/security path leaves behind the smallest thing that fails if the logic
   breaks — an assert-based self-check or one small test. No frameworks, no
   fixtures unless asked. Trivial one-liners are exempt.

4. **Scope.** Every changed line traces to the request. Anything else —
   drive-by reformat, an import you added then stopped needing, a helper
   nobody calls — comes back out now.

## Report

One block, honest:

```
ran: <command> → <real result>
checked: <what step 3 left behind, or "n/a — trivial">
scope: clean | removed <X>
```

A failure reported with its output beats a pass you didn't run. Never write
"should work" — either it ran or it didn't, and say which.

## Config

- Off for a session: `CODE_CHECK_OFF=1`.
- Nudge debounce and the code-file extension list live at the top of
  `hooks/postwrite-check.js`.
