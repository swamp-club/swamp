---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Audit Doctor — preflight diagnostic

`swamp doctor audit` verifies that the AI-tool audit integration
configured for the current repository is healthy. It's read-only (the
only write is a filtered sentinel row from the end-to-end smoke test)
and emits per-check pass/fail/skip results in both log and JSON output
modes. Non-zero exit on any fail, so CI can gate on it.

## Why it exists

The audit hook chain has many moving parts — an external AI tool's
binary, its hook config shape, a workspace-level default-agent setting
(Kiro), swamp on PATH, and the per-tool normalizer that accepts the
runtime `postToolUse` payload. When any upstream tool changes its
contract (e.g. kiro-cli 2.0 switching its runtime `tool_name` from
`execute_bash` to `shell`), the swamp audit simply stops recording —
silently. Users don't know until they go looking.

`doctor audit` exercises each link of that chain with an actionable hint
attached to every failure mode, so drift surfaces loudly instead of
silently.

## The five checks

Run in fixed order so output is stable:

1. **`binary-on-path`** — the AI tool's own binary (`claude`, `cursor`,
   `kiro-cli`, `opencode`, `copilot`) is resolvable on PATH.
2. **`swamp-binary-on-path`** — swamp is on PATH (all five tools invoke
   `swamp audit record --from-hook` from their hook configs). For Kiro
   only, also verifies the absolute swamp path baked into
   `.kiro/hooks/swamp-audit.kiro.hook` at init time still resolves —
   catches the "user ran `brew upgrade` and orphaned the baked path"
   case.
3. **`agent-config-loadable`** — per-tool parser checks the config
   `swamp init` wrote is present, parses, and has the expected shape
   (e.g. Kiro's `.kiro/agents/swamp.json` must not contain `tools: ["*"]`
   — kiro-cli 2.0 silently rejects it).
4. **`default-agent-set`** — Kiro only. `.kiro/settings/cli.json` has
   `chat.defaultAgent: "swamp"`. Skips for the other four tools.
5. **`recording-smoke-test`** — the load-bearing end-to-end check. Pipes
   a tool-matched synthetic `postToolUse` payload through
   `swamp audit record --from-hook`, then reads today's JSONL and
   asserts a row with the sentinel command prefix is present. This is
   the check that catches upstream normalizer drift.

## Architecture

```
src/domain/audit/doctor/
├── check.ts                       — PreflightCheck interface, CheckResult, SpawnFn, NoToolConfiguredError
├── doctor_service.ts              — auditDoctor() streaming service; defaultCheckOrder()
├── synthetic_payloads.ts          — per-tool fixture payloads; imports DIAGNOSTIC_COMMAND_PREFIX
└── checks/
    ├── resolve_binary.ts          — ResolveBinary port + binaryNameFor(); CLI wires defaultCommandResolver()
    ├── binary_on_path.ts
    ├── swamp_binary_on_path.ts    — includes Kiro baked-path sub-check
    ├── agent_config_loadable.ts   — tool-dispatched parser
    ├── default_agent_set.ts       — Kiro-only
    └── recording_smoke.ts         — uses ctx.spawnSwamp + reads today's JSONL
```

The service emits four event kinds: `check-started`, `check-completed`,
`completed { report }`, `error { SwampError }`. The streaming shape
mirrors `datastoreStatus` and integrates with `consumeStream` + a
renderer the same way.

## Compile-time contract against the normalizer

`synthetic_payloads_test.ts` round-trips every per-tool fixture through
the corresponding normalizer in `hook_input.ts` and asserts a
well-formed `NormalizedHookInput`. This turns the fixture file into a
compile-time contract: if anyone edits either side (fixtures or
normalizers) in an incompatible way, CI breaks.

## Sentinel session filtering

The `recording-smoke-test` check (`checks/recording_smoke.ts`) writes a
real audit row via `ctx.spawnSwamp`, but with a reserved command prefix (`echo swamp-doctor-smoke-test <nonce>`). The constant
lives in `audit_service.ts` as `DIAGNOSTIC_COMMAND_PREFIX` and is
re-exported by `synthetic_payloads.ts` so writer and reader are pinned
to the same string. The timeline service filters rows matching the
prefix out of the default `swamp audit` view; `--include-diagnostic`
reveals them.

The alternative (filter on `sessionId`) doesn't work cross-tool: the
Kiro and Cursor normalizers discard the session ID from their upstream
payloads, so the persisted row has no session to filter on. The command
prefix is the only identifier available for all five tools.

## Tool resolution

- `--tool <name>` overrides; validated against the `AiTool` union via
  `parseAiToolOrThrow` in `src/cli/ai_tool_parser.ts`. Invalid names
  produce a usage error listing valid values.
- Without `--tool`, reads `.swamp.yaml`'s `tools[0]` (the primary enrolled
  tool; the legacy single `tool` field is promoted into `tools` on read).
- If both are absent, throws `NoToolConfiguredError` — a usage error,
  not a check fail, exits non-zero from the CLI.
- `amp`, `codex`, `none`, and any custom (non-built-in) tool short-circuit
  to a single skip result (`doctor_service.ts`) — those tools don't emit
  audit hooks.

## Platform

`ResolveBinary` is a port declared in the domain; the CLI wires in
`defaultCommandResolver()` from `src/infrastructure/process/`, which shells
out to `which` on POSIX and `where` on Windows. Tests inject a fake
resolver directly.

## Other `doctor <thing>` diagnostics

`doctor` is a namespace. `src/cli/commands/doctor.ts` registers `audit`,
`datastores`, `extensions`, `install`, `secrets`, `vaults`, and
`workflows` as sibling subcommands on `doctorCommand`. The `PreflightCheck`
type in `check.ts` is audit-specific — the other diagnostics have their own
check shapes rather than sharing a primitive.
