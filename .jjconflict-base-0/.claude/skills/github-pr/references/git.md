# Git VCS Commands

## Review Changes

```bash
# View change summary
git diff --stat

# View status
git status

# View full diff
git diff
```

## Create Branch (If Needed)

Check if already on a feature branch:

```bash
current_branch=$(git branch --show-current)
if [ "$current_branch" = "main" ] || [ "$current_branch" = "master" ]; then
  # On main branch, need to create feature branch
  git checkout -b <feature-name>
fi
# Otherwise already on feature branch, skip creation
```

## Stage and Commit

```bash
# Stage all changes
git add -A

# Commit with message
git commit -m "feat: add new feature

Detailed description of the changes."
```

## Push

For a new PR:

```bash
# Push and set upstream
git push -u origin <branch-name>
```

## Update Existing PR

When updating after review feedback:

```bash
# Stage and commit changes
git add -A
git commit -m "fix: address review feedback"

# Push updates
git push
```

## After Merge

Clean up after PR is merged:

```bash
# Switch to main
git checkout main

# Pull latest
git pull

# Delete local feature branch
git branch -d <feature-name>
```
