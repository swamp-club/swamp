---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Audit subdomain

Records and reports the bash/tool-use commands the user's AI coding agent
(Claude Code, Cursor, Kiro, OpenCode, Copilot) invokes while working in a
swamp-initialized repository. Acts as an append-only activity log —
useful for reviewing what an agent has been doing and for correlating
agent actions with swamp workflow runs.

## Components

- **Per-tool normalizers** (`src/domain/audit/hook_input.ts`) — take the
  raw `postToolUse` JSON each tool emits (five different shapes) and
  produce a common `NormalizedHookInput`. `normalizeHookInput()` dispatches
  on `HookTool` to `normalizeClaude`, `normalizeCursor`, `normalizeKiro`,
  `normalizeOpenCode`, and `normalizeCopilot`; each carries a per-function
  comment describing its payload shape (only the Copilot one links an
  upstream contract URL). New tools plug in here.

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
  integration is healthy. See [`audit-doctor.md`](./audit-doctor.md) for
  details.

## Repo layout of audit config

The five supported tools wire their audit hook into tool-specific config
files that `swamp repo init --tool <tool>` (alias `swamp init`) generates.
Locations summarized:

| Tool     | Hook config                              | Other config                                                                           |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Claude   | `.claude/settings.local.json`            | n/a                                                                                    |
| Cursor   | `.cursor/hooks.json`                     | n/a                                                                                    |
| Kiro     | `.kiro/hooks/swamp-audit.kiro.hook` + `.kiro/agents/swamp.json` | `.kiro/settings/cli.json` (default agent); `.vscode/settings.local.json` (`kiroAgent.trustedCommands: ["swamp *"]`) |
| OpenCode | `.opencode/plugins/swamp-audit.ts`       | n/a                                                                                    |
| Copilot  | `.github/hooks/swamp-audit.json`         | n/a                                                                                    |

See `src/domain/repo/repo_service.ts` for the exact generators
(`updateClaudeSettings`, `updateCursorHooks`, `updateKiroHooks`,
`updateKiroAgentConfig`, `ensureKiroCliDefaultAgent`,
`updateOpenCodePlugin`, `updateCopilotHooks`,
`createCopilotHooksIfNotExists`).

## Reserved session / command prefixes

The command prefix `echo swamp-doctor-smoke-test`
(`DIAGNOSTIC_COMMAND_PREFIX` in `src/domain/audit/audit_service.ts`) is
reserved for the `doctor audit` smoke-test. The timeline service filters
rows whose command starts with that prefix from the default `swamp audit`
view; pass `--include-diagnostic` to reveal them. User shell invocations
must not start with that prefix.

The smoke-test fixtures also use a `swamp-doctor-smoke-test` session ID
(`DOCTOR_SMOKE_TEST_SESSION_ID` in `doctor/synthetic_payloads.ts`) for the
tools whose normalizer keeps `session_id`. That is a fixture convention
only — the timeline service does not filter on session ID, because the
Kiro and Cursor normalizers discard it.
