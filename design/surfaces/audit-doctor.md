---
audience: maintainer
last-verified: 2026-08-28 @ 3d5955a9
---

# Audit Doctor — preflight diagnostic

`swamp doctor audit` checks that the repository's AI-tool audit integration
works. It is read-only apart from one filtered sentinel row written by the
smoke test. It reports pass, fail or skip per check in log and JSON output, and
exits non-zero on any fail so CI can gate on it.

## Why it exists

The audit hook chain has many parts: the AI tool's binary, its hook config
format, a workspace default-agent setting (Kiro), swamp on PATH, and the
per-tool normalizer for the runtime `postToolUse` payload. When an upstream tool
changes its contract, recording stops with no error, and users only find out
when they look. For example, kiro-cli 2.0 renamed its runtime `tool_name` from
`execute_bash` to `shell`.

`doctor audit` tests each link and gives a fix hint for every failure.

## The five checks

They run in a fixed order so output is stable:

1. **`binary-on-path`**: the AI tool's binary (`claude`, `cursor`, `kiro-cli`,
   `opencode`, `copilot`) is on PATH.
2. **`swamp-binary-on-path`**: swamp is on PATH, since every hook config runs
   `swamp audit record --from-hook` through a PATH lookup.
3. **`agent-config-loadable`**: a per-tool parser checks that the config
   `swamp init` wrote exists, parses and has the expected shape. For example,
   Kiro's `.kiro/agents/swamp.json` must not contain `tools: ["*"]`, which
   kiro-cli 2.0 silently rejects.
4. **`default-agent-set`**: Kiro only. `.kiro/settings/cli.json` has
   `chat.defaultAgent: "swamp"`. Skipped for the other four tools.
5. **`recording-smoke-test`**: the end-to-end check, and the one that
   catches upstream normalizer changes. It pipes a synthetic `postToolUse`
   payload for the tool through `swamp audit record --from-hook`, then asserts
   that today's JSONL has a row with the sentinel command prefix.

## Architecture

```
src/domain/audit/doctor/
├── check.ts                       — PreflightCheck interface, CheckResult, SpawnFn, NoToolConfiguredError
├── doctor_service.ts              — auditDoctor() streaming service; defaultCheckOrder()
├── synthetic_payloads.ts          — per-tool fixture payloads; imports DIAGNOSTIC_COMMAND_PREFIX
└── checks/
    ├── resolve_binary.ts          — ResolveBinary port + binaryNameFor(); CLI wires defaultCommandResolver()
    ├── binary_on_path.ts
    ├── swamp_binary_on_path.ts    — PATH lookup for swamp binary
    ├── agent_config_loadable.ts   — tool-dispatched parser
    ├── default_agent_set.ts       — Kiro-only
    └── recording_smoke.ts         — uses ctx.spawnSwamp + reads today's JSONL
```

The service emits four event kinds: `check-started`, `check-completed`,
`completed { report }`, `error { SwampError }`. Like `datastoreStatus`, it works
with `consumeStream` and a renderer.

## Compile-time contract against the normalizer

`synthetic_payloads_test.ts` passes every per-tool fixture through its
normalizer in `hook_input.ts` and asserts a well-formed `NormalizedHookInput`.
An incompatible edit to either fixtures or normalizers breaks CI.

## Sentinel session filtering

The `recording-smoke-test` check (`checks/recording_smoke.ts`) writes a real
audit row via `ctx.spawnSwamp` with a reserved command prefix
(`echo swamp-doctor-smoke-test <nonce>`). The prefix is `DIAGNOSTIC_COMMAND_PREFIX`
in `audit_service.ts`, re-exported by `synthetic_payloads.ts` so writer and
reader share one string. The timeline service hides these rows from the default
`swamp audit` view; `--include-diagnostic` shows them.

Filtering on `sessionId` would not work: the Kiro and Cursor normalizers drop
the upstream session ID. The command prefix is the only identifier all five
tools keep.

## Tool resolution

- `--tool <name>` overrides, validated against the `AiTool` union by
  `parseAiToolOrThrow` in `src/cli/ai_tool_parser.ts`. An invalid name gives a
  usage error listing valid values.
- Without `--tool`, it reads `.swamp.yaml`'s `tools[0]`, the primary tool (the
  legacy single `tool` field is promoted into `tools` on read).
- With neither, it throws `NoToolConfiguredError`: a usage error, not a check
  fail, and the CLI exits non-zero.
- `amp`, `codex`, `none` and any custom (non-built-in) tool return a single skip
  result (`doctor_service.ts`), because they do not emit audit hooks.

## Platform

`ResolveBinary` is a port declared in the domain. The CLI wires in
`defaultCommandResolver()` from `src/infrastructure/process/`, which runs
`which` on POSIX and `where` on Windows. Tests inject a fake resolver.

## Other `doctor <thing>` diagnostics

`doctor` is a namespace. `src/cli/commands/doctor.ts` registers `audit`,
`datastores`, `extensions`, `install`, `secrets`, `vaults` and `workflows` as
subcommands of `doctorCommand`. The `PreflightCheck` type in `check.ts` is
audit-only; the others have their own check shapes.
