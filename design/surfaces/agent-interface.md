---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Global Skills

How swamp installs its bundled skills (`swamp`, `swamp-getting-started`) into
each AI tool's **global (user-level)** skills directory, and what stays per
repo.

## Background

`swamp repo init` and `swamp repo upgrade` used to copy the bundled skills into
each repo's tool directory (`.claude/skills/`, `.agents/skills/`,
`.kiro/skills/`, etc.). Skills went stale whenever the binary was upgraded
without re-running `repo upgrade` in every repo, N repos held N identical
copies, and generated files sat in version control beside user code.

Built-in tools now get skills only in their global directories, with no
per-repo copy (`RepoService.installGlobalSkills` in
`src/domain/repo/repo_service.ts`).

## Global Skill Paths (Built-in Tools)

Each AI tool reads skills at runtime from its own global path:

| Tool     | Global skills path                       | Reads `~/.agents/skills/`? |
| -------- | ---------------------------------------- | -------------------------- |
| amp      | reads from `~/.agents/skills/` directly  | Yes                        |
| claude   | `~/.claude/skills/`                      | No                         |
| cursor   | reads from `~/.agents/skills/` directly  | Yes                        |
| opencode | reads from `~/.agents/skills/` directly  | Yes                        |
| codex    | reads from `~/.agents/skills/` directly  | Yes                        |
| copilot  | reads from `~/.agents/skills/` directly  | Yes                        |
| kiro     | `~/.kiro/skills/`                        | No                         |
| pi       | reads from `~/.agents/skills/` directly  | Yes                        |
| antigravity | reads from `~/.agents/skills/` directly | Yes                     |

Tools that read `~/.agents/skills/` (Amp, Cursor, OpenCode, Codex, Copilot, Pi,
AntiGravity) share one copy. Claude Code and Kiro need their own.

`GLOBAL_SKILL_DIRS` in `src/domain/repo/skill_dirs.ts` gives each built-in
tool's path relative to home:

```typescript
export const GLOBAL_SKILL_DIRS: Record<string, string> = {
  amp: ".agents/skills",
  claude: ".claude/skills",
  cursor: ".agents/skills",
  opencode: ".agents/skills",
  codex: ".agents/skills",
  copilot: ".agents/skills",
  kiro: ".kiro/skills",
  pi: ".agents/skills",
  antigravity: ".agents/skills",
};
```

`resolveUniqueGlobalSkillsDirs(tools)` resolves these against the home directory
and dedupes, so codex + copilot + opencode write `~/.agents/skills/` once. At
most three directories are written, `~/.claude/skills/`, `~/.agents/skills/`
and `~/.kiro/skills/`, each holding `swamp/` and `swamp-getting-started/`.

The `none` tool has no global directory. For it and for unknown tools, skill
directory resolution falls back to `.swamp/pulled-extensions/skills/`, used only
by extension-installed skills.

## Skill Reference Style

All built-in tools use `skillReferenceStyle: "name"`. Generated instructions
files (CLAUDE.md, AGENTS.md, `.cursor/rules/swamp.mdc`,
`.kiro/steering/swamp-rules.md`) name skills (e.g. "use the `swamp` skill")
rather than give a project path. This is required because skills are global,
so a project path would not exist after init.

Custom tools may use `"name"` or `"path"`. A `"path"` tool must install skills
to a project directory or give the agent another way to resolve the paths.

## Custom Tools

Custom tools are defined with `swamp agent setup` and stored in
`.swamp-custom-tools.yaml`. `CustomToolDefinition`
(`src/domain/repo/custom_tool.ts`) has one `skillsDir` field; the path alone
decides global or local:

- A home-relative `skillsDir` (starting `~/`) is global. `repo init` and
  `repo upgrade` expand `~/`, copy bundled skills there, and register the
  absolute path in `~/.config/swamp/custom-tool-skill-dirs.json` so the
  repo-less `swamp update` command can find it.
- A repo-relative `skillsDir` (e.g. `.agents/skills/`) is project-local.
  `repo init` / `repo upgrade` resolve it against the repo root and copy bundled
  skills there. It is not registered, because `swamp update` runs without a repo
  and cannot sync it.

The `swamp agent setup` wizard (`src/cli/commands/agent_setup.ts`) builds its
skills-directory choices with `buildSkillsDirChoices()`. The choices are the
default derived from the tool name, the tool's detected `skillsDir` (if found on
disk), `<configDir>/skills` (if a config directory was found), and an "Other
path" free-text option. If only the derived default exists, it is offered inline
with Enter-to-accept.

## What `repo init` / `repo upgrade` Write

**`repo init`:**

1. Detect enrolled tools.
2. Write skills to each enrolled built-in tool's global directory and to each
   custom tool's `skillsDir`. Directories are deduplicated: `~/.agents/skills/`
   is written once even if amp, codex, copilot and opencode are all enrolled.
3. Register the built-in global directories in
   `~/.config/swamp/builtin-tool-skill-dirs.json` and `~/`-prefixed custom
   directories in `custom-tool-skill-dirs.json`.
4. Write instructions files to the repo (CLAUDE.md, AGENTS.md,
   `.cursor/rules/swamp.mdc`, `.kiro/steering/swamp-rules.md`). These stay per
   repo because they refer to repo-specific context.
5. Write tool-specific settings/hooks to the repo.
6. Do **not** copy skills into repo tool directories for built-in tools.

**`repo upgrade`:**

1. Re-write global skills with the new binary's bundled versions.
2. Update per-repo instructions files and settings/hooks.
3. Detect and warn about local skill copies (see below).
4. Update `.swamp.yaml` version.

Skill files are copied as bundled from the asset list in
`src/infrastructure/assets/skill_assets.ts`. The installed SKILL.md frontmatter
has no version stamp.

## Keeping Global Skills Current

Global skills are synced in three places:

1. **`swamp update`** (`src/cli/commands/update.ts`). After the binary updates
   (interactive or background), skills are written to the directories in both
   registries. Missing built-in directories are skipped; missing custom ones
   are removed from the registry. Directories outside home are skipped. With no
   built-in registry file (a pre-registry CLI), it syncs every built-in
   directory that already exists. It refuses to sync as root, so files under
   `~/` never become root-owned, and warns the user to run `swamp update`
   without sudo or `swamp repo upgrade` in a repo.
2. **`swamp repo init`**: during first-time setup.
3. **`swamp repo upgrade`**: during the upgrade.

Ordinary CLI startup does not sync, which avoids writing to `~/` on arbitrary
commands.
The bundled files are the source of truth and the sync is idempotent;
concurrent syncs from several repos give the same result. Sync failures
(permissions, disk full) log a warning and do not block the update or command.

### Registries

Both registries are JSON arrays of absolute directory paths under
`~/.config/swamp/`:

- `builtin-tool-skill-dirs.json`: additive. Initializing repos with different
  tools unions their directories. If the file exists but is empty (no built-in
  tools enrolled anywhere), `swamp update` syncs no built-in directories.
- `custom-tool-skill-dirs.json`: `~/`-prefixed custom tool directories.

## Local Copies Shadowing Global Skills

Repos initialized before global installation still have local skill copies.
Most tools prefer a project skill over a global one of the same name, so a stale
local copy keeps the user on old skills.

`repo init` and `repo upgrade` run `detectLocalBundledSkills()`
(`src/domain/repo/repo_service.ts`) over each enrolled tool's project skill
directory, looking for subdirectories named `swamp` or `swamp-getting-started`.
The repo-init renderer reports them (`src/presentation/renderers/repo_init.ts`):

```
WRN Local copies of swamp, swamp-getting-started are shadowing the globally installed skills.
    Delete them manually:
      .claude/skills/swamp
      .claude/skills/swamp-getting-started
```

Local copies are never deleted automatically. Repos that keep local skills on
purpose (e.g. the swamp source repo) can set `skillMigrationDismissed: true` in
`.swamp.yaml` to hide the warning. The older `lastSkillMigrationWarning` /
`lastStalenessWarning` marker fields are legacy runtime state, removed on the
next marker write.

A separate startup warning covers **superseded** skill directories: old
per-topic skills merged into the bundled `swamp` skill. See
[repo.md](./repo.md#superseded-skill-detection).

### Extension-Installed Skills

`swamp extension install` installs extension skills. They are separate from the
bundled swamp skills, stay project-local (per extension, per repo), and are
ignored by local-copy detection.

## What Stays Per-Repo

These files stay in the project because their content is specific to the repo:

- **Instructions files**: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/swamp.mdc`,
  `.kiro/steering/swamp-rules.md`. They describe the repo's models, extensions
  and purpose.
- **Settings/hooks**: `.claude/settings.local.json`, `.cursor/hooks.json`,
  `.kiro/hooks/`, `.kiro/agents/`, `.kiro/settings/cli.json`,
  `.vscode/settings.local.json` (Kiro trusted commands), `.opencode/plugins/`,
  `.github/hooks/`. They hold repo-specific configuration.
- **Extension skills**: installed by `swamp extension install`, scoped to the
  repo.
- **`.swamp.yaml` marker**: tracks repo version and enrolled tools.
