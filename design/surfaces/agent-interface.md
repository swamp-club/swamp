---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Global Skills

This document describes how swamp installs its bundled skills (`swamp`,
`swamp-getting-started`) into each AI tool's **global (user-level)** skills
directory, and what stays per-repo.

## Background

Earlier versions of `swamp repo init` and `swamp repo upgrade` copied the
bundled skill files into each repo's tool-specific directory
(`.claude/skills/`, `.agents/skills/`, `.kiro/skills/`, etc.). That meant
skills went stale whenever the binary was upgraded without re-running
`repo upgrade` in every repo, N repos held N identical copies, and generated
files sat in version control next to user code.

Built-in tools now receive skills only in their global directories
(`RepoService.installGlobalSkills` in `src/domain/repo/repo_service.ts`);
no per-repo copy is written for them.

## Global Skill Paths (Built-in Tools)

Each AI tool has a native global skills path that it reads at runtime:

| Tool     | Global skills path                       | Reads `~/.agents/skills/`? |
| -------- | ---------------------------------------- | -------------------------- |
| amp      | reads from `~/.agents/skills/` directly  | Yes                        |
| claude   | `~/.claude/skills/`                      | No                         |
| cursor   | reads from `~/.agents/skills/` directly  | Yes                        |
| opencode | reads from `~/.agents/skills/` directly  | Yes                        |
| codex    | reads from `~/.agents/skills/` directly  | Yes                        |
| copilot  | reads from `~/.agents/skills/` directly  | Yes                        |
| kiro     | `~/.kiro/skills/`                        | No                         |
| pi       | `~/.pi/agent/skills/`                    | Yes                        |

Tools that read from `~/.agents/skills/` natively (Amp, Cursor, OpenCode, Codex,
Copilot, Pi) share a single copy. Claude Code and Kiro require their own copies
at their vendor-specific global paths. Pi also reads from its own
`~/.pi/agent/skills/` directory.

The `GLOBAL_SKILL_DIRS` mapping in `src/domain/repo/skill_dirs.ts` defines
the home-relative path per built-in tool:

```typescript
export const GLOBAL_SKILL_DIRS: Record<string, string> = {
  amp: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".agents/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  copilot: ".agents/skills",
  kiro: ".kiro/skills",
  pi: ".pi/agent/skills",
};
```

`resolveUniqueGlobalSkillsDirs(tools)` resolves these against the home
directory and deduplicates, so a repo enrolled for codex + copilot + opencode
writes `~/.agents/skills/` once. After deduplication swamp writes to at most
four directories: `~/.claude/skills/`, `~/.agents/skills/`,
`~/.kiro/skills/`, and `~/.pi/agent/skills/`, each holding `swamp/` and
`swamp-getting-started/`.

The `none` tool has no global directory; skill directory resolution for it
(and for unknown tools) falls back to `.swamp/pulled-extensions/skills/`,
which only extension-installed skills use.

## Skill Reference Style

All built-in tools use `skillReferenceStyle: "name"`, meaning generated
instructions files (CLAUDE.md, AGENTS.md, `.cursor/rules/swamp.mdc`,
`.kiro/steering/swamp-rules.md`) reference skills by name (e.g. "use the
`swamp` skill") rather than by project-local path. This is required because
skills are installed globally — project-local skill directories do not exist
after init, so path-based references would dangle.

Custom tools may use either `"name"` or `"path"`. Tools with `"path"` style
must install skills to a project-local directory or provide a mechanism for
the agent to resolve the referenced paths.

## Custom Tools

Custom tools are defined via `swamp agent setup` and stored in
`.swamp-custom-tools.yaml`. `CustomToolDefinition`
(`src/domain/repo/custom_tool.ts`) has a single `skillsDir` field — there is
no separate global-vs-local field. Global intent is inferred from the path:

- A home-relative `skillsDir` (starting with `~/`) is a global skill
  directory. During `repo init` and `repo upgrade`, swamp expands the `~/`
  prefix, copies bundled skills to the resolved path, and registers the
  absolute path in `~/.config/swamp/custom-tool-skill-dirs.json` so the
  repo-less `swamp update` command can find it later.
- A repo-relative `skillsDir` (e.g. `.agents/skills/`) is project-local. Swamp
  resolves it against the repo root and copies bundled skills there during
  `repo init` / `repo upgrade`, but does not register it — `swamp update`
  runs without repo context and cannot sync it.

The `swamp agent setup` wizard (`src/cli/commands/agent_setup.ts`) builds the
skills-directory choices with `buildSkillsDirChoices()`: the default derived
from the tool name, the tool's detected `skillsDir` (if the tool was found on
disk), `<configDir>/skills` (if a config directory was detected), plus an
"Other path" free-text option. When only the derived default is available,
the wizard offers it inline with Enter-to-accept.

## What `repo init` / `repo upgrade` Write

**`repo init`:**

1. Detect enrolled tools.
2. Write skills to each enrolled built-in tool's global directory
   (deduplicated — `~/.agents/skills/` is written once even if amp, codex, copilot and opencode are all enrolled) and to each custom tool's `skillsDir`.
3. Register the built-in global directories in
   `~/.config/swamp/builtin-tool-skill-dirs.json` and `~/`-prefixed custom
   directories in `custom-tool-skill-dirs.json`.
4. Write instructions files to the **repo** (CLAUDE.md, AGENTS.md,
   `.cursor/rules/swamp.mdc`, `.kiro/steering/swamp-rules.md`) — these stay
   per-repo because they reference repo-specific context.
5. Write tool-specific settings/hooks to the **repo**.
6. Do **not** copy skills into repo tool directories for built-in tools.

**`repo upgrade`:**

1. Re-write global skills with the new binary's bundled versions.
2. Update per-repo instructions files and settings/hooks.
3. Detect and warn about local skill copies (see below).
4. Update `.swamp.yaml` version.

Skill files are copied as bundled from the asset list in
`src/infrastructure/assets/skill_assets.ts`; there is no version stamp in the
installed SKILL.md frontmatter.

## Keeping Global Skills Current

Global skills are synced in three places:

1. **`swamp update`** (`src/cli/commands/update.ts`) — after the binary is
   updated (interactive and background), skills are written to the
   directories in both registries. Built-in entries whose directory does not
   exist on disk are skipped; custom entries whose directory does not exist
   are pruned from the registry. Directories outside the home directory are
   skipped. If no built-in registry file exists (pre-registry CLI version), a
   heuristic fallback syncs to all built-in directories that already exist on
   disk. The sync is refused when running as root (a warning tells the user
   to run `swamp update` without sudo or `swamp repo upgrade` in a repo), so
   files under `~/` never end up root-owned.
2. **`swamp repo init`** — writes global skills as part of first-time setup.
3. **`swamp repo upgrade`** — writes global skills as part of the upgrade
   flow.

Skills are not synced on ordinary CLI startup; this avoids writing to `~/`
on arbitrary invocations. The bundled skill files in the binary are the
source of truth and the sync is idempotent — concurrent syncs from several
repos produce the same result. Failures during sync (permissions, disk full)
log a warning and do not block the update or command.

### Registries

Both registries are simple JSON arrays of absolute directory paths under
`~/.config/swamp/`:

- `builtin-tool-skill-dirs.json` — additive; initializing multiple repos
  with different tools unions their directories. If the file exists but is
  empty (no built-in tools enrolled anywhere), `swamp update` syncs no
  built-in directories.
- `custom-tool-skill-dirs.json` — `~/`-prefixed custom tool directories.

## Local Copies Shadowing Global Skills

Repos initialized before global installation still hold local skill copies.
Most tools give a project-level skill precedence over a global one with the
same name, so a stale local copy pins the user to old skills.

`repo init` and `repo upgrade` run `detectLocalBundledSkills()`
(`src/domain/repo/repo_service.ts`) over each enrolled tool's project-local
skill directory, looking for subdirectories matching the bundled skill names
(`swamp`, `swamp-getting-started`). Any found are reported by the repo-init
renderer (`src/presentation/renderers/repo_init.ts`):

```
WRN Local copies of swamp, swamp-getting-started are shadowing the globally installed skills.
    Delete them manually:
      .claude/skills/swamp
      .claude/skills/swamp-getting-started
```

Local copies are never deleted automatically. For repos that intentionally
keep local skills (e.g. the swamp source repo), set
`skillMigrationDismissed: true` in `.swamp.yaml` to suppress the warning.
The older `lastSkillMigrationWarning` / `lastStalenessWarning` marker fields
are legacy runtime state and are stripped on the next marker write.

A separate, startup-time warning covers **superseded** skill directories
(old per-topic skills consolidated into the bundled `swamp` skill); see
[repo.md](./repo.md#superseded-skill-detection).

### Extension-Installed Skills

Extensions install skills via `swamp extension install`. These are separate
from the bundled swamp skills, remain project-local (installed per extension
per repo), and are not touched by the local-copy detection.

## What Stays Per-Repo

These files remain project-local because they contain repo-specific content:

- **Instructions files**: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/swamp.mdc`,
  `.kiro/steering/swamp-rules.md` — reference the repo's models, extensions,
  and project purpose
- **Settings/hooks**: `.claude/settings.local.json`, `.cursor/hooks.json`,
  `.kiro/hooks/`, `.kiro/agents/`, `.kiro/settings/cli.json`,
  `.vscode/settings.local.json` (Kiro trusted commands),
  `.opencode/plugins/`, `.github/hooks/` — contain repo-contextual
  configuration
- **Extension skills**: Installed by `swamp extension install`, scoped to the
  repo
- **`.swamp.yaml` marker**: Tracks repo version and enrolled tools
