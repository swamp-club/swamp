# Triage Phase

Steps 1–5 of the issue lifecycle. Read this when starting a new triage or
resuming an issue in the `triaging` phase.

## 1. Create the Model Instance

If it doesn't already exist:

```
swamp model create @swamp/issue-lifecycle issue-<N> \
  --global-arg issueNumber=<N> \
  --global-arg repo=<owner/repo> --json
```

**Worktree note:** If you are in a Claude Code worktree (`.claude/worktrees/`),
the worktree is not an initialized swamp repository. Add
`--repo-dir <path-to-main-repo>` to all `swamp` commands, where the main repo is
the parent of the `.claude/worktrees/` directory. All subsequent `swamp`
commands in this skill also need `--repo-dir`.

## 2. Fetch the Issue Context

```
swamp model method run issue-<N> start
```

## 3. Read the Issue Context and Codebase

Read the model output, then explore the codebase.

Read `agent-constraints/triage-conventions.md` at the repo root for how to
explore this codebase. If it does not exist, start with `CLAUDE.md` and explore
source files related to the issue. Check for regression signals: use `git log`
on affected files to see if they were recently changed.

## 4. Classify the Issue

```
swamp model method run issue-<N> triage \
  --input type=<bug|feature|regression|unclear> \
  --input confidence=<high|medium|low> \
  --input reasoning="<your analysis>"
```

**Classification guidance:**

- `bug` — something is broken or behaving incorrectly
- `feature` — a request for new functionality or enhancement
- `regression` — a bug where something **previously worked** but is now broken.
  Look for signals like: "this used to work", "stopped working after", "worked
  in version X", references to recent changes that broke existing behavior, or
  git history showing the affected code was recently modified. Regressions get
  both `bug` and `regression` labels.
- `unclear` — not enough information to classify confidently

## 5. Reproduce the Bug

**Bugs and regressions only — skip for features.**

Before planning a fix, reproduce the issue to confirm the failure mode.

Read `agent-constraints/triage-conventions.md` for repo-specific reproduction
steps. If it does not exist, create a minimal reproduction in `/tmp/` using the
project's standard tooling.

If the bug **cannot be reproduced**, note that in the plan. It may mean the
issue description is incomplete, the bug is environment-specific, or the
underlying code has already changed. Ask the human how to proceed.

## Next Phase

Triage is complete. Read [planning.md](planning.md) to generate the
implementation plan.
