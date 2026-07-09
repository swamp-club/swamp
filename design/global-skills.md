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

### Keeping Global Skills Current

Global skills are synced automatically in three places:

1. **`swamp update`** — after the binary is updated (interactive and background),
   skills are written to enrolled global tool directories. For built-in tools,
   directories registered in `~/.config/swamp/builtin-tool-skill-dirs.json` are
   synced (see below). For custom tools, directories registered in
   `custom-tool-skill-dirs.json` are synced (see below). Stale registry entries
   for deleted directories are pruned automatically. If no built-in registry
   file exists (pre-registry CLI version), a heuristic fallback syncs to all
   built-in directories that already exist on disk.
2. **`swamp repo init`** — writes global skills as part of first-time setup.
   Creates built-in tool directories and custom tool global directories.
3. **`swamp repo upgrade`** — writes global skills as part of the upgrade flow.
   Creates built-in tool directories and custom tool global directories.

The bundled skill files in the binary are the source of truth. The sync is
idempotent — writing the same content is harmless. Failures during sync (e.g.,
permissions, disk full) log a warning and do not block the update or command.

### Custom Tool Global Skills

Custom tools (defined via `swamp agent setup` / `.swamp-custom-tools.yaml`) with
a home-relative `skillsDir` (starting with `~/`) are treated as global skill
directories. During `repo init` and `repo upgrade`, swamp expands the `~/`
prefix, copies bundled skills to the resolved path, and registers the absolute
path in `~/.config/swamp/custom-tool-skill-dirs.json`.

This registry bridges the gap between repo-scoped custom tool configuration and
the repo-less `swamp update` command. Without it, `swamp update` has no way to
discover custom tool directories.

The registry is a simple JSON array of absolute directory paths:

```json
["/home/user/.pi/agent/skills", "/home/user/.foo/skills"]
```

Custom tools with repo-relative `skillsDir` (not `~/`-prefixed) are not
registered — those are project-local directories, not global skill targets.

> **Note:** The original design proposed a separate `globalSkillsDir` field on
> `CustomToolDefinition`. The current implementation infers global intent from
> the `~/` prefix on the existing `skillsDir` field instead. This is simpler and
> covers the common case. The `globalSkillsDir` field can be added later if
> finer-grained control is needed.

### Built-in Tool Global Skills Registry

Built-in tools (claude, cursor, opencode, codex, copilot, kiro) use a parallel
registry at `~/.config/swamp/builtin-tool-skill-dirs.json`. During `repo init`
and `repo upgrade`, swamp registers the resolved global skill directories for
each enrolled built-in tool. The registry is additive — initializing multiple
repos with different tools unions their directories.

The registry is a simple JSON array of absolute directory paths:

```json
["/home/user/.claude/skills", "/home/user/.agents/skills"]
```

When `swamp update` runs, it reads this registry to determine which built-in
directories to sync. If the registry file does not exist (pre-registry CLI
version or no repo has been initialized), `swamp update` falls back to a
directory-existence heuristic for backwards compatibility. If the registry
exists but is empty (user has no built-in tools enrolled), no built-in
directories are synced.

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

### Migration Warning

Once a user upgrades to a CLI version that installs global skills, any repo that
still has local skill copies is in a conflict state — the local copies shadow the
global ones and the user may be running stale skills.

**On CLI startup** (once per day per repo), if local bundled skill copies are
detected:

```
WRN Swamp skills are now installed globally but this repo still has local
    copies that take precedence. Run 'swamp repo upgrade' to clean up.

    Local copies found:
      .claude/skills/swamp/
      .claude/skills/swamp-getting-started/
```

The debounce is tracked via a `lastSkillMigrationWarning` timestamp in the
`.swamp.yaml` marker file. The warning persists until the user deletes the
local copies manually.

**During `swamp repo upgrade`**, local copies are detected and reported:

```
WRN Local copies of swamp, swamp-getting-started are shadowing the globally installed skills.
    Delete them manually:
      .claude/skills/swamp
      .claude/skills/swamp-getting-started
```

For repos that intentionally keep local skills (e.g., the swamp source repo),
set `skillMigrationDismissed: true` in `.swamp.yaml` to suppress the warning.

### Migration Flow

```
Any CLI command in a repo:
  │
  ├─ Check for local bundled skill copies in enrolled tool dirs
  ├─ If found and not dismissed: emit warning (once per day)
  └─ Continue with normal command execution

swamp repo upgrade:
  │
  ├─ For each enrolled tool:
  │   ├─ Resolve global skill dir for this tool
  │   ├─ Write/update skills to global dir
  │   ├─ Check for local skill copies in repo
  │   │   ├─ If found: warn user to delete manually
  │   │   └─ If no local copy: clear migration marker fields
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

1. ~~**Auto-update on startup**~~ — **Resolved**: skills sync during
   `swamp update`, not on every CLI startup. This avoids writing to `~/` on
   arbitrary invocations while keeping skills in sync with the binary. The
   `repo init` and `repo upgrade` paths also sync as before.

2. **Concurrent writes**: Multiple swamp processes (in different repos) could try
   to update global skills simultaneously. Mitigated by the sync being idempotent
   — concurrent writes produce the same result.

3. **`swamp repo init` without `repo upgrade`**: Should `repo init` also update
   global skills, or only write them if missing? Currently `repo init` is the
   first entry point for new repos, so it should ensure global skills exist.

4. ~~**Permissions**~~ — **Resolved**: sync catches errors and logs a warning
   without blocking the update or command.

5. **`none` tool**: The `none` tool currently writes to
   `.swamp/pulled-extensions/skills/`. With global skills, it could either remain
   unchanged (only extensions use it) or be dropped.
