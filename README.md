# claude-skill-suite

A suite of [Claude Code](https://claude.com/claude-code) skills built to keep a
**cheaper model** doing high-quality engineering work. Some are deterministic
Node tools — the model just runs them, so quality doesn't degrade with the
model; others are prose skills that shape how the model reviews, advises, and
writes. The governing rule for the security ones: **skill the judgment, hook
the gates** — a risk that must never slip through (a committed secret) belongs
in a deterministic hook that fires regardless of which model is running, not in
a skill the model has to remember to invoke.

> Memory / documentation-system skills live in the sibling repo
> **[claude-project-memory](https://github.com/Evan-Daruwalla/claude-project-memory)**.
> Together these two repos hold the generalized skill set.

## Security gates — deterministic, hook-backed

| Skill | What it does |
|---|---|
| **history-leak-scan** | Scans a repo's full git history (or the staged diff) for leaked credentials — per-provider keys (AWS, GitHub, Slack, Google, Stripe, Alpaca), private-key blocks, JWTs, high-entropy assignments, weak passwords. Token-level placeholder suppression so it doesn't cry wolf. Ships a `--canary` self-test. |
| **commit-gate** | Blocks any commit that stages a secret, two ways: a native git `pre-commit` hook (shell commits) **and** a `PreToolUse` hook (commits the model makes via Bash) — because a PreToolUse hook alone misses shell commits. Both share the scanner and fail open on error. |

## Model quality & output

| Skill | What it does |
|---|---|
| **llm-eval-harness** | Measures how far a cheaper model falls from your flagship model's quality bar, deterministically: `checks` (format / no-fabrication / surgical-scope assertions — no golden needed) and `golden` (word-level similarity to a captured flagship reference). Appends every run to a ratchet so the gap is a tracked series. No LLM-judge — a non-reproducible judge would be invented data. |
| **token-squeeze** | Deterministic text compressor: strips filler and collapses verbose phrasing while a guard layer proves numbers, negations, dotted identifiers, and masked spans survive byte-for-byte. Ships a reproducible corpus test (`node test.js`). Requires `npm install` (`gpt-tokenizer`). |
| **compact-io** | Always-on output-density style: lead with the answer, cut filler, plain words — governed by a **never-cut list** (numbers, paths, commands, caveats, tradeoffs, negations) so density never drops a fact. Also compresses a prompt/doc for reuse on request. Not a length cap. |
| **opus-workers** | Cost-tiered orchestration: when an expensive flagship (e.g. Fable 5, max/ultracode) spins up agents, route the WORKERS one tier cheaper (Opus 4.8) and keep the flagship as a thin reviewer — accept, or send back with specific pointers, bounded to 2 redo rounds. The cheaper model does the bulk generation; the flagship only reviews. |

## Judgment & review

| Skill | What it does |
|---|---|
| **trusted-advisor** | Candid advisor in two layers: a BASELINE (verdict first, no yes-man, honest calibration — always on) and a triggered FULL-CRITIQUE mode (severity-ranked, flaw-typed analysis). Yields to project/task instructions on format; never on honesty. |
| **audit** | Full sweeping project audit: enumerate findings, rank by severity, present for one-word approval, then fix in order with each fix verified. Diagnosis-first — it does not fix before you approve the plan. |
| **skill-vet** | Evaluates a third-party skill / plugin / MCP server before you install it — capability, risk, redundancy with what you already run — and gives a keep/skip verdict. |
| **research-brief** | Turns a topic into a sourced, decision-oriented research document — every claim cited, structured for the decision it feeds. |
| **reorg-proposal** | Read-only codebase-reorganization advisor: inspects a repo and proposes a file/folder restructure — current tree, proposed tree, and a per-move risk table naming what each move breaks (imports, paths, build, CI) — and **writes nothing**. Grounds every path in a real `git ls-files` listing; "already coherent, propose nothing" is a valid outcome. |
| **github-repo-polish** | Professionalizes an existing repo's *presentation* — name, description, topics, README structure, semver tags/releases — with `gh` commands grounded in the manual, **propose→confirm→apply** on every public change (rename breaks links; a release goes public), and a portfolio-grade anti-fabrication gate: every README/description claim must trace to real repo content. Scoped to presentation; defers prose voice to the-humanizer. |

## Verify before you trust the gates

A security gate you haven't watched catch a real secret is theater. The scanner
is canary-verified both ways — it must catch a planted real-format secret **and**
ignore a placeholder:

```
node history-leak-scan/pm-secretscan.js --canary          # -> PASS (4 caught, 0 false positives)
node history-leak-scan/pm-secretscan.js --history <repo>   # scan full history
node llm-eval-harness/score.js commit-message <file> --model <name>
node token-squeeze/test.js                                 # corpus guards (after: npm install)
```

## Install

- **Node tools** (history-leak-scan, commit-gate, llm-eval-harness): clone
  anywhere, run with `node`. No dependencies.
- **token-squeeze:** `cd token-squeeze && npm install` once (pulls
  `gpt-tokenizer`), then `node cli.js` / `node test.js`.
- **Prose skills** (compact-io, opus-workers, trusted-advisor, audit, skill-vet, research-brief, reorg-proposal):
  drop the folder into `~/.claude/skills/`; nothing to install.
- **commit-gate PreToolUse hook:** add to `~/.claude/settings.json` under
  `hooks.PreToolUse` an entry with `"matcher": "Bash"` running
  `node "<clone>/commit-gate/hooks/pretooluse-commit-gate.js"`.
- **commit-gate git hook:** set `SCANNER` at the top of `commit-gate/hooks/pre-commit`
  to your clone path, then `cp commit-gate/hooks/pre-commit <repo>/.git/hooks/`.

## Design notes

- **Deterministic over clever.** The security and compression tools survive a
  model downgrade because a script does the work; the model just runs it and
  reports.
- **Canary self-tests are part of "done."** Both false positives (which train
  you to bypass the gate) and false negatives (which give false confidence) are
  caught before the tool is trusted.
- **No fabricated data.** The eval harness refuses an LLM-judge precisely
  because it can't be reproduced.
