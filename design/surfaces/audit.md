---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Audit subdomain

Records the bash and tool-use commands the user's AI coding agent (Claude Code,
Cursor, Kiro, OpenCode, Copilot) runs in a swamp-initialized repository. It is
an append-only activity log for reviewing what an agent did and matching its
actions to swamp workflow runs.

## Components

- **Per-tool normalizers** (`src/domain/audit/hook_input.ts`): turn each tool's
  raw `postToolUse` JSON (five shapes) into a common `NormalizedHookInput`.
  `normalizeHookInput()` dispatches on `HookTool` to `normalizeClaude`,
  `normalizeCursor`, `normalizeKiro`, `normalizeOpenCode` and
  `normalizeCopilot`. Each documents its payload shape in a comment; only the
  Copilot one links an upstream contract URL. New tools are added here. Claude's
  normalizer takes both of Claude Code's shell tools, `Bash` and `PowerShell`
  (on by default on Windows, opt-in elsewhere); both carry the command in
  `tool_input.command`.

- **JSONL repository**
  (`src/infrastructure/persistence/jsonl_audit_repository.ts`): writes one row
  per hook event to date-partitioned files,
  `.swamp/audit/commands-YYYY-MM-DD.jsonl`. It never throws, because a hook
  failure must never disrupt the user's coding session.

- **Path helpers** (`src/domain/audit/audit_path.ts`): the one definition of the
  `commands-YYYY-MM-DD.jsonl` format. The writer and the doctor's smoke-test
  reader both import it, so the filename format cannot drift.

- **Timeline service** (`src/domain/audit/audit_service.ts`): reads rows back,
  separates swamp from direct commands, filters noise, and can filter out the
  doctor sentinel prefix.

- **`swamp audit record --from-hook --tool <tool>`**
  (`src/cli/commands/audit.ts`): the command the AI tools' hook configs call.
  It reads the raw payload from stdin (or the `USER_PROMPT` env var for Kiro
  IDE) and appends a row. An explicit `--repo-dir` is used as given, as for
  every other command: if it has no `.swamp.yaml` marker the row is dropped.
  Otherwise the row goes to the first initialized repository found from, in
  order: the payload's `cwd` walked up to the nearest marker,
  `SWAMP_REPO_DIR`, then the process cwd walked up the same way. When none of
  them is an initialized repository the row is dropped — the hook never
  creates a `.swamp/` directory, so a hook firing in a git worktree or other
  non-repo directory cannot leave a half-initialized repository behind.

- **`swamp audit install --user` / `uninstall --user`**
  (`src/cli/commands/audit_install.ts`, `src/domain/audit/user_hook.ts`): add
  or remove swamp's Claude audit hook in the user's Claude Code settings,
  `~/.claude/settings.json`. Claude Code loads project hooks only from the
  folder a session starts in (`.claude/settings.local.json` from the git root,
  or the start folder on Windows and before Claude Code 2.1.211), so a repo
  nested below its git root, or one a session starts above, never runs its own
  hook. The user-level hook covers every repo, because recording already
  resolves the repo from the payload's `cwd` and drops rows outside one. The
  cost is a swamp process for every Bash and PowerShell call in every project,
  about 0.45 s each, most of it binary startup. Install merges with
  `mergeAuditHooks` like the repo config, keeps every other key, refuses a file
  that does not parse, and writes through a symlinked file or `.claude` dir to
  its target so a dotfiles link stays a link. Uninstall removes only entries
  equal to one swamp wrote. Claude Code runs an identical handler defined in
  several settings files once, even under different matchers, so a repo hook
  plus the user hook records each call once. `--user` is the only scope; the repo hook belongs to `swamp repo
  upgrade`.

- **`swamp audit`**: shows the merged timeline. With `--server` it sends
  `audit.timeline` to `swamp serve`, which needs `admin` on `access:audit`. Its
  command lines can name behaviors, workflows and vaults, so a behavior `read`
  grant is not enough.

- **`swamp doctor audit`**: a preflight check that the audit integration works.
  See [`audit-doctor.md`](./audit-doctor.md).

## Repo layout of audit config

Each supported tool's audit hook lives in tool-specific config files generated
by `swamp repo init --tool <tool>` (alias `swamp init`):

| Tool     | Hook config                              | Other config                                                                           |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Claude   | `.claude/settings.local.json`            | n/a                                                                                    |
| Cursor   | `.cursor/hooks.json`                     | n/a                                                                                    |
| Kiro     | `.kiro/hooks/swamp-audit.json` (Kiro IDE) + `.kiro/agents/swamp.json` (kiro-cli) | `.kiro/settings/cli.json` (default agent) |
| OpenCode | `.opencode/plugins/swamp-audit.ts`       | n/a                                                                                    |
| Copilot  | `.github/hooks/swamp-audit.json`         | n/a                                                                                    |

The generators are in `src/domain/repo/repo_service.ts`
(`updateClaudeSettings`, `updateCursorHooks`, `updateKiroHooks`,
`updateKiroAgentConfig`, `ensureKiroCliDefaultAgent`, `updateOpenCodePlugin`,
`updateCopilotHooks`, `createCopilotHooksIfNotExists`).

Kiro has two hook files because its surfaces read different ones.
`.kiro/hooks/swamp-audit.json` is a hook in Kiro's v1 hook schema
(`PostToolUse`), which Kiro IDE 1.0 runs; the IDE no longer runs the legacy
`.kiro.hook` files earlier versions wrote, and it ignores agent configs that
contain `hooks`. `.kiro/agents/swamp.json` carries the hook for kiro-cli. It is
written in kiro-cli's universal format, which both the 2.x engine (the default)
and the opt-in 3.0 engine load: the 2.x `toolsSettings` with the 3.0
`permissions.rules` mirroring them, and the array form of `hooks`. kiro-cli 3.0
also runs workspace `.kiro/hooks/*.json` files, so under that engine a shell
call can be recorded twice. Dropping the profile's hook would lose audit on
the 2.x default, so the duplicate is accepted.

The OpenCode plugin serves OpenCode 1 and OpenCode 2 from one file. It keeps
the original named export `SwampAudit` (a factory returning
`tool.execute.before`/`tool.execute.after` hooks that match the `bash` tool),
and adds a default export object with `id`, `server` (the same factory) and
`setup(ctx)`. OpenCode 1.3.4 and later use `default.server` and ignore the
other exports. OpenCode 2 requires a default object with `id` and `setup`,
ignores named exports, and names the tool `shell`: `setup` registers
`ctx.tool.hook("execute.after", ...)`, which receives the command in
`event.input`. Both paths send the same payload to
`swamp audit record --from-hook --tool opencode`, so `normalizeOpenCode` does
not distinguish them. The imports are type-only, so the file needs no OpenCode
package at runtime. OpenCode 1 builds before 1.3.4 call every export as a
function, which no file OpenCode 2 accepts can satisfy: on 1.0 to 1.2.10 the
default object crashes the run, and on 1.2.11 to 1.3.3 it records but OpenCode
reports a plugin load error. The supported range is therefore OpenCode 1.3.4 or
later, and OpenCode 2.

Upgrade migrates Kiro repos scaffolded by earlier versions: it deletes swamp's
`swamp-audit.kiro.hook`, and removes copies of the audit hook (post-tool
entries whose command is exactly swamp's audit hook command, with the binary
bare or as an absolute path) from other v1 hook files in `.kiro/hooks/`, which
Kiro IDE writes when it auto-migrates legacy hooks. A command the user extended
is kept. A hook file is deleted only when
nothing else is left in it; symlinks and files that do not parse are skipped.

Upgrade and `init --force` merge the audit hook into an existing Claude,
Cursor or Copilot hook config with `mergeAuditHooks`. An event that already
runs `swamp audit record --from-hook` in any form (a backgrounded wrapper, an
extra `timeout`) keeps that hook, and swamp's own entry is not added beside it:
two hooks would record every tool call twice. For Claude, only entries whose
matcher covers `Bash` count, judged by Claude Code's own matcher rules (a list
of exact names, or an unanchored regex). Swamp's Claude entry matches
`Bash|PowerShell`; before the merge, an entry equal to the Bash-only one earlier
versions wrote is replaced in place, since the merge would otherwise count it as
an existing hook and never widen it. A user's own Bash-only variant is kept.
Swamp's Claude allow-list grants `Bash(swamp ...)` rules only, so swamp calls
through the PowerShell tool still ask for permission. Where an earlier upgrade did add
swamp's entry next to a user's variant, the merge removes swamp's entry again.
Only entries whose serialised JSON equals swamp's own entry are ever removed;
every other entry, including one that differs from swamp's only in key order,
is left as it is.

## Reserved session / command prefixes

The command prefix `echo swamp-doctor-smoke-test`
(`DIAGNOSTIC_COMMAND_PREFIX` in `src/domain/audit/audit_service.ts`) is
reserved for the `doctor audit` smoke test. The timeline service hides rows
whose command starts with it from the default `swamp audit` view;
`--include-diagnostic` shows them. User shell commands must not start with this
prefix.

The smoke-test fixtures also use a `swamp-doctor-smoke-test` session ID
(`DOCTOR_SMOKE_TEST_SESSION_ID` in `doctor/synthetic_payloads.ts`) for tools
whose normalizer keeps `session_id`. This is only a fixture convention; the
timeline service does not filter on session ID, since the Kiro and Cursor
normalizers drop it.
