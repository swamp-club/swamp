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
  Copilot one links an upstream contract URL. New tools are added here.

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
  IDE) and appends a row.

- **`swamp audit`**: shows the merged timeline.

- **`swamp doctor audit`**: a preflight check that the audit integration works.
  See [`audit-doctor.md`](./audit-doctor.md).

## Repo layout of audit config

Each supported tool's audit hook lives in tool-specific config files generated
by `swamp repo init --tool <tool>` (alias `swamp init`):

| Tool     | Hook config                              | Other config                                                                           |
| -------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Claude   | `.claude/settings.local.json`            | n/a                                                                                    |
| Cursor   | `.cursor/hooks.json`                     | n/a                                                                                    |
| Kiro     | `.kiro/hooks/swamp-audit.kiro.hook` + `.kiro/agents/swamp.json` | `.kiro/settings/cli.json` (default agent); `.vscode/settings.local.json` (`kiroAgent.trustedCommands: ["swamp *"]`) |
| OpenCode | `.opencode/plugins/swamp-audit.ts`       | n/a                                                                                    |
| Copilot  | `.github/hooks/swamp-audit.json`         | n/a                                                                                    |

The generators are in `src/domain/repo/repo_service.ts`
(`updateClaudeSettings`, `updateCursorHooks`, `updateKiroHooks`,
`updateKiroAgentConfig`, `ensureKiroCliDefaultAgent`, `updateOpenCodePlugin`,
`updateCopilotHooks`, `createCopilotHooksIfNotExists`).

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
