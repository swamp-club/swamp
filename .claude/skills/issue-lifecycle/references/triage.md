# Triage Phase

Steps 1–5 of the issue lifecycle. Read this when starting a new triage or
resuming an issue in the `triaging` phase.

## Before You Start

Check whether the model instance already exists and is past triage:

```
swamp data get issue-<N> state-main --json
```

- If this **returns data** and the `phase` is anything other than `created` or
  `triaging`, the issue is already in flight. **Do NOT call `start`** — go to
  the "Resuming a Session" section in SKILL.md and use the phase-to-action table
  to pick up where the issue left off.
- If the command **fails** (no data found), the model instance hasn't been
  created yet — proceed with step 1 below.

## 1. Create the Model Instance

The swamp-club issue must already exist — create it in the swamp-club UI first,
then note its sequential number (e.g. `42`).

```
swamp model create @swamp/issue-lifecycle issue-<N> \
  --global-arg issueNumber=<N> --json
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

> **Warning:** `start` unconditionally resets the phase to `triaging`. Only call
> it once when beginning a new lifecycle. Never use it to resume an in-progress
> issue — it will destroy all progress (classification, plan, approvals).

This fetches the issue from swamp-club via `GET /api/v1/lab/issues/<N>` and
writes the title, body, type, status, and comments to the `context` resource. If
the issue doesn't exist in swamp-club, `start` fails loudly — create the issue
there first.

## 3. Read the Issue Context and Codebase

Read the model output, then explore the codebase.

Read `agent-constraints/triage-conventions.md` at the repo root for how to
explore this codebase. If it does not exist, start with `CLAUDE.md` and explore
source files related to the issue. Check for regression signals: use `git log`
on affected files to see if they were recently changed.

## 4. Classify the Issue

```
swamp model method run issue-<N> triage \
  --input type=<bug|feature|security> \
  --input confidence=<high|medium|low> \
  --input reasoning="<your analysis>"
```

**Classification guidance:**

- `bug` — something is broken or behaving incorrectly
- `feature` — a request for new functionality or enhancement
- `security` — security vulnerability, hardening, or compliance work

Add `--input isRegression=true` when the bug previously worked. Look for signals
like: "this used to work", "stopped working after", "worked in version X",
references to recent changes that broke existing behavior, or git history
showing the affected code was recently modified. A regression is still
classified as `type: bug` — `isRegression` is a detail on the classification
record.

**If you cannot classify confidently**, do NOT guess. Ask the human first, or
call `triage` with `confidence=low` and `clarifyingQuestions` populated, then
wait for the human's response before moving on.

Running `triage` automatically:

- Updates the swamp-club issue's `type` field via PATCH
- Transitions the swamp-club status to `triaged`
- Posts a `classified` lifecycle entry with the full classification payload

## 5. Reproduce the Bug

**Bugs and regressions only — skip for features and security issues.**

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
