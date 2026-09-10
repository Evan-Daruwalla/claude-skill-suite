---
name: long-task
description: >-
  Execution loop for work longer than one sitting or more than ~7 steps: a
  numbered plan where every step ends in a check, riskiest step first, a
  one-line state tracker at the top of each turn, an iteration budget, and a
  progress lock — the same command failing the same way twice means change
  approach or stop and report NO-PROGRESS (hooks/no-progress.js fires this
  deterministically on PostToolUseFailure). Invoke: "long-task", "plan this
  out", "this is a big one", multi-hour or multi-session work. Small work →
  small-task. Cheaper-tier delegation → opus-workers. Launch risks → pre-mortem.
license: MIT
---

# long-task

## 1. Plan before the first edit

Numbered steps, each one a verifiable unit:

```
N. <step> → verify: <command or observation that proves it>
```

Riskiest or most uncertain step first — it is the one most likely to change
the plan, so learn that before spending on the rest. Set a BUDGET: max tool
turns per step (default 25; the user's cap if they gave one). Say the plan
before executing it; a plan nobody can read is not a plan.

## 2. State tracker — first line of every turn while the task is open

```
[LONG-TASK] step k/N · done: <verified steps> · blocked: <error, or none> · next: <the single step this turn>
```

One line. It exists for the reader at high context, when the plan written
80k tokens ago is no longer in view — the same reason small-task and
compact-io are injected per prompt.

## 3. The loop

Analyze the last result → pick the single next step → execute → verify with
real output. Advance only on a passed check. A step that will not pass inside
its budget is a finding, not a retry: report it and re-plan.

## 4. Progress lock

The same command producing the same failure twice in a row means you are
spinning. `hooks/no-progress.js` injects `[NO-PROGRESS]` when it sees exactly
that. On it: change the approach — a different command, a different
diagnosis, read the code instead of re-running it — or stop and report a
**NO-PROGRESS BLOCK** naming the command and the error. Never a third
identical attempt.

## 5. Done

Before declaring the goal done: every step's verify ran and its real output
is in the transcript; the project's own definition of done applies on top.
An unmet check means the loop continues with a corrective step, or the
shortfall is reported as unmet — never rounded up to done.

## Hand-offs

Delegating steps to a cheaper tier → opus-workers. Launch-blocking risks
before shipping → pre-mortem. Recording the run → the project's record.

## Config

- Off for a session: `NO_PROGRESS_OFF=1`.
- The repeat threshold and error normalisation live at the top of
  `hooks/no-progress.js`.

`node hooks/no-progress.js --canary` — MUST print `CANARY PASS 14/14` before you trust a result.
