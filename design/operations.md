---
audience: maintainer
last-verified: 2026-09-16 @ 600af419
---

# Operations

Subsystems that are real code but neither a primitive nor an enabler of one.
Each gets one line and a pointer to source, not a design doc. If one grows into
something a primitive depends on, move it to `enablers/` and give it an
`enables:` header.

- **Telemetry**: product telemetry, spooled under the user config dir and sent
  over HTTP. The CLI flushes once at teardown; `swamp serve` runs its own flush
  loop (`src/serve/telemetry_flush.ts`). Entries carry an `insert_id` for dedup
  and are quarantined after a bounded number of retries. `swamp completions`
  records no event: shell rc files run it at every shell start and its scripts
  call it on every Tab press, so it must not wait on the teardown flush.
  `src/domain/telemetry/`, `src/infrastructure/telemetry/`. The recorded
  command is resolved against the real command tree
  (`src/cli/telemetry_invocation.ts`): every command word is kept in
  `commandPath`, names, ids, queries and types are sent, and filesystem paths,
  input values, option values, access groups and principals, and the
  `data query` predicate are redacted. Error messages keep names but replace
  whole paths with `<PATH>` (`src/domain/telemetry/error_message_redaction.ts`).
  Before any pattern runs, the exact values the invocation redacted (and their
  absolute forms), the working, home and repo directories are removed from the
  message, so a path with a space in it needs no guessing; other redacted
  values are removed as whole words after the path patterns. Those values stay
  in memory and are never recorded. Errors also carry the paths they name as
  marked values (`markErrorPaths` / `errorPaths` in `src/domain/errors.ts`),
  which are removed exactly in the same pass, including those on the `cause`
  chain. Marks survive the places where an error is turned into a string and
  back: workflow `step_failed` events (a domain-internal `errorPaths` field,
  stripped from the published event), libswamp stream errors rebuilt by the
  CLI (`userErrorFromSwampError`), and remote worker results
  (`DispatchResult.errorPaths`, bounded). Runs executed by `swamp serve` have
  no command line, so they depend on these marks. The path patterns remain the
  fallback for text the marks do not cover, such as errors from the runtime or
  third-party libraries.
  `swamp behavior …` and `swamp behaviour …` are recorded in their
  `swamp model …` form (swamp-club#3411): `command`, `subcommand`, `args` and
  `commandPath` are exactly what the `swamp model` spelling records, so
  `behavior run m x` records as `model method run m x`. One command then
  counts the same however it was typed, and analytics keep the names they
  already group by. `commandSpelling` keeps the typed root word, one of
  `model`, `behavior` or `behaviour`. It is a fixed set of command words, so
  it carries no user data. Invocations of other groups, and the entries swamp
  records on its own (workflow steps, serve runs), have no `commandSpelling`.
  The mapping is applied only when the invocation is recorded
  (`toRecordedInvocation`); the auth gate reads the resolution as typed.
- **Tracing**: OpenTelemetry traces and logs, turned on only by `OTEL_*`
  environment variables and passed into dispatch runners.
  `src/infrastructure/tracing/`.
  Application execution metrics opt in separately with
  `OTEL_METRICS_EXPORTER=otlp`; see the
  [remote telemetry contract](enablers/remote-execution-telemetry.md) for native
  parentage, metric resets and interpretation of incomplete exports, and
  [serve phase telemetry](enablers/serve-phase-telemetry.md) for the phases of
  worker enrollment, worker deletion, run-detail output resolution, output
  retention and access-data polling.
- **Self-update**: version check, integrity check, and OS-scheduled autoupdate
  (launchd / systemd / cron). `src/domain/update/`,
  `src/infrastructure/update/`.
- **Issues**: `swamp issue` files redacted bug reports to the swamp-club Lab and
  to GitHub via `gh`. `src/domain/issues/`, `src/libswamp/issues/`,
  `src/infrastructure/github/` (the `gh` call).
- **Quest / Genesis Pass**: a read model of the user's swamp-club progression
  ladder, shown by `swamp quest`. `src/domain/quest/genesis_pass.ts`.
- **Invite / recruit link**: `swamp invite link` (and the hidden top-level
  `swamp first-rule`) prints the operative's swamp-club recruit link. The link
  is a server-owned read model, fetched get-or-create. Like Quest, it has no
  CLI-side domain type. `src/libswamp/invite/`,
  `SwampClubClient.fetchRecruitLink`.
- **Summarise**: activity summary across contexts for `swamp summarise`.
  `src/domain/summary/`.
- **Source fetch**: downloads and caches swamp source archives for
  `swamp source`. `src/domain/source/`, `src/infrastructure/source/`.
- **SBOM / license compliance**: CycloneDX generation and FOSSA scanning; see
  [scripts/README.md](../scripts/README.md).
