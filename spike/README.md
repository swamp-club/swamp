# swamp-club#3234 Litestream spike (throwaway)

Prototype and measurement scripts behind
`design/enablers/datastore-litestream.md`. This branch is never merged.

- `lib.ts` — node:sqlite writer, Litestream config, control-socket client.
- `exp_compat.ts` — Q2 checkpoint regimes.
- `exp_latency.ts` — Q4/Q8 per-command vs long-lived cost, forced sync, lag.
- `exp_crash.ts` — Q5 kill -9 of replicator, writer, and machine loss.
- `exp_failover.ts`, `exp_zombie.ts` — Q6 restore, follow mode, fences.
- `platform_probe.ts`, `ci_run.sh` — Q7, run by
  `.github/workflows/spike-3234-litestream.yml` on Windows/macOS/Linux.
- `golib/` — option (b), Litestream as a c-shared library via `Deno.dlopen`.
- `rtt_proxy.ts`, `creds_server.ts` — injected RTT and container credentials.
- `results/` — raw JSON lines from the runs quoted in the record.
