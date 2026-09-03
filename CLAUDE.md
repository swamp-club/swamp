@AGENTS.md

## Workflows (Claude Code)

Do NOT interpret workflow requests as a request to build a Claude Code agent
task list, spin up worktrees, or schedule a cron/remote agent. Only reach for
the harness orchestration tools (TaskCreate/TaskList, EnterWorktree, CronCreate,
RemoteTrigger) when the user explicitly names that mechanism (e.g. "task list",
"subagent", "worktree", "cron", "remote agent") or explicitly asks you to do the
work yourself step by step rather than author a swamp workflow.

## Skills

Skills live in `.claude/skills/<skill-name>/`.

IMPORTANT: Before creating or modifying ANY skill file, you MUST load the
`skill-creator` skill first. Do not skip this step — it contains the
authoritative guidelines for structure, frontmatter, and progressive disclosure.
This is a hard prerequisite, not a suggestion.

Repo-specific rules on top of skill-creator's guidance:

- `SKILL.md` must be uppercase — not `skill.md`.
- After editing any `.md` file in `.claude/skills/`, run `deno fmt` — skill
  markdown follows the same formatting rules as all other files in this
  repository.

After creating or modifying a skill, verify it before submitting:

- `npx tessl skill review .claude/skills/<skill-name>` — quality review of the
  description and content; aim for an average score ≥ 90%. CI enforces that
  threshold for the bundled skills (`swamp`, `swamp-getting-started`) via
  `deno run review-skills`; for other skills it is good hygiene, not a gate.
- `deno run eval-skill-triggers` — promptfoo trigger-routing evals for the
  bundled skills (needs `ANTHROPIC_API_KEY`); run when a bundled skill's
  description or `trigger_evals.json` changed.

See `contributing/skills-pipeline.md` for the full skill testing pipeline.

## Session Learnings (Claude Code)

If you hit a non-obvious problem during a session — something that wasted time,
caused a wrong approach, or revealed a convention not documented here — propose
an update to CLAUDE.md or the relevant skill before finishing. Only capture
things that would trip up future sessions, not one-off issues. Frame learnings
as positive conventions (what to do) rather than reactive rules (what not to
do).
