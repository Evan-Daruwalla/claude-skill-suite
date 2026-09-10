---
name: coding-conventions
description: >-
  The coding rules that drift without a trigger: surgical changes, root cause
  over symptom, simplicity-first rungs with marked shortcuts, verify before
  claiming done with one runnable check. hooks/postwrite-check.js injects this
  body after every Edit/Write of a CODE file (docs/config excluded, debounced
  so a burst nudges once) so the rules land where code is being written. Also
  "check this", "verify that code", "did that actually run". Not an audit
  (/audit), not a bug hunt (/code-review).
license: MIT
---

# coding-conventions

Four rules and one verification pass. They lived in CLAUDE.md, where a long
session stops reading them; now the hook puts them next to the code you just
wrote. The firing is deterministic; following them is still your job.

## The rules

1. **Surgical changes only.** Every changed line traces to the request; match
   existing style; no drive-by refactors, reformatting, or "improvements".
   Remove orphans YOUR change created (imports, helpers, variables); leave
   pre-existing dead code and mention it.
2. **Root cause, not symptom.** Before patching the reported call site, grep the
   shared function's other callers — the chokepoint fix is usually smaller and
   actually closes the bug.
3. **Simplicity first — stop at the first rung that holds:** (1) doesn't need to
   exist → skip it, say so; (2) existing helper/pattern; (3) stdlib; (4) native
   platform feature; (5) already-installed dependency; (6) one line; (7) minimum
   new code. No features beyond the ask, no abstraction for single-use code, no
   configurability nobody requested, no handling for impossible cases. 200 lines
   that could be 50 get rewritten. Mark deliberate corner-cuts in-code:
   `# shortcut: <ceiling + upgrade trigger>`.
4. **Verify before claiming done.** Run it and paste real output; "should work"
   is banned. Non-trivial logic ships with ONE runnable check (assert-based
   self-check; no framework unless asked).

## The pass (after every code edit)

**SKIP WHEN** the edit was a comment, a string, a doc, or a one-line constant —
say so in one line and move on. Verification that costs more than the change
it guards is theater.

1. **Re-read the real diff.** `git diff` or the file region — the bytes on
   disk, not your memory of what you meant to write.
2. **Make it run.** Cheapest thing that proves it executes: `python -c "import
   mod"`, `node --check file.js`, `tsc --noEmit`, the linter, the existing
   test. If a suite covers this path, run it and paste real output. No output
   = not verified.
3. **One runnable check behind non-trivial logic.** A branch, loop, parser, or
   money/security path leaves behind the smallest thing that fails if the
   logic breaks. Trivial one-liners are exempt.
4. **Scope.** Anything that does not trace to the request — a drive-by
   reformat, an import you stopped needing, a helper nobody calls — comes
   back out now.

Report, one block, honest:

```
ran: <command> → <real result>
checked: <what step 3 left behind, or "n/a — trivial">
scope: clean | removed <X>
```

A failure reported with its output beats a pass you didn't run.

## Config

- Off for a session: `CODING_CONVENTIONS_OFF=1` (`CODE_CHECK_OFF=1` is still
  honoured — this skill absorbed `code-check` on 2026-09-06).
- Debounce and the code-file extension list live at the top of
  `hooks/postwrite-check.js`.

Sources: the engineering-discipline block of a personal CLAUDE.md (moved here
2026-09-06), the `code-check` skill (merged), and Andrej Karpathy's LLM-coding
observations as packaged in the MIT `karpathy-guidelines` skill.
