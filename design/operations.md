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
  and are quarantined after a bounded number of retries.
  `src/domain/telemetry/`, `src/infrastructure/telemetry/`.
- **Tracing**: OpenTelemetry traces and logs, turned on only by `OTEL_*`
  environment variables and passed into dispatch runners.
  `src/infrastructure/tracing/`.
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
