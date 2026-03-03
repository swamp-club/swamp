# Jujutsu VCS Commands

Jujutsu automatically tracks changes, so no explicit staging is needed.

## Review Changes

```bash
# View change summary
jj diff --stat

# View current change details
jj log -r @

# View full diff
jj diff
```

## Describe Changes

```bash
jj describe -m "feat: add new feature

Detailed description of the changes."
```

## Create Bookmark and Push

For a new PR:

```bash
# Create a bookmark pointing to current change
jj bookmark create <feature-name> -r @

# Push the bookmark to origin
jj git push --bookmark <feature-name>
```

## Update Existing PR

When updating after review feedback:

```bash
# Changes are auto-tracked, just describe if needed
jj describe -m "Updated message if changed"

# Push updates (bookmark already exists)
jj git push --bookmark <feature-name>
```

## After Merge

Clean up after PR is merged:

```bash
# Fetch latest from remote
jj git fetch

# Rebase onto main
jj rebase -d main
```
