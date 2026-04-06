# Triage Phase

Steps 1–5 of the issue lifecycle. Read this when starting a new triage or
resuming an issue in the `triaging` phase.

## 1. Create the Model Instance

If it doesn't already exist:

```
swamp model create @si/issue-lifecycle issue-<N> \
  --global-arg issueNumber=<N> --json
```

The repo defaults to `systeminit/swamp`. Override with
`--global-arg repo=<owner/repo>` for other repositories.

## 2. Fetch the Issue Context

```
swamp model method run issue-<N> start
```

## 3. Read the Issue Context and Codebase

Read the model output, then explore the codebase:

- Read `CLAUDE.md` and `design/*.md`
- Read relevant skills (especially `ddd/SKILL.md`)
- Explore source files related to the issue
- Trace code paths to understand the problem
- **Check for regression signals**: If the issue describes a bug, use `git log`
  on the affected files to see if they were recently changed. Check if the
  described behavior worked in a prior version. This informs whether to classify
  as `bug` or `regression`.

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

Before planning a fix, reproduce the issue in an isolated scratch repo to
confirm the failure mode and understand it firsthand.

a. **Ensure swamp is up to date:**

```
swamp update
```

b. **Create a scratch repo:**

```
mkdir -p /tmp/swamp-repro-issue-<N>
cd /tmp/swamp-repro-issue-<N>
SWAMP_MODELS_DIR=$REPO_ROOT/extensions/models swamp repo init
```

where `$REPO_ROOT` is the absolute path captured during Phase 0 environment
setup. All subsequent `swamp` commands in the scratch repo must also include the
`SWAMP_MODELS_DIR` prefix so dev extension models are available and their
imports resolve correctly.

c. **Build a minimal reproduction.** Based on the issue description and your
codebase analysis, create the simplest set of models and/or workflows that
trigger the bug. Use an Agent (subagent) to do this — give it the issue context,
the error description, and tell it to create and run a swamp scenario that
reproduces the problem. The agent should:

- Create model definitions and workflow YAML files
- Create any required input data
- Run the workflow or model method that triggers the issue
- Capture the exact error output or incorrect behavior

d. **Document what you observed.** Before moving to planning, record:

- The exact commands that reproduce the issue
- The actual output/error (copy it verbatim)
- The expected output/behavior
- Any differences from what the issue originally described

e. **Keep the scratch repo.** You'll reuse it in the verification step after the
fix is implemented. The path `/tmp/swamp-repro-issue-<N>` must survive until
verification is complete.

If the bug **cannot be reproduced**, note that in the plan. It may mean the
issue description is incomplete, the bug is environment-specific, or the
underlying code has already changed. Ask the human how to proceed.

## Next Phase

Triage is complete. Read [planning.md](planning.md) to generate the
implementation plan.
