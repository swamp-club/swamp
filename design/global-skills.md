# Global Skills

This document describes the design for moving swamp skills from per-repo local
copies to globally-installed, per-tool skill directories.

## Problem

Today, `swamp repo init` and `swamp repo upgrade` copy bundled skill files into
each repo's tool-specific directory (`.claude/skills/`, `.agents/skills/`,
`.kiro/skills/`, etc.). This has three problems:

1. **Staleness**: Upgrading the swamp binary does not update skills in existing
   repos. Users must run `swamp repo upgrade` in every repo individually.
2. **Duplication**: N repos = N copies of identical skill files.
3. **Repo clutter**: Generated skill files live alongside user code in version
   control.

## Solution

Install skills to each tool's **global (user-level)** directory instead of
per-repo project directories. Each AI tool has a native global skills path that
it reads at runtime:

| Tool     | Global skills path                       | Reads `~/.agents/skills/`? |
| -------- | ---------------------------------------- | -------------------------- |
| claude   | `~/.claude/skills/`                      | No                         |
| cursor   | reads from `~/.agents/skills/` directly  | Yes                        |
| opencode | reads from `~/.agents/skills/` directly  | Yes                        |
| codex    | reads from `~/.agents/skills/` directly  | Yes                        |
| copilot  | reads from `~/.agents/skills/` directly  | Yes                        |
| kiro     | `~/.kiro/skills/`                        | No                         |

Tools that read from `~/.agents/skills/` natively (Cursor, OpenCode, Codex,
Copilot) share a single copy. Claude Code and Kiro require their own copies at
their vendor-specific global paths.

### Global Skill Paths (Built-in Tools)

The `GLOBAL_SKILL_DIRS` mapping defines where swamp writes skills for each
built-in tool:

```typescript
const GLOBAL_SKILL_DIRS: Record<string, string> = {
  claude: "~/.claude/skills",
  cursor: "~/.agents/skills",
  opencode: "~/.agents/skills",
  codex: "~/.agents/skills",
  copilot: "~/.agents/skills",
  kiro: "~/.kiro/skills",
};
```

After deduplication, swamp writes to at most three directories:

- `~/.claude/skills/swamp/` and `~/.claude/skills/swamp-getting-started/`
- `~/.agents/skills/swamp/` and `~/.agents/skills/swamp-getting-started/`
- `~/.kiro/skills/swamp/` and `~/.kiro/skills/swamp-getting-started/`

### Custom Tools

Custom tools (defined via `swamp agent setup` / `.swamp-custom-tools.yaml`) gain
an optional `globalSkillsDir` field:

```typescript
interface CustomToolDefinition {
  name: string;
  skillsDir: string;            // project-local path (kept for instructions)
  globalSkillsDir?: string;     // global path, defaults to "~/.agents/skills"
  instructionsFile: string;
  instructionsMode: "shared" | "owned";
  frontmatter?: string;
  skillReferenceStyle: "name" | "path";
  gitignoreEntries?: string;
}
```

When `globalSkillsDir` is omitted, the tool is assumed to read from
`~/.agents/skills/` (the cross-tool convention). When set, swamp writes an
additional copy to that path.

The `swamp agent setup` wizard offers three choices for the global path:

1. Shared agents path (`~/.agents/skills/`) — default, works for most tools
2. Derived from tool name (`~/.<tool-name>/skills/`) — for tools with native
   paths
3. Custom path — user-specified

### What Changes in `repo init` / `repo upgrade`

Today these commands copy skills into the repo. Under the new model:

**`repo init`:**

1. Detect enrolled tools (same as today)
2. Write skills to each tool's **global** directory (deduplicated — write to
   `~/.agents/skills/` once even if codex + copilot + opencode are all enrolled)
3. Write instructions files to the **repo** (CLAUDE.md, AGENTS.md,
   `.cursor/rules/swamp.mdc`, `.kiro/steering/swamp-rules.md`) — these stay
   per-repo because they reference repo-specific context (model names,
   extensions, project purpose)
4. Write tool-specific settings/hooks to the **repo** (same as today)
5. Do **not** copy skills into repo tool directories
6. Version-stamp the global skills in SKILL.md frontmatter

**`repo upgrade`:**

1. Re-write global skills with the new binary's bundled versions
2. Update per-repo instructions files and settings/hooks
3. Run migration (see below) to remove local skill copies if present
4. Update `.swamp.yaml` version

### Version Stamping

Each installed SKILL.md gets a `swampVersion` field in its frontmatter:

```yaml
---
name: swamp
description: ...
swampVersion: "20260622.150000.0"
---
```

This is injected at install time from the running binary's version, matching the
existing CalVer format in `SwampVersion`. On upgrade, the CLI compares the
installed version against its own and overwrites if stale.

### Freshness Check

A lightweight version check runs on CLI startup for repo-scoped commands:

1. Read `swampVersion` from each enrolled tool's global skill SKILL.md
2. Compare against the running binary's version
3. If stale, emit a deferred warning:
   `WRN Global swamp skills are outdated (installed: X, current: Y). Run 'swamp repo upgrade' to update.`
4. Optionally auto-update (controlled by a config flag or `--auto-update-skills`)

This replaces the current superseded-skill detection which only catches renamed
skill directories.

## Migration: Local to Global

Users with existing repos have local skill copies in their tool directories.
These must be cleaned up to avoid conflicts (a project-level skill with the same
name as a global skill takes precedence in most tools, which would pin the user
to the stale local version).

### Detection

During `repo init` or `repo upgrade`, check each enrolled tool's **project-local
skill directory** for swamp-managed skill subdirectories (currently `swamp/` and
`swamp-getting-started/`):

```
.claude/skills/swamp/           ← local copy, should be removed
.claude/skills/swamp-getting-started/  ← local copy, should be removed
.agents/skills/swamp/           ← local copy, should be removed
.kiro/skills/swamp/             ← local copy, should be removed
```

### Persistent Migration Warning

Once a user upgrades to a CLI version that installs global skills, any repo that
still has local skill copies is in a conflict state — the local copies shadow the
global ones and the user is silently running stale skills. The CLI must make this
impossible to ignore.

**On every CLI invocation** in a repo with local skill copies, emit a warning:

```
WRN Swamp skills are now installed globally but this repo still has local
    copies that take precedence. Run 'swamp repo upgrade' to clean up.

    Local copies found:
      .claude/skills/swamp/
      .claude/skills/swamp-getting-started/
```

This warning fires **once per day per repo**. It is non-blocking (the command
still runs) but it is unavoidable on the first invocation of each day. It
persists until the user runs `swamp repo upgrade` in that repo and confirms
removal of the local copies.

The debounce is tracked via a `lastSkillMigrationWarning` timestamp in the
`.swamp.yaml` marker file. On each CLI invocation, if local copies are detected
and the timestamp is missing or older than 24 hours, the warning is emitted and
the timestamp is updated. This keeps the reminder visible without spamming
users who run many commands per day.

**During `swamp repo upgrade`**, for each enrolled tool with local copies:

```
Local swamp skills found in .claude/skills/swamp/ — these are now
installed globally at ~/.claude/skills/swamp/ and the local copies
take precedence, meaning this repo is using stale skills.

Remove local copies? [Y/n]
```

Note the default is **Y** (yes) — removal is the expected action. If the user
declines, the warning continues on every future CLI invocation.

If the local copy has been modified by the user (no `swampVersion` field or
content differs from any known bundled version), the prompt says so:

```
Local swamp skills in .claude/skills/swamp/ have been modified from
the bundled version. The global version will not include your
changes.

Remove local copies anyway? [y/N]
```

Note the default flips to **N** (no) for modified copies — don't destroy user
work without explicit intent.

### Migration Flow

```
Any CLI command in a repo:
  │
  ├─ Check for local bundled skill copies in enrolled tool dirs
  ├─ If found: emit persistent warning on every invocation
  └─ Continue with normal command execution

swamp repo upgrade:
  │
  ├─ For each enrolled tool:
  │   ├─ Resolve global skill dir for this tool
  │   ├─ Write/update skills to global dir (with version stamp)
  │   ├─ Check for local skill copies in repo
  │   │   ├─ If local copies found:
  │   │   │   ├─ Check if modified (compare to bundled versions)
  │   │   │   ├─ Prompt user to confirm removal
  │   │   │   │   (default Y for unmodified, default N for modified)
  │   │   │   ├─ If confirmed: delete local copies
  │   │   │   └─ If declined: leave in place, warning continues
  │   │   └─ If no local copy: nothing to do
  │   ├─ Update instructions file in repo (stays local)
  │   └─ Update settings/hooks in repo (stays local)
  │
  └─ Update .swamp.yaml version
```

### Extension-Installed Skills

Extensions can install skills via `swamp extension install`. These are separate
from the bundled swamp skills and are **not affected** by this migration.
Extension skills remain project-local since they are repo-specific (installed per
extension per repo).

The migration only targets skill directories matching the bundled skill names
(`swamp`, `swamp-getting-started`, and any future bundled skills listed in
`skill_assets.ts`).

### Backwards Compatibility

- Repos that haven't been upgraded continue to work — local skills still
  function, they're just stale.
- The freshness warning guides users to upgrade.
- `swamp repo upgrade` is idempotent — running it on an already-migrated repo
  is a no-op for the migration step.
- The `.swamp.yaml` marker version tracks whether migration has been applied.

### Gitignore Changes

Since bundled skills no longer live in the repo, the gitignore entries for skill
directories can be simplified or removed for the bundled skills. Extension skills
still need gitignore entries.

## What Stays Per-Repo

These files remain project-local because they contain repo-specific content:

- **Instructions files**: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/swamp.mdc`,
  `.kiro/steering/swamp-rules.md` — reference the repo's models, extensions, and
  project purpose
- **Settings/hooks**: `.claude/settings.local.json`, `.cursor/hooks.json`,
  `.kiro/hooks/`, `.opencode/plugins/`, `.github/hooks/` — contain
  repo-contextual configuration
- **Extension skills**: Installed by `swamp extension install`, scoped to the
  repo
- **`.swamp.yaml` marker**: Tracks repo version and enrolled tools

## Open Questions

1. **Auto-update on startup**: Should the CLI silently update global skills on
   every invocation (GitButler pattern), or only on explicit
   `swamp repo upgrade`? Auto-update is more convenient but means any CLI run
   could write to `~/`. A middle ground: auto-update with a flag to opt out.

2. **Concurrent writes**: Multiple swamp processes (in different repos) could try
   to update global skills simultaneously. Needs a file lock or atomic-write
   strategy.

3. **`swamp repo init` without `repo upgrade`**: Should `repo init` also update
   global skills, or only write them if missing? Currently `repo init` is the
   first entry point for new repos, so it should ensure global skills exist.

4. **Permissions**: Writing to `~/.claude/skills/` etc. requires the user's home
   directory to be writable. Should fail gracefully with a clear error if the
   directory is read-only or doesn't exist.

5. **`none` tool**: The `none` tool currently writes to
   `.swamp/pulled-extensions/skills/`. With global skills, it could either remain
   unchanged (only extensions use it) or be dropped.
