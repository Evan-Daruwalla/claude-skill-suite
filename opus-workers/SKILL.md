---
name: opus-workers
description: >
  When running an expensive flagship model as the orchestrator (e.g. Claude Fable 5, especially
  max effort / ultracode) and about to spin up subagents or a workflow, run the WORKER agents one
  tier cheaper (e.g. Opus 4.8) instead of on the flagship, then have the flagship review each output
  and either accept + present it, or send it back to the worker with specific pointers. Keeps token
  cost down: the cheaper model does the bulk generation, the flagship stays a thin reviewer. Triggers
  when spawning agents / running a workflow / fanning out work on a flagship. Skip for trivial one-shot
  tasks (review overhead isn't worth it) or when already running a cheaper tier (nothing to save).
---

# opus-workers — flagship orchestrates, a cheaper tier works, flagship reviews

**APPLIES WHEN** the session's orchestrator is your most capable / most expensive model
(e.g. Fable 5 at max effort or ultracode) AND you are about to spawn subagents (Agent tool)
or a workflow (Workflow tool) for non-trivial work.

**SKIP WHEN** you are already on a cheaper tier (nothing to save), or the task is a single
trivial step — just do it inline; the review round-trip costs more than it saves.

**WHY.** The flagship is the priciest tier per token. The tier one step down (Fable 5 →
Opus 4.8; Opus → Sonnet) is cheaper and strong enough for most delegated execution. Put the
BULK generation on the cheaper tier and keep the flagship as a thin reviewer. Output tokens
cost more than input and re-enter context on every later turn, so moving generation to the
cheaper model compounds across the session.

## The loop

0. **Pick the workers' effort — medium or high by default; ask only for demanding work.**
   Set worker reasoning effort by the task: **medium** for routine or mechanical bulk, **high**
   for substantive generation that needs real reasoning. Pick per task — don't ask for the
   ordinary cases. **Only when the work is unusually demanding** — correctness-critical, or
   where you'd want to push past high toward **xhigh / max** — ask the user which effort before
   spawning. Apply it on the Workflow path: `agent(prompt, { model, effort: "medium" | "high" | ... })`
   (model = one tier down from the orchestrator). The plain **Agent tool has no `effort`
   parameter** (subagents inherit the session effort), so effort only binds on the Workflow
   path; on the Agent-tool path, note in your summary that workers ran at inherited effort.

1. **Delegate to the cheaper tier.** Spawn every worker with the model override set one tier
   down from the orchestrator — NOT the flagship:
   - Agent tool: pass `model: "opus"` (or `"sonnet"`/`"haiku"` per your orchestrator tier).
   - Workflow: `agent(prompt, { model: "opus" })`.
   Give each worker a self-contained task AND explicit, checkable **success criteria** (what
   "done and correct" looks like) — the same criteria you'll review against. Independent tasks
   → fan out multiple workers in parallel.

2. **Review as the flagship.** For each returned output, verify it against those criteria —
   correctness, completeness, scope (did it do only what was asked), and any project rules in
   force. Actually check; don't rubber-stamp. When it's checkable (code, a command, a file),
   check it rather than eyeballing.

3. **Decide per output.**
   - **Satisfactory** → keep it. Once all workers pass, present the result to the user.
   - **Not satisfactory** → send it back to the SAME worker task with **specific pointers**:
     what's wrong, why it's wrong, and the concrete change you want. "Do better" wastes a
     round — name the fix.

4. **Bound the loop.** At most **2 redo rounds** per worker. If it's still short after that,
   present the best version WITH an honest note on what's still weak. Never loop forever;
   never silently ship a result you know is weak.

## Rules

- The routing is an instruction you follow, not something the harness enforces — you must
  actually pass the cheaper-tier model override when you spawn. Forget it and the worker runs
  on the flagship and the savings are gone.
- Review is the flagship's job precisely because it's the quality gate. Delegating the review
  itself to the cheaper tier defeats the purpose.
- Worth it only when the delegated work is substantial (multi-file, multi-step, or fanned out).
  For a quick lookup or a one-line edit, skip the whole dance.
- Savings come from the worker doing the output-heavy generation; the flagship still pays input
  tokens to read each output during review. So the win scales with how much the workers GENERATE
  vs. how much the flagship re-reads.
- All standing rules (no fabrication, surgical scope, project conventions) apply to both the
  workers and the review — delegation doesn't relax them.
