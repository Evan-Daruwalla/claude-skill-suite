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

0. **Workflow path only — ask the workers' reasoning effort; don't default silently.**
   If (and only if) the workers will be spawned via the **Workflow tool**, ask the user what
   reasoning level the workers should run at — **low / medium / high / xhigh / max** — with
   a recommendation (default **high** for substantive delegated work; **max** only for
   correctness-critical reasoning; **low / medium** for mechanical bulk). The
   output-quality-vs-token tradeoff is theirs to make, not yours to assume. Apply the choice
   per worker: `agent(prompt, { model: "opus", effort: "<level>" })` (adjust the model to
   your tier). If spawning via the plain **Agent tool** instead, SKIP the question — it has
   no `effort` parameter (subagents inherit the session's effort), so the answer would be
   inert; just note in your summary that workers ran at inherited effort.

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
