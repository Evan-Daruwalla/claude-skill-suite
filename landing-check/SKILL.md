---
name: landing-check
description: >-
  Post-work verification sweep run by a FRESH agent: did the change land where
  it actually executes, do the stated claims match disk, and what should have
  moved and didn't. Reads claims from ARTIFACTS (diff, record entry, report),
  never from the session's recollection. Use when: "landing-check", "did that
  land", "sweep the changes", "verify what I just did", "check my work", before
  committing a multi-file or multi-tree change. Invoked only — never auto-fires.
  Defers code correctness to /code-review and whole-project sweeps to /audit.
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

## Trigger
`/landing-check`, or: "did that land", "sweep the changes", "verify what I just
did", "check my work before I commit". Invoked only — it costs an agent, so it
never fires on its own.

## Not this skill
- **Code correctness in the diff** → `/code-review` (built-in; has multi-agent
  and `--fix`). Do not re-review logic here.
- **Whole-project sweep** → `/audit` (nine methods, cold, expensive).
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
- steps 1–3 and the output format below.

**What it must NOT get: your account of what you did.** The claims are the
specimen. If you hand the agent your summary, you hand it the same blind spot
that produced the error — you become both defendant and witness. It re-derives
every claim from the written artifacts and from disk. This is the one rule that
makes the skill worth its cost; drop it and this is self-grading in a second
window.

## 1. LANDING — did the edit reach the file that runs?

For every changed file, ask whether another copy exists and whether something
chooses between them. The signature is: **the edited file and the executed file
have the same name and different paths.**

- **Shadowing**: `git config core.hooksPath` (set ⇒ `.git/hooks/*` is dead
  code), `PATH` order for scripts, symlinks, vendored copies under
  `node_modules`, a venv copy vs a repo copy.
- **Multi-tree systems**: if a file exists in more than one tree (installed /
  lab / public, dev / dist, src / build), which one does the runtime load? Was
  the changed one it?
- **Registration**: if the change adds or edits something that must be wired up
  (a hook, a scheduled task, a route, an entry point), read the registration
  file and confirm the path there resolves to the file you changed.
- Verdict per changed file: **LANDED** / **MISLANDED** / **UNVERIFIABLE** (say
  why). A file whose executing copy you could not determine is UNVERIFIABLE, not
  LANDED.

## 2. CLAIMS — does the written account match disk?

Extract every checkable assertion from the artifacts, then **re-derive each one
independently** — a different command than the one that produced it, where a
different one exists. Priority order, highest yield first:

1. **Universals** — "all 7", "every copy", "byte-identical", "none remain",
   "0 findings". One miss falsifies the whole statement, and this is the class
   that produced the 08-05 error. Enumerate the full set and check each member;
   never accept a spot check as proof of a universal.
2. **Counts** — "17 rules", "29 skills", "21/21". Count from the source of
   truth, not from the sentence.
3. **States** — "passes", "clean", "regenerated", "pushed". Run it, or read the
   artifact that proves it.

A claim you cannot check is reported as **UNVERIFIED**, never as true. A claim
that is true but for a different reason than stated is a finding.

## 3. COLLATERAL — what should have moved and didn't?

The diff shows what changed. This asks what the change *obligated* and left
undone. Run the inverse of the diff: for each changed value or concept, grep the
tree for other places still asserting the old one.

- **Sibling copies** — every other tree/branch/package holding the same file.
- **Docs quoting the changed value** — READMEs, skill descriptions, HANDOFF,
  PRD, comments. A count changed in code and unchanged in prose is a finding.
- **New artifact types** — did the work create a kind of file that did not exist
  before (cache dirs, build output, logs)? Is there an ignore rule, and is it in
  the right repo?
- **Byproducts** — files created and left behind: untracked files, temp
  directories, `__pycache__`, `.tmp`, backups. List them with full paths; do not
  delete anything.
- **The obligation the docs state** — if the project's own rules say a change of
  this kind requires something (a record entry, a regenerated twin, a synced
  snapshot, a test run), check that it happened.

## Output

Short. This is a pre-commit sanity sweep, not an audit report.

- **Verdict line**: SAFE TO COMMIT / FIX FIRST / UNVERIFIABLE, one sentence.
- **Landing table**: `file | copies found | which one executes | verdict`.
  Only rows that are MISLANDED or UNVERIFIABLE need detail.
- **Claims table**: `claim (quoted) | source artifact | re-derived result |
  TRUE / FALSE / UNVERIFIED`.
- **Collateral list**: what should have moved and didn't, each with a path.
- **Handoffs**: anything belonging to `/code-review`, `/audit`, or `code-check`,
  named and passed on rather than half-done here.

## Rules
- **Findings only. Change nothing, delete nothing** — including byproducts and
  files that look like junk. Report paths; the author decides.
- **Evidence or it isn't a finding**: a command and its output, a file:line, or
  a reproduced state. No speculation.
- **A zero result is a claim.** If a search comes back empty and something
  load-bearing rests on it, re-run it a second way before believing it — and if
  a whole-repo search returns nothing, grep the ignore files for `{`/`}` first
  (one malformed glob silently hides an entire repo from ripgrep-backed tools;
  git is unaffected).
- **Never fabricate** a count, path, or command output. "Could not determine" is
  a valid and expected verdict.
- Prose skill: it ships no script, so it has **no canary**. Its checks are only
  as good as the agent running them — say so rather than implying a gate.
