---
name: landing-check
description: >-
  Post-work verification sweep run by a FRESH agent: did the change land where
  it actually executes (and does a new guard actually FIRE), do the stated
  claims match disk, what should have moved and didn't, and did anything land
  where it must NOT (a private identifier in a public copy). Reads claims from
  ARTIFACTS (diff, record entry, report), never from the session's
  recollection. Use when: "landing-check", "did that land", "sweep the
  changes", "verify what I just did", "check my work", before committing a
  multi-file or multi-tree change. Invoked only — never auto-fires. Ships
  landing-probe.js (hooksPath / twin / registration / remote census, zero deps)
  for the mechanical half. Defers code correctness to /code-review and
  whole-project sweeps to /audit.
---

# landing-check — did the work land, and are the claims true?

Three questions nothing else in the toolchain asks. `/code-review` reads the
diff for correctness. `/audit` sweeps the whole project, cold. `code-check`
makes the author re-run their own code. All three can pass while the change
went to a file nothing executes, the report states a number that is wrong, and
half the copies were never touched.

**The failure class this exists for, observed in practice:** a security fix was
deployed by looping over every `.git/hooks/pre-commit` file in a set of repos.
But several of those repos set `core.hooksPath`, and git then ignores
`.git/hooks` entirely — so in some of them the fix landed on a dead file while
the live hook kept the old path. The loop confirmed every write, and the report
asserted the fix was universal for six days. **The diff was correct. The
verification was real. Both were about the wrong file.**

Every check below is one a real run needed. None is speculative — see
Provenance at the end. Ten runs in: the sweep has found **zero code bugs** and
roughly forty false claims, mislanded fixes, dead guards, and corrections that
did not propagate. That is the shape of what it catches.

## Trigger
`/landing-check`, or: "did that land", "sweep the changes", "verify what I just
did", "check my work before I commit". Invoked only — it costs an agent, so it
never fires on its own.

## Not this skill
- **Code correctness in the diff** → `/code-review` (built-in; has multi-agent
  and `--fix`). Do not re-review logic here.
- **Whole-project sweep** → `/audit` (cold, expensive).
- **Re-running what you just wrote** → `code-check` (same context, author's own
  eyes, fires from the PostToolUse hook).
  If a finding belongs to one of those, name it and hand it off — don't grow
  this skill into them.

## How to run it

**Spawn ONE fresh agent** (Agent tool, general-purpose). Moderate context: this
is scoped to what changed, not to the project.

**What the agent gets — artifacts only:**
- the repo paths touched, and one line on what the project is;
- `git status` + `git diff` (and `git diff --stat` per repo) — or, for
  non-repo trees, the list of paths modified this session;
- the WRITTEN account of the work: commit messages, the record entry, the
  final report text, any doc edited to describe the change;
- which of the touched trees are PUBLIC (pushed anywhere), if any;
- steps 1–3 and the output format below, and the instruction to mark anything
  it does not reach **NOT SWEPT**.

**What it must NOT get: your account of what you did.** The claims are the
specimen. If you hand the agent your summary, you hand it the same blind spot
that produced the error — you become both defendant and witness. It re-derives
every claim from the written artifacts and from disk. This is the one rule that
makes the skill worth its cost; drop it and this is self-grading in a second
window.

**The agent re-reads state live.** `git status`, ahead/behind, what is pushed:
derived at sweep time, not from the capture it was handed — other sessions
commit, push and edit in between (a concurrent session has committed a fix
inside an unrelated commit; six repos were pushed minutes before a sweep that
was told "zero pushes"). `ahead N` proves nothing without a `fetch` first — ask
the remote (`git ls-remote`, then `rev-list --left-right --count @{u}...HEAD`).

## 1. LANDING — did the edit reach the file that runs?

For every changed file, ask whether another copy exists and whether something
chooses between them. The signature is: **the edited file and the executed file
have the same name and different paths.**

- **Shadowing**: `git config core.hooksPath` (set ⇒ `.git/hooks/*` is dead
  code; resolve with `git rev-parse --git-path hooks/<name>`, the resolver git
  itself uses), `PATH` order for scripts, symlinks, vendored copies under
  `node_modules`, a venv copy vs a repo copy.
- **Multi-tree systems**: if a file exists in more than one tree (installed /
  lab / public, dev / dist, src / build), which one does the runtime load? Was
  the changed one it?
- **Registration**: if the change adds or edits something that must be wired up
  (a hook, a scheduled task, a route, an entry point), read the registration
  file and confirm the path there resolves to the file you changed.
- **Activation — the right file is necessary, not sufficient.** For anything
  that is a *control* — a guard, deny rule, hook matcher, regex, permission
  pattern, canary assertion, ignore rule — plant the positive it exists to
  catch and watch it fire, then a negative and watch it stay quiet. A control
  never observed firing is UNVERIFIED. Controls that read as protection and
  could not fire, all found by runs: deny rules that were prefix matchers and
  could never block a mid-command token; a leak regex whose `\R` compiled to
  `X:Repo` and could not match a real path; a case-sensitive name filter
  that let an all-caps spelling through; an assertion
  `/findings/.test(src)` that was true forever.
- Verdict per changed file: **LANDED** / **MISLANDED** / **UNVERIFIABLE** (say
  why). A file whose executing copy you could not determine is UNVERIFIABLE, not
  LANDED. A dead copy left behind is not itself a finding — say which copy is
  live and that the edit is in it.

## 2. CLAIMS — does the written account match disk?

Extract every checkable assertion from the artifacts, then **re-derive each one
independently** — a different command than the one that produced it, where a
different one exists. Priority order, highest yield first:

1. **Universals** — "all 7", "every copy", "byte-identical", "none remain",
   "0 findings", "nothing leaked across all 17 repos". One miss falsifies the
   whole statement, and this is the class that produced the 08-05 error.
   Enumerate the full set and check each member; never accept a spot check as
   proof of a universal. A universal you could only spot-check is UNVERIFIED.
2. **Counts** — "17 rules", "29 skills", "21/21". Count from the source of
   truth, not from the sentence. Watch the **tense**: a count of record entries
   written inside the entry being counted is off by one the moment it lands; a
   "the only dirty files left" claim made from inside a dirty file is
   self-falsifying; a citation of an entry that does not exist yet points at
   nothing until it is written.
3. **States** — "passes", "clean", "regenerated", "pushed". Run it, or read the
   artifact that proves it. **Quoted output is a claim about the program**: if
   an artifact quotes a line of tool output as evidence, grep the tool for that
   literal — a line printed only on the failure branch cannot evidence a pass,
   and a line the program never emits is a fabricated quote.
4. **Numbers** — a value with more significant figures than the output it
   traces to is invented (13 share counts published at 4 dp from a 2 dp table:
   12 wrong). A statistic from a LIVE corpus (transcripts, logs, a growing
   record) is not reproducible without its corpus state pinned (file count +
   timestamp); report it as UNVERIFIED-AS-STATED and name what *does*
   reproduce. Check the arithmetic inside one sentence ("27 plus 3 … 29
   today"). For comparisons: same sample set in every arm, estimator named, n
   stated — a 2×2 whose arms do not share batches is not a comparison. An
   absent field is not `false`. An `==` on a float that round-trips through
   float32 never matched, and the committed JSON held `0.0` for a true `0.605`.
5. **Internal contradiction** — a sentence falsified by its own paragraph's
   caveat five lines later; a claim and its refutation both present with no
   dated strike; the same figure quoted three times and wrong in all three.

A claim you cannot check is reported as **UNVERIFIED**, never as true. A claim
that is true but for a different reason than stated is a finding.

## 3. COLLATERAL — what should have moved and didn't?

The diff shows what changed. This asks what the change *obligated* and left
undone. Run the inverse of the diff: for each changed value or concept, grep the
tree for other places still asserting the old one.

- **Sibling copies** — every other tree/branch/package holding the same file.
  The fix for a mislanding has itself mislanded in one of two copies; a
  wholesale copy of a private file over its public twin has re-introduced what
  an earlier commit deliberately removed — compare the public copy to its own
  `git show HEAD:`, not to the private source.
- **Correction propagation** — if the work corrects a claim, find every other
  copy of the OLD claim: HANDOFF, PRD, memory bins, README, code comments, the
  public twin, the skill's own description. "Corrected in the record, left
  HANDOFF and the bin stating the old numbers" and "the third copy of this
  claim was still unstruck" are the most repeated finding of every run.
- **Docs quoting the changed value** — READMEs, skill descriptions, HANDOFF,
  PRD, comments, `MUST print N/N` pins. A count changed in code and unchanged in
  prose is a finding.
- **Publication leak — landed where it must NOT.** If any touched tree is
  public: sweep its diff (and the files it touched, against `HEAD`) for private
  identifiers — names, emails, absolute paths, private project names —
  **case-insensitively**. Say whether this change introduced the string or
  inherited it; the two need different fixes and the author has called the
  first the second before.
- **Generated twins** — rendered HTML of a record, TOC rows, memory bins,
  anchors: regenerated? An anchor that resolves but lands one heading early is
  not "broken", so `broken: 0` does not prove it.
- **New artifact types** — did the work create a kind of file that did not exist
  before (cache dirs, build output, logs)? Is there an ignore rule, and is it in
  the right repo?
- **Byproducts** — files created and left behind: untracked files, temp
  directories, `__pycache__`, `.tmp`, backups. List them with full paths; do not
  delete anything.
- **The obligation the docs state** — if the project's own rules say a change of
  this kind requires something (a record entry, a regenerated twin, a synced
  snapshot, a test run, a pin bump), check that it happened.

## Probe — the mechanical half, run before the agent judges

`landing-probe.js` (portable Node, zero deps, read-only) enumerates what steps
1–3 would otherwise re-derive by hand, so the agent reads a census instead of
guessing one. Give it every touched tree; hand its output to the agent as an
artifact.

```
node landing-probe.js probe <root>... [--file <p>]... [--since <min>]
                           [--settings <json>] [--remote] [--all]
node landing-probe.js --canary
```

- `HOOK` — per repo, per hook: the file git will RUN (`git rev-parse
  --git-path`, honours `core.hooksPath`) and any `DEAD` copy in the other
  place; a registered path with no file is `MISSING`.
- `CHANGED` — staged / modified / untracked per repo; `--file` names files
  outside any repo; `--since N` adds files modified in the last N minutes under
  NON-repo roots (an installed tree is not a repo).
- `TWIN` — for each changed file, every same-name file under any root, `SAME` or
  `DIFF` (sha256, CRLF-normalized). Conventional names (`SKILL.md`, `README.md`
  — any basename with more than 6 copies) match on parent-dir/name, not name
  alone. `--all` lists every twin group, not just the changed ones.
- `REG` — `--settings <json>`: every path-shaped string (after `~`/`$HOME`/
  `%USERPROFILE%` expansion) and whether it `RESOLVES`.
- `REMOTE` — ahead/behind per repo, labelled `CACHED ref` unless `--remote`
  fetched first. `ahead N` off a cached ref proves nothing.

Exit 1 when there is something to look at (a DEAD hook, a DIFF twin of a changed
file, a MISSING registration); 0 for a clean census. It judges nothing — `DIFF`
between a private and its genericized public copy is expected, and the agent
says so. `--canary` builds throwaway repos (hooksPath set / unset / pointing at
nothing, a bare remote and a clone one commit ahead, CRLF twins, a
conventional-name forest, a settings file with one missing path) and MUST print
`CANARY PASS 23/23` before you trust a census.

## Output

Short. This is a pre-commit sanity sweep, not an audit report.

- **Verdict line**: SAFE TO COMMIT / FIX FIRST / UNVERIFIABLE, one sentence.
- **Coverage line**: which artifacts were read, which trees swept, and what was
  **NOT SWEPT** — a short report must never read as a clean one.
- **Landing table**: `file | copies found | which one executes | fired on a
  planted positive? | verdict`. Only rows that are MISLANDED or UNVERIFIABLE
  need detail.
- **Claims table**: `claim (quoted) | source artifact | re-derived result |
  TRUE / FALSE / UNVERIFIED`.
- **Collateral list**: what should have moved and didn't, each with a path.
- **Confirmed**: the load-bearing negatives and the numbers that re-derived
  exactly (no misland, no leak, 25/25 reproduced) — a sweep that reports only
  faults teaches nothing about what is solid, and the author's record needs
  them.
- **Handoffs**: anything belonging to `/code-review`, `/audit`, or `code-check`,
  named and passed on rather than half-done here.

## After the report

- **Re-verify every finding by hand before acting.** The verifier's claims are
  claims: one run's re-derived integers were off because the corpus had grown
  under it; the invariants held. Accept what reproduces.
- **The fix is subject to the same three questions.** Fixes to FIX FIRST
  findings go to every copy and every doc quoting the old value — the run that
  fixed a one-of-two-copies mislanding shipped the fix to one of two copies.
- **Write the record entry from the re-derived values**, after the last
  verification run, not before it: an entry written first records the state you
  expected, and the append-only record makes that permanent.

## Rules
- **Findings only. Change nothing, delete nothing** — including byproducts and
  files that look like junk. Report paths; the author decides.
- **Evidence or it isn't a finding**: a command and its output, a file:line, or
  a reproduced state. No speculation.
- **A zero result is a claim.** If a search comes back empty and something
  load-bearing rests on it, re-run it a second way before believing it — and if
  a whole-repo search returns nothing, grep the ignore files for `{`/`}` first
  (one malformed glob silently hides an entire repo from ripgrep-backed tools;
  git is unaffected). A backslash pattern that matches nothing proves nothing:
  retry with `grep -F`, or build the path from a char code.
- **Never fabricate** a count, path, or command output. "Could not determine" is
  a valid and expected verdict.
- **Cut short is not clean.** If the agent dies or is resumed mid-sweep, it
  marks what it did not reach NOT SWEPT; a partial report that says which parts
  are partial is worth more than a complete-looking one that does not.
- The probe has a canary; the judgment does not. Steps 2–3 and the verdict are
  prose run by an agent, and are only as good as that agent — a clean probe is
  a clean census, not a clean sweep. Say so rather than implying a gate.

## Provenance

Ten runs over eleven days across four projects (a skills suite, an ML/robotics
project, a web app, a trading system). Among what they found: four false claims
on the first run, one inside this skill's own anecdote; a fix broken by its
canary's blind spot; a "pre-existing" leak the fix pass had introduced; a fix
landed in one of two copies; a dead leak regex; every record anchor one heading
off; a personal identifier in a public repo; 27 stale doc pins; four wrong
numbers in a sealed entry; quoted output the program never prints; a false
universal in a public repo; an unmatched 2×2; a float `==` that wrote `0.0`
for `0.605`; an unrendered status; a route enumeration wrong in three places
including the source comment; prefix-matching deny rules that blocked nothing;
4 dp share counts from 2 dp output. Zero of these were code bugs.
