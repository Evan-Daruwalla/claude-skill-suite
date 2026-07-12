---
name: skill-vet
description: Evaluate an external Claude Code skill, plugin, or MCP server (usually a GitHub URL) before installing it. Use when the user says "look at this skill", "evaluate whether these skills would be useful", "install this skill", or pastes a repo/marketplace link. Produces a verdict (install / skip / install-modified) with reasoning, then installs cleanly on approval.
---

# Skill Vet

Evaluate third-party skills/plugins/MCP servers against Evan's actual
workflow before anything touches `~/.claude/`. History shows unvetted bulk
installs left ~30 dead claude-flow skills polluting every session — this
skill exists to prevent that.

## Trigger
`/skill-vet <url>`, or Evan pastes a skill/plugin/MCP link asking "would this
be useful", "look at this", or "install this".

## Inputs
- URL(s) or local path(s) of the candidate.
- Target scope: global (`~/.claude/skills`) or one project
  (`<project>/.claude/skills`). Default: ask only if unclear; single-project
  tools go project-level.

## Steps
1. **Fetch and read the actual source** — SKILL.md, scripts, hooks, and any
   install steps. Never judge from the README pitch alone.
2. **Check dependencies.** Does it require MCP servers, daemons, CLIs, or API
   keys not present on this machine (Windows 11, Claude Code desktop app, no
   `claude` on PATH, no ANTHROPIC_API_KEY)? A skill whose tools can't run is
   an automatic SKIP no matter how good it sounds.
3. **Check overlap.** Compare against currently installed skills and built-in
   Claude Code features. If it duplicates something already present, say so
   and name the incumbent.
4. **Check cost.** Every installed skill's description is injected into every
   session. Is the description tight and trigger-specific, or will it bloat
   context / mistrigger?
5. **Check safety.** Flag anything that runs arbitrary code at install or
   hook time, phones home, or writes outside its folder.
6. **Verdict.** One of: **INSTALL** (as-is), **INSTALL-MODIFIED** (trim or
   rewrite parts — say which), **SKIP** (with the one-line reason). For
   multi-skill repos, verdict per skill — cherry-pick, never bulk-install.
7. **On approval, install**: copy into the chosen scope, verify the skill
   registers (frontmatter parses, name doesn't collide), and confirm with a
   one-line test of its trigger.

## Output
- Per-candidate verdict table: `Skill | Verdict | Why | Deps OK? | Overlaps`.
- After approval: installed files listed with paths, registration verified.

## Rules
- Never bulk-install a suite because one piece is useful.
- Prefer project-scope over global unless it's clearly useful everywhere.
- Note what to delete if the skill is later removed (leave no orphans).
