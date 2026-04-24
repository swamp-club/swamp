# Audit subdomain

Records and reports the bash/tool-use commands the user's AI coding agent
(Claude Code, Cursor, Kiro, OpenCode) invokes while working in a
swamp-initialized repository. Acts as an append-only activity log —
useful for reviewing what an agent has been doing and for correlating
agent actions with swamp workflow runs.

## Components

- **Per-tool normalizers** (`src/domain/audit/hook_input.ts`) — take the
  raw `postToolUse` JSON each tool emits (four different shapes; see the
  header comments in that file for the upstream contract references) and
  produce a common `NormalizedHookInput`. Each AI tool has its own
  normalizer; new tools plug in here.

- **JSONL repository** (`src/infrastructure/persistence/jsonl_audit_repository.ts`)
  — writes one row per hook event to date-partitioned files under
  `.swamp/audit/commands-YYYY-MM-DD.jsonl`. Never throws; hook failures
  must never disrupt the user's coding session.

- **Path helpers** (`src/domain/audit/audit_path.ts`) — one source of truth
  for the `commands-YYYY-MM-DD.jsonl` format. Both the writer and the
  doctor's smoke-test reader import these helpers so the filename
  convention can't silently drift.

- **Timeline service** (`src/domain/audit/audit_service.ts`) — reads rows
  back, separates swamp-vs-direct commands, filters noise, and optionally
  filters the doctor sentinel prefix.

- **`swamp audit record --from-hook --tool <tool>`** (`src/cli/commands/audit.ts`)
  — the command the AI tools' hook configs invoke. Reads the raw payload
  from stdin (or `USER_PROMPT` env var for Kiro IDE) and appends a row.

- **`swamp audit`** — renders the merged timeline.

- **`swamp doctor audit`** — preflight diagnostic verifying the audit
  integration is healthy. See [`audit-doctor.md`](audit-doctor.md) for
  details.

## Repo layout of audit config

The four supported tools wire their audit hook into tool-specific config
files that `swamp init --tool <tool>` generates. Locations summarized:

| Tool     | Hook config                              | Default-agent config    |
| -------- | ---------------------------------------- | ----------------------- |
| Claude   | `.claude/settings.local.json`            | n/a                     |
| Cursor   | `.cursor/hooks.json`                     | n/a                     |
| Kiro     | `.kiro/hooks/swamp-audit.kiro.hook` + `.kiro/agents/swamp.json` | `.kiro/settings/cli.json` |
| OpenCode | `.opencode/plugins/swamp-audit.ts`       | n/a                     |

See `src/domain/repo/repo_service.ts` for the exact generators
(`updateClaudeSettings`, `updateCursorHooks`, `updateKiroHooks`,
`updateKiroAgentConfig`, `ensureKiroCliDefaultAgent`,
`updateOpenCodePlugin`).

## Reserved session / command prefixes

`swamp-doctor-*` session IDs and the command prefix
`echo swamp-doctor-smoke-test` are reserved for the `doctor audit`
smoke-test. The timeline service filters rows matching the prefix from
the default `swamp audit` view; pass `--include-diagnostic` to reveal
them. User shell invocations must not start with that prefix.
