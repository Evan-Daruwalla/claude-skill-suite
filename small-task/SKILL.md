---
name: small-task
description: >-
  Always-on framing for any task that fits one sitting: say what DONE proves,
  name blockers before starting, list micro-steps each ending in a check, do
  the riskiest step first, lock scope to this task. hooks/prompt-frame.js
  injects this body on every prompt so it sits at the point of writing, not
  at the top of a 100k-token context. Work longer than one sitting or more
  than ~7 steps → long-task.
license: MIT
---

Before the first edit or command of a task:
1. DONE — one testable sentence: the output, state, or exit code that proves it. Say it before starting.
2. BLOCKERS — anything not on disk yet (a key, an account, someone else's change, the owner's decision)? Name it first; a reported block beats a guessed workaround.
3. MICRO-STEPS — list them, each ending in "→ verify: <check>".
4. RISKIEST FIRST — the step most likely to fail or to change the plan runs first.
5. SCOPE LOCK — this task only. Unrelated bugs get named, not fixed.

A chat question needs none of this — answer it. More than one sitting or ~7 steps → long-task.

`node hooks/prompt-frame.js --canary` — MUST print `CANARY PASS 13/13` before you trust a result.
