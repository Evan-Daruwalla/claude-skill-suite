# Cross-domain sweep — X1–X5

Read by `audit` and `audit-recent` only. The single-domain skills do not run
this, and saying so is the honest boundary: **`audit` is not `audit-code` plus
`audit-docs`.** It is those two plus this file, and this file is the reason the
combined skill exists.

**Run X last.** Every method here consumes the *output* of both sweeps. Running
it early means running it on nothing.

**Prerequisites**: the docs sweep's claim inventory (D1), its stated-contract
list, and its doc-coverage map; the code sweep's observed behaviour, M1's
contract verdicts, and M5's test-coverage measure.

---

## The test each X method must pass

Same rule the M-series and D-series live by, applied across the seam: **a
cross-method earns its place only if neither single-domain sweep could produce
its finding alone.** Anything one sweep could have found belongs in that sweep.

---

## X1 — Claim reconciled against behaviour

D1 tests a claim against **disk state** — does the file exist, is the count
right, does the symbol resolve. It cannot test a claim about **what the code
does**, because it never runs anything. The code sweep observes behaviour but
does not know which claims were made about it.

X1 is the join: take every **behavioural** claim from D1's inventory and check
it against what the code sweep actually observed.

- "The gate blocks `--amend`" — D1 can confirm the sentence exists; only the
  code sweep knows whether it does.
- "Runs on every commit" — check the hook is registered, executable, and on the
  path git actually consults.
- "Refuses when given no value" — feed it no value.
- "All copies are byte-identical" — hash them.

**This is where the 2026-08-15 finding "one executing file gates all 7 repos"
lived.** The sentence was in a doc. The truth was in `git rev-parse
--git-path hooks/pre-commit` across sixteen repos. Neither sweep alone had both
halves.

**Every behavioural claim gets one of three verdicts: TRUE (with the command),
FALSE (with the contradiction), or UNTESTED (with why).** A behavioural claim
you did not test is not a passing claim.

## X2 — The contract set difference

M1 produces the contracts the **code** relies on. D-series produces the
contracts the **docs** state. The interesting output is the two set
differences, and neither sweep can compute a difference it only holds one side
of.

- **Relied on but never stated.** An invariant the code depends on that no
  document mentions. These are the ones that break when someone new — or a
  future session with no memory — touches the code, because nothing warned
  them. Report each, and flag explicitly that it was never written down.
- **Stated but never enforced.** A documented contract with no mechanical guard
  anywhere: "never run these concurrently", "always open read-only", "don't
  edit prior entries". M1 calls this verdict **UNENFORCEABLE**, and on a
  one-person project it is frequently the highest-value finding available,
  because nothing will ever catch the slip.
- **Stated and enforced, but by a guard that cannot fire.** The worst of the
  three, and the easiest to miss: the doc says it, a guard exists, everyone
  relaxes, and the guard's threshold sits outside the mathematical range of the
  quantity it guards. Compare each guard's bound against what it guards.

## X3 — Drift adjudication: which side is wrong?

When code and docs disagree, **something is wrong, but not necessarily the
docs.** M7 reports the drift; it explicitly does not assume the code is the
intent. X3 is where that gets decided, and it needs inputs from both sides plus
history.

Decide with evidence, in this order:

1. **What does the record say was intended?** The append-only record is the
   historical authority — it beats every snapshot.
2. **Which side changed last?** `git log` the doc and the code. A doc written
   deliberately and code changed casually afterwards usually means the *code*
   drifted.
3. **Precedence on conflict**: the user's live instruction > the project's
   agent-instruction file > the roadmap > the live-status snapshot.
4. **Check every doc layer before concluding.** Live snapshot, PRD, record,
   docstring, README. Reporting the correct layer as the wrong one is a real
   failure mode and an embarrassing one.

Output per disagreement: **which side is wrong, what evidence decided it, and
the surgical fix on that side.** "The docs and code disagree" is not a finding;
it is half of one.

## X4 — Coverage asymmetry

Cross M5's test-coverage measure against D4's documentation coverage. Four
quadrants, and two of them are findings:

| | Documented | Undocumented |
|---|---|---|
| **Tested** | fine | **bus-factor risk** — works, nobody can safely change it |
| **Untested** | **false confidence** — reads authoritative, nothing checks it | known-unknown; rank by churn |

- **Documented but untested** is the dangerous quadrant. A confident doc over
  unverified code is trusted precisely because it reads well. Pair this with
  M10's mutation score: documented, "covered", and mutation-score-zero is a
  paper-thin guarantee wearing three layers of reassurance.
- **Tested but undocumented** is a slower risk and worth reporting at lower
  severity — unless it is high-churn, in which case somebody is editing code
  whose contract exists only in tests.

**State which coverage measure you used**, per M5. An import-graph fallback
overstates coverage, and overstating it here silently moves modules out of the
dangerous quadrant.

## X5 — Cross-domain blast radius of every proposed fix

Runs during reporting, not during the sweep — but it is a cross-method and it
belongs here.

**For every fix in the fix order, check the other domain.** This closes the
loop that produced several 2026-08-15 findings, where a fix landed in one place
and the documentation kept asserting the old behaviour for days.

- A **code fix** → which doc statements does it invalidate? A patched gate, a
  changed default, a renamed flag: name the doc lines that must change with it.
- A **doc fix** → does correcting the sentence reveal a code bug? Sometimes the
  doc was right and aspirational, and writing down what the code *actually*
  does exposes that nobody wants that behaviour.
- A **fix in one copy** → many projects keep several copies of the same file. **A fix that lands in one copy is not done.** Enumerate the
  copies rather than assuming their count.

Output: for each fix, a one-line "also touches:" note, or "no cross-domain
impact" — stated, not omitted.

---

## Reporting X findings

They go in the normal findings table with Method `X1`–`X5`. Two additions:

- **Name both halves of the evidence** — the doc line and the code fact. An X
  finding with only one half is a D or M finding filed in the wrong place.
- **X findings are frequently the highest-severity output of a combined
  audit**, because a false statement someone acts on outranks a latent bug
  nobody has hit. Do not let them sink beneath the code findings out of habit.

If the X sweep produces nothing, say so explicitly and say what you joined —
"27 behavioural claims reconciled, all TRUE" is a load-bearing negative for
`reporting.md` section 5. Silence here reads as "did not run".
