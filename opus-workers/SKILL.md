---
name: opus-workers
description: >
  When an expensive model is orchestrating (e.g. Claude Fable 5 / Opus at high effort) and
  you're about to spin up subagents or a workflow for non-trivial work, run the WORKER agents
  on a cheaper tier — one tier down (e.g. Opus) at medium/high effort for substantive
  generation, two tiers down (e.g. Sonnet) at low/medium for mechanical bulk — after
  pre-registering a review rubric, then have the orchestrator review each output against that
  rubric: accept + present, or send back with specific pointers. Cheaper workers do the bulk
  generation; the orchestrator stays a thin reviewer. Skip for trivial one-shot tasks (inline),
  for GATED actions (commit/push/publishing stay with the orchestrator), and when no cheaper
  tier fits the task.
---

# opus-workers — the orchestrator reviews, cheaper tiers do the bulk work

**APPLIES WHEN** you are about to spawn subagents (Agent tool) or a workflow (Workflow
tool) for non-trivial work AND a tier strictly cheaper than the orchestrating model can do
that work faithfully.

**SKIP WHEN** no cheaper tier fits: the task is a single trivial step (do it inline — the
spawn + review round-trip costs more than it saves), the work is a GATED action (below),
or the session model is already at/below the tier the task needs.

**NEVER DELEGATE gated actions.** Anything bound to the user's explicit authorization —
`git commit`, `git push`, publishing / public-visibility changes, deletions, account or
config changes — is done INLINE by the orchestrator, never handed to a worker on any tier.
The authorization lives in THIS conversation's context; a worker can't know what the user
approved, and a misfire is exactly the class of action that isn't cheaply undone. (They're
also single commands — spawn overhead alone exceeds the work.)

**WHY.** Keep the expensive orchestrating model as a THIN reviewer and move the BULK
generation onto the cheapest tier that can do it faithfully. Output tokens cost more than
input and re-enter context on every later turn, so offloading generation compounds across
the session.

## The loop

0. **Pick the worker tier + effort by task class.**
   - **Substantive generation** (real reasoning: drafting, analysis, non-trivial code):
     one tier down from the orchestrator (Fable → Opus; Opus → Sonnet), effort **medium**
     (routine) or **high** (substantive). **Only when unusually demanding** —
     correctness-critical, or you'd push toward xhigh/max — ask the user which effort
     before spawning.
   - **Mechanical bulk** (high volume, low ambiguity, judgment-free: applying an approved
     mechanical transform across many files, genericizing copies, regenerating fixtures,
     mass renames per an approved plan): two tiers down (Fable → Sonnet; Opus → Haiku),
     effort **low** or **medium**. If a "mechanical" task turns out to need judgment
     mid-flight, that's a misclassification — pull it back up a tier or inline; don't let
     the cheap worker improvise.
   - Rule of thumb: the cheapest tier the task class tolerates, always strictly cheaper
     than the orchestrator; if nothing cheaper fits, do it inline.
   - Effort binds on the Workflow path (`agent(prompt, { model, effort })`); the plain
     Agent tool has no `effort` param (subagents inherit session effort) — note that in
     your summary when it applies.

1. **Pre-register the review rubric — BEFORE spawning.** Write down, in your plan or the
   spawn message, the **3–7 concrete checks** this output must pass and HOW each will be
   stress-tested: the command you'll run, the canary, the sample you'll re-derive by hand,
   the diff you'll scan. Executable checks over eyeball checks wherever possible. The same
   rubric goes into the worker prompt as its success criteria. Pre-registering kills the
   two review failure modes: rubber-stamping, and a post-hoc rubric quietly shaped by
   whatever the output happens to be. Scale it to the tier: substantive work gets the full
   rubric; mechanical bulk gets counts + spot-checks (N samples re-derived, diff scanned
   for out-of-scope lines) — a line-by-line re-read of bulk output eats the savings.

2. **Delegate.** Spawn every worker with the step-0 model override — never the
   orchestrator's model. Each worker gets a self-contained task AND the step-1 rubric as
   its success criteria. Independent tasks → fan out in parallel.

3. **Review as the orchestrator, against the pre-registered rubric.** Run the rubric as
   written — every check actually executed. You may ADD checks for problems you only saw
   once the output existed; you may NOT silently drop a pre-registered check that is
   failing. The orchestrator IS the reviewer — don't spawn one and don't downgrade the
   review.

4. **Decide per output.**
   - **Satisfactory** (rubric passes) → keep it. Once all workers pass, present.
   - **Not satisfactory** → send back to the SAME worker with the failing rubric items and
     the concrete change you want. "Do better" wastes a round — name the fix.

5. **Bound the loop.** At most **2 redo rounds** per worker. Still short after that →
   present the best version WITH an honest note on what's still weak. Never loop forever;
   never silently ship a result you know is weak.

## Rules

- The routing is an instruction you follow, not something the harness enforces — you must
  actually pass the model override when you spawn. Forget it and the worker runs on the
  orchestrator's model and the savings are gone.
- Review is the orchestrator's job precisely because it's the quality gate. Delegating the
  review itself to a cheaper tier defeats the purpose.
- The rubric is written before the output exists. A review that invents its criteria after
  seeing the output isn't a gate, it's a rationalization.
- Worth it only when the delegated work is substantial (multi-file, multi-step, or fanned
  out). For a quick lookup or a one-line edit, skip the whole dance.
- Savings come from the workers doing the output-heavy generation; the orchestrator still
  pays input tokens to read each output during review. The win scales with how much the
  workers GENERATE vs. how much the orchestrator re-reads — which is why bulk review is
  sampled, not re-read line-by-line.
- All standing rules (no fabrication, surgical scope, project conventions) apply to every
  worker tier and the review — delegation doesn't relax them.
