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

## Create PR

In this repository the PR is opened by the `submit-change` workflow, not by
`gh pr create`. The workflow verifies, generates the attestation from its own
run record, publishes it, pushes the verified commit and opens the PR with the
attestation id as an input — so a PR with no attestation behind it cannot be
expressed. `link_pr` also rejects one, as a backstop for the manual path.

Run it with the title and body you would otherwise have passed to `gh`:

```bash
cat > /tmp/pr-body.yaml <<'EOF'
prBody: |
  ## Summary

  Brief description of changes.

  ## Test Plan

  - How the changes were tested
EOF

SWAMP_WORKFLOWS_DIR=verification swamp workflow run submit-change \
  --input commit=$(git rev-parse HEAD) \
  --input branch=$(git branch --show-current) \
  --input issue=<N> \
  --input prTitle="Title here" \
  --input-file /tmp/pr-body.yaml
```

Do not push by hand first — the run pushes `<commit>:refs/heads/<branch>` so the
pushed tip is the commit the attestation names.

Do not run lint/test/fmt manually as a pre-PR gate; the run covers all checks.
See `agent-constraints/verification-conventions.md` and the `issue-lifecycle`
skill's [verification reference](../issue-lifecycle/references/verification.md)
for the full flow, including the boolean inputs for re-running a subset.

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
