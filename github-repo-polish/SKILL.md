---
name: github-repo-polish
description: >-
  Polish/professionalize an EXISTING GitHub repo's PRESENTATION so it reads well
  to a recruiter or admissions reviewer — name, one-line description, topics,
  README structure, homepage, and semver tags/releases — using grounded `gh` CLI
  commands, propose-then-confirm on every public change. Use ONLY when explicitly
  asked to set up/clean up/professionalize a repo's presentation or its README,
  description, topics, or releases. Do NOT use for writing code, committing,
  pushing, creating a new repo/scaffolding, or CI/Actions/Projects/Wikis.
---

# github-repo-polish

Make a repo look professional on GitHub. Scoped to the **presentation /
discoverability layer**; every outward-facing change is proposed first and only
applied on an explicit yes.

## Trigger

Fires only on an explicit request to polish an **existing** repo's presentation:
"professionalize this repo", "set up the repo's description and topics", "write a
proper README", "clean up the repo page", "cut a v1 release".

Does NOT fire on: "commit"/"push", writing or refactoring code, "create a new
repo"/scaffolding a project, or CI/Actions/Projects/Wikis/Pages/Discussions
requests (all out of scope, below).

## Scope

**In:** repo name, description, topics, homepage URL, README *structure*,
default branch, git tags + semver releases.
**Out (say so, don't improvise):** GitHub Actions/CI, Projects, Wikis, Pages,
Discussions, packages, branch-protection rules, org/security settings. README
*prose texture* → defer to `the-humanizer`. Turning the project record into a
narrative case study → defer to `portfolio-case-study`.

## Hard rules (read before running anything)

1. **PROPOSE → CONFIRM → APPLY. Never auto-apply a public change.** For every
   mutating command — `rename`, `--description`, `--add-topic`/`--remove-topic`,
   `--homepage`, `--default-branch`, `release create` — show the user the exact
   command and the before→after, get an explicit yes, THEN run it. The `gh`
   permission prompt is the hard gate; your job is to surface the consequence
   *before* it:
   - **Rename breaks every existing clone URL and link.** GitHub adds a
     redirect, but don't rely on it — flag it and confirm before renaming.
   - **A published release is public and notifies watchers.** Draft first
     (`--draft`) for review unless the user says publish.
   - **Changing the default branch** affects PRs/clones — confirm.
   Never rename or publish without an explicit yes.

2. **Anti-fabrication (portfolio-grade — this is the #1 rule).** Every claim in a
   README/description/release-notes must trace to REAL repo content (code, the
   project record, commits, tests). No invented features, metrics, benchmarks,
   "used by", or badges for things that don't exist. Topics must be real tech in
   the repo. Missing info stays a marked `[ADD: …]` placeholder — never filled
   with a plausible guess. For a portfolio or public repo, a fabricated
   claim is worse than a blank.

3. **Surgical + respect what's there.** Read the current state first (Step 0),
   propose the minimum that raises the bar, and match the project's existing
   conventions/CLAUDE.md. "Already solid, leave it" is a valid outcome.

## Step 0 — inspect current state first

Don't propose blind. Read what's already set (verified on gh 2.96.0):
```
gh repo view <owner>/<repo> --json name,nameWithOwner,description,homepageUrl,repositoryTopics,defaultBranchRef,visibility,latestRelease
```
Then propose only the gaps.

## Playbook

**Target the repo explicitly in EVERY command** — pass the `<owner>/<repo>`
positional (e.g. `gh repo edit OWNER/REPO --description "…"`), OR run from inside
the repo's working dir. The bare form infers the repo from your cwd's git remote
and dies with `fatal: not a git repository` if you're not in it. Use the
explicit target so it works from anywhere.

`gh` flags below are grounded in cli.github.com/manual; anything genuinely
undocumented is tagged `[verify]`. Prefer LONG flags (e.g. `--homepage`, not
`-h`, which is the usual `--help` alias).

### Name
Lowercase, hyphen-separated, descriptive. Rules: ≤ **100 code points**; only
hyphen `-`, underscore `_`, period `.`, or ASCII alphanumerics (other chars
collapse to a single hyphen). Rename only with explicit confirm (Rule 1):
```
gh repo rename <new-name>            # current repo; add --yes to skip gh's own prompt
gh repo rename <new-name> --repo OWNER/OLD   # a different repo
```

### Description
One line, concrete, says *what it is and who it's for* — no buzzwords, no
fabricated scope. Max length ~350 chars `[verify: community-reported, not in
official docs]`.
```
gh repo edit <owner>/<repo> --description "One-line: what it is and who it is for (concrete, no buzzwords)"
```

### Topics
5–15 real ones (language, framework, domain). Rules (GitHub docs): **≤ 20
topics**, each **≤ 50 chars**, **lowercase letters + numbers + hyphens only**.
Repeat the flag per topic (most reliable form):
```
gh repo edit <owner>/<repo> --add-topic fastapi --add-topic nextjs --add-topic typescript --add-topic volunteering
gh repo edit <owner>/<repo> --remove-topic <stale-topic>
```

### README (structure checklist — not prose)
Propose the *sections*; hand the actual writing voice to `the-humanizer` and any
record→narrative to `portfolio-case-study`. A portfolio README should have, each
grounded in real repo content:
- **Title + one-line what/why.**
- **Status + stack** — only badges/tech that are real.
- **Demo** — screenshot / GIF / live link, only if it exists (else `[ADD: …]`).
- **What it does** — real features only.
- **Run it** — the actual commands from the repo (verify they work).
- **Architecture / decisions** — link to `docs/` / the project record, don't restate.
- **Tests** — how to run them; real coverage only.
- **License.**
Mark every section you can't ground as `[ADD: …]` rather than inventing it.

### Branches, tags, releases (semver)
Tags are `vMAJOR.MINOR.PATCH` (the `v` is convention; semver itself is `X.Y.Z`,
non-negative integers). MAJOR = incompatible change, MINOR = backward-compatible
addition, PATCH = backward-compatible fix. Cut a release (confirm first, Rule 1):
```
gh release create v1.0.0 --target main --title "…" --notes "…"   # notes trace to real changes
gh release create v1.0.0 --draft                                  # draft for review first
gh release create v1.0.0 --generate-notes                         # starting point ONLY — still verify every line
```
`--generate-notes` is a draft aid, not a source of truth — anti-fabrication still applies to whatever it produces.

### Homepage
```
gh repo edit <owner>/<repo> --homepage https://example.com
```

## Prerequisites
`gh` must be installed and authenticated (`gh auth status`). If not, say so and
stop — don't fabricate the outcome (report it as blocked). All writes need repo push
access `[verify auth scope per command if a write is rejected]`.
