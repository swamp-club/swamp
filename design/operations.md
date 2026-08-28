---
audience: maintainer
last-verified: 2026-08-28 @ 4bde205b
---

# Operations

Subsystems that are real code but are neither a primitive nor an enabler of
one. Each gets one line and a pointer to source; none gets a design doc. If one
grows into something a primitive depends on, promote it to `enablers/` and give
it an `enables:` header.

- **Telemetry** — product telemetry spooled under the user config dir and
  flushed over HTTP; the CLI flushes once at teardown, `swamp serve` runs its
  own flush loop (`src/serve/telemetry_flush.ts`). Entries carry an `insert_id`
  for dedup and are quarantined after bounded retries. `src/domain/telemetry/`,
  `src/infrastructure/telemetry/`.
- **Tracing** — OpenTelemetry traces and logs, enabled purely by `OTEL_*`
  environment variables, propagated into dispatch runners.
  `src/infrastructure/tracing/`.
- **Self-update** — version check, integrity verification, and OS-scheduled
  autoupdate (launchd / systemd / cron). `src/domain/update/`,
  `src/infrastructure/update/`.
- **Issues** — `swamp issue` files redacted bug reports to the swamp-club Lab
  and to GitHub via `gh`. `src/domain/issues/`, `src/libswamp/issues/`.
- **Quest / Genesis Pass** — a read model of the user's swamp-club progression
  ladder shown by `swamp quest`. `src/domain/quest/genesis_pass.ts`.
- **Summarise** — cross-context activity summary for `swamp summarise`.
  `src/domain/summary/`.
- **Source fetch** — downloads and caches swamp source archives for
  `swamp source`. `src/domain/source/`, `src/infrastructure/source/`.
- **SBOM / license compliance** — CycloneDX generation and FOSSA scanning; see
  [scripts/README.md](../scripts/README.md).
