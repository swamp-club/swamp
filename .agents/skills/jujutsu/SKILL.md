---
name: jujutsu
description: Track changes, rebase modifications, resolve conflicts, and manage bookmarks with Jujutsu (jj). Use when committing changes, navigating history, squashing/splitting commits, or pushing to Git remotes.
---

# Jujutsu Cheatsheet

Jujutsu (JJ) is a Git-compatible VCS with a focus on concurrent development and ease of use.

## Key Commands

| Command | Description |
|---------|-------------|
| `jj st` | Show working copy status |
| `jj log` | Show change log |
| `jj diff` | Show changes in working copy |
| `jj new` | Create new change |
| `jj desc` | Edit change description |
| `jj squash` | Move changes to parent |
| `jj split` | Split current change |
| `jj rebase -s src -d dest` | Rebase changes |
| `jj absorb` | Move changes into stack of mutable revisions |
| `jj bisect` | Find bad revision by bisection |
| `jj fix` | Update files with formatting fixes |
| `jj sign` | Cryptographically sign a revision |
| `jj metaedit` | Modify metadata without changing content |

## Project Setup

```bash
jj git init              # Init in existing git repo
jj git init --colocate   # Side-by-side with git
```

## Basic Workflow

```bash
jj new                   # Create new change
jj desc -m "feat: add feature"  # Set description
jj log                   # View history
jj edit change-id        # Switch to change
jj new --before @        # Time travel (create before current)
jj edit @-               # Go to parent
```

## Time Travel

```bash
jj edit change-id        # Switch to specific change
jj next --edit           # Next child change
jj edit @-               # Parent change
jj new --before @ -m msg # Insert before current
```

## Merging & Rebasing

```bash
jj new x yz -m msg       # Merge changes
jj rebase -s src -d dest # Rebase source onto dest
jj abandon              # Delete current change
```

## Conflicts

```bash
jj resolve              # Interactive conflict resolution
# Edit files, then continue
```

## Templates & Revsets

```bash
jj log -T 'commit_id ++ "\n" ++ description'
jj log -r 'heads(all())'    # All heads
jj log -r 'remote_bookmarks()..'  # Not on remote
jj log -r 'author(name)'    # By author
```

## Git Interop

```bash
jj bookmark create main -r @  # Create bookmark
jj git push --bookmark main   # Push bookmark
jj git fetch                 # Fetch from remote
jj bookmark track main@origin # Track remote
```

## Advanced Commands

```bash
jj absorb               # Auto-move changes to relevant commits in stack
jj bisect start         # Start bisection
jj bisect good          # Mark current as good
jj bisect bad           # Mark current as bad
jj fix                  # Run configured formatters on files
jj sign -r @            # Sign current revision
jj metaedit -r @ -m "new message"  # Edit metadata only
```

## Tips

- No staging: changes are immediate
- Use conventional commits: `type(scope): desc`
- `jj undo` to revert operations
- `jj op log` to see operation history
- Bookmarks are like branches
- Concurrent development encouraged
- `jj absorb` is powerful for fixing up commits in a stack