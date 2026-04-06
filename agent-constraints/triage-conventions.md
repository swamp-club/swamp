# Triage Conventions

## Codebase Exploration

When triaging an issue, read:

- `CLAUDE.md` and `design/*.md` for project conventions and architecture
- Relevant skills (especially `ddd/SKILL.md`) for domain context
- Source files related to the issue
- **Check for regression signals**: If the issue describes a bug, use `git log`
  on the affected files to see if they were recently changed. Check if the
  described behavior worked in a prior version. This informs whether to classify
  as `bug` or `regression`.

## Bug Reproduction

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
swamp repo init
```

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
