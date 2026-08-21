# Shared report contract — all three audit skills

Read by `audit`, `audit-code` and `audit-docs`, at either scope. One
contract so two audits of the same tree are comparable, and so a finding keeps
its meaning when it moves between reports.

Every section below is REQUIRED unless marked optional. A section with nothing
in it is written with its heading and the word "none", never silently dropped —
an absent heading reads as "not applicable", which is a different claim from
"looked, found nothing".

---

## 0. Verification tiers — the spine of the whole report

The old rule was "no speculative findings — if you can't demonstrate it, don't
list it." **Both real runs of this skill broke that rule and were right to.**
The 2026-08-20 audit shipped a section titled "HIGHS REPORTED BUT NOT
INDEPENDENTLY VERIFIED" because a delegate's plausible high is genuinely worth
the user's attention — it just isn't worth the same trust as a reproduced crit.

So the tier is stated per finding, never implied:

| Tier | Bar | Written as |
|---|---|---|
| **CONFIRMED** | Reproduced by the reporting model itself, with the command and its real output pasted | `CONFIRMED` |
| **REPORTED** | A delegate found it and gave evidence; the reporting model did NOT re-run it | `REPORTED (unverified)` |
| **CONSTRUCTED** | Does not exist on disk now; you can name the exact input that triggers it | `CONSTRUCTED` |
| **REFUTED** | Was reported, then failed to reproduce | `REFUTED` — keep it, see below |

**REFUTED findings stay in the report.** A delegate claim that did not
reproduce is information: it tells the user the delegate's yield and stops the same
claim being re-litigated next audit. The 2026-08-20 run did this explicitly —
"where a claim did NOT reproduce, that is stated rather than relayed."

**A crit or high may not ship as REPORTED without a stated reason.** Either
reproduce it or say why you couldn't ("needs a live Postgres"; "would require
force-pushing a real repo"). Effort is not a reason at crit.

---

## 1. Executive summary — 3–5 lines

Top risks, overall health, and the single sentence a reader keeps if they read
nothing else. Lead with the pattern if there is one.

The 2026-08-20 run's opener is the model to imitate: *"Every confirmed crit is
in code written or modified during the previous session — code that was
verified at the time, and written up in the record as working."* That sentence
reframed ten findings into one structural problem. Look for that sentence
before writing the summary; if there genuinely isn't one, say so plainly rather
than manufacturing a theme.

---

## 2. Architecture & policy findings — ABOVE the patch list

**New section, and it outranks everything below it.** Some findings are not
patches; they are decisions the user has to make, and shipping them inside a
numbered fix list mis-frames them as chores.

From 2026-08-20: *"the gate FAILS OPEN by design, so every parser gap is an
unscanned commit rather than a blocked one. Closing shapes one at a time is a
treadmill; denying on `unknown` is an architecture decision, not a patch."*
That outranked all six crits and had nowhere to live.

Qualifies here when **all three** hold:

1. The fix is a design change, not a diff — or the same class of finding will
   keep recurring until the design changes.
2. Patching the instances individually is a treadmill you can already see.
3. the user, not the auditor, owns the call.

Format: one heading per item, 3–6 lines, ending in the actual question being
put to him. No severity letter — these are not ranked against patches.

Cap this section at three items. A fourth "architecture finding" usually means
the auditor is editorialising; demote the weakest to the findings table.

---

## 3. Findings table

`# | Sev | Tier | Src | Method | Finding | Evidence | Surgical fix | Eff`

- **Sev** — `crit` / `high` / `med` / `low`. Revision is written `med->high`
  with a reason, never silently re-graded.
- **Tier** — from section 0.
- **Src** — which auditor produced it (`A`, `B`, `C`, `session`). Makes a thin
  or a dominant worker visible; both real runs carried this column.
- **Method** — `M1`-`M9` for code, `D1`-`D8` for docs. A method that produced
  no findings across a whole audit is either genuinely clean or badly run, and
  this column is what lets you tell.
- **Evidence** — file:line, the query result, the tool output, or the
  reproduction. For CONFIRMED, the actual command and its actual output.
- **Surgical fix** — file:line and the smallest change that closes it. If the
  honest fix is large, say so and size it; never propose a small patch that
  only appears to close it.
- **Eff** — `XS` / `S` / `M` / `L`.

Ordered by severity, then by tier within severity (CONFIRMED above REPORTED).

---

## 4. Edge-case table

`# | Pri | Gen | L | B | Trigger (literal, OBSERVED/CONSTRUCTED) | Where | Failure | Surgical fix`

Numbered `E1, E2, ...`. Priority from the L x B matrix in `code-methods.md`.
P3s may collapse to one line each; full detail is owed to P1 and P2.

---

## 5. VERIFIED TRUE — load-bearing negatives

**Required section.** What you checked and proved FINE, with the command that
proves it. This is the highest-trust output an audit produces and the first
thing a shallow one omits.

The 2026-08-20 examples set the bar — note that every one carries its
measurement, not just a verdict:

- "All 10 gated repos read ONE scanner — 5 delegate, 5 byte-identical copies,
  sha-verified. The census in the status doc is exact."
- "`pm-secretscan --history` clean across all three project repos."
- "Record at rest is clean: 73 appendices, letters unique and ordered, TOC
  balanced and contiguous, 0 CRLF, 73/73 anchors resolve."
- "`agent-runs.jsonl`: 314 rows, 0 unparseable."

A negative belongs here only if it is **load-bearing** — a claim someone
actually relies on. "No syntax errors" is not load-bearing. "The status-doc census
is exact" is, because the user quotes it.

**Every negative in this section is cross-checked by a second implementation
before it is written** (the agent's search tool vs `grep -rn`), per the zero-result rule in
`code-methods.md`. An unverified negative here is worse than no section at all:
it is a wrong answer wearing a proof's clothes.

---

## 6. Corrections to the project's own records — optional

Where the audit falsified a number or claim the project has written down.
Separate from section 3 because the fix is an edit to the record, not to code,
and because the append-only rule means prior entries are corrected forward with
a dated note, never edited in place.

Format: a table of `claim as written | re-measured | verdict`, then one line on
what should be dated-and-scoped. The 2026-08-20 run corrected its own
transcript study this way — two invariants held exactly, two ratios did not
reproduce at a larger corpus.

---

## 7. Fix order

One interleaved list across findings and edge cases so there is a single thing
to approve: e.g. `C1, C2, E3, 4, E1, 7`. Severity and priority are the same
scale: crit ~ P1, high ~ P1/P2, med ~ P2, low ~ P3.

Follow it with 2-4 lines of rationale — why this order, not just what it is.
Cheap-and-closes-a-live-hole outranks expensive-and-theoretical at equal
severity.

If section 2 has entries, state explicitly that they outrank this list.

---

## 8. Coverage map

Every method and generator marked **swept** / **partial** / **not swept**, each
with a reason. Absence of findings means nothing where coverage was not real.

**The map is computed from the reconciled search trails, not written from
impression.** Each worker returns a trail per `fanout.md` rule 7 — the
enumeration command, the count it returned, and every depth/filter/glob limit
inside it. Before this section is written:

- reconcile each trail count against the manifest shard that worker was given;
- state any discrepancy as a finding about the audit itself;
- **mark any method whose trail does not reconcile as `not swept`** — never
  "no findings";
- re-enumerate at least one shard independently and say so here, with both
  numbers.

A coverage map that cites no trail is an assertion. The whole point of this
section is that it is checkable, and it stopped being checkable the moment it
became prose.

**"Partial" must say what made it partial and which direction the error runs.**
The 2026-08-20 map is the standard: *"M5 partial (coverage measure = canary
existence, which **overstates** coverage: `append-record-entry.js` has 15
assertions and 9 defects none of them reach)"*. That names the measure, admits
the bias, and quantifies it.

Then a **Gaps** line: what was left undone and would be worth doing next time.

An audit with no dynamic pass (M6) is a reading exercise — say so in those
words rather than letting a clean map imply otherwise.

---

## 9. Cost

One line: auditors spawned, tool calls, subagent tokens, wall clock. Both real
runs grew this organically; it is what makes "was this worth it" answerable.

Example: *"3 auditors (2 with their own delegates), 208 tool calls, ~796K
subagent tokens, ~35 min wall clock."*

---

## 10. Addendum — late delegate findings

Delegates finish after the main report is written. Do not silently fold them in
and do not discard them: append an `## ADDENDUM` section, run each through
section 0 tiering, and mark duplicates against the main table rather than
renumbering it.

If an addendum finding outranks something already in the fix order, say so
explicitly in the addendum — do not rewrite section 7 in place, because the user
may have already started working from it.

---

## Rules that bind every section

- **The findings pass changes NOTHING.** No drive-by fixes.
- **Never invent a number, a timestamp, or a measurement.** Missing data is
  reported as missing. Run `date` before writing any timestamp; label the zone
  from the real reported UTC offset. Absolute dates only.
- **Likelihood and severity are cited, never guessed, and never percentages.**
  "L1 because it runs on every commit" is a rank. "L1, ~80% likely" is an
  invented number wearing a rank's clothes.
- **Quote the artifact, not your memory of it.** Evidence is pasted from a real
  command run in this audit.
- **A finding you cannot state as a concrete trigger is a hypothesis** — drop
  it rather than padding the count.
- Keep the report readable: sample large files, prefer grep over full reads, no
  long code excerpts pasted into the report.
