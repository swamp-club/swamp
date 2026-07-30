# Triage Phase

Steps 1–4 of the issue lifecycle. Read this when starting a new triage or
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

## 1. Start the Lifecycle

The swamp-club issue must already exist — create it in the swamp-club UI first,
then note its sequential number (e.g. `42`).

```
swamp model @swamp/issue-lifecycle method run start issue-<N> --input issueNumber=<N>
```

This uses direct type execution to auto-create the model definition and run
`start` in a single command. The definition is stored in
`.swamp/auto-definitions/` (not `models/`).

> **Warning:** `start` unconditionally resets the phase to `triaging`. Only call
> it once when beginning a new lifecycle. Never use it to resume an in-progress
> issue — it will destroy all progress (classification, plan, approvals).

`start` fetches the issue from swamp-club via `GET /api/v1/lab/issues/<N>` and
writes the title, body, type, status, and comments to the `context` resource. If
the issue doesn't exist in swamp-club, `start` fails loudly — create the issue
there first.

**Worktree note:** If you are in a Claude Code worktree (`.claude/worktrees/`),
the worktree is not an initialized swamp repository. Add
`--repo-dir <path-to-main-repo>` to all `swamp` commands, where the main repo is
the parent of the `.claude/worktrees/` directory. All subsequent `swamp`
commands in this skill also need `--repo-dir`.

### Auto-assignment

`start` automatically assigns the issue to you in swamp-club. It reads your
username from local auth (`~/.config/swamp/auth.json`, written by
`swamp auth login`), resolves it to a userId via the eligible-assignees
endpoint, and PATCHes the issue's assignees. Existing assignees are preserved
(additive). If assignment fails for any reason (missing credentials, lookup
error, API failure), `start` still succeeds — it logs a warning and continues
with triage.

## 2. Read the Issue Context and Codebase

Read the model output, then explore the codebase.

Read `agent-constraints/triage-conventions.md` at the repo root for how to
explore this codebase. If it does not exist, start with `CLAUDE.md` and explore
source files related to the issue. Check for regression signals: use `git log`
on affected files to see if they were recently changed.

## 3. Classify the Issue

```
swamp model @swamp/issue-lifecycle method run triage issue-<N> \
  --input type=<bug|feature|platform|security> \
  --input confidence=<high|medium|low> \
  --input reasoning="<your analysis>"
```

**Classification guidance:**

- `bug` — something is broken or behaving incorrectly
- `feature` — a request for new functionality or enhancement
- `platform` — admin-only platform infrastructure work
- `security` — security vulnerability, hardening, or compliance work

**Regression classification requires adversarial verification.** If you believe
the issue is a regression, you MUST complete the following before calling
`triage`:

1. **Gather evidence FOR regression**: Find concrete proof it previously worked
   — a commit where the behavior was correct, a version where it passed, test
   output, or a git bisect result. Vague signals like "this used to work" from
   the issue author are not sufficient on their own — corroborate with code
   history.

2. **Argue AGAINST regression**: Construct the strongest case that this is NOT a
   regression. Ask yourself: "Did this ever actually work correctly, or was it
   always broken and just unnoticed?" Consider: the feature was never shipped,
   docs were stale, the behavior was never tested, the reporter may be
   misremembering, or the expected behavior changed intentionally.

3. **Reach a verdict**: Weigh both sides. If the evidence survives the
   challenge, the verdict is `confirmed`. If the counter-argument is stronger,
   the verdict is `downgraded` — it's a plain bug, not a regression. Present
   both sides and your verdict to the human before calling `triage`.

4. **Pass all four regression fields** to the `triage` command:
   ```
   --input isRegression=true \
   --input regressionEvidence="<concrete proof it previously worked>" \
   --input regressionCounterEvidence="<strongest case it is NOT a regression>" \
   --input regressionVerdict=<confirmed|downgraded> \
   --input regressionVerdictReasoning="<why the verdict holds>"
   ```
   The `triage` method will reject the call if any of these four fields are
   missing when `isRegression=true`. If the verdict is `downgraded`, the method
   automatically sets `isRegression=false` in the classification record and the
   swamp-club lifecycle entry — no regression data is sent upstream.

When `regressionVerdict=confirmed`, also provide
`--input regressionIntroducedIn=<version>`. Check `git log` on the affected
files and cross-reference with recent releases to identify which version
introduced the breakage. If the introducing version cannot be determined, omit
the field.

Marking a regression means our pipeline failed to catch a breakage — we must be
very sure before sending that signal.

**If you cannot classify confidently**, do NOT guess. Ask the human first, or
call `triage` with `confidence=low` and `clarifyingQuestions` populated, then
wait for the human's response before moving on.

Running `triage` automatically:

- Updates the swamp-club issue's `type` field via PATCH
- Transitions the swamp-club status to `triaged`
- Posts a `classified` lifecycle entry with the full classification payload

## 4. Reproduce the Bug

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
