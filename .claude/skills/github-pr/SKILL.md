---
name: github-pr
description: |
  Create and manage GitHub pull requests. Supports both jujutsu (jj) and git
  version control. Use when submitting PRs, checking PR status, fixing review
  feedback, or merging PRs. Triggers on "submit pr", "create pr", "check pr",
  "fix review", "pr status", "merge pr".
---

# GitHub PR Workflow

## Detect VCS

First, determine which version control system is in use:

```bash
if [ -d ".jj" ]; then
  echo "jujutsu"
else
  echo "git"
fi
```

- **If `.jj` exists**: Read [references/jujutsu.md](references/jujutsu.md) for
  VCS-specific commands
- **Otherwise**: Read [references/git.md](references/git.md) for VCS-specific
  commands

## Pre-flight Checks

Run these checks before submitting any PR:

```bash
deno fmt --check
deno lint
deno run check:models
deno run test
```

Fix any issues before proceeding. All checks must pass.

If `deno fmt --check` fails, run `deno fmt` to auto-fix formatting, then re-run
the checks.

## Create PR

After pushing changes (see VCS reference), create the PR:

```bash
gh pr create --head <branch-or-bookmark> --base main --title "Title here" --body "$(cat <<'EOF'
## Summary

Brief description of changes.

## Test Plan

- How the changes were tested
EOF
)"
```

## Check Merge Status

To check if a PR is ready to merge:

```bash
# Check CI status
gh pr checks <pr-number>

# View PR details including review status
gh pr view <pr-number>
```

## Handle Blocking Reviews

When a PR has blocking review feedback:

1. Get the review comments:
   ```bash
   gh pr view <pr-number> --comments
   ```

2. Enter plan mode to analyze the feedback and plan fixes

3. Implement the fixes

4. Push updates (see VCS reference for push commands)

5. Re-request review if needed:
   ```bash
   gh pr edit <pr-number> --add-reviewer <username>
   ```

## Handle Suggestions

When reviewers provide non-blocking suggestions:

1. Get suggestions from the review:
   ```bash
   gh pr view <pr-number> --comments
   ```

2. Enter plan mode to evaluate each suggestion

3. Decide which suggestions to implement (discuss with user if unclear)

4. Implement approved suggestions and push

5. Respond to suggestions you chose not to implement with reasoning

## Merge PR

Once all checks pass and reviews are approved:

```bash
# Squash merge (preferred)
gh pr merge <pr-number> --squash --delete-branch

# Or merge commit
gh pr merge <pr-number> --merge --delete-branch
```
